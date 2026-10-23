/**
 * Diagnostic logging (DESIGN-V3 §9.2: `options.debug` drives this).
 *
 * The log lives at `~/.opencode/remote-code-debug.log` and is append-only. Two
 * hard rules, both learned the hard way in V2 (`src/index.ts` used to inline
 * this):
 *
 * 1. Never throw. The plugin must not break the host because a log directory is
 *    read-only or a disk is full — every fs error is swallowed.
 * 2. When disabled, `log()` is a no-op returning an already-resolved promise, so
 *    the dormant path (no `ssh` configured) writes nothing at all.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG_DIR = path.join(os.homedir(), ".opencode")
const LOG_FILE = path.join(LOG_DIR, "remote-code-debug.log")

export interface Logger {
  /** Absolute path of the log file (useful in error messages / docs). */
  readonly file: string
  log(msg: string): Promise<void>
  /** Toggled on once remote mode is confirmed active. */
  enabled: boolean
}

export function createLogger(enabled: boolean): Logger {
  /** `~/.opencode` does not necessarily exist yet (custom mirror, first run). */
  let dirReady = false

  return {
    file: LOG_FILE,
    enabled,

    async log(msg: string): Promise<void> {
      if (!enabled) return
      if (!dirReady) {
        // Without this the append fails with ENOENT and the log silently stays
        // empty — the worst possible failure mode for a debugging aid.
        await fs.promises.mkdir(LOG_DIR, { recursive: true }).catch(() => {})
        dirReady = true
      }
      const line = `[${new Date().toISOString()}] ${msg}\n`
      await fs.promises.appendFile(LOG_FILE, line).catch(() => {})
    },
  }
}
