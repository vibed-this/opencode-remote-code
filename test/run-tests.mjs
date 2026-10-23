/**
 * run-tests.mjs — single entry point for the local end-to-end harness.
 *
 *   1. runs the standalone unit suites as child processes (fast ones first):
 *        test/remote-path.mjs, test/dialect.mjs, test/glob-matcher.mjs,
 *        test/remote-walk.mjs, test/path-mapper.mjs, test/plugin-entry.mjs
 *      and the slow one, test/ssh-pool-lifecycle.mjs (skipped with --skip-slow)
 *   2. for every requested remote dialect (posix and/or windows):
 *        a. wipes and recreates test/tmp/{remote,local,mirror}
 *        b. starts the mock SSH server (test/mock-ssh-server.mjs) in that dialect
 *           (`dialect: "windows"` also enables `virtualExecPaths`, because the
 *           real PowerShell the mock runs cannot be chrooted)
 *        c. runs the mock-server verification (test/verify-mock-server.mjs);
 *           its three POSIX-shaped checks are reported as SKIP in the windows
 *           dialect (see POSIX_ONLY_VERIFICATION below)
 *        d. runs the plugin smoke test for that dialect:
 *             posix   -> test/plugin-smoke.mjs
 *             windows -> test/plugin-smoke-windows.mjs
 *   3. prints a summary tagged with the dialect; exit code 1 if anything failed
 *
 * Requires `npm run build` first (the suites import from dist/).
 *
 * Usage: node test/run-tests.mjs [--dialect=posix|windows|both] [--verbose]
 *                                [--skip-plugin] [--skip-slow]
 *
 *   --dialect=X    which remote dialect(s) to exercise (default: both)
 *   --skip-plugin  do not load dist/index.js (no plugin smoke test at all)
 *   --skip-slow    skip the ssh-pool lifecycle suite (it waits ~25s on timers)
 */

import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { startMockServer, DIALECTS } from "./mock-ssh-server.mjs"
import { runVerification } from "./verify-mock-server.mjs"
import { runPluginSmoke } from "./plugin-smoke.mjs"
import { runPluginSmokeWindows } from "./plugin-smoke-windows.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, "tmp")
const REMOTE = path.join(TMP, "remote")
const LOCAL = path.join(TMP, "local")
const MIRROR = path.join(TMP, "mirror")

const USAGE =
  "usage: node test/run-tests.mjs [--dialect=posix|windows|both] [--verbose] [--skip-plugin] [--skip-slow]"

/* -------------------------------------------------------------------------- */
/* arguments                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const parsed = { dialect: "both", verbose: false, skipPlugin: false, skipSlow: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dialect") {
      const value = argv[i + 1]
      if (value === undefined) usageError("--dialect needs a value")
      parsed.dialect = value
      i++
    } else if (arg.startsWith("--dialect=")) {
      parsed.dialect = arg.slice("--dialect=".length)
    } else if (arg === "--verbose") parsed.verbose = true
    else if (arg === "--skip-plugin") parsed.skipPlugin = true
    else if (arg === "--skip-slow") parsed.skipSlow = true
    else if (arg === "--help" || arg === "-h") parsed.help = true
    else usageError(`unknown argument: ${arg}`)
  }

  const wanted = String(parsed.dialect).toLowerCase()
  if (wanted === "both" || wanted === "all") {
    // "all" is accepted so the flag keeps working if a third dialect is added.
    parsed.dialects = DIALECTS.slice()
  } else if (DIALECTS.includes(wanted)) {
    parsed.dialects = [wanted]
  } else {
    usageError(`unsupported dialect "${parsed.dialect}" (expected ${DIALECTS.join("|")}|both)`)
  }
  return parsed
}

function usageError(message) {
  console.error(`error: ${message}`)
  console.error(USAGE)
  process.exit(1)
}

const options = parseArgs(process.argv.slice(2))
const verbose = options.verbose
const skipPlugin = options.skipPlugin
const skipSlow = options.skipSlow
const dialects = options.dialects
const dialectLabel = dialects.length === DIALECTS.length ? "both" : dialects.join("+")

if (options.help) {
  console.log(USAGE)
  process.exit(0)
}

/* -------------------------------------------------------------------------- */
/* suites                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Standalone suites, run as child processes (they call process.exit()
 * themselves, so they cannot be imported into this process).
 *
 * `slow` suites are skipped by --skip-slow; the rest are pure in-memory
 * assertions and finish in well under a second each.
 */
