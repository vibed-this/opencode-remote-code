/**
 * Suite: `activateIn` scoping + the 3.0.1 default changes.
 *
 * `node test/config-activate.mjs` — exit 0 = all PASS.
 *
 * Why this exists: the seven tools are NAME OVERRIDES, so an active plugin means
 * the session has no local file access at all. `activateIn` is the escape hatch —
 * one global config, remote tools only where the user asked for them. A bug here
 * is silent (the plugin just replaces the local tools everywhere), so the
 * boundary cases are spelled out.
 */
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"

import {
  DEFAULT_POOL,
  describeRemoteConfig,
  isWithinActivateIn,
  loadConfig,
  resolveActivateIn,
} from "../dist/config.js"
import { DEFAULT_IGNORE, DEFAULT_TOOL_LIMITS, resolveIgnore } from "../dist/limits.js"

let pass = 0
let fail = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    fail += 1
    failures.push(`${name}: ${error.message}`)
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const { hostname } = os
const isWin = process.platform === "win32"
const sessions = isWin ? "C:/Users/WIN11/.opencode/remote-sessions" : `${os.homedir()}/.opencode/remote-sessions`

/* ------------------------------- parsing -------------------------------- */

await check("resolveActivateIn: absent -> empty (always active)", () => {
  assert.deepEqual(resolveActivateIn(undefined), [])
  assert.deepEqual(resolveActivateIn(null), [])
  assert.deepEqual(resolveActivateIn([]), [])
})

await check("resolveActivateIn: single string is accepted", () => {
  const out = resolveActivateIn(sessions)
  assert.equal(out.length, 1)
  assert.equal(out[0], path.resolve(sessions))
})

await check("resolveActivateIn: trailing separator is stripped", () => {
  const out = resolveActivateIn([sessions + "/", sessions + path.sep])
  assert.deepEqual(out, [path.resolve(sessions), path.resolve(sessions)])
  assert.ok(!out[0].endsWith("/") && !out[0].endsWith("\\"))
})

await check("resolveActivateIn: ~ is expanded", () => {
  const out = resolveActivateIn("~/.opencode/remote-sessions")
  assert.equal(out[0], path.join(os.homedir(), ".opencode", "remote-sessions"))
})

await check("resolveActivateIn: junk entries are dropped", () => {
  const out = resolveActivateIn(["", "   ", 42, null, sessions])
  assert.equal(out.length, 1)
})

/* ------------------------------ matching -------------------------------- */

await check("isWithinActivateIn: exact match", () => {
  assert.equal(isWithinActivateIn([sessions], sessions), true)
})

await check("isWithinActivateIn: nested session directory", () => {
  assert.equal(isWithinActivateIn([sessions], `${sessions}/frp-use.com_C_Users_x_proj`), true)
})

await check("isWithinActivateIn: sibling with a shared name prefix is NOT inside", () => {
  // The classic boundary bug: `/a/remote-sessions-archive` must not match
  // `/a/remote-sessions`.
  assert.equal(isWithinActivateIn([sessions], `${sessions}-archive`), false)
  assert.equal(isWithinActivateIn([sessions], `${sessions}-archive/x`), false)
})

await check("isWithinActivateIn: parent / unrelated directory is NOT inside", () => {
  assert.equal(isWithinActivateIn([sessions], path.dirname(sessions)), false)
  assert.equal(isWithinActivateIn([sessions], os.homedir()), false)
  assert.equal(isWithinActivateIn([sessions], path.join(os.tmpdir(), "elsewhere")), false)
})

await check("isWithinActivateIn: backslashes and forward slashes are equivalent", () => {
  const slashed = sessions.replaceAll("\\", "/")
  const backslashed = sessions.replaceAll("/", "\\")
  assert.equal(isWithinActivateIn([slashed], `${slashed}/a`), true)
  assert.equal(isWithinActivateIn([backslashed], `${slashed}/a`), true)
})

await check("isWithinActivateIn: case-insensitive on Windows only", () => {
  const upper = sessions.toUpperCase()
  if (isWin) assert.equal(isWithinActivateIn([sessions], upper), true)
  else assert.equal(isWithinActivateIn([sessions], upper), false)
})

await check("isWithinActivateIn: extended-length prefix is tolerated", () => {
  if (!isWin) return
  assert.equal(isWithinActivateIn([sessions], `\\\\?\\${sessions.replaceAll("/", "\\")}\\x`), true)
})

