/**
 * run-tests.mjs — single entry point for the local end-to-end harness.
 *
 *   1. wipes and recreates test/tmp/{remote,local,mirror}
 *   2. starts the mock SSH server (test/mock-ssh-server.mjs)
 *   3. runs the mock-server verification (test/verify-mock-server.mjs)
 *   4. runs the plugin smoke test (test/plugin-smoke.mjs) when dist/index.js exists
 *   5. prints a summary; exit code 1 if anything failed
 *
 * Usage: node test/run-tests.mjs [--verbose] [--skip-plugin]
 */

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

async function main() {
  const startedAt = Date.now()
  await prepareTmp()

  banner("mock ssh server")
  const server = await startMockServer({
    rootDir: REMOTE,
    verbose,
  })
  console.log(`listening on ${server.host}:${server.port}`)
  console.log(`user="${server.user}" password="${server.password}"`)
  console.log(`remote root = ${server.rootDir}`)

  const checks = []
  let fatalError = null

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
