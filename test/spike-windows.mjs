/**
 * spike-windows.mjs — end-to-end proof that the **Windows transport** works.
 *
 * DESIGN-V3 §11.1 / §13 P0: the dev machine *is* Windows with a real PowerShell
 * 5.1, so the mock SSH server can emulate a Windows remote faithfully:
 *
 *   - exec   -> the plugin's real command shape is decoded and run by real
 *               powershell.exe (`-EncodedCommand` and `-File`)
 *   - SFTP   -> virtual `/C:/Users/test/proj/...` paths over a real directory
 *   - realpath(".") -> `/C:/Users/test/proj`
 *
 * This script needs **nothing from src/**: it builds the PowerShell command by
 * hand exactly like the plugin's windows dialect does (DESIGN-V3 §6.2) and then
 * checks quoting, base64/UTF-16LE, exit codes, CLIXML, UTF-8 output, long-script
 * staging and the SFTP path space.
 *
 * Usage:   node test/spike-windows.mjs      (MOCK_SSH_VERBOSE=1 logs every request)
 * Exit:    0 when every check passed, 1 otherwise.
 *
 * NOTE about exec vs. SFTP: PowerShell cannot be "chrooted", so exec scripts see
 * the **real** filesystem. The virtual `/C:/Users/test/proj` tree exists only on
 * the SFTP side (plus the `-File` lookup, which the mock resolves through its
 * virtual map). The exec checks therefore use the mock's real root directory as
 * their workdir — that is the same directory `/C:/Users/test/proj` maps to.
 */

import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import path from "node:path"
import ssh2 from "ssh2"

import {
  startMockServer,
  WINDOWS_PROJECT_PATH,
  WINDOWS_PROJECT_SFTP,
  WINDOWS_STAGING_RELATIVE,
  WINDOWS_STAGING_SFTP,
} from "./mock-ssh-server.mjs"

const { Client } = ssh2

const WORKDIR = WINDOWS_PROJECT_PATH // "C:/Users/test/proj" — what the plugin will use
const STAGED_SFTP = `${WINDOWS_STAGING_SFTP}/oc-spike.ps1`
const B64_LIMIT = 6000

/* -------------------------------------------------------------------------- */
/* ssh2 helpers                                                               */
/* -------------------------------------------------------------------------- */

function connect({ port, user, password, host = "127.0.0.1" }) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const timer = setTimeout(() => {
      client.end()
      reject(new Error("connect timeout"))
    }, 15_000)
    client
      .on("ready", () => {
        clearTimeout(timer)
        resolve(client)
      })
      .on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    client.connect({ host, port, username: user, password, readyTimeout: 15_000 })
  })
}

/** exec: returns raw buffers *and* decoded text (utf8 non-fatal). */
function execOn(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      const out = []
      const errOut = []
      stream
        .on("data", (d) => out.push(d))
        .on("close", (code) => {
          const stdoutBuf = Buffer.concat(out)
          const stderrBuf = Buffer.concat(errOut)
          resolve({
            stdoutBuf,
            stderrBuf,
            stdout: stdoutBuf.toString("utf8"),
            stderr: stderrBuf.toString("utf8"),
            code,
          })
        })
        .on("error", reject)
      stream.stderr.on("data", (d) => errOut.push(d))
    })
  })
}

const call = (obj, method, ...args) =>
  new Promise((resolve, reject) => {
    obj[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })

const sftpOf = (client) =>
  new Promise((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))))

/* -------------------------------------------------------------------------- */
/* the plugin's windows command shape (DESIGN-V3 §6.2)                        */
/* -------------------------------------------------------------------------- */

