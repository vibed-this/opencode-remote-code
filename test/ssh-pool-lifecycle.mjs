/**
 * ssh-pool-lifecycle.mjs — lifecycle / resource-leak tests for the SSH pool.
 *
 * Regression coverage for:
 *   1. a failed `createSSHPool()` must not leave a 30s health-check interval
 *      behind (and therefore cannot spin a 5s "replenish forever" loop);
 *   2. the process must be able to exit on its own after that failure;
 *   3. `close()` is idempotent, and calls after close reject instead of hanging;
 *   4. queued `acquire()` waiters are rejected (not orphaned) by `close()`.
 *
 * Plain Node ESM, no test framework. Imports the compiled output.
 *
 * Usage: node test/ssh-pool-lifecycle.mjs
 */

import assert from "node:assert"
import { spawn } from "node:child_process"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { startMockServer } from "./mock-ssh-server.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const TMP = path.join(HERE, "tmp")
const REMOTE_DIR = path.join(TMP, "lifecycle-remote")
const DIST_POOL = path.join(ROOT, "dist", "ssh-pool.js")

const results = []

function pass(name, detail = "") {
  results.push({ name, ok: true })
  console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`)
}

function fail(name, err) {
  results.push({ name, ok: false })
  console.log(`FAIL ${name}: ${(err && err.message) || err}`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    pass(name, detail)
  } catch (err) {
    fail(name, err)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Reject if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${ms}ms`)),
      ms
    )
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Assert that `promise` rejects, returning the error. */
async function expectReject(promise, label, ms = 2000) {
  try {
    const value = await withTimeout(promise, ms, label)
    throw new Error(`${label} resolved unexpectedly: ${JSON.stringify(value)}`)
  } catch (err) {
    if (err && err.message && err.message.includes("did not settle within")) throw err
    return err
  }
}

function makeConfig(port, extra = {}) {
  return {
    sshCommand: `ssh -p ${port} user@127.0.0.1`,
    host: "127.0.0.1",
    port,
    user: "testuser",
    extraOptions: [],
    remoteWorkdir: REMOTE_DIR,
    mirrorRoot: path.join(TMP, "lifecycle-mirror"),
    active: true,
    ...extra,
  }
}

async function loadPool() {
  try {
    return await import(pathToFileURL(DIST_POOL).href)
  } catch (err) {
    throw new Error(
      `cannot import ${DIST_POOL} — run "npm run build" first (${err.message})`
    )
  }
}

function timeoutResourceCount() {
  if (typeof process.getActiveResourcesInfo !== "function") return undefined
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length
}

/** Silence console.error/console.warn while counting calls. */
function captureLogs() {
  const counters = { error: 0, warn: 0, messages: [] }
  const origError = console.error
  const origWarn = console.warn
  const wrap = (kind, orig) =>
    function (...args) {
      counters[kind]++
      if (counters.messages.length < 20) {
        counters.messages.push(`[${kind}] ${args.map(String).join(" ")}`)
      }
      // Swallow: these are the expected noisy failure logs.
    }
  console.error = wrap("error", origError)
  console.warn = wrap("warn", origWarn)
  return {
    counters,
    restore() {
      console.error = origError
      console.warn = origWarn
    },
  }
}