const UNIT_SUITES = [
  { script: "remote-path.mjs", label: "remote path suite", slow: false },
  { script: "dialect.mjs", label: "dialect suite", slow: false },
  { script: "glob-matcher.mjs", label: "glob matcher suite", slow: false },
  { script: "remote-walk.mjs", label: "remote walk suite", slow: false },
  { script: "path-mapper.mjs", label: "path-mapper suite", slow: false },
  { script: "plugin-entry.mjs", label: "plugin entry suite", slow: false },
  { script: "ssh-pool-lifecycle.mjs", label: "ssh-pool lifecycle suite", slow: true },
]

/**
 * `verify-mock-server.mjs` is a *transport* conformance suite and three of its
 * checks are written for a POSIX remote: they send POSIX shell one-liners
 * (`echo boom >&2; exit 7`) or assert that the SFTP root canonicalises to "/".
 * Under the windows dialect those are dialect differences, not defects, so they
 * are reported as SKIP instead of FAIL. Everything else (auth, SFTP round trips,
 * traversal guard, exit-code plumbing) runs unchanged in both dialects.
 *
 * Kept as data (not a filter on the windows side of verify-mock-server.mjs)
 * because that file belongs to the mock suite and must stay dialect-agnostic.
 */
const POSIX_ONLY_VERIFICATION = [
  {
    label: "exec: non-zero exit code is propagated",
    name: /^exec: non-zero exit code is propagated$/,
    why: "sends a POSIX sh command (`echo boom >&2; exit 7`); PowerShell rejects `>&2`",
  },
  {
    label: "exec: stderr is separated from stdout",
    name: /^exec: stderr is separated from stdout$/,
    why: "sends POSIX shell redirection (`echo out; echo err >&2`)",
  },
  {
    label: "sftp: realpath('/') is the virtual root",
    name: /^sftp: realpath\('\/'\) is the virtual root$/,
    why: 'the windows dialect canonicalises "/" as "/C:/Users/test/proj" (that is what platform detection reads)',
  },
]

function banner(text) {
  console.log("")
  console.log(`--- ${text} ${"-".repeat(Math.max(0, 60 - text.length))}`)
}

/**
 * Wipe `test/tmp` and recreate the three roots. Called once per dialect, so each
 * dialect starts from an empty remote root (the windows dialect creates
 * AppData/Local/Temp inside it on startup, the posix verification leaves files
 * behind, and neither may leak into the other dialect's run).
 */
async function prepareTmp() {
  // Only ever delete inside test/tmp (no recursion outside this folder).
  const resolved = path.resolve(TMP)
  if (path.basename(resolved) !== "tmp" || path.basename(path.dirname(resolved)) !== "test") {
    throw new Error(`refusing to clean unexpected path: ${resolved}`)
  }
  // Windows sometimes keeps a handle open for a moment (antivirus, editor);
  // retry a few times instead of failing the whole run.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fsp.rm(resolved, { recursive: true, force: true })
      break
    } catch (err) {
      if (attempt === 3) {
        console.warn(`WARN could not fully clean ${resolved}: ${err.message}`)
        console.warn("     continuing anyway (leftover files may remain)")
      } else {
        await new Promise((r) => setTimeout(r, 250 * attempt))
      }
    }
  }
  await fsp.mkdir(REMOTE, { recursive: true })
  await fsp.mkdir(LOCAL, { recursive: true })
  await fsp.mkdir(MIRROR, { recursive: true })
}

function tally(checks) {
  return {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    skip: checks.filter((c) => c.status === "skip").length,
  }
}

/** `total: PASS=3 FAIL=0 ...` or `PASS=3 FAIL=0` (both forms are in use). */
const TOTAL_LINE = /^(?:total:\s*)?PASS=\d+/

/**
 * Run one standalone suite and fold it into a single check.
 *
 * Only the child's exit code and its trailing `total:` / `PASS=` / `FAIL` lines
 * are used, so the suites stay runnable on their own (`node test/<suite>.mjs`).
 */
