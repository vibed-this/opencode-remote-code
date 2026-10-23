/**
 * run-tests.mjs — single entry point for the local end-to-end harness.
 *
 *   1. wipes and recreates test/tmp/{remote,local,mirror}
 *   2. runs the standalone unit suites as child processes
 *      (test/path-mapper.mjs, test/ssh-pool-lifecycle.mjs)
 *   3. starts the mock SSH server (test/mock-ssh-server.mjs)
 *   4. runs the mock-server verification (test/verify-mock-server.mjs)
 *   5. runs the plugin smoke test (test/plugin-smoke.mjs) when dist/index.js exists
 *   6. prints a summary; exit code 1 if anything failed
 *
 * Requires `npm run build` first (the suites import from dist/).
 *
 * Usage: node test/run-tests.mjs [--verbose] [--skip-plugin] [--skip-slow]
 *
 *   --skip-plugin  do not load dist/index.js
 *   --skip-slow    skip the ssh-pool lifecycle suite (it waits ~25s on timers)
 */

import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { startMockServer } from "./mock-ssh-server.mjs"
import { runVerification } from "./verify-mock-server.mjs"
import { runPluginSmoke } from "./plugin-smoke.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, "tmp")
const REMOTE = path.join(TMP, "remote")
const LOCAL = path.join(TMP, "local")
const MIRROR = path.join(TMP, "mirror")

const args = new Set(process.argv.slice(2))
const verbose = args.has("--verbose")
const skipPlugin = args.has("--skip-plugin")
const skipSlow = args.has("--skip-slow")

/**
 * Standalone suites, run as child processes (they call process.exit()
 * themselves, so they cannot be imported into this process).
 */
const UNIT_SUITES = [
  { script: "path-mapper.mjs", label: "path-mapper suite", slow: false },
  { script: "ssh-pool-lifecycle.mjs", label: "ssh-pool lifecycle suite", slow: true },
]

function banner(text) {
  console.log("")
  console.log(`--- ${text} ${"-".repeat(Math.max(0, 60 - text.length))}`)
}

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

/**
 * Run one standalone suite and fold it into a single check.
 *
 * Only the child's exit code and its trailing `total:` / `FAIL` lines are used,
 * so the suites stay runnable on their own (`node test/<suite>.mjs`).
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
        .find((line) => line.trimStart().startsWith("total:"))
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

async function main() {
  const startedAt = Date.now()
  await prepareTmp()

  const checks = []
  let fatalError = null

  banner("unit suites")
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

  banner("mock ssh server")
  const server = await startMockServer({
    rootDir: REMOTE,
    verbose,
  })
  console.log(`listening on ${server.host}:${server.port}`)
  console.log(`user="${server.user}" password="${server.password}"`)
  console.log(`remote root = ${server.rootDir}`)

  try {
    banner("mock server verification")
    const verification = await runVerification({
      port: server.port,
      user: server.user,
      password: server.password,
      rootDir: server.rootDir,
      server,
    })
    checks.push(...verification.results)

    if (skipPlugin) {
      banner("plugin smoke test")
      console.log("SKIP --skip-plugin was passed")
      checks.push({ name: "plugin smoke", status: "skip", detail: "--skip-plugin" })
    } else {
      banner("plugin smoke test")
      const smoke = await runPluginSmoke({
        port: server.port,
        user: server.user,
        password: server.password,
      })
      checks.push(...smoke.checks)
    }
  } catch (err) {
    fatalError = err
    console.error("FATAL:", (err && err.stack) || err)
    checks.push({ name: "harness", status: "fail", detail: (err && err.message) || String(err) })
  } finally {
    await server.close().catch(() => {})
  }

  const counts = tally(checks)
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  banner("summary")
  for (const check of checks) {
    if (check.status === "fail") console.log(`FAIL ${check.name}: ${check.detail ?? ""}`)
  }
  const pluginSkip = checks.find((c) => c.name === "plugin smoke" && c.status === "skip")
  console.log("")
  console.log(`total: PASS=${counts.pass} FAIL=${counts.fail} SKIP=${counts.skip} (${seconds}s)`)
  if (pluginSkip) {
    if (pluginSkip.detail === "--skip-plugin") {
      console.log("note: plugin smoke test skipped on request (--skip-plugin).")
    } else {
      console.log(`note: plugin smoke test skipped - ${pluginSkip.detail ?? "see reason above"}`)
      console.log("      (expected while dist/index.js is still the old V1 build.)")
    }
  }
  console.log(counts.fail === 0 ? "RESULT: PASS" : `RESULT: FAIL (${counts.fail} failing checks)`)

  // Explicit exit: a skipped plugin may still leave timers/sockets behind.
  process.exit(counts.fail === 0 && !fatalError ? 0 : 1)
}

main().catch((err) => {
  console.error("FATAL", (err && err.stack) || err)
  process.exit(1)
})
