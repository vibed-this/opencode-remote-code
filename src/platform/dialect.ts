/**
 * RemoteDialect — the only abstraction that knows how to turn a *script* into
 * an SSH exec command string (DESIGN-V3 §6).
 *
 * Only the `shell` tool ever touches a remote shell, so all quoting/encoding
 * differences between POSIX shells and PowerShell die here. Everything else in
 * the plugin talks to `RemoteFs` (SFTP) exclusively.
 */
import type { PlatformKind, RemotePathOps } from "./path.js"
import { createPosixDialect } from "./dialect-posix.js"
import { createWindowsDialect } from "./dialect-windows.js"

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}

export interface ExecOptions {
  cwd?: string
  timeout?: number
}

export interface StagedScript {
  /** The command string to hand to `ssh2.exec()`. */
  command: string
  /** Must be awaited after the command ran (temp script cleanup). */
  cleanup?: () => Promise<void>
}

export interface DialectDeps {
  /** Upload `content` (already UTF-8 with BOM) to the absolute remote path `remotePath`. */
  upload(remotePath: string, content: string): Promise<void>
  unlink(remotePath: string): Promise<void>
}

export interface RemoteDialect {
  readonly id: "posix-sh" | "windows-powershell"
  /** Human name for tool descriptions / system prompt: "bash" | "PowerShell 5.1" | "PowerShell 7 (pwsh)". */
  readonly shellName: string
  buildCommand(script: string, opts?: ExecOptions): Promise<StagedScript>
  /** Remote byte stream -> text. */
  decode(buf: Buffer): string
  /** Extra instructions for the system prompt (empty string for posix). */
  promptHint(): string
}

/** Options accepted by `createDialect()`. `tempDir` is windows-only. */
export interface DialectCreateOptions {
  pathOps?: RemotePathOps
  deps?: DialectDeps
  /** Use PowerShell 7 (`pwsh.exe`) instead of Windows PowerShell 5.1. */
  pwsh?: boolean
  /** Explicit shell name/executable ("pwsh.exe", "powershell.exe", ...). */
  shell?: string
  /** Remote scratch dir for staged scripts (windows only, e.g. "<home>/AppData/Local/Temp"). */
  tempDir?: string
}

/**
 * Windows `exec` ultimately goes through `cmd.exe /c`, whose command line is
 * capped at ~8191 chars. Base64 of UTF-16LE inflates the script ~2.67x, so
 * anything above this budget is staged to a `.ps1` file over SFTP instead.
 * Declared in `dialect-windows.ts` and re-exported here (see that file's note).
 */
export { ENCODED_COMMAND_MAX_LENGTH } from "./dialect-windows.js"

export function createDialect(kind: PlatformKind, opts: DialectCreateOptions = {}): RemoteDialect {
  return kind === "windows" ? createWindowsDialect(opts) : createPosixDialect()
}