function runSuite({ script, label }) {
  const file = path.join(HERE, script)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      cwd: path.resolve(HERE, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", (e) =>
      resolve({ name: label, status: "fail", detail: `spawn failed: ${e.message}` })
    )
    child.on("close", (code) => {
      const text = `${out}\n${err}`
      if (verbose) console.log(text.trimEnd())
      const lines = text.split(/\r?\n/)
      const totalLine = lines
        .slice()
        .reverse()
        .find((line) => TOTAL_LINE.test(line.trimStart()))
      if (code === 0) {
        resolve({ name: label, status: "pass", detail: totalLine ? totalLine.trim() : "" })
        return
      }
      const failures = lines.filter((line) => line.trimStart().startsWith("FAIL"))
      resolve({
        name: label,
        status: "fail",
        detail: failures.length
          ? failures.slice(0, 3).join(" | ")
          : totalLine?.trim() || `exit code ${code}`,
      })
    })
  })
}

/* -------------------------------------------------------------------------- */
/* dialect runs                                                               */
/* -------------------------------------------------------------------------- */

/** Tag every check with the dialect it belonged to (survives into the summary). */
const tagDialect = (checks, dialect) => checks.map((c) => ({ ...c, dialect }))

/**
 * Downgrade the POSIX-shaped verification checks to SKIP under the windows
 * dialect. Warns if a rule no longer matches anything, so a rename in
 * verify-mock-server.mjs cannot silently resurrect three red checks.
 */
function applyDialectFilter(results, dialect) {
  if (dialect !== "windows") return tagDialect(results, dialect)
  const matched = new Set()
  const converted = results.map((result) => {
    const rule = POSIX_ONLY_VERIFICATION.find((candidate) => candidate.name.test(result.name))
    if (!rule) return { ...result, dialect }
    matched.add(rule)
    return {
      ...result,
      dialect,
      status: "skip",
      detail: `posix-only check in the windows dialect: ${rule.why}`,
    }
  })
  for (const rule of POSIX_ONLY_VERIFICATION) {
    if (!matched.has(rule)) {
      console.log(`WARN windows dialect: expected posix-only check "${rule.label}" is gone`)
      console.log("     (test/verify-mock-server.mjs renamed it? update POSIX_ONLY_VERIFICATION)")
    }
  }
  return converted
}

/** Plugin smoke test for one dialect: posix and windows use different suites. */
async function runSmoke(dialect, server) {
  const common = {
    port: server.port,
    user: server.user,
    password: server.password,
    rootDir: server.rootDir,
    server,
  }
  if (dialect === "windows") {
    return runPluginSmokeWindows({ ...common, mirrorRoot: MIRROR, prefix: "[windows] " })
  }
  return runPluginSmoke({ port: server.port, user: server.user, password: server.password, prefix: "[posix] " })
}

