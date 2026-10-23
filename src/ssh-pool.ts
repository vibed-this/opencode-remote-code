import { Client, type SFTPWrapper } from "ssh2"
import { readFileSync } from "fs"
import type { RemoteConfig } from "./config.js"

export interface SSHPool {
  exec(command: string, options?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>
  withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T>
  getSudoAskpassPath(): string | undefined
  close(): Promise<void>
}

const HEALTH_CHECK_INTERVAL_MS = 30_000
const HEALTH_CHECK_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 500
/** Base delay for replacement-connection retries: 5s, 10s, 20s, ... */
const CONNECTION_RETRY_DELAY_MS = 5_000
/** Hard cap on attempts per replenish() call. Never loop forever. */
const REPLENISH_MAX_ATTEMPTS = 3
const REPLENISH_MAX_DELAY_MS = 60_000

type PoolStatus = "connecting" | "ready" | "failed" | "closed"

interface QueueEntry {
  resolve: (client: Client) => void
  reject: (err: Error) => void
}

interface PendingConnect {
  cancel: () => void
}

class ConnectionPool {
  private clients: Client[] = []
  private busy = new Set<Client>()
  private queue: QueueEntry[] = []
  private healthTimer?: NodeJS.Timeout
  private status: PoolStatus = "connecting"
  private replenishing = false
  private pendingConnects = new Set<PendingConnect>()
  private retrySleepTimer?: NodeJS.Timeout
  private cancelRetrySleep?: () => void
  ready: Promise<void>

  constructor(
    private config: RemoteConfig,
    private size: number,
    private staggerMs: number = 0
  ) {
    this.ready = this.init()
    // Avoid an unhandled-rejection warning while still letting callers await
    // the original (rejecting) promise.
    this.ready.catch(() => {})
  }

  private isClosed(): boolean {
    return this.status === "closed"
  }

  private async init(): Promise<void> {
    try {
      // Sequential creation with optional stagger to avoid overwhelming legacy SSH servers
      for (let i = 0; i < this.size; i++) {
        if (this.isClosed()) throw new Error("Connection pool closed")
        await this.createClient()
        if (this.staggerMs > 0 && i < this.size - 1) {
          await this.sleep(this.staggerMs)
          if (this.isClosed()) throw new Error("Connection pool closed")
        }
      }
    } catch (err) {
      // Do not leave half-open sockets behind when startup fails part-way.
      this.discardClients()
      if (!this.isClosed()) this.status = "failed"
      this.stopHealthCheck()
      throw err
    }

    if (this.isClosed()) {
      this.discardClients()
      throw new Error("Connection pool closed")
    }
    // Health checking only makes sense once we actually have connections.
    this.status = "ready"
    this.startHealthCheck()
  }

  private createClient(): Promise<void> {
    if (this.isClosed()) {
      return Promise.reject(new Error("Connection pool closed"))
    }
    const CREATE_TIMEOUT_MS = 30_000
    return new Promise((resolve, reject) => {
      const client = new Client()
      let resolved = false
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.pendingConnects.delete(pending)
          client.end()
          reject(new Error(`SSH connection timeout after ${CREATE_TIMEOUT_MS}ms`))
        }
      }, CREATE_TIMEOUT_MS)

      const pending: PendingConnect = {
        cancel: () => {
          if (resolved) return
          resolved = true
          this.pendingConnects.delete(pending)
          clearTimeout(timer)
          client.end()
          reject(new Error("Connection pool closed"))
        },
      }
      this.pendingConnects.add(pending)

      const connConfig: any = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        readyTimeout: 20_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        algorithms: buildAlgorithms(this.config.extraOptions),
      }

      // Parse extra -o options
      for (let i = 0; i < this.config.extraOptions.length; i++) {
        const opt = this.config.extraOptions[i]
        if (opt === "StrictHostKeyChecking" && this.config.extraOptions[i + 1] === "no") {
          connConfig.hostVerifier = () => true
          i++
        }
      }

      if (this.config.identity) {
        connConfig.privateKey = readFileSync(this.config.identity)
      } else if (this.config.password) {
        connConfig.password = this.config.password
      }

