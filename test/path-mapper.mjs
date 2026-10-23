/**
 * test/path-mapper.mjs — regression tests for PathMapper (dist build).
 *
 * Focus: `remoteWorkdir: "/"` used to make every path "outside the workspace"
 * (because the comparison was `root + "/"` -> `"//"`), which made the plugin
 * ask for permission on every single file access.
 *
 *   node test/path-mapper.mjs        # exit 0 = all PASS
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PathMapper } from "../dist/path-mapper.js"
import { loadConfig } from "../dist/config.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIRROR_ROOT = path.join(HERE, "tmp", "mirror")

/** Build a plain RemoteConfig object literal (same shape as src/config.ts). */
function makeConfig(overrides = {}) {
  return {
    sshCommand: "ssh u@h",
    host: "h",
    user: "u",
    port: 22,
    extraOptions: [],
    remoteWorkdir: "/",
    mirrorRoot: MIRROR_ROOT,
    active: true,
    ...overrides,
  }
}

function mapper(remoteWorkdir) {
  return new PathMapper(makeConfig({ remoteWorkdir }))
}

let pass = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`PASS ${name}`)
  } catch (err) {
    failures.push({ name, message: (err && err.message) || String(err) })
    console.log(`FAIL ${name}`)
    console.error(`     ${((err && err.message) || String(err)).split("\n").join("\n     ")}`)
  }
}

function expectThrow(fn) {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw, but it returned normally")
}

// ---------------------------------------------------------------------------
// 1. core regression: workdir "/" -> everything is inside the workspace
// ---------------------------------------------------------------------------
check('root workdir: "/" is within workspace', () => {
  const m = mapper("/")
  for (const p of ["/", "/etc/passwd", "/home/a/b.txt", "/tmp"]) {
    assert.equal(m.isWithinWorkspace(p), true, `expected isWithinWorkspace(${JSON.stringify(p)}) === true`)
  }
})

check('root workdir: remoteRoot is "/" and mirrorBase has a non-empty root slug', () => {
  const m = mapper("/")
  assert.equal(m.remoteRoot, "/")
  const rel = path.relative(MIRROR_ROOT, m.mirrorBase).split(path.sep)
  assert.equal(rel.length, 2, `mirrorBase should be mirrorRoot/host_slug/root_slug, got ${m.mirrorBase}`)
  assert.equal(rel[0], "u_h")
  assert.ok(rel[1].length > 0, "root slug must not be empty")
})

// ---------------------------------------------------------------------------
// 2. nested workdir boundary behaviour (must stay unchanged)
// ---------------------------------------------------------------------------
const INSIDE = ["/home/proj", "/home/proj/a.txt", "/home/proj/src/x.ts"]
const OUTSIDE = ["/home/project", "/home/proj2", "/home", "/etc/passwd"]

check('workdir "/home/proj": inside paths are within workspace', () => {
  const m = mapper("/home/proj")
  for (const p of INSIDE) {
    assert.equal(m.isWithinWorkspace(p), true, `expected isWithinWorkspace(${JSON.stringify(p)}) === true`)
  }
})

check('workdir "/home/proj": sibling/prefix paths are outside the workspace', () => {
  const m = mapper("/home/proj")
  for (const p of OUTSIDE) {
    assert.equal(m.isWithinWorkspace(p), false, `expected isWithinWorkspace(${JSON.stringify(p)}) === false`)
  }
})

check('workdir "/home/proj": ".." traversal out of the workspace is rejected', () => {
  const m = mapper("/home/proj")
  assert.equal(m.isWithinWorkspace("/home/proj/../etc/passwd"), false)
  assert.equal(m.isWithinWorkspace("/home/proj/src/../a.txt"), true)
})