await check("isWithinActivateIn: missing directory is outside (never guess)", () => {
  assert.equal(isWithinActivateIn([sessions], undefined), false)
  assert.equal(isWithinActivateIn([sessions], ""), false)
  assert.equal(isWithinActivateIn([sessions], "   "), false)
})

await check("isWithinActivateIn: empty roots -> every directory is outside", () => {
  // The caller skips the check entirely when the list is empty; the helper itself
  // must never claim "inside" for it.
  assert.equal(isWithinActivateIn([], sessions), false)
})

/* ------------------------------ config ---------------------------------- */

const base = { ssh: "ssh -p 2222 zxk@127.0.0.1" }

await check("loadConfig: activateIn defaults to []", () => {
  const config = loadConfig({ ...base })
  assert.deepEqual(config.activateIn, [])
})

await check("loadConfig: activateIn accepts a string and an array", () => {
  const one = loadConfig({ ...base, activateIn: sessions })
  assert.deepEqual(one.activateIn, [path.resolve(sessions)])

  const many = loadConfig({ ...base, activateIn: [sessions, path.join(os.tmpdir(), "x")] })
  assert.equal(many.activateIn.length, 2)
})

await check("loadConfig: kebab-case alias works", () => {
  const config = loadConfig({ ...base, "activate-in": sessions })
  assert.deepEqual(config.activateIn, [path.resolve(sessions)])
})

await check("describeRemoteConfig: reports the scope, never the password", () => {
  const always = describeRemoteConfig(loadConfig({ ...base }))
  assert.match(always, /scope=always/)

  const scoped = describeRemoteConfig(
    loadConfig({ ...base, password: "hunter2", activateIn: sessions })
  )
  assert.match(scoped, /scope=/)
  assert.ok(!scoped.includes("hunter2"))
})

/* ------------------------- changed 3.0.1 defaults ------------------------ */

await check("DEFAULT_POOL.file is 4 (walk issues up to 8 concurrent readdirs)", () => {
  assert.equal(DEFAULT_POOL.file, 4)
  const config = loadConfig({ ...base })
  assert.equal(config.pool.file, 4)
  assert.equal(config.pool.command, 3)
})

await check("pool option still overrides the defaults", () => {
  const config = loadConfig({ ...base, pool: { file: 2 } })
  assert.equal(config.pool.file, 2)
})

await check("walk/search time budget is 45 s", () => {
  assert.equal(DEFAULT_TOOL_LIMITS.searchMillis, 45_000)
  const config = loadConfig({ ...base })
  assert.equal(config.limits.searchMillis, 45_000)
})

await check("limits option still overrides the budget", () => {
  const config = loadConfig({ ...base, limits: { searchMillis: 5000 } })
  assert.equal(config.limits.searchMillis, 5000)
})

await check("ignore list covers volume-root noise", () => {
  for (const name of ["$RECYCLE.BIN", "System Volume Information", "Windows.old", ".pnpm-store", ".Trash"]) {
    assert.ok(DEFAULT_IGNORE.includes(name), `${name} missing from DEFAULT_IGNORE`)
  }
  // Still extends, never replaces.
  const extended = resolveIgnore(["custom-noise"])
  assert.ok(extended.includes("custom-noise"))
  assert.ok(extended.includes("node_modules"))
  assert.ok(extended.includes("$RECYCLE.BIN"))
})

await check("the walk ignore list matches the tool ignore list", async () => {
  const { DEFAULT_WALK_IGNORE } = await import("../dist/remote/walk.js")
  for (const name of ["$RECYCLE.BIN", "System Volume Information", ".pnpm-store"]) {
    assert.ok(DEFAULT_WALK_IGNORE.includes(name), `${name} missing from DEFAULT_WALK_IGNORE`)
  }
})

await check("search budget constants agree between limits.ts and search.ts", async () => {
  const { SEARCH_DEFAULTS } = await import("../dist/remote/search.js")
  const { WALK_DEFAULTS } = await import("../dist/remote/walk.js")
  assert.equal(SEARCH_DEFAULTS.maxMillis, DEFAULT_TOOL_LIMITS.searchMillis)
  assert.equal(WALK_DEFAULTS.maxMillis, DEFAULT_TOOL_LIMITS.searchMillis)
})

console.log(`\ntotal: PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log("\nfailures:")
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL")
process.exit(fail === 0 ? 0 : 1)
