/**
 * plugin-smoke-windows.mjs — the real end-to-end proof that the **plugin** works
 * against a **Windows** remote (DESIGN-V3 §11.1 / §11.2 / §11.3).
 *
 * `test/spike-windows.mjs` proves the *transport* by hand-building the PowerShell
 * command; this file goes one level up and proves the shipped product:
 *
 *   dist/index.js  ->  fake V2 plugin context  ->  setup(ctx)
 *                  ->  drive the real registered tools (shell/read/write/edit/
 *                      glob/grep) against the mock SSH server's windows dialect
 *
 * The mock emulates Win32-OpenSSH + PowerShell 5.1: `exec` decodes the plugin's
 * `-EncodedCommand` / `-File` command and runs it with the **real** powershell.exe
 * of this machine, SFTP speaks `/C:/...` paths bridged onto `test/tmp/remote`, and
 * `realpath(".")` answers `/C:/Users/test/proj`.
 *
 * Two things that are easy to get wrong and are therefore explicit here:
 *
 *  - `startMockServer({ virtualExecPaths: true })` is required. PowerShell cannot
 *    be chrooted, so a script that says `Set-Location -LiteralPath
 *    'C:/Users/test/proj'` would fail against the real disk; `virtualExecPaths`
 *    rewrites the virtual project root to the real directory inside the staged
 *    copy the mock runs (the file the plugin uploaded is untouched).
 *  - `platform` is deliberately **unset** for the main case, so detection
 *    (`realpath(".")` -> `/C:/Users/test/proj` -> windows) is exercised end to
 *    end. One extra assertion then checks that an explicit `platform: "windows"`
 *    works too.
 *
 * Usage:
 *   node test/plugin-smoke-windows.mjs        # starts its own mock server
 *   node test/run-tests.mjs --dialect=windows # via the harness (reuses its server)
 *
 * Import: `runPluginSmokeWindows({ port, user, password, rootDir, server })`.
 * Exit:   0 on PASS, 1 on FAIL (also 1 + "TIMEOUT" if the watchdog fires).
 */

import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  startMockServer,
  WINDOWS_PROJECT_PATH,
  WINDOWS_PROJECT_SFTP,
  WINDOWS_STAGING_RELATIVE,
} from "./mock-ssh-server.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")
const DEFAULT_DIST = path.join(REPO_ROOT, "dist", "index.js")
const TMP = path.join(HERE, "tmp")
const REMOTE = path.join(TMP, "remote")
const MIRROR = path.join(TMP, "mirror")

/** What the plugin's `workdir` option says (= what `realpath(".")` must return). */
const WORKDIR = WINDOWS_PROJECT_PATH
/** Trailing-slash-free for comparisons. */
const WORKDIR_SFTP = WINDOWS_PROJECT_SFTP

const REQUIRED_TOOLS = ["shell", "read", "write", "edit", "patch", "glob", "grep"]

const SETUP_TIMEOUT_MS = 90_000
const TOOL_TIMEOUT_MS = 90_000
const CLEANUP_TIMEOUT_MS = 30_000
const WATCHDOG_MS = 120_000

/* -------------------------------------------------------------------------- */
/* small utilities                                                            */
/* -------------------------------------------------------------------------- */

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (timer.unref) timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** `C:\a\b` -> `C:/a/b` (comparison helper only). */
const toPosix = (p) => String(p).replace(/\\/g, "/")

/** Forward slashes, lower case, no trailing separator — for "same directory?" checks. */
const squash = (p) => toPosix(p).toLowerCase().replace(/\/+$/, "")

/** First non-empty stdout line of a tool result. */
function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
}

/** Every non-empty line of a tool result. */
function lines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Error message of anything thrown. */
const messageOf = (err) => (err && err.message) || String(err)

/**
 * Describe what a module default export is, without running it.
 * Same classification as `plugin-smoke.mjs` (kept local so both files stay
 * independently readable).
 */
function classify(exported) {
  if (typeof exported === "function") {
    return { kind: "v1-function", detail: "default export is a function (V1 form)" }
  }
  if (exported && typeof exported === "object") {
    if (typeof exported.setup === "function") {
      return { kind: "v2", detail: `V2 plugin definition (id=${exported.id ?? "?"})` }
    }
    if (typeof exported.effect === "function") {
      return { kind: "v2", detail: `V2 effect-style plugin (id=${exported.id ?? "?"})` }
    }
    if (typeof exported.server === "function" || exported.server) {
      return { kind: "v1-object", detail: "default export is `{ id, server }` (V1 shape)" }
    }
    return { kind: "unknown", detail: `object without setup/effect (keys: ${Object.keys(exported).join(", ") || "none"})` }
  }
  return { kind: "unknown", detail: `default export is ${typeof exported}` }
}