async function runDialect(dialect) {
  const startedAt = Date.now()
  const checks = []
  await prepareTmp()

  banner(`${dialect} dialect`)
  console.log(`remote root = ${REMOTE}`)
  console.log(`mirror root = ${MIRROR}`)
  console.log(`tmp wiped fresh for this dialect`)

  let server = null
  try {
    server = await startMockServer({
      rootDir: REMOTE,
      dialect,
      // PowerShell cannot be chrooted, so the mock rewrites the virtual project
      // root inside the staged copy it executes. Only meaningful for windows.
      virtualExecPaths: dialect === "windows",
      verbose,
    })
    console.log(`listening on ${server.host}:${server.port} (dialect=${server.dialect})`)
    console.log(`user="${server.user}" password="${server.password}"`)
    if (dialect === "windows") {
      console.log(`powershell      = ${server.powershellPath}`)
      console.log(`sftp virtual /  = ${server.projectSftp}  ->  ${server.rootDir}`)
    }

    banner(`${dialect} dialect: mock server verification`)
    if (dialect === "windows") {
      // verify-mock-server.mjs prints its own PASS/FAIL lines, so warn *before*
      // the three POSIX-shaped checks show up as red on screen; they are folded
      // into SKIP in the summary below.
      console.log("NOTE 3 checks in this transport suite are POSIX-shaped; they print FAIL here")
      console.log("     and are reported as SKIP in the summary (see POSIX_ONLY_VERIFICATION):")
      for (const rule of POSIX_ONLY_VERIFICATION) {
        console.log(`       - ${rule.label}  (${rule.why})`)
      }
      console.log("")
    }
    const verification = await runVerification({
      port: server.port,
      user: server.user,
      password: server.password,
      rootDir: server.rootDir,
      server,
      prefix: `[${dialect}] `,
    })
    checks.push(...applyDialectFilter(verification.results, dialect))

    if (skipPlugin) {
      banner(`${dialect} dialect: plugin smoke test`)
      console.log("SKIP --skip-plugin was passed")
      checks.push({ name: "plugin smoke", status: "skip", detail: "--skip-plugin", dialect })
    } else {
      banner(`${dialect} dialect: plugin smoke test`)
      const smoke = await runSmoke(dialect, server)
      checks.push(...tagDialect(smoke.checks, dialect))
    }
  } catch (err) {
    console.error("FATAL:", (err && err.stack) || err)
    checks.push({
      name: `${dialect} harness`,
      status: "fail",
      detail: (err && err.message) || String(err),
      dialect,
    })
  } finally {
    if (server) await server.close().catch(() => {})
  }

  const counts = tally(checks)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  return { dialect, checks, counts, seconds }
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = Date.now()

  console.log(`test/run-tests.mjs  dialects=${dialectLabel}  node ${process.version}`)
  console.log(`(banners below are prefixed with the dialect they belong to)`)

  const checks = []
  let fatalError = null

  // test/tmp is prepared again per dialect; this first pass keeps the unit
  // suites running against a clean tree, as before.
  await prepareTmp()

  banner("unit suites (dialect independent)")
  try {
    for (const suite of UNIT_SUITES) {
      if (suite.slow && skipSlow) {
        console.log(`SKIP ${suite.label} (--skip-slow)`)
        checks.push({ name: suite.label, status: "skip", detail: "--skip-slow" })
        continue
      }
      const check = await runSuite(suite)
      const mark = check.status === "pass" ? "PASS" : "FAIL"
      console.log(`${mark} ${check.name}${check.detail ? ` (${check.detail})` : ""}`)
      checks.push(check)
    }
  } catch (err) {
    fatalError = err
    console.error("FATAL:", (err && err.stack) || err)
    checks.push({ name: "unit suites", status: "fail", detail: (err && err.message) || String(err) })
  }

  const perDialect = []
  for (const dialect of dialects) {
    try {
      perDialect.push(await runDialect(dialect))
    } catch (err) {
      fatalError = err
      console.error("FATAL:", (err && err.stack) || err)
      checks.push({
        name: `${dialect} dialect`,
        status: "fail",
        detail: (err && err.message) || String(err),
        dialect,
      })
    }
  }
  for (const run of perDialect) checks.push(...run.checks)

  const counts = tally(checks)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  banner(`summary (dialect=${dialectLabel})`)
  for (const check of checks) {
    if (check.status === "fail") {
      const tag = check.dialect ? `[${check.dialect}] ` : ""
      console.log(`FAIL ${tag}${check.name}: ${check.detail ?? ""}`)
    }
  }
  for (const run of perDialect) {
    console.log(
      `dialect ${run.dialect}: PASS=${run.counts.pass} FAIL=${run.counts.fail} ` +
        `SKIP=${run.counts.skip} (${run.seconds}s)`
    )
  }
  const pluginSkips = checks.filter((c) => c.name === "plugin smoke" && c.status === "skip")
  console.log("")
  console.log(
    `total: PASS=${counts.pass} FAIL=${counts.fail} SKIP=${counts.skip} (${seconds}s) dialect=${dialectLabel}`
  )
  for (const pluginSkip of pluginSkips) {
    const tag = pluginSkip.dialect ? `[${pluginSkip.dialect}] ` : ""
    if (pluginSkip.detail === "--skip-plugin") {
      console.log(`note: ${tag}plugin smoke test skipped on request (--skip-plugin).`)
    } else {
      console.log(`note: ${tag}plugin smoke test skipped - ${pluginSkip.detail ?? "see reason above"}`)
    }
  }
  const posixOnly = checks.filter((c) => c.status === "skip" && /posix-only check/.test(c.detail ?? ""))
  if (posixOnly.length > 0) {
    console.log(
      `note: ${posixOnly.length} mock-server check(s) are POSIX-shaped and were skipped in the ` +
        `windows dialect (they still run under --dialect=posix).`
    )
  }
  console.log(
    counts.fail === 0
      ? "RESULT: PASS"
      : `RESULT: FAIL (${counts.fail} failing checks)`
  )

  // Explicit exit: a skipped plugin may still leave timers/sockets behind.
  process.exit(counts.fail === 0 && !fatalError ? 0 : 1)
}

main().catch((err) => {
  console.error("FATAL", (err && err.stack) || err)
  process.exit(1)
})
