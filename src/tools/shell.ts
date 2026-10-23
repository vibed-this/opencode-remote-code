/**
 * `shell` — the ONE tool allowed to touch the remote shell (DESIGN-V3 §3.2, §7.3).
 *
 * Everything platform-specific about running a command lives in
 * `ctx.dialect.buildCommand()`: POSIX turns the script into `cd <cwd> && <script>`,
 * PowerShell embeds it in its `-EncodedCommand` template (and may stage an
 * over-long script to a remote `.ps1` file, handing back a `cleanup` callback).
 * This file therefore contains no quoting, no `cd … && …` and no `if (windows)`.
 *
 * Two things this file *does* own:
 *
 * 1. **Cleanup always runs.** A staged PowerShell script is deleted in a
 *    `finally`, so a timeout or a transport error cannot leave a temp file
 *    behind (§3.5 "远端不留痕").
 * 2. **The exit code is trusted.** V2 carried a stderr-heuristic workaround for
 *    OpenSSH 5.3, which did not reliably propagate exit codes (§12 deletion
 *    list). V3 requires OpenSSH >= 8.0, so the channel is authoritative and the
 *    heuristics are gone: `"command not found"` on stderr no longer fabricates a
 *    failure, and a non-zero exit is reported verbatim.
 */
import type { ExecResult } from "../platform/dialect.js"
import type { RemoteToolDefinition } from "../v2-bridge.js"
import { resolveRemotePath, type RemoteToolContext } from "./context.js"

/**
 * Banner noise an SSH server/agent can still print on the command stream. None
 * of it is produced by the user's command, and showing it to the model only
 * invites it to "fix" a non-problem.
 */
const SSH_NOISE_PATTERNS = [
  /^Warning: Permanently added .* to the list of known hosts\.\s*$/,
  /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\.\s*$/,
  /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\.\s*$/,
  /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html\s*$/,
  /^Connection to .* closed\.\s*$/,
]

function filterSshNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !SSH_NOISE_PATTERNS.some((p) => p.test(line)))
    .join("\n")
}

export function createShellTool(ctx: RemoteToolContext): RemoteToolDefinition {
  // The real shell, in the model's own language ("bash", "PowerShell 5.1",
  // "PowerShell 7 (pwsh)"). DESIGN §10: the description must name it, otherwise
  // the model writes `ls -la` against a PowerShell remote.
  const shellName = ctx.dialect.shellName

  return {
    name: "shell",
    description: `Execute commands in ${shellName} on the remote machine.`,

    input: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: `The ${shellName} command or script to execute`,
        },
        description: {
          type: "string",
          description: "A short description of what the command does",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (optional)",
        },
        workdir: {
          type: "string",
          description:
            "The absolute path on the remote machine to run the command in. Defaults to the workspace root.",
        },
      },
      required: ["command", "description"],
      additionalProperties: false,
    },

    async execute(args, _call) {
      const command = typeof args.command === "string" ? args.command : ""
      if (command.trim() === "") {
        throw new Error('Remote Code: shell requires a non-empty "command" string')
      }

      // 1. Timeout: default from config, rejects negative / non-finite values
      //    instead of letting `setTimeout` silently fire after 1 ms.
      const rawTimeout = args.timeout ?? ctx.limits.shellTimeout
      if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout)) {
        throw new Error(
          `Remote Code: "timeout" must be a finite number of milliseconds, got ${JSON.stringify(args.timeout)}`
        )
      }
      const timeout = rawTimeout
      if (timeout < 0) {
        throw new Error("Timeout must be a non-negative number")
      }

      // 2. Working directory. A model-supplied relative path resolves against
      //    the workspace root; the canonical remote form is what the dialect
      //    interpolates (and what the model sees back in errors).
      const cwd = args.workdir ? resolveRemotePath(ctx, args.workdir) : ctx.remoteRoot

      // 3. Script -> one SSH exec command string (quoting / encoding / staging).
      const staged = await ctx.dialect.buildCommand(command, { cwd, timeout })

      // 4. Run it. `cleanup` is in a `finally` on purpose: when exec throws
      //    (timeout, dropped connection) the staged temp script must still go.
      let result: ExecResult
      try {
        result = await ctx.pool.exec(staged.command, {
          timeout,
          decode: (buf) => ctx.dialect.decode(buf),
        })
      } finally {
        await staged.cleanup?.()
      }

      const stdout = result.stdout ?? ""
      const stderr = filterSshNoise(result.stderr ?? "")

      // 5. A timeout is not an exit code: report it as its own failure.
      if (result.timedOut === true) {
        const parts: string[] = []
        if (stdout.trim() !== "") parts.push(stdout)
        if (stderr.trim() !== "") parts.push(`stderr:\n${stderr}`)
        const detail = parts.length > 0 ? `\n\n${parts.join("\n\n")}` : ""
        throw new Error(`Command timed out after ${timeout}ms${detail}`)
      }

      // 6. Non-zero exit. Both streams are included (empty parts omitted) so the
      //    model can see *why* without a second round trip.
      if (result.exitCode !== 0) {
        const parts: string[] = []
        if (stdout.trim() !== "") parts.push(stdout)
        if (stderr.trim() !== "") parts.push(`stderr:\n${stderr}`)
        const detail = parts.length > 0 ? parts.join("\n\n") : "(no output)"
        throw new Error(
          `Command failed with exit code ${result.exitCode}:\n${command}\n\n${detail}`
        )
      }

      // 7. Success: stdout, plus stderr only when the command wrote something
      //    there (warnings are information, not failure).
      let output = stdout
      if (stderr.trim() !== "") {
        output += `\n\nstderr:\n${stderr}`
      }
      if (output.trim() === "") {
        output = "(no output)"
      }

      return {
        content: output,
        metadata: {
          title: args.description || "shell",
          exit: result.exitCode,
          description: args.description,
          stderr: stderr.trim() !== "" ? stderr : undefined,
        },
      }
    },
  }
}