// ---------------------------------------------------------------------------
// 3. trailing slash normalisation ("/home/proj/" === "/home/proj")
// ---------------------------------------------------------------------------
check('trailing slash: "/home/proj/" behaves exactly like "/home/proj"', () => {
  const plain = mapper("/home/proj")
  const slash = mapper("/home/proj/")
  assert.equal(slash.remoteRoot, "/home/proj", "remoteRoot should be normalised (no trailing slash)")
  assert.equal(slash.mirrorBase, plain.mirrorBase, "mirrorBase must not depend on a trailing slash")
  for (const p of INSIDE) {
    assert.equal(slash.isWithinWorkspace(p), true, `expected isWithinWorkspace(${JSON.stringify(p)}) === true`)
  }
  for (const p of OUTSIDE) {
    assert.equal(slash.isWithinWorkspace(p), false, `expected isWithinWorkspace(${JSON.stringify(p)}) === false`)
  }
  for (const p of ["/etc/passwd", "/home/proj/src/x.ts", "/home/proj"]) {
    assert.equal(slash.toLocal(p), plain.toLocal(p), `toLocal(${JSON.stringify(p)}) should match`)
  }
})

check('duplicate slashes / "." segments are normalised away', () => {
  const m = mapper("//home//proj/./")
  assert.equal(m.remoteRoot, "/home/proj")
  assert.equal(m.isWithinWorkspace("/home/proj/a.txt"), true)
})

// ---------------------------------------------------------------------------
// 4. root workdir round-trip: toRemote(toLocal(p)) === p
// ---------------------------------------------------------------------------
check('root workdir: toRemote(toLocal(p)) === p', () => {
  const m = mapper("/")
  assert.equal(m.toLocal("/"), m.mirrorBase)
  for (const p of ["/etc/passwd", "/home/a/b.txt", "/"]) {
    assert.equal(m.toRemote(m.toLocal(p)), p, `round-trip failed for ${JSON.stringify(p)}`)
  }
  assert.equal(m.toLocal("/etc/passwd"), path.join(m.mirrorBase, "etc", "passwd"))
})

check("root workdir: manifestPath() stays inside mirrorBase", () => {
  const m = mapper("/")
  assert.equal(m.manifestPath(), path.join(m.mirrorBase, "manifest.json"))
})

// ---------------------------------------------------------------------------
// 5. nested workdir round-trip (inside + outside)
// ---------------------------------------------------------------------------
check('workdir "/home/proj": inside path round-trips', () => {
  const m = mapper("/home/proj")
  const local = m.toLocal("/home/proj/src/main.ts")
  assert.equal(local, path.join(m.mirrorBase, "src", "main.ts"))
  assert.equal(m.toRemote(local), "/home/proj/src/main.ts")
  assert.equal(m.toRemote(m.toLocal("/home/proj")), "/home/proj")
})

check('workdir "/home/proj": outside path lands in mirrorBase and round-trips', () => {
  const m = mapper("/home/proj")
  const local = m.toLocal("/etc/passwd")
  assert.equal(local, path.join(m.mirrorBase, "etc", "passwd"))
  assert.equal(m.toRemote(local), "/etc/passwd")
})

check('workdir "/home/proj": the last mapping of a colliding local path wins', () => {
  // `/etc/passwd` (outside) and `/home/proj/etc/passwd` (inside) share one
  // local mirror path by design; toRemote() must follow the newest toLocal().
  const m = mapper("/home/proj")
  const outsideLocal = m.toLocal("/etc/passwd")
  const insideLocal = m.toLocal("/home/proj/etc/passwd")
  assert.equal(outsideLocal, insideLocal, "both remote paths map to the same local path")
  assert.equal(m.toRemote(insideLocal), "/home/proj/etc/passwd")
})

check("workdir \"/\": external round-trip is exact without any outside mapping", () => {
  // With root == "/", nothing is outside, so toRemote() must work purely from
  // the mirror layout (no bookkeeping involved).
  const m = mapper("/")
  assert.equal(m.toRemote(m.toLocal("/var/log/syslog")), "/var/log/syslog")
})

// ---------------------------------------------------------------------------
// 6. mirrorBase layout: "/" and "/home" must not shadow each other
// ---------------------------------------------------------------------------
check('mirrorBase: "/" and "/home" are disjoint (no prefix relationship)', () => {
  const root = mapper("/").mirrorBase
  const home = mapper("/home").mirrorBase
  assert.notEqual(root, home)
  assert.equal(root.startsWith(home + path.sep), false, `"/" mirrorBase must not be inside "/home" one`)
  assert.equal(home.startsWith(root + path.sep), false, `"/home" mirrorBase must not be inside "/" one`)
  assert.equal(root.startsWith(home), false, "raw prefix overlap would make rm -rf hit both")
  assert.equal(home.startsWith(root), false, "raw prefix overlap would make rm -rf hit both")
  for (const base of [root, home]) {
    const rel = path.relative(MIRROR_ROOT, base).split(path.sep)
    assert.equal(rel.length, 2, `expected mirrorRoot/host_slug/root_slug, got ${base}`)
    assert.equal(rel[0], "u_h")
    assert.ok(rel[1].length > 0, `root slug must not be empty, got ${base}`)
  }
  assert.notEqual(path.basename(root), path.basename(home))
})

