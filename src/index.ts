import fs from "fs/promises"
import { Plugin } from "@opencode/plugin"
import type { SFTPWrapper } from "ssh2"

import { describeRemoteConfig, isWithinActivateIn, loadConfig } from "./config.js"
import { createLogger } from "./log.js"
import { createDialect } from "./platform/dialect.js"
import { detectRemote } from "./platform/detect.js"
import { createRemoteFs } from "./remote/fs.js"
import { PathMapper } from "./mirror/path-mapper.js"
import { ManifestManager } from "./mirror/manifest.js"
import { SyncEngine } from "./mirror/sync.js"
import { createSSHPool, type SSHPool } from "./ssh-pool.js"
import { createEditTool } from "./tools/edit.js"
import { createGlobTool } from "./tools/glob.js"
import { createGrepTool } from "./tools/grep.js"
import { createPatchTool } from "./tools/patch.js"
import { createReadTool } from "./tools/read.js"
import { createShellTool } from "./tools/shell.js"
import { createWriteTool } from "./tools/write.js"
import type { RemoteToolContext } from "./tools/context.js"
import { buildRemoteSystemPrompt } from "./system-prompt.js"
import {
  createPermissionGateway,
  type PluginContext,
  type RemoteToolDefinition,
} from "./v2-bridge.js"

/** Cap on the remote AGENTS.md we are willing to pull into the system prompt. */
const MAX_AGENTS_MD_BYTES = 256 * 1024