      client
        .on("ready", () => {
          if (!resolved) {
            resolved = true
            this.pendingConnects.delete(pending)
            clearTimeout(timer)
            this.clients.push(client)
            resolve()
          }
        })
        .on("error", (err: Error) => {
          if (!resolved) {
            resolved = true
            this.pendingConnects.delete(pending)
            clearTimeout(timer)
            // A connection that failed mid-handshake must not keep its socket.
            try {
              client.end()
            } catch {
              /* ignore */
            }
            reject(err)
          } else {
            this.removeClient(client)
            client.end()
          }
        })
        .on("close", () => {
          this.removeClient(client)
          this.processQueue()
        })

      client.connect(connConfig)
    })
  }

  private removeClient(client: Client): void {
    this.clients = this.clients.filter((c) => c !== client)
    this.busy.delete(client)
  }

  private processQueue(): void {
    while (this.queue.length > 0) {
      if (this.isClosed()) {
        this.rejectQueue(new Error("Connection pool closed"))
        return
      }
      const free = this.clients.find((c) => !this.busy.has(c))
      if (!free) break
      const next = this.queue.shift()
      if (next) {
        this.busy.add(free)
        next.resolve(free)
      }
    }
  }

  private rejectQueue(err: Error): void {
    const queued = this.queue
    this.queue = []
    for (const entry of queued) {
      entry.reject(err)
    }
  }

  private startHealthCheck(): void {
    if (this.status !== "ready" || this.healthTimer) return
    this.healthTimer = setInterval(() => {
      if (this.isClosed() || this.status === "failed") return
      this.checkHealth().catch(() => {})
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = undefined
    }
  }

  /** Cancel any in-flight backoff sleep so close() is not blocked by it. */
  private cancelSleep(): void {
    if (this.retrySleepTimer) {
      clearTimeout(this.retrySleepTimer)
      this.retrySleepTimer = undefined
    }
    if (this.cancelRetrySleep) {
      const cancel = this.cancelRetrySleep
      this.cancelRetrySleep = undefined
      cancel()
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.retrySleepTimer) clearTimeout(this.retrySleepTimer)
        this.retrySleepTimer = undefined
        this.cancelRetrySleep = undefined
        resolve()
      }
      this.retrySleepTimer = setTimeout(finish, ms)
      this.cancelRetrySleep = finish
    })
  }

  private async checkHealth(): Promise<void> {
    if (this.status !== "ready") return

    // 1. Replenish missing connections (bounded: this call always terminates)
    await this.replenish()
    if (this.status !== "ready") return

    // 2. Ping idle connections to verify they are responsive
    const idleClients = this.clients.filter((c) => !this.busy.has(c))
    for (const client of idleClients) {
      if (this.status !== "ready") return
      try {
        await this.pingClient(client)
      } catch {
        if (this.status !== "ready") return
        console.log(
          `[SSHPool] Health check: unresponsive connection replaced (${this.config.host}:${this.config.port})`
        )
        this.removeClient(client)
        client.end()
        await this.replenishOne()
      }
    }
  }

  /**
   * Try to fill the pool up to `size`.
   *
   * Bounded on purpose: at most REPLENISH_MAX_ATTEMPTS connection attempts per
   * call, with exponential backoff, and a single summary log when giving up.
   * A later health check may try again — but this call always returns.
   */
  private async replenish(): Promise<void> {
    if (this.isClosed() || this.status === "failed") return
    if (this.replenishing) return
    if (this.clients.length >= this.size) return

    this.replenishing = true
    let failures = 0
    let lastError: Error | undefined
    try {
      while (this.clients.length < this.size && !this.isClosed()) {
        if (failures >= REPLENISH_MAX_ATTEMPTS) break

        try {
          await this.createClient()
          lastError = undefined
          continue
        } catch (err) {
          lastError = err as Error
          failures++
          if (this.isClosed()) break
          // Log only the first failure of this round; the rest is summarised.
          if (failures === 1) {
            console.error(
              `[SSHPool] Failed to create replacement connection: ${lastError.message}`
            )
          }
          if (failures >= REPLENISH_MAX_ATTEMPTS) break

          const delay = Math.min(
            CONNECTION_RETRY_DELAY_MS * 2 ** (failures - 1),
            REPLENISH_MAX_DELAY_MS
          )
          await this.sleep(delay)
        }
      }
    } finally {
      this.replenishing = false
    }

    if (lastError && failures >= REPLENISH_MAX_ATTEMPTS && !this.isClosed()) {
      console.error(
        `[SSHPool] giving up replenishing after ${failures} attempts: ${lastError.message}`
      )
    }
  }

  private async replenishOne(): Promise<void> {
    if (this.isClosed() || this.status === "failed") return
    if (this.clients.length >= this.size) return
    try {
      await this.createClient()
    } catch (err) {
      if (this.isClosed()) return
      console.error(
        `[SSHPool] Failed to replace connection: ${(err as Error).message}`
      )
    }
  }

  private pingClient(client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Health check ping timeout"))
      }, HEALTH_CHECK_TIMEOUT_MS)

      client.exec("echo __SSH_HEALTH_CHECK__", (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }

        let output = ""
        const cleanup = () => clearTimeout(timer)

        stream
          .on("data", (data: Buffer) => {
            output += data.toString("utf-8")
          })
          .on("close", () => {
            cleanup()
            if (output.trim() === "__SSH_HEALTH_CHECK__") {
              resolve()
            } else {
              reject(new Error("Health check ping response invalid"))
            }
          })
          .on("error", (err: Error) => {
            cleanup()
            reject(err)
          })
      })
    })
  }

  async acquire(): Promise<Client> {
    if (this.isClosed()) throw new Error("Connection pool destroyed")

    await this.ready
    if (this.isClosed()) throw new Error("Connection pool destroyed")

    // Opportunistically replenish if pool is undersized
    if (this.clients.length < this.size) {
      this.replenish().catch(() => {})
    }

    const free = this.clients.find((c) => !this.busy.has(c))
    if (free) {
      this.busy.add(free)
      return free
    }

    return new Promise<Client>((resolve, reject) => {
      if (this.isClosed()) {
        reject(new Error("Connection pool closed"))
        return
      }
      this.queue.push({ resolve, reject })
    })
  }

  release(client: Client): void {
    this.busy.delete(client)
    this.processQueue()
  }

  /** Evict a problematic connection and trigger replacement. */
  evictAndReplace(client: Client): void {
    this.removeClient(client)
    client.end()
    this.replenishOne().catch(() => {})
  }

  private discardClients(): void {
    for (const client of this.clients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    this.clients = []
    this.busy.clear()
  }

  /** Cancel connections still handshaking so close() does not hang. */
  private cancelPendingConnects(): void {
    const pending = Array.from(this.pendingConnects)
    this.pendingConnects.clear()
    for (const p of pending) {
      try {
        p.cancel()
      } catch {
        /* ignore */
      }
    }
  }

  async close(): Promise<void> {
    if (this.isClosed()) return
    this.status = "closed"

    this.stopHealthCheck()
    this.cancelSleep()
    this.cancelPendingConnects()
    this.discardClients()
    this.rejectQueue(new Error("Connection pool closed"))
  }
}

