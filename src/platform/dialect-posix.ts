/**
 * POSIX sh/bash dialect (DESIGN-V3 §6.1) — behaviour identical to V2's
 * `ssh-pool.ts:493-495`, just moved out of the transport layer.
 *
 * We deliberately do NOT wrap the script in `bash -lc`: the remote default shell
 * is already the user's login shell, and forcing `-lc` would rewrite PATH and
 * break exactly the environment the user configured.
 */
import { quoteShell } from "../shell-quote.js"
import type { ExecOptions, RemoteDialect, StagedScript } from "./dialect.js"

export function createPosixDialect(): RemoteDialect {
  return {
    id: "posix-sh",
    shellName: "bash",

    async buildCommand(script: string, opts: ExecOptions = {}): Promise<StagedScript> {
      // Single-quoted cwd + `cd && script` is the whole dialect.
      const command = opts.cwd ? `cd ${quoteShell(opts.cwd)} && ${script}` : script
      return { command }
    },

    decode(buf: Buffer): string {
      return buf.toString("utf-8")
    },

    promptHint(): string {
      return ""
    },
  }
}
