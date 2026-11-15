/** Session routing is independent of OpenCode, SSH and authentication. */
export interface RuntimeConnection {
  close(): Promise<void>
}
export type RuntimePhase = "local" | "connecting" | "connected" | "failed"
interface Entry<T> { phase: RuntimePhase; connection?: T }

export class RuntimeRouter<T extends RuntimeConnection> {
  private entries = new Map<string, Entry<T>>()
  private active = new Map<string, number>()
  private pending = new Map<string, Promise<unknown>>()
  private closed = false

  constructor(private readonly mark: (id: string, remote: boolean) => Promise<void> = async () => {}) {}

  restore(id: string) { this.entries.set(id, { phase: "failed" }) }
  status(id: string): RuntimePhase { return this.entries.get(id)?.phase ?? "local" }
  connection(id: string): T | undefined { return this.entries.get(id)?.connection }
  snapshot() { return new Map(this.entries) }

  private assertIdle(id: string) {
    if (this.closed) throw new Error("Remote runtime is closed")
    if (this.active.get(id)) throw new Error("Tools are still running; stop them before changing target")
  }

  async connect(id: string, open: () => Promise<T>): Promise<void> {
    this.assertIdle(id)
    if (["connecting", "connected"].includes(this.status(id))) throw new Error("Disconnect before selecting another target")
    const entry: Entry<T> = { phase: "connecting" }
    this.entries.set(id, entry) // block local execution before the first await
    const task = (async () => {
      try {
        await this.mark(id, true)
        const connection = await open()
        if (this.closed || this.entries.get(id) !== entry) {
          await connection.close()
          throw new Error("Connection cancelled")
        }
        entry.connection = connection
        entry.phase = "connected"
      } catch (error) {
        if (this.entries.get(id) === entry) entry.phase = "failed"
        throw error
      }
    })()
    this.pending.set(id, task)
    try { await task } finally { this.pending.delete(id) }
  }

  async disconnect(id: string): Promise<void> {
    this.assertIdle(id)
    if (this.status(id) === "connecting") throw new Error("Connection is still pending; wait for it to finish")
    const previous = this.entries.get(id)
    const blocked: Entry<T> = { phase: "failed" }
    this.entries.set(id, blocked)
    await previous?.connection?.close()
    await this.mark(id, false)
    this.entries.set(id, { phase: "local" })
  }

  async route<R>(snapshot: ReturnType<RuntimeRouter<T>["snapshot"]>, id: string,
    local: () => Promise<R>, remote: (connection: T) => Promise<R>): Promise<R> {
    if (!id || this.closed) throw new Error("Remote runtime unavailable")
    const entry = this.entries.get(id)
    if (snapshot.get(id) !== entry) throw new Error("Target changed since this tool snapshot; retry in a new turn")
    if (entry && entry.phase !== "local" && entry.phase !== "connected") {
      throw new Error(`Remote target is ${entry.phase}; reconnect or explicitly disconnect. Local execution is blocked.`)
    }
    this.active.set(id, (this.active.get(id) ?? 0) + 1)
    try {
      // Deliberately no catch-and-delegate: remote errors can never run locally.
      return entry?.connection ? await remote(entry.connection) : await local()
    } finally {
      const remaining = (this.active.get(id) ?? 1) - 1
      if (remaining) this.active.set(id, remaining)
      else this.active.delete(id)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending.values())
    await Promise.allSettled([...this.entries.values()].map(entry => entry.connection?.close()))
    this.entries.clear()
  }

  async forget(id: string): Promise<void> {
    const previous = this.entries.get(id)
    if (!previous) return
    this.entries.set(id, { phase: "failed" })
    await this.pending.get(id)?.catch(() => {})
    await previous.connection?.close()
    await this.mark(id, false)
  }
}