export async function createSSHPool(config: RemoteConfig): Promise<SSHPool> {
  const commandPoolSize = parseInt(process.env.REMOTE_POOL_COMMAND_SIZE || "3", 10)
  const filePoolSize = parseInt(process.env.REMOTE_POOL_FILE_SIZE || "2", 10)
  const staggerMs = parseInt(process.env.REMOTE_POOL_STAGGER_MS || "0", 10)
  const commandPool = new ConnectionPool(config, commandPoolSize, staggerMs)
  const filePool = new ConnectionPool(config, filePoolSize, staggerMs)

  // Setup sudo askpass on remote if needed
  let sudoAskpassPath: string | undefined
  try {
    await Promise.all([commandPool.ready, filePool.ready])

    if (config.sudoPassword) {
      const mktempResult = await execOnPool(
        commandPool,
        "mktemp /tmp/.opencode_sudo_askpass_XXXXXX"
      )
      sudoAskpassPath = mktempResult.stdout.trim()
      const escaped = config.sudoPassword.replace(/'/g, "'\"'\"'")
      await execOnPool(
        commandPool,
        `cat > ${quoteShell(sudoAskpassPath)} << 'EOF'\n#!/bin/sh\necho '${escaped}'\nEOF\nchmod 700 ${quoteShell(sudoAskpassPath)}`
      )
    }
  } catch (err) {
    // Startup failed: never leak the pools that did come up (sockets + timers).
    if (sudoAskpassPath) {
      await execOnPool(commandPool, `rm -f ${quoteShell(sudoAskpassPath)}`).catch(
        () => {}
      )
    }
    await commandPool.close().catch(() => {})
    await filePool.close().catch(() => {})
    throw err
  }

  let closed = false
  return {
    async exec(command, options = {}) {
      let shellCommand = command
      if (options.cwd) {
        shellCommand = `cd ${quoteShell(options.cwd)} && ${command}`
      }
      if (sudoAskpassPath && shellCommand.includes("sudo ")) {
        shellCommand = `SUDO_ASKPASS=${quoteShell(sudoAskpassPath)} ${shellCommand.replace(
          /\bsudo\b/g,
          "sudo -A"
        )}`
      }
      return execOnPool(commandPool, shellCommand, options.timeout)
    },

    async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
      const client = await filePool.acquire()
      try {
        return await new Promise<T>((resolve, reject) => {
          client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
            if (err) {
              reject(err)
              return
            }
            fn(sftp)
              .then((result) => {
                sftp.end()
                resolve(result)
              })
              .catch((err) => {
                sftp.end()
                reject(err)
              })
          })
        })
      } finally {
        filePool.release(client)
      }
    },

    getSudoAskpassPath(): string | undefined {
      return sudoAskpassPath
    },

    async close() {
      if (closed) return
      closed = true
      if (sudoAskpassPath) {
        await execOnPool(commandPool, `rm -f ${quoteShell(sudoAskpassPath)}`).catch(
          () => {}
        )
      }
      await Promise.all([commandPool.close(), filePool.close()])
    },
  }
}

