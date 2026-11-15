import path from "node:path"
import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { createRemoteBackend } from "./backend.js"
import { loadConfig, isWithinActivateIn } from "./config.js"
import { RuntimeRouter } from "./runtime-router.js"
import { RemoteRuntime, RuntimeTargetSchema, type RuntimeConnectInput, type RuntimeSessionInput, type RuntimeStatus } from "./rpc.js"
import type { PluginContext } from "./v2-bridge.js"

type Backend = Awaited<ReturnType<typeof createRemoteBackend>>
const NAMES = ["shell", "glob", "grep", "read", "write", "edit", "patch"]
const MARKER = "runtime/session/"

export async function setupRuntime(ctx: PluginContext) {
  if (["ssh", "sshCommand", "ssh-command", "host"].some(key => ctx.options[key])) {
    throw new Error("Use runtime mode without a configured ssh/host, or omit runtime for legacy mode")
  }
  const router = new RuntimeRouter<Backend>(async (sessionID, remote) => {
    if (remote) await ctx.storage.set(MARKER + sessionID, true)
    else await ctx.storage.remove(MARKER + sessionID)
  })
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: MARKER, ...(after ? { after } : {}) })
    for (const entry of page.entries) router.restore(entry.key.slice(MARKER.length))
    after = page.next
  } while (after)
  const registrations: { dispose(): Promise<void> }[] = []
  const events = new AbortController()
  let eventTask: Promise<void> | undefined
  const native = new Set<string>()
  try {
    registrations.push(await ctx.tool.transform(editor => {
      native.clear()
      const snapshot = router.snapshot()
      for (const name of NAMES) {
        const original = editor.get(name)
        if (!original) continue // Builtins may arrive after setup; transforms replay.
        native.add(name)
        editor.update(name, tool => {
          tool.execute = (input, call) => router.route(snapshot, call.sessionID,
            () => original.execute(input, call),
            async backend => {
              const remote = backend.tools.find(candidate => candidate.name === name)!
              const args = { ...(input as Record<string, unknown>) }
              if (["read", "write", "edit"].includes(name)) args.filePath = args.path ?? args.filePath
              if (name === "shell") {
                if (args.background) throw new Error("Remote background shell execution is not supported")
                args.description ??= "Remote command"
              }
              if (name === "grep") {
                if (args.literal) args.pattern = String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                if (args.caseSensitive === false) args.pattern = "(?i)" + args.pattern
              }
              return remote.execute(args, call)
            })
        })
      }
    }))
    registrations.push(await ctx.session.hook("context", async event => {
      const phase = router.status(event.sessionID)
      if (phase === "local") return
      const backend = router.connection(event.sessionID)
      if (backend) {
        await backend.context(event)
        for (const tool of backend.tools) {
          // Keep native input contracts/decoding; only execution and descriptions change.
          if (event.tools[tool.name]) event.tools[tool.name].description = tool.description
        }
      } else event.system.push({ type: "text", text: `Remote target is ${phase}. File and shell tools are blocked until reconnect or explicit disconnect.` })
      // A child session has its own target; do not let delegation silently run locally.
      delete event.tools.subagent
    }))
    registrations.push(await ctx.tool.hook("execute.before", event => {
      if (event.tool === "subagent" && router.status(event.sessionID) !== "local") {
        throw new Error("Subagents require a separate explicit remote connection; delegation from remote sessions is disabled")
      }
    }))

    async function session(input: RuntimeSessionInput) {
      const value = await ctx.session.get({ sessionID: input.sessionID })
      if (path.resolve(value.location.directory) !== path.resolve(ctx.location.directory)) {
        throw new Error("Session belongs to another location; call the RPC at that location")
      }
      return value.id
    }
    function status(sessionID: string): RuntimeStatus {
      const backend = router.connection(sessionID)
      return { sessionID, phase: router.status(sessionID), ...(backend ? {
        workdir: backend.workdir, platform: backend.platform, host: backend.host, port: backend.port, user: backend.user,
      } : {}) }
    }
    const api = {
      status: async (input: RuntimeSessionInput) => status(await session(input)),
      connect: async (input: RuntimeConnectInput) => {
        const id = await session(input)
        try {
          await router.connect(id, async () => {
            // Refresh before checking: builtin registration can complete after setup.
            await ctx.tool.reload()
            await ctx.tool.list()
            if (NAMES.some(name => !native.has(name))) throw new Error("Host does not expose all seven native executors; runtime routing is unavailable")
            const config = loadConfig({ ...ctx.options, ...input.target })
            if (!config) throw new Error("A runtime ssh or host target is required")
            if (config.activateIn.length > 0 && !isWithinActivateIn(config.activateIn, ctx.location.directory)) throw new Error("Location is outside activateIn")
            // The auth feature is independent. Never silently ignore this credential selector.
            if (input.target.agentSocket !== undefined && !("agentSocket" in config)) {
              throw new Error("agentSocket requires the agent-socket authentication feature")
            }
            config.mirrorRoot = path.join(config.mirrorRoot, "runtime", createHash("sha256").update(id).digest("hex"), randomUUID())
            try {
              const backend = await createRemoteBackend(ctx, config)
              return { ...backend, close: async () => {
                await backend.close()
                await fs.rm(config.mirrorRoot, { recursive: true, force: true })
              } }
            } catch (error) {
              await fs.rm(config.mirrorRoot, { recursive: true, force: true })
              throw error
            }
          })
          return status(id)
        } finally { await ctx.tool.reload() }
      },
      disconnect: async (input: RuntimeSessionInput) => {
        const id = await session(input)
        try { await router.disconnect(id); return status(id) }
        finally { await ctx.tool.reload() }
      },
    }
    registrations.push(await ctx.rpc.register(RemoteRuntime, {
      connect: async (input, context) => {
        try { return await api.connect(input as RuntimeConnectInput) }
        catch (error) { return context.error("operation_failed", (error as Error).message, {}) }
      },
      status: async (input, context) => {
        try { return await api.status(input as RuntimeSessionInput) }
        catch (error) { return context.error("operation_failed", (error as Error).message, {}) }
      },
      disconnect: async (input, context) => {
        try { return await api.disconnect(input as RuntimeSessionInput) }
        catch (error) { return context.error("operation_failed", (error as Error).message, {}) }
      },
    }))
    registrations.push(await ctx.command.transform(editor => {
      editor.add({
        name: "remote", description: "Remote target: connect <JSON target> | status | disconnect",
        async execute({ sessionID, prompt }) {
          const text = prompt.text.trim()
          const action = text.split(/\s+/, 1)[0]
          let result: RuntimeStatus
          if (action === "connect") {
            const target = JSON.parse(text.slice(action.length).trim())
            if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("Expected a JSON target object")
            for (const [key, value] of Object.entries(target)) {
              if (!Object.hasOwn(RuntimeTargetSchema.properties, key)) throw new Error(`Unknown target field: ${key}`)
              if (key === "port" ? typeof value !== "number" : typeof value !== "string") throw new Error(`Invalid target field: ${key}`)
            }
            // Passwords should use RPC, not persisted command text.
            if ("password" in target) throw new Error("Pass passwords through the runtime RPC, not slash-command text")
            result = await api.connect({ sessionID, target })
          } else if (action === "status") result = await api.status({ sessionID })
          else if (action === "disconnect") result = await api.disconnect({ sessionID })
          else throw new Error('Usage: /remote connect {"ssh":"user@host","workdir":"~/project"} | status | disconnect')
          await ctx.session.synthetic({ sessionID, text: `Remote Code: ${JSON.stringify(result)}`, resume: false })
        },
      })
    }))
    eventTask = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["session.deleted"], signal: events.signal })) {
        await router.forget(event.data.sessionID)
        await ctx.tool.reload()
      }
    })().catch(error => {
      if (!events.signal.aborted) console.error(`[remote-code] runtime cleanup event failed: ${(error as Error).message}`)
    })
    return async () => {
      // Closing first makes every previously captured wrapper fail closed.
      events.abort()
      await eventTask
      await router.close()
      for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    }
  } catch (error) {
    events.abort()
    await eventTask
    await router.close()
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }
}
