/**
 * test/dialect.mjs — RemoteDialect conformance (no SSH needed).
 *
 * Covers DESIGN-V3 §6.1 (posix `cd <quoted> && script`), §6.2 (the validated
 * PS 5.1 template, `-EncodedCommand`, the `-File` staging fallback and its
 * cleanup), §6.3 (UTF-8 with GB18030 fallback) and the CLIXML scrubbing that
 * PowerShell's error stream forces on us.
 *
 *   npm run build && node test/dialect.mjs      # exit 0 = all PASS
 */

import assert from "node:assert/strict"

import { createDialect, ENCODED_COMMAND_MAX_LENGTH } from "../dist/platform/dialect.js"

let pass = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS ${name}`)
  } catch (err) {
    failures.push({ name, message: (err && err.message) || String(err) })
    console.log(`FAIL ${name}`)
    console.error(`     ${((err && err.message) || String(err)).split("\n").join("\n     ")}`)
  }
}

/** Collect upload/unlink calls so the cleanup contract can be asserted. */
function fakeDeps() {
  const uploads = []
  const unlinks = []
  return {
    uploads,
    unlinks,
    deps: {
      async upload(remotePath, content) {
        uploads.push({ remotePath, content })
      },
      async unlink(remotePath) {
        unlinks.push(remotePath)
      },
    },
  }
}

/** Decode the base64 argument of `-EncodedCommand` back to the PS script text. */
function decodeEncodedCommand(command) {
  const m = command.match(/-EncodedCommand\s+(\S+)\s*$/)
  assert.ok(m, `command does not end with -EncodedCommand <base64>: ${command.slice(0, 120)}…`)
  return Buffer.from(m[1], "base64").toString("utf16le")
}

const PS_PREFIX = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
const PWSH_PREFIX = "pwsh.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
const LONG_SCRIPT = "Write-Output 'padding line for the staging path'\n".repeat(400)

// ===========================================================================
// POSIX
// ===========================================================================
const posix = createDialect("posix")

await check("posix: id/shellName/promptHint", () => {
  assert.equal(posix.id, "posix-sh")
  assert.equal(posix.shellName, "bash")
  assert.equal(posix.promptHint(), "")
})

await check("posix buildCommand: no cwd -> script untouched", async () => {
  const staged = await posix.buildCommand("echo hi && pwd")
  assert.equal(staged.command, "echo hi && pwd")
  assert.equal(staged.cleanup, undefined)
})

await check("posix buildCommand: safe cwd is not quoted", async () => {
  const staged = await posix.buildCommand("ls -la", { cwd: "/home/x" })
  assert.equal(staged.command, "cd /home/x && ls -la")
})

await check("posix buildCommand: quoteShell handles spaces and single quotes", async () => {
  const staged = await posix.buildCommand("ls -la", { cwd: "/home/it's proj" })
  assert.equal(staged.command, `cd '/home/it'"'"'s proj' && ls -la`)
})

await check("posix decode: UTF-8 passthrough", () => {
  const text = "hello 中文 ok\r\n"
  assert.equal(posix.decode(Buffer.from(text, "utf-8")), text)
})

// ===========================================================================
// WINDOWS
// ===========================================================================
const windows = createDialect("windows")

await check("windows: id/shellName/promptHint", () => {
  assert.equal(windows.id, "windows-powershell")
  assert.equal(windows.shellName, "PowerShell 5.1")
  const hint = windows.promptHint()
  assert.ok(hint.length > 0, "expected a non-empty prompt hint")
  assert.ok(/PowerShell/.test(hint))
  assert.ok(/&&/.test(hint))
  assert.ok(/Get-ChildItem/.test(hint))
})

await check("windows buildCommand: powershell.exe + -EncodedCommand prefix", async () => {
  const staged = await windows.buildCommand("Write-Output hi", { cwd: "C:/Users/x" })
  assert.ok(staged.command.startsWith(PS_PREFIX), `unexpected command: ${staged.command.slice(0, 80)}`)
  assert.equal(staged.cleanup, undefined)
})

await check("windows buildCommand: payload is base64(UTF-16LE(template)) with cwd line", async () => {
  const staged = await windows.buildCommand("Write-Output hi", { cwd: "C:/Users/x" })
  const script = decodeEncodedCommand(staged.command)

  // template shape (§6.2)
  assert.ok(script.startsWith("$ProgressPreference='SilentlyContinue'\n"), "missing ProgressPreference header")
  assert.ok(script.includes("$ErrorActionPreference='Stop'\n"))
  assert.ok(script.includes("[Console]::OutputEncoding=[Text.Encoding]::UTF8\n"))
  assert.ok(script.includes("$OutputEncoding=[Text.Encoding]::UTF8\n"))
  assert.ok(script.includes("$global:LASTEXITCODE=0\n"))
  assert.ok(script.includes("try {\n"))
  assert.ok(script.includes("  Set-Location -LiteralPath 'C:/Users/x'\n"), "missing Set-Location line")
  assert.ok(script.includes("Write-Output hi\n"), "payload must be embedded verbatim")
  assert.ok(script.includes("} catch {\n"))
  assert.ok(script.includes("[Console]::Error.WriteLine($_.Exception.Message)\n"))
  assert.ok(script.includes("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n"))
  // Measured on PS 5.1: a trailing `exit 0` discards unflushed host output
  // (bare `Get-Location` prints nothing when redirected), so the success path
  // must end *without* an explicit exit.
  assert.ok(!/\nexit 0\s*$/.test(script), "template must NOT end with an explicit `exit 0`")
  assert.ok(script.trimEnd().endsWith("if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"))
})

await check("windows buildCommand: no cwd -> no Set-Location line", async () => {
  const staged = await windows.buildCommand("Get-Location")
  const script = decodeEncodedCommand(staged.command)
  assert.ok(!script.includes("Set-Location"), "Set-Location must only appear when cwd is given")
  assert.ok(script.includes("Get-Location\n"))
})

await check("windows buildCommand: single quote in cwd is doubled", async () => {
  const staged = await windows.buildCommand("Get-Location", { cwd: "C:/Users/o'brien" })
  const script = decodeEncodedCommand(staged.command)
  assert.ok(script.includes("Set-Location -LiteralPath 'C:/Users/o''brien'\n"))
})

await check("windows buildCommand: pwsh:true uses pwsh.exe", async () => {
  const d = createDialect("windows", { pwsh: true })
  assert.equal(d.shellName, "PowerShell 7 (pwsh)")
  const staged = await d.buildCommand("Get-Location", { cwd: "C:/Users/x" })
  assert.ok(staged.command.startsWith(PWSH_PREFIX), `unexpected command: ${staged.command.slice(0, 80)}`)
})

await check("windows buildCommand: short script stays on -EncodedCommand", async () => {
  const staged = await windows.buildCommand("Write-Output hi", { cwd: "C:/Users/x" })
  const base64 = staged.command.slice(staged.command.lastIndexOf(" ") + 1)
  assert.ok(base64.length <= ENCODED_COMMAND_MAX_LENGTH)
  assert.ok(!staged.command.includes("-File"))
})

await check("windows buildCommand: long script is staged with -File and cleaned up", async () => {
  const { uploads, unlinks, deps } = fakeDeps()
  const d = createDialect("windows", { deps, tempDir: "C:/Users/x/AppData/Local/Temp" })
  const staged = await d.buildCommand(LONG_SCRIPT, { cwd: "C:/Users/x" })

  assert.ok(!staged.command.includes("-EncodedCommand"), "long payload must not use -EncodedCommand")
  assert.ok(/ -File "[^"]+\.ps1"$/.test(staged.command), `unexpected staged command: ${staged.command}`)

  assert.equal(uploads.length, 1, "expected exactly one upload")
  const { remotePath, content } = uploads[0]
  assert.equal(remotePath.startsWith("C:/Users/x/AppData/Local/Temp/oc-"), true)
  assert.ok(/^C:\/Users\/x\/AppData\/Local\/Temp\/oc-[0-9a-f]{8}\.ps1$/.test(remotePath), remotePath)
  assert.ok(staged.command.includes(remotePath), "command must reference the staged path")
  // UTF-8 with BOM, or PS 5.1 would read the file as CP936.
  assert.equal(content.charCodeAt(0), 0xfeff)
  assert.ok(content.includes("Set-Location -LiteralPath 'C:/Users/x'"))

  assert.equal(typeof staged.cleanup, "function", "staged script must expose cleanup()")
  await staged.cleanup()
  assert.deepEqual(unlinks, [remotePath])
})

await check("windows buildCommand: cleanup() swallows unlink errors", async () => {
  const deps = {
    async upload() {},
    async unlink() {
      throw new Error("permission denied")
    },
  }
  const d = createDialect("windows", { deps, tempDir: "C:/T" })
  const staged = await d.buildCommand(LONG_SCRIPT)
  await staged.cleanup() // must not reject
})

await check("windows buildCommand: staging without deps throws", async () => {
  const d = createDialect("windows", { tempDir: "C:/T" })
  await assert.rejects(
    () => d.buildCommand(LONG_SCRIPT),
    /requires both "deps" \(upload\/unlink\) and "tempDir"/
  )
})

await check("windows buildCommand: staging without tempDir throws", async () => {
  const { deps } = fakeDeps()
  const d = createDialect("windows", { deps })
  await assert.rejects(
    () => d.buildCommand(LONG_SCRIPT),
    /requires both "deps" \(upload\/unlink\) and "tempDir"/
  )
})

await check("windows decode: plain UTF-8 passthrough", () => {
  const text = "Get-ChildItem output\r\n中文文件名.txt\r\n"
  assert.equal(windows.decode(Buffer.from(text, "utf-8")), text)
})

await check("windows decode: GBK bytes fall back to gb18030", () => {
  // 0xD6 0xD0 0xCE 0xC4 == "中文" in CP936/GBK, invalid as UTF-8.
  const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  assert.ok(windows.decode(buf) !== buf.toString("utf-8"), "GBK input must not be decoded as UTF-8")
  assert.equal(windows.decode(buf), "中文")
})

await check("windows decode: CLIXML block is stripped", () => {
  const clixml =
    '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
    '<S S="Error">boom_x000D__x000A_</S></Objs>\r\n'
  assert.equal(windows.decode(Buffer.from(clixml, "utf-8")), "")
})

await check("windows decode: CLIXML after real output keeps the real output", () => {
  const mixed =
    "real line\r\n" +
    '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">boom_x000D__x000A_</S></Objs>\r\n'
  assert.equal(windows.decode(Buffer.from(mixed, "utf-8")), "real line\r\n")
})

await check("windows decode: CLIXML newline escapes are translated", () => {
  assert.equal(windows.decode(Buffer.from("a_x000D__x000A_b", "utf-8")), "a\nb")
  assert.equal(windows.decode(Buffer.from("a_x000A_b", "utf-8")), "a\nb")
})

// ===========================================================================
// factory dispatch
// ===========================================================================
await check("createDialect dispatches on kind", () => {
  assert.equal(createDialect("posix").id, "posix-sh")
  assert.equal(createDialect("windows").id, "windows-powershell")
  assert.equal(createDialect("windows").promptHint().length > 0, true)
  assert.equal(createDialect("posix").promptHint(), "")
})

// ===========================================================================
// summary
// ===========================================================================
console.log("")
console.log(`PASS=${pass} FAIL=${failures.length}`)
if (failures.length > 0) {
  console.error("RESULT: FAIL")
  for (const f of failures) console.error(`  - ${f.name}: ${f.message}`)
}
process.exit(failures.length ? 1 : 0)