async function execOnPool(
  pool: ConnectionPool,
  command: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt < 2; attempt++) {
    const client = await pool.acquire()
    try {
      return await execOnClient(client, command, timeoutMs)
    } catch (err) {
      lastError = err as Error
      const isConnError = isConnectionError(lastError)

      if (isConnError) {
        console.log(
          `[SSHPool] Connection error on attempt ${attempt + 1}: ${lastError.message}`
        )
        pool.evictAndReplace(client)
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
          continue
        }
      }

      throw lastError
    } finally {
      pool.release(client)
    }
  }

  throw lastError!
}

async function execOnClient(
  client: Client,
  command: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let killed = false

    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            if (!killed) {
              killed = true
              reject(new Error(`Remote Code: SSH exec timeout after ${timeoutMs}ms`))
            }
          }, timeoutMs)
        : undefined

    client.exec(command, (err: Error | undefined, stream: any) => {
      if (err) {
        if (timer) clearTimeout(timer)
        reject(err)
        return
      }

      stream
        .on("data", (data: Buffer) => {
          stdout += data.toString("utf-8")
        })
        .stderr.on("data", (data: Buffer) => {
          stderr += data.toString("utf-8")
        })
        .on("close", (code: number, signal: string) => {
          if (timer) clearTimeout(timer)
          if (killed) return
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
          })
        })
        .on("error", (err: Error) => {
          if (timer) clearTimeout(timer)
          if (killed) return
          reject(err)
        })
    })
  })
}

function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return (
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotconn") ||
    msg.includes("broken pipe") ||
    msg.includes("no response from server") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("network") ||
    msg.includes("disconnected")
  )
}

import { quoteShell } from "./shell-quote.js"

/**
 * Build ssh2 algorithms config from OpenSSH -o options.
 * CentOS 6 and other legacy systems need ssh-rsa (SHA-1) enabled.
 */
function buildAlgorithms(extraOptions: string[]): any {
  const serverHostKey = [
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "rsa-sha2-512",
    "rsa-sha2-256",
    "ssh-rsa",
  ]

  // Parse HostKeyAlgorithms from extraOptions
  // Format: extraOptions = ["-o", "HostKeyAlgorithms=+ssh-rsa", ...]
  for (let i = 0; i < extraOptions.length; i++) {
    const opt = extraOptions[i]
    if (opt.startsWith("HostKeyAlgorithms=")) {
      const value = opt.slice("HostKeyAlgorithms=".length)
      if (value.startsWith("+")) {
        const algo = value.slice(1)
        if (!serverHostKey.includes(algo)) {
          serverHostKey.push(algo)
        }
      } else {
        // Replace entire list
        return { serverHostKey: value.split(",") }
      }
    }
  }

  return { serverHostKey }
}