/* -------------------------------------------------------------------------- */
/* fake V2 plugin context                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build the minimal V2 `ctx` the plugin touches: `options`, `tool.transform`
 * (tool editor), `session.hook`, `permission.assert`, `location`, `storage`.
 */
function makeMockContext(options) {
  const projectDir = process.cwd()
  const added = []
  const notes = []

  const editor = {
    add: (tool) => {
      added.push(tool)
      return tool
    },
    list: () => added.slice(),
    get: (id) => added.find((t) => t.name === id),
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }

  const ctx = {
    options,
    location: {
      directory: projectDir,
      project: { id: "p", directory: projectDir, canonical: projectDir },
    },
    tool: {
      transform: async (cb) => {
        await cb(editor)
        return { dispose: async () => notes.push("tool registration disposed") }
      },
      list: async () => added.slice(),
      reload: async () => {},
      hook: async (name) => {
        notes.push(`tool.hook(${typeof name === "string" ? name : "?"})`)
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name) => {
        notes.push(`session.hook(${typeof name === "string" ? name : "?"})`)
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    },
    permission: { assert: async (request) => void notes.push(`permission.assert(${request?.action ?? "?"})`) },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
  }

  return { ctx, added, notes }
}

/** The V2 tool-call identity every `execute(input, context)` needs. */
function callContext(label) {
  return {
    sessionID: "ses_windows_smoke",
    messageID: "msg_windows_smoke",
    id: `tool_${label}`,
    agent: "build",
    abort: new AbortController().signal,
  }
}

/* -------------------------------------------------------------------------- */
/* plugin loading                                                             */
/* -------------------------------------------------------------------------- */

async function loadPlugin(distPath) {
  const stat = await fsp.stat(distPath).catch(() => null)
  if (!stat || !stat.isFile()) {
    throw new Error(`dist/index.js not found at ${distPath} - run \`npm run build\` first`)
  }
  let mod
  try {
    mod = await import(pathToFileURL(distPath).href)
  } catch (err) {
    throw new Error(`import of ${distPath} failed: ${messageOf(err)}`)
  }
  const exported = mod.default
  const shape = classify(exported)
  if (shape.kind !== "v2") {
    throw new Error(`dist/index.js is not a V2 plugin -- ${shape.detail}`)
  }
  return exported
}

/* -------------------------------------------------------------------------- */
/* the suite                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run the Windows end-to-end plugin smoke test.
 *
 * @param {object} opts
 * @param {number} opts.port              mock SSH server port
 * @param {string} [opts.user]            SSH user the mock accepts (default "testuser")
 * @param {string} [opts.password]
 * @param {string} [opts.rootDir]         real directory behind `/C:/Users/test/proj`
 * @param {object} [opts.server]          handle from startMockServer (for logging)
 * @param {string} [opts.distPath]
 * @param {string} [opts.mirrorRoot]      local mirror root (default test/tmp/mirror)
 * @param {string} [opts.prefix]          printed before every check name
 * @returns {Promise<{status:"pass"|"fail", checks:Array<{name:string,status:string,detail?:string}>}>}
 */
export async function runPluginSmokeWindows(opts) {
  const {
    port,
    user = "testuser",
    password = "testpass",
    rootDir = REMOTE,
    server = null,
    distPath = DEFAULT_DIST,
    mirrorRoot = MIRROR,
    prefix = "[win] ",
  } = opts ?? {}

  const checks = []
  const say = (line) => console.log(`${prefix}${line}`)

  let counter = 0
  /**
   * One numbered assertion line. `fn` may contain several `assert.*` calls; the
   * first failure fails the whole numbered item and prints its message.
   */
  async function check(text, fn) {
    counter++
    const name = `${counter}. ${text}`
    try {
      await fn()
      checks.push({ name, status: "pass" })
      say(`PASS ${name}`)
    } catch (err) {
      const detail = messageOf(err)
      checks.push({ name, status: "fail", detail })
      say(`FAIL ${name}`)
      for (const line of detail.split(/\r?\n/)) say(`     ${line}`)
    }
  }

  const note = (text) => say(`     NOTE ${text}`)

  /* ------------------------------ plugin --------------------------------- */

  let exported
  try {
    exported = await loadPlugin(distPath)
  } catch (err) {
    checks.push({ name: "load dist/index.js", status: "fail", detail: messageOf(err) })
    say(`FAIL load dist/index.js\n${prefix}     ${messageOf(err)}`)
    return { status: "fail", checks }
  }

  /**
   * Plugin options, using the **real V3 option names** (src/config.ts OPTION_KEYS).
   * `platform` stays unset -> detection is exercised (§6.4).
   */
  const baseOptions = {
    ssh: `ssh -p ${port} ${user}@127.0.0.1`,
    workdir: WORKDIR,
    password,
    mirror: mirrorRoot,
    debug: true,
  }

  /* ------------------------------ 1. setup ------------------------------- */

  let ctxBundle = makeMockContext(baseOptions)
  let { ctx, added, notes } = ctxBundle
  let cleanup = null
  let setupError = null

  await check("setup(ctx) completes and returns a cleanup function", async () => {
    const entry = typeof exported.setup === "function" ? exported.setup : exported.effect
    cleanup = await withTimeout(
      Promise.resolve().then(() => entry.call(exported, ctx)),
      SETUP_TIMEOUT_MS,
      "setup"
    )
    assert.equal(typeof cleanup, "function", "setup() must return an async cleanup function")
  })
  setupError = checks[0].status === "fail" ? checks[0].detail : null
  if (setupError !== null) {
    // Nothing else can run without a live plugin; report and bail out.
    note(`setup failed, skipping the remaining assertions: ${setupError}`)
    return { status: "fail", checks }
  }

  const tool = (name) => added.find((t) => t.name === name)
  const execute = async (name, args) => {
    const t = tool(name)
    if (!t || typeof t.execute !== "function") throw new Error(`tool "${name}" is not registered`)
    return withTimeout(
      Promise.resolve().then(() => t.execute(args, callContext(name))),
      TOOL_TIMEOUT_MS,
      `${name}.execute`
    )
  }

  /* ------------------------------ 2. tools ------------------------------ */

  await check("all seven tools register (shell read write edit patch glob grep)", async () => {
    const names = added.map((t) => t.name)
    for (const required of REQUIRED_TOOLS) {
      assert.ok(names.includes(required), `tool "${required}" missing; registered: ${names.join(", ") || "none"}`)
      assert.equal(
        typeof tool(required).execute,
        "function",
        `tool "${required}" has no execute() function`
      )
    }
    const extra = names.filter((n) => !REQUIRED_TOOLS.includes(n))
    if (extra.length > 0) note(`extra tools registered: ${extra.join(", ")}`)
  })
  if (notes.length > 0) note(notes.join(", "))

  /* --------------------------- 3. shell (real exec) --------------------- */

  // exec runs real PowerShell on the real disk, so the observable workdir is the
  // directory `/C:/Users/test/proj` maps to (that is what virtualExecPaths does).
  const realRoot = toPosix(rootDir)

  await check("shell runs PowerShell and prints the workdir", async () => {
    // `(Get-Location).Path`, never a bare `Get-Location`: PS 5.1 drops the table
    // output of a bare cmdlet when the host tears down (see test/README.md).
    const res = await execute("shell", {
      command: "(Get-Location).Path",
      description: "print the remote working directory",
    })
    const printed = firstLine(res.content)
    assert.ok(printed, `no output from (Get-Location).Path: ${JSON.stringify(res.content)}`)
    assert.equal(
      squash(printed),
      squash(realRoot),
      `(Get-Location).Path printed ${JSON.stringify(printed)}, want ${realRoot} (the real dir behind ${WORKDIR_SFTP})`
    )
    // stderr must stay clean: no CLIXML, no PowerShell banner.
    assert.ok(
      !String(res.content).includes("#< CLIXML"),
      `PowerShell error stream leaked into the output: ${JSON.stringify(res.content).slice(0, 300)}`
    )
  })

  // ---------------------------------------------------------------------------
  // Exit-code propagation end to end (DESIGN-V3 §7.3 / §12: "the exit code is
  // trusted").
  //
  // This check is the regression guard for a real bug that shipped once in the
  // rewrite: `execOnClient()` chained the channel handlers onto `stream.stderr`
  // instead of onto the channel —
  //
  //     stream.on("data", …).stderr.on("data", …).on("close", (code) => …)
  //                                                  ^ attached to stderr
  //
  // — and because `stderr`'s "close" carries no code, `code ?? 0` always
  // yielded 0: every remote command looked successful. Never weaken this.
  // ---------------------------------------------------------------------------
  await check("shell propagates a native exit code (`cmd /c exit 3` -> throws \"exit code 3\")", async () => {
    let error = null
    let returned = null
    try {
      returned = await execute("shell", {
        command: "cmd /c exit 3",
        description: "fail on purpose with exit code 3",
      })
    } catch (err) {
      error = err
    }
    assert.ok(
      error,
      "a command that exits 3 must make the shell tool throw, not return: " +
        `got ${JSON.stringify(returned && returned.metadata)}. ` +
        "Suspect src/ssh-pool.ts execOnClient(): are the 'close'/'error' handlers still attached to `stream` (not to `stream.stderr`)?"
    )
    assert.match(messageOf(error), /exit code 3/, `unexpected error message: ${messageOf(error)}`)
  })

  /* --------------------- 4. oversized script staging -------------------- */

  const stagingDir = path.join(rootDir, ...WINDOWS_STAGING_RELATIVE.split("/"))

  await check("oversized shell script (>300 lines) is staged and still succeeds; no .ps1 left behind", async () => {
    const lineCount = 320
    const command = Array.from({ length: lineCount }, (_, i) => `Write-Output "line ${i}"`).join("\n")
    // Lower bound of the -EncodedCommand payload the dialect would build; if this
    // is already > 6000 the plugin must take the staged `-File` path (§6.2).
    const b64LowerBound = Buffer.from(command, "utf16le").toString("base64").length
    assert.ok(
      b64LowerBound > 6000,
      `payload too small to force the -File path (base64=${b64LowerBound}, need > 6000)`
    )

    // Watch for the transient oc-*.ps1 while the call runs (informational).
    const seen = new Set()
    const watcher = setInterval(() => {
      fsp
        .readdir(stagingDir)
        .then((names) => {
          for (const name of names) if (/^oc-.*\.ps1$/i.test(name)) seen.add(name)
        })
        .catch(() => {})
    }, 15)
    if (watcher.unref) watcher.unref()

    let res
    try {
      res = await execute("shell", { command, description: "print 320 lines to force -File staging" })
    } finally {
      clearInterval(watcher)
    }

    const printed = lines(res.content)
    assert.ok(
      printed.length >= 300,
      `expected >= 300 stdout lines, got ${printed.length}: ${JSON.stringify(res.content).slice(0, 300)}`
    )
    assert.ok(printed.includes("line 0"), `first line missing: ${JSON.stringify(printed.slice(0, 3))}`)
    assert.ok(
      printed.includes(`line ${lineCount - 1}`),
      `last line missing: ${JSON.stringify(printed.slice(-3))}`
    )

    const leftovers = (await fsp.readdir(stagingDir).catch(() => [])).filter((n) => /^oc-.*\.ps1$/i.test(n))
    assert.equal(
      leftovers.length,
      0,
      `staged scripts were left behind in ${stagingDir}: ${leftovers.join(", ")}`
    )
    if (seen.size > 0) note(`observed the transient staged script(s): ${[...seen].join(", ")} (cleaned up)`)
    else
      note(
        `the transient oc-*.ps1 was not caught by the 15ms poller; the -File path itself is pinned by test/spike-windows.mjs`
      )
  })

  /* ------------------------------- 5. write ----------------------------- */

  const e2eRemote = `${WORKDIR}/src/e2e.ts`
  const e2eLocal = path.join(rootDir, "src", "e2e.ts")
  const e2eBody = [
    "export const answer = 42",
    "",
    "export function greet(name: string): string {",
    '  return `hello ${name}`',
    "}",
    "",
  ].join("\n")

  await check("write creates C:/Users/test/proj/src/e2e.ts and the bytes land on disk", async () => {
    const res = await execute("write", { filePath: e2eRemote, content: e2eBody })
    assert.match(String(res.content), /Wrote file successfully/, `unexpected write result: ${res.content}`)

    const onDisk = await fsp.readFile(e2eLocal, "utf8")
    assert.equal(onDisk, e2eBody, `content on disk differs from what write() was given`)
    assert.ok(onDisk.includes("export function greet"), "multi-line content was not preserved")
  })

  /* -------------------------------- 6. read ----------------------------- */

  await check("read returns the same content with line numbers; CRLF files keep their line count", async () => {
    const res = await execute("read", { filePath: e2eRemote })
    assert.ok(
      String(res.content).includes(`<path>${e2eRemote}</path>`),
      `read did not report the remote path: ${JSON.stringify(res.content).slice(0, 200)}`
    )
    const rendered = lines(res.content)
    const expected = e2eBody.split("\n")
    for (let i = 0; i < expected.length; i++) {
      // Blank lines render as "3: " and are trimmed away by lines(); check the
      // non-empty ones, which carry all the content.
      if (expected[i].trim() === "") continue
      const wanted = `${i + 1}: ${expected[i]}`
      assert.ok(
        rendered.includes(wanted),
        `missing line ${JSON.stringify(wanted)} in: ${JSON.stringify(rendered.slice(0, 8))}`
      )
    }

    // --- CRLF rule (§7.3): a CRLF file read back keeps its CRLF line count ---
    const crlfName = "crlf-fixture.txt"
    const lfName = "lf-fixture.txt"
    const crlfBody = "alpha\r\nbeta\r\ngamma\r\n"
    const lfBody = "alpha\nbeta\ngamma\n"
    await fsp.writeFile(path.join(rootDir, crlfName), crlfBody, "utf8")
    await fsp.writeFile(path.join(rootDir, lfName), lfBody, "utf8")

    const crlfRead = String((await execute("read", { filePath: `${WORKDIR}/${crlfName}` })).content)
    const lfRead = String((await execute("read", { filePath: `${WORKDIR}/${lfName}` })).content)
    const totalOf = (text) => {
      const m = /total (\d+) lines/.exec(text)
      assert.ok(m, `read did not report a line total: ${JSON.stringify(text.slice(-200))}`)
      return Number(m[1])
    }
    assert.equal(
      totalOf(crlfRead),
      totalOf(lfRead),
      `CRLF and LF twins report a different line count:\nCRLF: ${JSON.stringify(crlfRead.slice(-120))}\nLF:   ${JSON.stringify(lfRead.slice(-120))}`
    )
    assert.equal(totalOf(crlfRead), 4, "3 CRLF lines + trailing newline should render as 4 split lines")
    // The \r must still be there — that is what "CRLF preserved" means at this layer.
    assert.ok(crlfRead.includes("1: alpha\r"), `read dropped the CR of a CRLF line: ${JSON.stringify(crlfRead.slice(0, 200))}`)

    // --- write over a CRLF file keeps it CRLF --------------------------------
    const nextBody = "one\ntwo\nthree\n"
    await execute("write", { filePath: `${WORKDIR}/${crlfName}`, content: nextBody })
    const afterWrite = await fsp.readFile(path.join(rootDir, crlfName), "utf8")
    assert.ok(afterWrite.includes("\r\n"), `write turned the CRLF file into LF: ${JSON.stringify(afterWrite)}`)
    assert.equal(
      afterWrite.split("\r\n").join("").includes("\n"),
      false,
      `write left a bare LF in a CRLF file: ${JSON.stringify(afterWrite)}`
    )
    assert.equal(afterWrite, "one\r\ntwo\r\nthree\r\n", `unexpected CRLF result: ${JSON.stringify(afterWrite)}`)
  })

  /* -------------------------------- 7. edit ----------------------------- */

  await check("edit replaces a string and the change reaches the disk", async () => {
    const res = await execute("edit", {
      filePath: e2eRemote,
      oldString: "export const answer = 42",
      newString: "export const answer = 43",
    })
    assert.match(String(res.content), /Edit applied successfully/, `unexpected edit result: ${res.content}`)
    const onDisk = await fsp.readFile(e2eLocal, "utf8")
    assert.ok(onDisk.includes("export const answer = 43"), `the edit did not reach the remote file:\n${onDisk}`)
    assert.ok(!onDisk.includes("export const answer = 42"), "the old string is still present on disk")
  })

  /* -------------------------------- 8. glob ----------------------------- */

  await check("glob '*.ts' finds src/e2e.ts and prints an absolute C:/ path", async () => {
    // A second .ts file so the match is not accidental, and a decoy that must not match.
    await execute("write", {
      filePath: `${WORKDIR}/src/helper.ts`,
      content: "export const helper = true\n",
    })
    await execute("write", {
      filePath: `${WORKDIR}/src/notes.md`,
      content: "# not a typescript file\n",
    })

    const res = await execute("glob", { pattern: "*.ts" })
    const found = lines(res.content)
    assert.ok(
      found.includes(e2eRemote),
      `glob did not return the absolute remote path ${e2eRemote}: ${JSON.stringify(found)}`
    )
    assert.ok(
      found.every((line) => line.startsWith("C:/")),
      `every result must be an absolute "C:/..." path, got: ${JSON.stringify(found)}`
    )
    assert.ok(
      !found.some((line) => line.endsWith(".md")),
      `glob "*.ts" must not report markdown files: ${JSON.stringify(found)}`
    )
  })

  /* -------------------------------- 9. grep ----------------------------- */

  await check("grep finds the line, reporting the C:/ path and a 1-based line number", async () => {
    const res = await execute("grep", { pattern: "answer = 43", include: "*.ts" })
    const text = String(res.content)
    assert.ok(
      text.includes(`${e2eRemote}:`),
      `grep did not report the absolute remote path: ${JSON.stringify(text.slice(0, 400))}`
    )
    // `export const answer = 43` is line 1 of e2e.ts (1-based, per the V2 format).
    assert.ok(
      /Line 1: export const answer = 43/.test(text),
      `grep did not report "Line 1" for the first line: ${JSON.stringify(text.slice(0, 400))}`
    )
    assert.match(text, /Found \d+ matches/, `unexpected grep header: ${JSON.stringify(text.slice(0, 200))}`)
  })

  /* --------------------------- 10. read directory ----------------------- */

  await check("read lists a directory with trailing '/' for subdirectories and hints on a typo", async () => {
    const res = await execute("read", { filePath: WORKDIR })
    const text = String(res.content)
    assert.ok(text.includes("<type>directory</type>"), `expected a directory listing: ${JSON.stringify(text.slice(0, 200))}`)
    const entries = lines(text)
    assert.ok(entries.includes("src/"), `missing "src/" (trailing slash) in: ${JSON.stringify(entries)}`)
    assert.ok(
      entries.includes(`AppData/`),
      `missing "AppData/" (the plugin's staging dir) in: ${JSON.stringify(entries)}`
    )
    assert.ok(
      !entries.includes("src"),
      `a subdirectory must be listed as "src/", not "src": ${JSON.stringify(entries)}`
    )

    let error = null
    try {
      // "e2e" does not exist; "e2e.ts" does -> the "Did you mean" path.
      await execute("read", { filePath: `${WORKDIR}/src/e2e` })
    } catch (err) {
      error = err
    }
    assert.ok(error, "reading a missing file must throw")
    assert.match(messageOf(error), /Did you mean/, `expected a "Did you mean" hint: ${messageOf(error)}`)
    assert.ok(
      messageOf(error).includes("e2e.ts"),
      `the hint should offer e2e.ts: ${messageOf(error)}`
    )
  })

  /* ---------------- extra: explicit platform: "windows" also works ------ */

  // Runs before the cleanup item so the main instance is still alive and the
  // mock server is still up (the explicit-platform setup needs a reachable port).
  await check('explicit platform: "windows" also works (detection skipped, same tools)', async () => {
    const explicitOptions = { ...baseOptions, platform: "windows" }
    const bundle = makeMockContext(explicitOptions)
    const entry = typeof exported.setup === "function" ? exported.setup : exported.effect
    const explicitCleanup = await withTimeout(
      Promise.resolve().then(() => entry.call(exported, bundle.ctx)),
      SETUP_TIMEOUT_MS,
      "setup(platform=windows)"
    )
    assert.equal(typeof explicitCleanup, "function", "setup() must return a cleanup function")
    try {
      const names = bundle.added.map((t) => t.name)
      for (const required of REQUIRED_TOOLS) {
        assert.ok(names.includes(required), `tool "${required}" missing with platform=windows`)
      }
      const shellTool = bundle.added.find((t) => t.name === "shell")
      const res = await withTimeout(
        Promise.resolve().then(() =>
          shellTool.execute(
            { command: "(Get-Location).Path", description: "workdir with explicit platform" },
            callContext("explicit")
          )
        ),
        TOOL_TIMEOUT_MS,
        "shell.execute(platform=windows)"
      )
      assert.equal(
        squash(firstLine(res.content)),
        squash(realRoot),
        `unexpected workdir with platform="windows": ${JSON.stringify(res.content)}`
      )
    } finally {
      await withTimeout(Promise.resolve().then(() => explicitCleanup()), CLEANUP_TIMEOUT_MS, "cleanup").catch(
        () => {}
      )
    }
  })

  /* ----------------------------- cleanup -------------------------------- */

  await check("cleanup() resolves and closes the SSH pool (no lingering sockets)", async () => {
    assert.equal(typeof cleanup, "function", "setup() did not return a cleanup function")
    await withTimeout(Promise.resolve().then(() => cleanup()), CLEANUP_TIMEOUT_MS, "cleanup")

    // The mock server runs in this process, so a pool that was not closed shows
    // up here as live TCP client sockets. Only the listener (TCPServerWrap) may
    // remain. Polled, because the OS/FIN handshake is asynchronous.
    const sockets = () =>
      process.getActiveResourcesInfo().filter((name) => /^TCPSocketWrap$/.test(name)).length
    let remaining = sockets()
    for (let attempt = 0; attempt < 50 && remaining > 0; attempt++) {
      await sleep(100)
      remaining = sockets()
    }
    assert.equal(
      remaining,
      0,
      `${remaining} TCP socket(s) are still open after cleanup(): the SSH pool was not closed, ` +
        `so a real process would hang until its watchdog fires. Suspect: setup()'s cleanup function ` +
        `not calling sshPool.close().`
    )
  })

  const failed = checks.filter((c) => c.status === "fail")
  return { status: failed.length === 0 ? "pass" : "fail", checks }
}

/* -------------------------------------------------------------------------- */
/* standalone entry point                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const watchdog = setTimeout(() => {
    console.error("TIMEOUT: plugin-smoke-windows did not finish within " + `${WATCHDOG_MS}ms`)
    console.error("         likely cause: an SSH connection/socket was left open, so the process cannot exit.")
    process.exit(1)
  }, WATCHDOG_MS)
  if (watchdog.unref) watchdog.unref()

  const startedAt = Date.now()
  await fsp.mkdir(REMOTE, { recursive: true })
  await fsp.mkdir(MIRROR, { recursive: true })

  console.log("plugin-smoke-windows: dist/index.js against a Windows remote (mock SSH server, dialect=windows)")
  console.log("")

  let server = null
  let outcome = { status: "fail", checks: [] }

  try {
    server = await startMockServer({
      rootDir: REMOTE,
      dialect: "windows",
      virtualExecPaths: true,
    })
    console.log(`mock ssh server   = ${server.host}:${server.port} (dialect=${server.dialect})`)
    console.log(`exec powershell   = ${server.powershellPath}`)
    console.log(`sftp virtual root = ${WORKDIR_SFTP}  ->  ${server.rootDir}`)
    console.log(`plugin workdir    = ${WORKDIR}   mirror = ${MIRROR}`)
    console.log("")

    outcome = await runPluginSmokeWindows({
      port: server.port,
      user: server.user,
      password: server.password,
      rootDir: server.rootDir,
      server,
      mirrorRoot: MIRROR,
    })
  } catch (err) {
    console.error("FATAL", (err && err.stack) || err)
  } finally {
    // A hanging close means the plugin left connections open; say so instead of
    // letting the watchdog print a generic TIMEOUT 15 s later.
    await withTimeout(Promise.resolve().then(() => server?.close()), 15_000, "mock server close").catch(
      (err) => {
        console.error(`FATAL the mock server could not close: ${messageOf(err)}`)
        console.error("      likely cause: the SSH pool was not closed, so its connections are still open.")
        clearTimeout(watchdog)
        process.exit(1)
      }
    )
    // Only the fixtures this script created; test/tmp itself belongs to run-tests.
    await fsp.rm(path.join(REMOTE, "src"), { recursive: true, force: true }).catch(() => {})
    for (const name of ["crlf-fixture.txt", "lf-fixture.txt"]) {
      await fsp.rm(path.join(REMOTE, name), { force: true }).catch(() => {})
    }
  }

  const passed = outcome.checks.filter((c) => c.status === "pass").length
  const failed = outcome.checks.filter((c) => c.status === "fail")
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log("")
  for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`)
  console.log(`total: PASS=${passed} FAIL=${failed.length} (${seconds}s)`)

  const ok = failed.length === 0 && outcome.checks.length > 0
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL")
  clearTimeout(watchdog)
  process.exit(ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("FATAL", (err && err.stack) || err)
    process.exit(1)
  })
}

export default runPluginSmokeWindows