export default Plugin.define({
  id: "remote-code",

  async setup(ctx: PluginContext) {
    // ---------------------------------------------------------------------
    // 1. Config (DESIGN-V3 §9). Nothing is written and no connection is
    //    opened until we know remote mode is configured.
    // ---------------------------------------------------------------------
    let config
    try {
      config = loadConfig(ctx.options as Record<string, unknown>)
    } catch (error) {
      // Misconfigured: stay dormant instead of crashing the host, but make the
      // reason loud — the plugin must never break local OpenCode usage.
      console.error(`[remote-code] ${(error as Error).message}`)
      return
    }

    if (!config) {
      // Dormant: no SSH, no tool registration, no files written.
      return
    }

    const logger = createLogger(config.debug)
    await logger.log("Plugin loaded")
    await logger.log(describeRemoteConfig(config))

    // ---------------------------------------------------------------------
    // 1b. cwd scope (`activateIn`, see README "local and remote in one config").
    //     The seven tools are NAME OVERRIDES, so an active plugin means the
    //     session has no local file access at all. Scoping activation to the
    //     launcher's session directory is what lets one global config give you
    //     remote tools there and OpenCode's native tools everywhere else.
    // ---------------------------------------------------------------------
    if (config.activateIn.length > 0) {
      const directory = ctx.location?.directory
      if (!isWithinActivateIn(config.activateIn, directory)) {
        await logger.log(
          `dormant: session directory ${directory ?? "(unknown)"} is outside activateIn=${config.activateIn.join(",")}`
        )
        return
      }
      await logger.log(`activated in ${directory}`)
    }

    // ---------------------------------------------------------------------
    // 2. Transport + platform detection (DESIGN-V3 §6.4).
    //    Detection runs over SFTP only: one `realpath(".")` answers both
    //    "is this Windows?" and "what is the login home?".
    // ---------------------------------------------------------------------
    let sshPool: SSHPool | undefined
    try {
      sshPool = await createSSHPool(config)

      const detected = await detectRemote(
        {
          realpath: (p) => sftpRealpath(sshPool!, p),
          exec: (command, opts) => sshPool!.exec(command, { timeout: opts?.timeout }),
        },
        {
          platform: config.platform,
          workdir: config.workdir,
          shell: config.shell,
          timeout: config.timeout,
        }
      )

      await logger.log(
        `detected platform=${detected.kind} shell=${detected.shell} workdir=${detected.workdir} home=${detected.home}`
      )

      const remoteFs = createRemoteFs(sshPool, detected.pathOps)

      const mapper = new PathMapper({
        mirrorRoot: config.mirrorRoot,
        user: config.user,
        host: config.host,
        port: config.port,
        remoteRoot: detected.workdir,
        ops: detected.pathOps,
      })

      // The mirror is wiped on every start (correctness over cache): stale local
      // copies must never be confused with remote state. The manifest lives
      // inside the namespace, so the wipe has to happen before it is loaded.
      await fs.rm(mapper.mirrorNamespace, { recursive: true, force: true }).catch(() => {})

      const manifest = new ManifestManager(mapper, (m) => void logger.log(m))
      await manifest.load()
      const sync = new SyncEngine(remoteFs, mapper, manifest, (m) => void logger.log(m))

      // The only place the shell dialect is needed: staged scripts for oversized
      // PowerShell payloads go through SFTP, so `deps` is wired here.
      const dialect = createDialect(detected.kind, {
        pathOps: detected.pathOps,
        pwsh: detected.pwshAvailable,
        shell: detected.shell,
        tempDir: detected.tempDir,
        deps: {
          upload: async (remotePath, content) => {
            await remoteFs.writeFile(remotePath, Buffer.from(content, "utf8"))
          },
          unlink: (remotePath) => remoteFs.unlink(remotePath),
        },
      })

      const permission = createPermissionGateway(ctx.permission)

      const toolContext: RemoteToolContext = {
        pool: sshPool,
        ops: detected.pathOps,
        remoteRoot: detected.workdir,
        dialect,
        fs: remoteFs,
        mapper,
        sync,
        permission,
        limits: { ...config.limits, shellTimeout: config.timeout },
        ignore: config.ignore,
        log: (m) => void logger.log(m),
      }

      // ---------------------------------------------------------------------
      // 3. Tools: V2 builtin names, registered via the tool editor.
      // ---------------------------------------------------------------------
      const tools: RemoteToolDefinition[] = [
        createShellTool(toolContext),
        createGlobTool(toolContext),
        createGrepTool(toolContext),
        createReadTool(toolContext),
        createWriteTool(toolContext),
        createEditTool(toolContext),
        createPatchTool(toolContext),
      ]

      const toolRegistration = await ctx.tool.transform((editor) => {
        for (const tool of tools) editor.add(tool)
      })
      await logger.log(`registered tools: ${tools.map((t) => t.name).join(", ")}`)

      // ---------------------------------------------------------------------
      // 4. System prompt replacement (V2 "context" hook). Every remote read
      //    happens once, here, and is cached for the session.
      // ---------------------------------------------------------------------
      const agentsPath = detected.pathOps.join(detected.workdir, "AGENTS.md")
      const isGitRepo =
        (await remoteFs.stat(detected.pathOps.join(detected.workdir, ".git")).catch(
          () => null
        )) !== null

      let agentsMd: string | undefined
      try {
        const stat = await remoteFs.stat(agentsPath)
        if (stat && stat.file && stat.size <= MAX_AGENTS_MD_BYTES) {
          const buf = await remoteFs.readFile(agentsPath)
          if (!buf.includes(0)) agentsMd = dialect.decode(buf).trim() || undefined
        }
      } catch (error) {
        await logger.log(`AGENTS.md not loaded: ${(error as Error).message}`)
      }

      await logger.log(
        `prompt context: git=${isGitRepo} agentsMd=${agentsMd ? "yes" : "no"} shell=${dialect.shellName}`
      )

      const hookRegistration = await ctx.session.hook("context", async (event) => {
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
            remoteRoot: detected.workdir,
            platform: detected.kind,
            shellName: dialect.shellName,
            shellHint: dialect.promptHint(),
            isGitRepo,
            agentsMd,
          },
          current
        )

        if (titleGeneratorIdx !== -1) {
          // Preserve the title generator, replace everything else.
          const titleGenerator = event.system[titleGeneratorIdx]
          event.system.length = 0
          event.system.push(titleGenerator, ...remoteSystem.map(toSystemPart))
        } else {
          event.system.length = 0
          event.system.push(...remoteSystem.map(toSystemPart))
        }

        await logger.log(`context hook done. system parts=${event.system.length}`)
      })

      // ---------------------------------------------------------------------
      // 5. Cleanup (replaces V1's `session.deleted` handler).
      // ---------------------------------------------------------------------
      return async () => {
        await logger.log("Plugin cleanup: saving manifest and closing SSH pool")
        await hookRegistration.dispose().catch(() => {})
        await toolRegistration.dispose().catch(() => {})
        await manifest.save().catch(() => {})
        await sshPool?.close().catch(() => {})
      }
    } catch (error) {
      // Runtime setup failed (unreachable host, bad workdir, ...): never leave a
      // half-wired plugin behind, and never take OpenCode down with us.
      console.error(`[remote-code] setup failed: ${(error as Error).message}`)
      await logger.log(`setup failed: ${(error as Error).message}`)
      await sshPool?.close().catch(() => {})
      return
    }
  },
})

function toSystemPart(text: string): { type: "text"; text: string } {
  return { type: "text", text }
}

/** `realpath` over a pooled SFTP session — the probe detection needs first. */
function sftpRealpath(pool: SSHPool, remotePath: string): Promise<string> {
  return pool.withSftp(
    (sftp: SFTPWrapper) =>
      new Promise<string>((resolve, reject) => {
        sftp.realpath(remotePath, (err: Error | undefined | null, resolved: string) => {
          if (err) reject(err)
          else resolve(resolved)
        })
      })
  )
}
