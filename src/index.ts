import { Plugin } from "@opencode/plugin"
import { loadConfig, isWithinActivateIn } from "./config.js"
import { createRemoteBackend } from "./backend.js"
import { setupRuntime } from "./runtime.js"

export default Plugin.define({
  id: "remote-code",
  async setup(ctx) {
    // Explicit opt-in keeps the legacy no-target path entirely dormant.
    if (ctx.options.runtime === true) return setupRuntime(ctx)
    let config
    try {
      config = loadConfig(ctx.options as Record<string, unknown>)
    } catch (error) {
      console.error(`[remote-code] ${(error as Error).message}`)
      return
    }
    if (!config || (config.activateIn.length > 0 && !isWithinActivateIn(config.activateIn, ctx.location?.directory))) return
    let backend: Awaited<ReturnType<typeof createRemoteBackend>> | undefined
    const registrations: { dispose(): Promise<void> }[] = []
    try {
      backend = await createRemoteBackend(ctx, config)
      const connected = backend
      registrations.push(await ctx.tool.transform(editor => {
        for (const tool of connected.tools) editor.add(tool)
      }))
      registrations.push(await ctx.session.hook("context", connected.context))
    } catch (error) {
      for (const registration of registrations) await registration.dispose()
      await backend?.close()
      console.error(`[remote-code] setup failed: ${(error as Error).message}`)
      return
    }
    return async () => {
      for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
      await backend?.close()
    }
  },
})