// ---------------------------------------------------------------------------
// 7. relative workdir is a configuration error (and creates nothing)
// ---------------------------------------------------------------------------
check('relative workdir "home/proj" throws and creates no mirror', () => {
  const mirrorRoot = path.join(HERE, "tmp", "mirror-relative")
  const err = expectThrow(() => new PathMapper(makeConfig({ remoteWorkdir: "home/proj", mirrorRoot })))
  assert.match(err.message, /absolute/, `error should mention "absolute", got: ${err.message}`)
  assert.match(err.message, /workdir/, `error should name the "workdir" option, got: ${err.message}`)
  assert.equal(fs.existsSync(mirrorRoot), false, "constructor must not create any mirror directory")
})

check('empty workdir throws', () => {
  const err = expectThrow(() => mapper(""))
  assert.match(err.message, /absolute/)
})

// ---------------------------------------------------------------------------
// 8. unchanged behaviour: toLocal() rejects non-absolute remote paths
// ---------------------------------------------------------------------------
check('toLocal("relative/path") still throws', () => {
  const err = expectThrow(() => mapper("/").toLocal("relative/path"))
  assert.match(err.message, /must be absolute/, `got: ${err.message}`)
  expectThrow(() => mapper("/home/proj").toLocal("relative/path"))
})

check("toRemote() rejects local paths outside mirrorBase", () => {
  const m = mapper("/home/proj")
  const err = expectThrow(() => m.toRemote(path.join(HERE, "elsewhere", "x.txt")))
  assert.match(err.message, /outside mirror base/, `got: ${err.message}`)
})

// ---------------------------------------------------------------------------
// 9. loadConfig() validation of the workdir option
// ---------------------------------------------------------------------------
const ENV_KEYS = ["REMOTE_SSH", "REMOTE_WORKDIR", "REMOTE_PASSWORD", "REMOTE_SUDO_PASSWORD", "REMOTE_MIRROR"]
const savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))

function withCleanEnv(fn) {
  for (const k of ENV_KEYS) delete process.env[k]
  try {
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (savedEnv.get(k) === undefined) delete process.env[k]
      else process.env[k] = savedEnv.get(k)
    }
  }
}

check("loadConfig(): relative workdir throws with an actionable message", () => {
  withCleanEnv(() => {
    const err = expectThrow(() =>
      loadConfig({ ssh: "ssh u@h", workdir: "rel/dir", mirror: MIRROR_ROOT })
    )
    assert.match(err.message, /absolute/)
    assert.match(err.message, /workdir/)
    assert.match(err.message, /"\/home\/project"/, `expected a suggested value, got: ${err.message}`)
  })
})

check("loadConfig(): absolute workdir is accepted (including \"/\")", () => {
  withCleanEnv(() => {
    const nested = loadConfig({ ssh: "ssh u@h", workdir: "/home/proj", mirror: MIRROR_ROOT })
    assert.ok(nested, "expected a config object")
    assert.equal(nested.remoteWorkdir, "/home/proj")
    assert.equal(new PathMapper(nested).isWithinWorkspace("/home/proj/a.txt"), true)

    const root = loadConfig({ ssh: "ssh u@h", workdir: "/", mirror: MIRROR_ROOT })
    assert.ok(root, "expected a config object")
    assert.equal(new PathMapper(root).isWithinWorkspace("/etc/passwd"), true)
  })
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
console.log("")
const total = pass + failures.length
console.log(`total: PASS=${pass} FAIL=${failures.length} (${total} checks)`)
if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED ${f.name}: ${f.message}`)
  process.exit(1)
}
process.exit(0)
