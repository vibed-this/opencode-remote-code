/**
 * Windows / PowerShell dialect (DESIGN-V3 §6.2, validated on real PS 5.1).
 *
 * Two hard problems this file solves:
 *
 * 1. **Quoting hell.** The script is never spliced into a command line as text.
 *    It is embedded in a fixed template and shipped as
 *    `-EncodedCommand <base64(UTF-16LE(template))>`, which survives cmd.exe, the
 *    SSH channel and PowerShell's own parser without a single escape rule. The
 *    only interpolated value is `cwd`, and there we double `'` (PS rule).
 *
 * 2. **stderr pollution.** An uncaught `Write-Error` makes PS serialise the
 *    whole error into CLIXML (`#< CLIXML <Objs …>`), including source lines.
 *    The template catches everything and writes the plain message to the real
 *    stderr via `[Console]::Error`. `decode()` still scrubs CLIXML defensively
 *    for output produced by other means.
 *
 * Exit codes: measured — `powershell -Command "cmd /c exit 3"` exits **1**; the
 * trailing `exit $LASTEXITCODE` is what makes the real code survive.
 *
 * The success path deliberately ends *without* `exit 0`: on PS 5.1 a trailing
 * `exit` discards output that the format engine has not flushed yet (a bare
 * `Get-Location` prints nothing when stdout is redirected — measured).
 */
import { randomBytes } from "node:crypto"

import { windowsPathOps, type RemotePathOps } from "./path.js"
import type { DialectCreateOptions, ExecOptions, RemoteDialect, StagedScript } from "./dialect.js"

/**
 * Base64 length above which we stop using `-EncodedCommand`. Windows `exec`
 * runs through `cmd.exe /c`, whose command line is capped at ~8191 characters;
 * UTF-16 + base64 inflates the script ~2.67x. 6000 leaves ample headroom for
 * the fixed flags and the rest of the command.
 */
export const ENCODED_COMMAND_MAX_LENGTH = 6000

/** PS 5.1 flags shared by the inline and the staged form. */
const PS_FLAGS = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass"

const HEADER = [
  "$ProgressPreference='SilentlyContinue'",
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
  "$OutputEncoding=[Text.Encoding]::UTF8",
  "$global:LASTEXITCODE=0",
  "try {",
]

const FOOTER = [
  "} catch {",
  "  [Console]::Error.WriteLine($_.Exception.Message)",
  "  exit 1",
  "}",
  // NOTE: no trailing `exit 0` on purpose. Measured on PS 5.1: a script that ends
  // with `exit 0` drops pending host output — a bare `Get-Location` prints nothing
  // when redirected, because `exit` tears the host down before the formatter
  // flushes. Ending without `exit` lets the process exit 0 naturally and keeps the
  // output; the failure branch above still propagates native exit codes.
  "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
]

const PROMPT_HINT = [
  "The remote shell is PowerShell. Prefer native cmdlets (Get-ChildItem, Get-Content,",
  "Select-String, Test-Path, New-Item); `&&` is unavailable, use `;` to chain commands.",
  "Quote paths with single quotes. Paths may use forward slashes.",
].join("\n")

