/**
 * test/plugin-entry.mjs — regression tests for how OpenCode v2 loads this plugin.
 *
 * V2 resolves a local plugin **directory** to `<dir>/index.js` or `<dir>/server.js`
 * and ignores `package.json` `main` / `exports` entirely. Before the root
 * `index.js` shim existed, pointing `plugins[].package` at this repo was silently
 * skipped: no "loading plugin" log, no error, plugin simply never ran
 * (measured on opencode v2.1.0, Windows).
 *
 *   node test/plugin-entry.mjs        # exit 0 = all PASS
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")

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

// ---------------------------------------------------------------------------
// 1. the entrypoints V2's directory resolution looks for must exist
// ---------------------------------------------------------------------------
await check("repo root has index.js (V2 directory entrypoint)", () => {
  const root = path.join(REPO_ROOT, "index.js")
  assert.ok(fs.existsSync(root), `missing ${root}`)
})

await check("build output dist/index.js exists (run `npm run build`)", () => {
  const dist = path.join(REPO_ROOT, "dist", "index.js")
  assert.ok(fs.existsSync(dist), `missing ${dist} — run \`npm run build\` first`)
})

// ---------------------------------------------------------------------------
// 2. the shim must expose the same plugin definition as the build output
// ---------------------------------------------------------------------------
const rootModule = await import(pathToFileURL(path.join(REPO_ROOT, "index.js")).href)
const distModule = await import(pathToFileURL(path.join(REPO_ROOT, "dist", "index.js")).href)

await check("root shim re-exports a V2 definition (id + setup)", () => {
  const def = rootModule.default
  assert.equal(typeof def, "object", "default export must be an object, not a function (that is V1)")
  assert.equal(def.id, "remote-code")
  assert.equal(typeof def.setup, "function")
})

await check("root shim and dist default export are the same definition", () => {
  assert.equal(rootModule.default.id, distModule.default.id)
  assert.equal(typeof rootModule.default.setup, typeof distModule.default.setup)
})

await check("root shim re-exports the named exports", () => {
  const named = Object.keys(distModule).sort()
  for (const key of named) {
    assert.ok(key in rootModule, `root shim is missing named export "${key}"`)
  }
})

// ---------------------------------------------------------------------------
// 3. package.json must not advertise an entrypoint V2 would trust
// ---------------------------------------------------------------------------
await check('package.json keeps "type": "module" so the shim is ESM', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"))
  assert.equal(pkg.type, "module")
  assert.equal(pkg.name, "opencode-remote-code")
})

console.log("")
if (failures.length > 0) {
  console.log(`total: PASS=${pass} FAIL=${failures.length}`)
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  console.log("RESULT: FAIL")
  process.exit(1)
}
console.log(`total: PASS=${pass} FAIL=0`)
console.log("RESULT: PASS")