/** PowerShell script template from DESIGN-V3 §6.2, verbatim. */
function buildScript(payload, workdir = WORKDIR) {
  const wd = String(workdir).replace(/'/g, "''") // PS single-quote escaping
  const body = String(payload)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
  return [
    `$ProgressPreference='SilentlyContinue'`,
    `$ErrorActionPreference='Stop'`,
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8`,
    `$OutputEncoding=[Text.Encoding]::UTF8`,
    `$global:LASTEXITCODE=0`,
    `try {`,
    `  Set-Location -LiteralPath '${wd}'`,
    body,
    `} catch {`,
    `  [Console]::Error.WriteLine($_.Exception.Message)`,
    `  exit 1`,
    `}`,
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
    `exit 0`,
    ``,
  ].join("\n")
}

/** script -> `powershell.exe ... -EncodedCommand <base64(UTF-16LE)>` */
function encodedCommand(script) {
  const b64 = Buffer.from(script, "utf16le").toString("base64")
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`
  return { command, b64 }
}

/** staged path -> `powershell.exe ... -File "<path>"` */
const PS_FILE_PREFIX = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `
function fileCommand(remotePs1) {
  return `${PS_FILE_PREFIX}"${remotePs1}"`
}

/** Run a payload through the plugin's command shape and return exec output. */
let EXEC_WORKDIR = WORKDIR
function runPayload(client, payload, { workdir = EXEC_WORKDIR } = {}) {
  const { command, b64 } = encodedCommand(buildScript(payload, workdir))
  return execOn(client, command).then((res) => ({ ...res, b64Length: b64.length }))
}

/* -------------------------------------------------------------------------- */
/* small utilities                                                            */
/* -------------------------------------------------------------------------- */

const toPosix = (p) => String(p).replace(/\\/g, "/")
const squash = (p) => toPosix(p).toLowerCase().replace(/\/+$/, "")

/** Strict UTF-8 decode: throws instead of substituting U+FFFD. */
function decodeStrictUtf8(buf) {
  return new TextDecoder("utf-8", { fatal: true }).decode(buf)
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const withBom = (text) => Buffer.concat([BOM, Buffer.from(text, "utf8")])

/* -------------------------------------------------------------------------- */
/* runner                                                                     */
/* -------------------------------------------------------------------------- */

const results = []
let counter = 0

async function check(name, fn) {
  counter++
  const label = `${counter}. ${name}`
  try {
    await fn()
    results.push({ label, status: "pass" })
    console.log(`PASS ${label}`)
  } catch (err) {
    const detail = (err && err.message) || String(err)
    results.push({ label, status: "fail", detail })
    console.log(`FAIL ${label}`)
    console.log(`     ${detail}`)
  }
}

const note = (text) => console.log(`     NOTE ${text}`)

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = Date.now()
  const createdReal = [] // real files created inside the mock root, for cleanup

  console.log("spike-windows: Windows transport end-to-end (mock SSH server, dialect=windows)")
  console.log("")

  const server = await startMockServer({ dialect: "windows" })
  const root = server.rootDir
  const stagingReal = path.join(root, ...WINDOWS_STAGING_RELATIVE.split("/"))
  console.log(`mock ssh server listening on ${server.host}:${server.port} (dialect=${server.dialect})`)
  console.log(`exec powershell   = ${server.powershellPath}`)
  console.log(`sftp virtual root = ${server.projectSftp}  ->  ${root}`)
  console.log(`drive overflow    = ${server.driveDir}`)
  console.log(`ps1 staging       = ${server.stagingDir}`)
  console.log("")

  let client = null
  let sftp = null
  let failure = null

  // exec runs real PowerShell against the real filesystem, so its workdir is the
  // directory `/C:/Users/test/proj` maps to (PowerShell cannot be chrooted).
  EXEC_WORKDIR = toPosix(root)

  try {
    client = await connect({ port: server.port, user: server.user, password: server.password })
    sftp = await sftpOf(client)

    /* ---------------------------- fixtures ------------------------------ */

    const listedName = "spike-listed.txt"
    const chineseName = "中文.txt"
    for (const name of [listedName, chineseName]) {
      const local = path.join(root, name)
      await fsp.writeFile(local, `fixture ${name}\n`, "utf8")
      createdReal.push(local)
    }

    /* ------------------------- 1. workdir + stdout ---------------------- */

    await check("exec: (Get-Location).Path is the workdir and Write-Output reaches stdout", async () => {
      const res = await runPayload(client, `(Get-Location).Path\nWrite-Output "spike-ok"`, {
        workdir: toPosix(root),
      })
      const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      assert.equal(res.code, 0, `exit code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
      assert.equal(squash(lines[0]), squash(root), `Get-Location printed ${JSON.stringify(lines[0])}, want ${toPosix(root)}`)
      assert.ok(lines.includes("spike-ok"), `stdout missing spike-ok: ${JSON.stringify(res.stdout)}`)
      assert.equal(res.stderr, "", `stderr should be clean, got ${JSON.stringify(res.stderr)}`)
    })
    note("bare `Get-Location` is NOT used here: in PS 5.1 its table output is dropped when the")
    note("script ends with `exit` (see test/README.md); `(Get-Location).Path` is reliable.")

    /* --------------------------- 2. Get-ChildItem ------------------------ */

    await check(`exec: Get-ChildItem -Name lists ${listedName}`, async () => {
      const res = await runPayload(client, `Get-ChildItem -Name`, { workdir: toPosix(root) })
      assert.equal(res.code, 0, `exit code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
      const names = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      assert.ok(names.includes(listedName), `listing ${JSON.stringify(names)} lacks ${listedName}`)
    })

    /* ------------------------- 3. clean stderr on error ------------------ */

    await check('exec: Write-Error "boom" -> stderr has "boom", no CLIXML, no source echo, exit 1', async () => {
      const res = await runPayload(client, `Write-Error "boom"`)
      assert.equal(res.code, 1, `expected exit code 1, got ${res.code}`)
      assert.match(res.stderr, /boom/, `stderr should contain "boom": ${JSON.stringify(res.stderr)}`)
      assert.ok(
        !res.stderr.includes("#< CLIXML"),
        `stderr must not be CLIXML-serialised, got ${JSON.stringify(res.stderr.slice(0, 300))}`
      )
      assert.ok(
        !res.stderr.includes("Write-Error"),
        `stderr must not echo the source line, got ${JSON.stringify(res.stderr)}`
      )
      assert.ok(!res.stdout.includes("boom"), `error text leaked to stdout: ${JSON.stringify(res.stdout)}`)
    })

    /* -------------------------- 4. exit code propagation ---------------- */

    await check("exec: native exit code propagates (`cmd /c exit 7` -> 7)", async () => {
      const res = await runPayload(client, `cmd /c exit 7`)
      assert.equal(res.code, 7, `expected exit code 7, got ${res.code} (stderr=${JSON.stringify(res.stderr)})`)
    })

    /* ----------------------------- 5. UTF-8 output ---------------------- */

    await check(`exec: Chinese filename (${chineseName}) survives as valid UTF-8`, async () => {
      const res = await runPayload(client, `Get-ChildItem -Name -Filter *.txt`, { workdir: toPosix(root) })
      assert.equal(res.code, 0, `exit code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
      const text = decodeStrictUtf8(res.stdoutBuf) // throws on invalid UTF-8
      assert.ok(text.includes(chineseName), `stdout lacks ${chineseName}: ${JSON.stringify(text)}`)
      assert.ok(!text.includes("\uFFFD"), `stdout contains U+FFFD (mojibake): ${JSON.stringify(text)}`)
    })

    /* -------------------------- 6. health check raw --------------------- */

    await check("exec: raw command line `echo __SSH_HEALTH_CHECK__` still works", async () => {
      const res = await execOn(client, "echo __SSH_HEALTH_CHECK__")
      assert.equal(res.code, 0, `exit code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
      assert.match(res.stdout, /__SSH_HEALTH_CHECK__/, `stdout=${JSON.stringify(res.stdout)}`)
    })

    /* --------------------- 7. long script via SFTP + -File -------------- */

    await check(`exec -File: long script (>${B64_LIMIT} b64 chars) staged at ${STAGED_SFTP} runs`, async () => {
      const payload = Array.from({ length: 300 }, (_, i) => `Write-Output "line ${i}"`).join("\n")
      const script = buildScript(payload, toPosix(root))
      const b64Length = encodedCommand(script).b64.length
      assert.ok(b64Length > B64_LIMIT, `payload too small to exercise the -File path (b64=${b64Length})`)

      // 1) staging dir exists and is writable over SFTP
      const stagingStat = await call(sftp, "stat", WINDOWS_STAGING_SFTP)
      assert.equal(stagingStat.isDirectory(), true, `${WINDOWS_STAGING_SFTP} should be a directory`)

      // 2) write the script as UTF-8 with BOM
      await call(sftp, "writeFile", STAGED_SFTP, withBom(script))
      const written = await fsp.readFile(path.join(stagingReal, "oc-spike.ps1"))
      assert.equal(written[0], 0xef, "staged .ps1 must start with a UTF-8 BOM")
      const onDisk = await call(sftp, "stat", STAGED_SFTP)
      assert.equal(onDisk.size, written.length, "staged .ps1 size mismatch")

      // 3) run it via -File (path form the plugin uses: bare `C:/...`, quoted)
      const res = await execOn(client, fileCommand(`${WORKDIR}/${WINDOWS_STAGING_RELATIVE}/oc-spike.ps1`))
      assert.equal(res.code, 0, `exit code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
      const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      assert.equal(lines.length >= 300, true, `expected >=300 lines, got ${lines.length}`)
      assert.ok(lines.includes("line 0"), `first line missing: ${JSON.stringify(lines.slice(0, 3))}`)
      assert.ok(lines.includes("line 299"), `last line missing: ${JSON.stringify(lines.slice(-3))}`)

      // 4) staged file is readable back and removable
      const back = await call(sftp, "readFile", STAGED_SFTP)
      assert.equal(back.length, written.length, "readFile round trip length mismatch")
      await call(sftp, "unlink", STAGED_SFTP)
      let gone = false
      try {
        await call(sftp, "stat", STAGED_SFTP)
      } catch {
        gone = true
      }
      assert.ok(gone, "staged .ps1 should be gone after unlink")
    })

    /* ------------------------------ 8. realpath ------------------------- */

    await check(`sftp: realpath(".") === ${WINDOWS_PROJECT_SFTP}`, async () => {
      assert.equal(await call(sftp, "realpath", "."), WINDOWS_PROJECT_SFTP)
      assert.equal(await call(sftp, "realpath", "/"), WINDOWS_PROJECT_SFTP)
      assert.equal(await call(sftp, "realpath", ""), WINDOWS_PROJECT_SFTP)
      assert.equal(await call(sftp, "realpath", WINDOWS_PROJECT_SFTP), WINDOWS_PROJECT_SFTP)
    })

    /* ------------------------------- 9. stat ---------------------------- */

    await check("sftp: stat works on the project root, a file, and the bare (no leading /) form", async () => {
      const rootStat = await call(sftp, "stat", WINDOWS_PROJECT_SFTP)
      assert.equal(rootStat.isDirectory(), true, "project root should be a directory")
      const fileStat = await call(sftp, "stat", `${WINDOWS_PROJECT_SFTP}/${listedName}`)
      assert.equal(fileStat.isFile(), true, `${listedName} should be a file`)
      const bareStat = await call(sftp, "stat", `${WORKDIR}/${listedName}`) // C:/Users/test/proj/...
      assert.equal(bareStat.size, fileStat.size, "bare form should resolve to the same file")
      assert.ok(fileStat.size > 0, "fixture should not be empty")
    })

    /* ------------------------------ 10. readdir ------------------------- */

    await check("sftp: readdir lists the entry written through SFTP", async () => {
      const name = "spike-dir-entry.txt"
      await call(sftp, "writeFile", `${WINDOWS_PROJECT_SFTP}/${name}`, "dir entry\n")
      createdReal.push(path.join(root, name))
      const list = await call(sftp, "readdir", WINDOWS_PROJECT_SFTP)
      const names = list.map((e) => e.filename)
      assert.ok(names.includes(name), `readdir ${JSON.stringify(names)} lacks ${name}`)
      const entry = list.find((e) => e.filename === name)
      assert.ok(entry.attrs && typeof entry.attrs.size === "number", "entry attrs missing")
      assert.ok(entry.longname.length > 0, "entry longname missing")
      await call(sftp, "unlink", `${WINDOWS_PROJECT_SFTP}/${name}`)
    })

    /* --------------------------- 11. write/read ------------------------- */

    await check("sftp: writeFile + readFile round trip is byte identical", async () => {
      const body = Buffer.from("line1\r\nline2 中文\r\nsha? *<>| chars are only local\r\n\0binary\0\r\n", "utf8")
      const remote = `${WINDOWS_PROJECT_SFTP}/spike-write.bin`
      createdReal.push(path.join(root, "spike-write.bin"))
      await call(sftp, "writeFile", remote, body)
      const back = await call(sftp, "readFile", remote)
      assert.equal(Buffer.compare(back, body), 0, "content differs after round trip")
      const st = await call(sftp, "stat", remote)
      assert.equal(st.size, body.length)
    })

    /* ------------------------------ 12. mkdir --------------------------- */

    await check("sftp: mkdir creates a directory under the project root", async () => {
      const remote = `${WINDOWS_PROJECT_SFTP}/spike-dir`
      createdReal.push(path.join(root, "spike-dir"))
      await call(sftp, "mkdir", remote)
      const st = await call(sftp, "stat", remote)
      assert.equal(st.isDirectory(), true, "mkdir + stat should report a directory")
      await call(sftp, "rmdir", remote)
    })

    /* ------------------------------ 13. unlink -------------------------- */

    await check("sftp: unlink removes a file", async () => {
      const remote = `${WINDOWS_PROJECT_SFTP}/spike-doomed.txt`
      await call(sftp, "writeFile", remote, "doomed\n")
      await call(sftp, "unlink", remote)
      let gone = false
      try {
        await call(sftp, "stat", remote)
      } catch (err) {
        gone = true
        assert.equal(err.code, 2, `expected NO_SUCH_FILE(2), got ${err.code}`)
      }
      assert.ok(gone, "file should be gone after unlink")
    })

    /* ------------------ 14. unrelated paths + traversal ----------------- */

    await check("sftp: unrelated /C:/... path maps under the drive sandbox", async () => {
      const remote = "/C:/Temp/spike-unrelated.txt"
      await call(sftp, "writeFile", remote, "outside the project\n")
      const back = (await call(sftp, "readFile", remote)).toString("utf8")
      assert.equal(back, "outside the project\n")
      const onDisk = path.join(server.driveDir, "C", "Temp", "spike-unrelated.txt")
      const st = await fsp.stat(onDisk)
      assert.equal(st.isFile(), true, `expected ${onDisk} to exist`)
      await fsp.rm(onDisk, { force: true })
      const dirStat = await call(sftp, "stat", "/C:/Temp")
      assert.equal(dirStat.isDirectory(), true, "/C:/Temp should be a directory")
    })

    await check("sftp: traversal above the virtual root is refused (PERMISSION_DENIED)", async () => {
      const before = server.stats.blockedPaths.length
      for (const bad of ["/C:/..", "/C:/../..", "/C:/../../../etc/passwd"]) {
        let error = null
        try {
          await call(sftp, "stat", bad)
        } catch (err) {
          error = err
        }
        assert.ok(error, `stat(${bad}) should fail`)
        assert.equal(error.code, 3, `expected PERMISSION_DENIED(3) for ${bad}, got ${error.code}`)
      }
      assert.ok(
        server.stats.blockedPaths.length > before,
        `server should record the attempts, got ${JSON.stringify(server.stats.blockedPaths)}`
      )
    })

    /* ------------------- 16. drive letter case + overflow ---------------- */

    await check("sftp: drive letter/segment case is folded, siblings of the project go to the drive sandbox", async () => {
      // case-insensitive match of the project root (Windows semantics)
      const lower = await call(sftp, "stat", `/c:/users/test/PROJ/${listedName}`)
      const canon = await call(sftp, "stat", `${WINDOWS_PROJECT_SFTP}/${listedName}`)
      assert.equal(lower.size, canon.size, "case-insensitive lookup should hit the same file")

      // a sibling that only *looks* like the project must NOT land inside it
      const remote = "/C:/Users/test/projx/overflow.txt"
      await call(sftp, "writeFile", remote, "overflow\n")
      const onDisk = path.join(server.driveDir, "C", "Users", "test", "projx", "overflow.txt")
      const viaSftp = (await call(sftp, "readFile", remote)).toString("utf8")
      assert.equal(viaSftp, "overflow\n")
      const text = await fsp.readFile(onDisk, "utf8")
      assert.equal(text, "overflow\n", `expected the file at ${onDisk}`)
      await call(sftp, "unlink", remote)
      await fsp.rm(onDisk, { force: true })
    })

    /* ------------------- 17. -File quoting / path forms ------------------ */

    await check("exec -File accepts both `C:/...` and `/C:/...` forms (quoted or bare)", async () => {
      const small = `oc-spike-small.ps1`
      const sftpPath = `${WINDOWS_STAGING_SFTP}/${small}`
      const script = buildScript(`Write-Output "small-file-ok"`, toPosix(root))
      await call(sftp, "writeFile", sftpPath, withBom(script))

      const forms = [
        `"${WORKDIR}/${WINDOWS_STAGING_RELATIVE}/${small}"`, // quoted, plugin style
        `${WORKDIR}/${WINDOWS_STAGING_RELATIVE}/${small}`, // bare
        `'${WINDOWS_PROJECT_SFTP}/${WINDOWS_STAGING_RELATIVE}/${small}'`, // quoted, SFTP style
        `${WINDOWS_PROJECT_SFTP}/${WINDOWS_STAGING_RELATIVE}/${small}`, // bare, SFTP style
      ]
      for (const form of forms) {
        const res = await execOn(client, `${PS_FILE_PREFIX}${form}`)
        assert.equal(res.code, 0, `-File ${form} -> code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
        assert.match(res.stdout, /small-file-ok/, `-File ${form} -> stdout=${JSON.stringify(res.stdout)}`)
      }
      await call(sftp, "unlink", sftpPath)
    })

    /* ------------- 18. optional exec path virtualization ----------------- */

    await check("exec: virtualExecPaths:true lets a script use the virtual project path", async () => {
      const virtualised = await startMockServer({ dialect: "windows", virtualExecPaths: true })
      let vClient = null
      let vSftp = null
      try {
        vClient = await connect({ port: virtualised.port, user: virtualised.user, password: virtualised.password })
        vSftp = await sftpOf(vClient)
        await call(vSftp, "writeFile", `${WINDOWS_PROJECT_SFTP}/spike-virtual.txt`, "virtual\n")

        // the payload hard-codes the *virtual* workdir, which only works because
        // the mock rewrites it to the real directory for the staged script
        const res = await runPayload(vClient, `(Get-Location).Path\nGet-ChildItem -Name`, {
          workdir: WORKDIR,
        })
        assert.equal(res.code, 0, `exit code ${res.code}, stderr=${JSON.stringify(res.stderr)}`)
        assert.ok(
          squash(res.stdout.split(/\r?\n/)[0]) === squash(virtualised.rootDir),
          `Get-Location printed ${JSON.stringify(res.stdout.split(/\r?\n/)[0])}, want the real dir ${toPosix(virtualised.rootDir)}`
        )
        assert.match(res.stdout, /spike-virtual\.txt/, `listing should contain the SFTP-written file: ${JSON.stringify(res.stdout)}`)
      } finally {
        if (vSftp) vSftp.end()
        if (vClient) vClient.end()
        await fsp.rm(path.join(virtualised.rootDir, "spike-virtual.txt"), { force: true }).catch(() => {})
        await virtualised.close().catch(() => {})
      }
    })
  } catch (err) {
    failure = err
    console.log("")
    console.log("UNEXPECTED ERROR:", (err && err.stack) || err)
  } finally {
    /* ----------------------------- cleanup ------------------------------ */
    try {
      if (sftp) sftp.end()
    } catch {
      /* ignore */
    }
    try {
      if (client) client.end()
    } catch {
      /* ignore */
    }
    for (const file of createdReal) {
      await fsp.rm(file, { recursive: true, force: true }).catch(() => {})
    }
    await server.close().catch(() => {})
  }

  /* ------------------------------- summary ------------------------------ */

  const pass = results.filter((r) => r.status === "pass").length
  const failed = results.filter((r) => r.status === "fail")
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log("")
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`)
  }
  console.log(`total: PASS=${pass} FAIL=${failed.length} (${seconds}s)`)

  const ok = failed.length === 0 && results.length > 0 && !failure
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL")
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error("FATAL", (err && err.stack) || err)
  process.exit(1)
})