/** PowerShell single-quoted string escaping: `'` -> `''`. */
function quotePs(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The validated PS 5.1 template. The payload is embedded **verbatim**: adding
 * indentation would break here-strings, whose terminator must start at column 0.
 */
function buildTemplate(script: string, cwd?: string): string {
  const lines = [...HEADER]
  if (cwd) {
    lines.push(`  Set-Location -LiteralPath ${quotePs(cwd)}`)
  }
  lines.push(script)
  lines.push(...FOOTER)
  return `${lines.join("\n")}\n`
}

/** `"pwsh.exe"` when PS7 is available, otherwise `"powershell.exe"` (PS 5.1, present on Win10+). */
function resolveExecutable(opts: DialectCreateOptions): string {
  const declared = (opts.shell ?? "").trim().toLowerCase()
  if (declared) {
    if (declared.includes("pwsh")) return "pwsh.exe"
    if (declared.includes("powershell")) return "powershell.exe"
  }
  return opts.pwsh === true ? "pwsh.exe" : "powershell.exe"
}

/**
 * Remove CLIXML noise (PowerShell's stderr serialisation) and undo its
 * `_x000D__x000A_` escapes so the model sees the plain error text.
 */
function stripClixml(text: string): string {
  if (text === "") return text
  let out = text
  // "#< CLIXML" banner line (can follow earlier stderr output, hence the /m).
  out = out.replace(/^[ \t]*#<[ \t]*CLIXML[^\r\n]*(?:\r?\n)?/gm, "")
  // "<Objs …>…</Objs>" payload, plus the remainder if it was truncated.
  out = out.replace(/<Objs\b[\s\S]*?<\/Objs>[^\r\n]*(?:\r?\n)?/g, "")
  if (out.includes("<Objs")) {
    out = out.slice(0, out.indexOf("<Objs"))
  }
  // CLIXML escapes newline/CR characters rather than emitting them literally.
  out = out
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/_x000D_/g, "\n")
    .replace(/_x000A_/g, "\n")
  return out
}

function countReplacement(s: string): number {
  const m = s.match(/\uFFFD/g)
  return m ? m.length : 0
}

export function createWindowsDialect(opts: DialectCreateOptions = {}): RemoteDialect {
  const pathOps: RemotePathOps = opts.pathOps ?? windowsPathOps
  const exe = resolveExecutable(opts)

  return {
    id: "windows-powershell",
    shellName: opts.pwsh === true || exe === "pwsh.exe" ? "PowerShell 7 (pwsh)" : "PowerShell 5.1",

    async buildCommand(script: string, execOpts: ExecOptions = {}): Promise<StagedScript> {
      const cwd = execOpts.cwd ? pathOps.normalize(execOpts.cwd) : undefined
      const template = buildTemplate(script, cwd)
      const base64 = Buffer.from(template, "utf16le").toString("base64")

      if (base64.length <= ENCODED_COMMAND_MAX_LENGTH) {
        return { command: `${exe} ${PS_FLAGS} -EncodedCommand ${base64}` }
      }

      // ---- staging path: script goes to %TEMP%/oc-<hex>.ps1 over SFTP ----
      const deps = opts.deps
      const tempDir = opts.tempDir ? pathOps.normalize(opts.tempDir) : ""
      if (!deps || tempDir === "") {
        throw new Error(
          `PowerShell script exceeds the ${ENCODED_COMMAND_MAX_LENGTH}-char -EncodedCommand budget ` +
            `(${base64.length} chars) and cannot be staged: ` +
            `createDialect() requires both "deps" (upload/unlink) and "tempDir" for the -File fallback.`
        )
      }

      const remotePath = pathOps.join(tempDir, `oc-${randomBytes(4).toString("hex")}.ps1`)
      // Windows PowerShell needs the BOM to read a .ps1 as UTF-8 (otherwise CP936).
      await deps.upload(remotePath, `\uFEFF${template}`)

      return {
        command: `${exe} ${PS_FLAGS} -File "${remotePath}"`,
        cleanup: async () => {
          try {
            await deps.unlink(remotePath)
          } catch {
            // Best effort: a leftover temp script must never fail a tool call.
          }
        },
      }
    },

    decode(buf: Buffer): string {
      const utf8 = new TextDecoder("utf-8").decode(buf)
      let text = utf8
      if (utf8.includes("\uFFFD")) {
        // A Chinese Windows emits native-program output as CP936, whole stream.
        try {
          const gb = new TextDecoder("gb18030").decode(buf)
          if (countReplacement(gb) < countReplacement(utf8)) text = gb
        } catch {
          // gb18030 not available in this Node build: keep the UTF-8 result.
        }
      }
      return stripClixml(text)
    },

    promptHint(): string {
      return PROMPT_HINT
    },
  }
}
