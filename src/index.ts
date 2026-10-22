import fs from "fs/promises"
import os from "os"
import path from "path"
import { Plugin } from "@opencode/plugin"
import { describeConfigSources, loadConfig } from "./config.js"
import { ManifestManager } from "./manifest.js"
import { PathMapper } from "./path-mapper.js"
import { createSSHPool } from "./ssh-pool.js"
import { SyncEngine } from "./sync-engine.js"
import { createBashTool } from "./tools/bash.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createGrepTool } from "./tools/grep.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createWriteTool } from "./tools/write.js"
import { buildRemoteSystemPrompt } from "./remote-system-prompt.js"
import {
  createPermissionGateway,
  type PluginContext,
  type RemoteToolDefinition,
} from "./v2-bridge.js"

const LOG_FILE = path.join(os.homedir(), ".opencode", "remote-code-debug.log")

/** Debug logging is opt-in (REMOTE_CODE_DEBUG=1) unless remote mode is active. */
let debugEnabled = process.env.REMOTE_CODE_DEBUG === "1"

async function logDebug(msg: string) {
  if (!debugEnabled) return
  const line = `[${new Date().toISOString()}] ${msg}\n`
  await fs.appendFile(LOG_FILE, line).catch(() => {})
}

export default Plugin.define({
  id: "remote-code",

  async setup(ctx: PluginContext) {
    // ---------------------------------------------------------------------
    // 1. Config. V2 reads `ctx.options` first (env vars / argv only as a
    //    compatibility fallback, see config.ts). Nothing is written and no
    //    connection is opened until we know remote mode is configured.
    // ---------------------------------------------------------------------
    let config
    try {
      config = loadConfig(ctx.options as Record<string, unknown>)
    } catch (error) {
      // Misconfigured (e.g. SSH string given but workdir missing): stay
      // dormant instead of crashing the host, but make the reason loud.
      console.error(`[remote-code] ${(error as Error).message}`)
      await logDebug(`config error: ${(error as Error).message}`)
      return
    }

    if (!config) {
      // Dormant: OpenCode keeps running in local mode. No side effects.
      await logDebug("Config is null - remote mode not activated")
      return
    }

    debugEnabled = true
    await logDebug("Plugin loaded")
    await logDebug(`config sources: ${describeConfigSources(ctx.options as Record<string, unknown>)}`)
    await logDebug(`Config loaded: host=${config.host}, workdir=${config.remoteWorkdir}`)

    // ---------------------------------------------------------------------
    // 2. Local mirror + SSH pool (unchanged behaviour from V1)
    // ---------------------------------------------------------------------
    const pathMapper = new PathMapper(config)
    const manifest = new ManifestManager(pathMapper)
    await manifest.load()

    const sshPool = await createSSHPool(config)
    const syncEngine = new SyncEngine(config, pathMapper, manifest, sshPool)

    // Clean and recreate mirror base to avoid stale files from previous sessions
    try {
      await fs.rm(pathMapper.mirrorBase, { recursive: true, force: true })
    } catch {}
    await mkdirp(pathMapper.mirrorBase)

    // Reset manifest since we're starting fresh
    ;(manifest as any).manifest = { remote_root: pathMapper.remoteRoot, files: {} }

    // Probe remote environment
    let remotePlatform = "linux"
    let isGitRepo = false
    try {
      const uname = await sshPool.exec("uname -s", { timeout: 5_000 })
      remotePlatform = uname.stdout.trim().toLowerCase()
    } catch {}
    try {
      const gitCheck = await sshPool.exec(
        `git -C "${config.remoteWorkdir}" rev-parse --git-dir 2>/dev/null && echo GIT || echo NO_GIT`,
        { timeout: 5_000 }
      )
      isGitRepo = gitCheck.stdout.trim().includes("GIT")
    } catch {}

    const remoteWorkdir = config.remoteWorkdir

    // ---------------------------------------------------------------------
    // 3. Tools (V2: plain objects + JSON Schema, registered via transform)
    // ---------------------------------------------------------------------
    const permission = createPermissionGateway(ctx.permission)

    const tools: RemoteToolDefinition[] = [
      createBashTool(sshPool, remoteWorkdir),
      createGlobTool(config, sshPool),
      createGrepTool(config, sshPool),
      createReadTool(pathMapper, syncEngine, sshPool, permission),
      createWriteTool(pathMapper, syncEngine, permission),
      createEditTool(pathMapper, syncEngine, permission),
      createPatchTool(config, pathMapper, syncEngine, sshPool, permission),
    ]

    const toolRegistration = await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        // V2 builtin names: shell / read / write / edit / patch / glob / grep
        editor.add(tool)
      }
    })
    await logDebug(`registered tools: ${tools.map((t) => t.name).join(", ")}`)

    // ---------------------------------------------------------------------
    // 4. System prompt replacement (V2: session "context" hook)
    // ---------------------------------------------------------------------
    const hookRegistration = await ctx.session.hook("context", async (event) => {
      // `event.system` is an array of SystemPart objects ({ type, text }).
      const current = event.system.map((part) => part.text)
      const titleGeneratorIdx = current.findIndex((text) =>
        text.includes("You are a title generator")
      )

      // Auxiliary title-generation requests carry only the title prompt;
      // leave them untouched (they never call tools).
      if (titleGeneratorIdx !== -1 && event.system.length === 1) return

      const remoteSystem = await buildRemoteSystemPrompt(
        {
          modelID: event.model?.id ? String(event.model.id) : "default",
          remoteWorkdir,
          remotePlatform,
          isGitRepo,
          sshPool,
        },
        current
      )

      if (titleGeneratorIdx !== -1) {
        // Preserve the title generator, replace everything else (V1 semantics).
        const titleGenerator = event.system[titleGeneratorIdx]
        event.system.length = 0
        event.system.push(titleGenerator, ...remoteSystem.map(toSystemPart))
      } else {
        event.system.length = 0
        event.system.push(...remoteSystem.map(toSystemPart))
      }

      await logDebug(`context hook done. system parts=${event.system.length}`)
    })

    // ---------------------------------------------------------------------
    // 5. Cleanup (replaces V1's `session.deleted` event handler)
    // ---------------------------------------------------------------------
    return async () => {
      await logDebug("Plugin cleanup: saving manifest and closing SSH pool")
      await hookRegistration.dispose().catch(() => {})
      await toolRegistration.dispose().catch(() => {})
      await manifest.save().catch(() => {})
      await sshPool.close().catch(() => {})
    }
  },
})

function toSystemPart(text: string): { type: "text"; text: string } {
  return { type: "text", text }
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import("fs/promises")
  await mkdir(dir, { recursive: true }).catch(() => {})
}