/** Pick a TCP port that is certainly closed. */
async function closedPort() {
  const net = await import("node:net")
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/* -------------------------------------------------------------------------- */
/* test 1 + 2: failed startup leaves no timers / nothing spinning             */
/* -------------------------------------------------------------------------- */

async function testFailureLeavesNoTimers() {
  const { createSSHPool } = await loadPool()
  const port = await closedPort()

  process.env.REMOTE_POOL_COMMAND_SIZE = "1"
  process.env.REMOTE_POOL_FILE_SIZE = "1"
  process.env.REMOTE_POOL_STAGGER_MS = "0"

  const logs = captureLogs()
  const startedAt = Date.now()
  let rejectError
  let firstTimeouts
  try {
    const err = await expectReject(
      createSSHPool(makeConfig(port)),
      "createSSHPool against a closed port",
      15000
    )
    rejectError = err
    firstTimeouts = timeoutResourceCount()

    // Watch for ~8s: a leaked health-check timer would fire once at 30s only,
    // but a leaked *replenish loop* logs every 5s. Both are caught by the
    // combination of (a) bounded log count and (b) flat Timeout count below.
    const samples = [firstTimeouts]
    for (let i = 0; i < 4; i++) {
      await sleep(2000)
      samples.push(timeoutResourceCount())
    }

    const elapsed = Date.now() - startedAt
    assert.ok(
      err && err.message,
      `createSSHPool must reject with an Error, got: ${String(err)}`
    )

    const logCount = logs.counters.error + logs.counters.warn
    assert.ok(
      logCount <= 4,
      `expected at most 4 error/warn calls after a failed startup, got ${logCount}: ` +
        JSON.stringify(logs.counters.messages)
    )

    if (firstTimeouts !== undefined) {
      const last = samples[samples.length - 1]
      // Requirement: the count must not *grow* while we wait. It may drop
      // (e.g. the connect-timeout timer settles), which is fine.
      assert.ok(
        last <= firstTimeouts,
        `active Timeout resources grew after startup failure: ${JSON.stringify(samples)}`
      )
    }
    return `${elapsed}ms, logs=${logCount}, timeouts=${JSON.stringify(samples)}`
  } finally {
    logs.restore()
  }
}

/**
 * Stronger version of "the process can exit on its own": a child process that
 * only does `createSSHPool()` against a closed port must exit without
 * `process.exit()` and without being killed. A leaked interval would keep the
 * event loop alive forever.
 */
async function testChildProcessExitsNaturally() {
  const port = await closedPort()
  const poolUrl = pathToFileURL(DIST_POOL).href
  const script = `
const { createSSHPool } = await import(${JSON.stringify(poolUrl)})
const config = {
  sshCommand: "ssh -p ${port} user@127.0.0.1",
  host: "127.0.0.1",
  port: ${port},
  user: "testuser",
  extraOptions: [],
  remoteWorkdir: ".",
  mirrorRoot: ".",
  active: true,
}
try {
  await createSSHPool(config)
  console.log("UNEXPECTED_SUCCESS")
  process.exitCode = 2
} catch (err) {
  console.log("REJECTED:" + err.message)
}
// Deliberately no process.exit(): a leaked interval/socket would hang here.
`
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: {
      ...process.env,
      REMOTE_POOL_COMMAND_SIZE: "1",
      REMOTE_POOL_FILE_SIZE: "1",
      REMOTE_POOL_STAGGER_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (d) => (stdout += d.toString()))
  child.stderr.on("data", (d) => (stderr += d.toString()))

  const startedAt = Date.now()
  const exit = await withTimeout(
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    15000,
    "child process waiting on createSSHPool failure"
  ).catch((err) => {
    try {
      child.kill("SIGKILL")
    } catch {
      /* ignore */
    }
    throw err
  })

  const elapsed = Date.now() - startedAt
  assert.equal(exit.code, 0, `child exited with ${JSON.stringify(exit)}; stderr=${stderr}`)
  assert.match(stdout, /REJECTED:/, `child did not report a rejection; stdout=${stdout}`)
  return `exited naturally in ${elapsed}ms`
}

/* -------------------------------------------------------------------------- */
/* tests 3 + 4: real mock SSH server                                          */
/* -------------------------------------------------------------------------- */

async function testCloseIsIdempotentAndTerminal(server) {
  const { createSSHPool } = await loadPool()

  process.env.REMOTE_POOL_COMMAND_SIZE = "2"
  process.env.REMOTE_POOL_FILE_SIZE = "1"
  process.env.REMOTE_POOL_STAGGER_MS = "0"

  const pool = await createSSHPool(
    makeConfig(server.port, { password: server.password, user: server.user })
  )
  try {
    const result = await pool.exec("echo hi")
    assert.match(result.stdout, /hi/, `unexpected stdout: ${JSON.stringify(result.stdout)}`)

    // Two closes in a row must not throw.
    await pool.close()
    await pool.close()

    // Calls after close must reject immediately, not hang.
    const execErr = await expectReject(pool.exec("echo after-close"), "exec() after close")
    assert.match(
      execErr.message,
      /destroyed|closed/i,
      `unexpected post-close error: ${execErr.message}`
    )

    const sftpErr = await expectReject(
      pool.withSftp(async () => "never"),
      "withSftp() after close"
    )
    assert.match(
      sftpErr.message,
      /destroyed|closed/i,
      `unexpected post-close SFTP error: ${sftpErr.message}`
    )

    return "exec ok, double close ok, post-close calls rejected"
  } finally {
    await pool.close().catch(() => {})
  }
}

async function testQueuedWaiterRejectedOnClose(server) {
  const { createSSHPool } = await loadPool()

  // Single command connection: the second exec has nowhere to go and queues.
  process.env.REMOTE_POOL_COMMAND_SIZE = "1"
  process.env.REMOTE_POOL_FILE_SIZE = "1"
  process.env.REMOTE_POOL_STAGGER_MS = "0"

  const pool = await createSSHPool(
    makeConfig(server.port, { password: server.password, user: server.user })
  )
  try {
    const execsBefore = server.stats.execs

    // Occupy the only connection with a long-running command.
    const holder = pool.exec("sleep 4")
    holder.catch(() => {})

    // Wait until the mock server actually started it (=> client is busy).
    const deadline = Date.now() + 5000
    while (server.stats.execs === execsBefore && Date.now() < deadline) {
      await sleep(25)
    }
    assert.ok(server.stats.execs > execsBefore, "holder command never started on the server")

    // This one must sit in the queue.
    const queued = pool.exec("echo queued")
    queued.catch(() => {})
    await sleep(100)

    const startedAt = Date.now()
    await pool.close()
    const err = await expectReject(queued, "queued exec after close", 2000)
    const elapsed = Date.now() - startedAt

    assert.match(
      err.message,
      /closed|destroyed/i,
      `queued exec should fail with a closed-pool error, got: ${err.message}`
    )
    await holder.catch(() => {})

    return `queued exec rejected in ${elapsed}ms: ${err.message}`
  } finally {
    await pool.close().catch(() => {})
  }
}

/* -------------------------------------------------------------------------- */
/* test 5: a runtime outage triggers a bounded, self-terminating replenish    */
/* -------------------------------------------------------------------------- */

/**
 * Start a healthy pool against the mock server, then kill the server. The next
 * `exec()` finds an undersized pool and kicks off `replenish()`. That call must
 * finish on its own (max 3 attempts, 5s/10s backoff) and log a summary instead
 * of retrying every 5s forever.
 */
async function testReplenishIsBounded(server) {
  const { createSSHPool } = await loadPool()

  process.env.REMOTE_POOL_COMMAND_SIZE = "1"
  process.env.REMOTE_POOL_FILE_SIZE = "1"
  process.env.REMOTE_POOL_STAGGER_MS = "0"

  const pool = await createSSHPool(
    makeConfig(server.port, { password: server.password, user: server.user })
  )
  const logs = captureLogs()
  try {
    const ok = await pool.exec("echo before-outage")
    assert.match(ok.stdout, /before-outage/)

    // Kill the server out from under the pool and wait for connections to drop.
    await server.close()
    const dropDeadline = Date.now() + 5000
    while (Date.now() < dropDeadline) {
      // A healthy pool has a live connection; once the server is gone every
      // acquire must fail or queue, which we detect below.
      const probe = pool.exec("echo probe").catch(() => "rejected")
      const settled = await Promise.race([
        probe,
        sleep(300).then(() => "pending"),
      ])
      if (settled === "pending") break
      await sleep(200)
    }

    // This exec is stuck in the queue while replenish() retries against a dead
    // port. Wait long enough for 3 attempts + 5s + 10s of backoff.
    const queued = pool.exec("echo during-outage")
    queued.catch(() => {})

    const giveUpDeadline = Date.now() + 25000
    let gaveUp = false
    while (Date.now() < giveUpDeadline) {
      if (logs.counters.messages.some((m) => m.includes("giving up replenishing"))) {
        gaveUp = true
        break
      }
      await sleep(250)
    }

    assert.ok(
      gaveUp,
      `replenish() never gave up; logs=${JSON.stringify(logs.counters.messages)}`
    )

    const failLogs = logs.counters.error
    // 1 = first failure of the round, 2 = summary on giving up. Nothing more.
    assert.ok(
      failLogs <= 3,
      `expected <= 3 error logs for one bounded replenish round, got ${failLogs}: ` +
        JSON.stringify(logs.counters.messages)
    )

    // Let a few more seconds pass: a still-spinning loop would keep logging.
    const settledCount = logs.counters.error
    await sleep(6000)
    assert.equal(
      logs.counters.error,
      settledCount,
      `replenish() kept logging after giving up: ${JSON.stringify(logs.counters.messages)}`
    )

    await pool.close()
    const err = await expectReject(queued, "queued exec after outage + close", 2000)
    assert.match(err.message, /closed|destroyed/i)
    return `gave up after bounded retries, logs=${failLogs}`
  } finally {
    logs.restore()
    await pool.close().catch(() => {})
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  if (typeof process.getActiveResourcesInfo !== "function") {
    console.log("note: process.getActiveResourcesInfo() unavailable; relying on log counts")
  }

  await fsp.mkdir(REMOTE_DIR, { recursive: true })

  await check("failed startup does not leave timers or a retry storm", testFailureLeavesNoTimers)
  await check("process exits naturally after failed startup", testChildProcessExitsNaturally)

  let server
  try {
    server = await startMockServer({ rootDir: REMOTE_DIR })
    await check("close() is idempotent and terminal", () =>
      testCloseIsIdempotentAndTerminal(server)
    )
    await check("close() rejects queued waiters", () => testQueuedWaiterRejectedOnClose(server))
  } catch (err) {
    fail("start mock ssh server", err)
  } finally {
    if (server) await server.close().catch(() => {})
  }

  // Dedicated server for the outage test (the previous one gets killed).
  let outageServer
  try {
    outageServer = await startMockServer({ rootDir: REMOTE_DIR })
    await check("replenish() is bounded and self-terminating", () =>
      testReplenishIsBounded(outageServer)
    )
  } catch (err) {
    fail("start mock ssh server (outage)", err)
  } finally {
    if (outageServer) await outageServer.close().catch(() => {})
    await fsp.rm(REMOTE_DIR, { recursive: true, force: true }).catch(() => {})
    await fsp
      .rm(path.join(TMP, "lifecycle-mirror"), { recursive: true, force: true })
      .catch(() => {})
  }

  const failed = results.filter((r) => !r.ok).length
  console.log("")
  console.log(`total: PASS=${results.length - failed} FAIL=${failed}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("FATAL", (err && err.stack) || err)
  process.exit(1)
})
