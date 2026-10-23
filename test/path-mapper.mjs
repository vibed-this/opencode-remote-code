/**
 * test/path-mapper.mjs — PathMapper / ManifestManager / SyncEngine (mirror v3).
 *
 * Covers DESIGN-V3 §8 (namespace layout, manifest v2, per-file sync), §5.2
 * (case-insensitive collisions) and risk S5 (local long paths).
 *
 *   npm run build && node test/path-mapper.mjs      # exit 0 = all PASS
 *
 * Imports the BUILT code from ../dist/mirror/*.js and ../dist/platform/path.js —
 * never from src/.
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PathMapper } from "../dist/mirror/path-mapper.js"
import { ManifestManager } from "../dist/mirror/manifest.js"
import { SyncEngine } from "../dist/mirror/sync.js"
import { createPathOps, posixPathOps } from "../dist/platform/path.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(HERE, "tmp", "path-mapper-v3")
const MIRROR_ROOT = path.join(TMP, "mirrors")

const USER = "zxk"
const HOST = "frp-oil.com"
const PORT = 48713
const SLUG = "zxk-frp-oil-com"
const HASH6 = createHash("sha256").update(`${USER}@${HOST}:${PORT}`, "utf8").digest("hex").slice(0, 6)

let pass = 0
let skipped = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS ${name}`)
  } catch (err) {
    const message = (err && err.message) || String(err)
    failures.push({ name, message })
    console.log(`FAIL ${name}`)
    console.error(`     ${message.split("\n").join("\n     ")}`)
  }
}

function skip(name, why) {
  skipped++
  console.log(`SKIP ${name} (${why})`)
}

function expectThrow(fn, pattern) {
  let caught
  try {
    fn()
  } catch (err) {
    caught = err
  }
  if (!caught) throw new Error("expected the call to throw, but it returned normally")
  if (pattern) {
    assert.match(caught.message, pattern, `unexpected error message: ${caught.message}`)
  }
  return caught
}

function mapper(kind, remoteRoot, extra = {}) {
  return new PathMapper({
    mirrorRoot: MIRROR_ROOT,
    user: USER,
    host: HOST,
    port: PORT,
    remoteRoot,
    ops: createPathOps(kind),
    ...extra,
  })
}

/** Local path expected for a remote path whose mirror segments are `segments`. */
function expectLocal(m, remote, segments) {
  assert.equal(m.toLocal(remote), path.join(m.mirrorNamespace, ...segments))
}

// ===========================================================================
// 1. mapping tables — posix
// ===========================================================================
const POSIX_TABLE = [
  // [remote, expected segments under the namespace]
  ["/", ["root"]],
  ["/home", ["root", "home"]],
  ["/home/zxk", ["root", "home", "zxk"]],
  ["/home/zxk/proj", ["root", "home", "zxk", "proj"]],
  ["/home/zxk/proj/src/a.ts", ["root", "home", "zxk", "proj", "src", "a.ts"]],
  ["/etc/passwd", ["root", "etc", "passwd"]],
  ["/etc/shadow", ["root", "etc", "shadow"]],
  ["/tmp/x.log", ["root", "tmp", "x.log"]],
  ["/var/log/syslog", ["root", "var", "log", "syslog"]],
  ["/usr/local/lib/node_modules/x/index.js", ["root", "usr", "local", "lib", "node_modules", "x", "index.js"]],
  ["/root/.ssh/authorized_keys", ["root", "root", ".ssh", "authorized_keys"]],
  ["/home/zxk/proj/.gitignore", ["root", "home", "zxk", "proj", ".gitignore"]],
  ["/home/zxk/proj/src/üñï.ts", ["root", "home", "zxk", "proj", "src", "üñï.ts"]],
  ["/home/zxk/proj/a b/c.ts", ["root", "home", "zxk", "proj", "a b", "c.ts"]],
  ["/mnt/data/back\\slash.ts", ["root", "mnt", "data", "back\\slash.ts"]],
]

await check("posix: mapping table (in-workspace, out-of-workspace, root)", () => {
  const m = mapper("posix", "/home/zxk/proj")
  for (const [remote, segments] of POSIX_TABLE) expectLocal(m, remote, segments)
})

await check("posix: toRemote(toLocal(p)) === p for the whole table", () => {
  const m = mapper("posix", "/home/zxk/proj")
  for (const [remote] of POSIX_TABLE) {
    assert.equal(m.toRemote(m.toLocal(remote)), remote, `round-trip failed for ${JSON.stringify(remote)}`)
  }
})

await check("posix: root workdir '/' keeps the same rule and round-trips", () => {
  const m = mapper("posix", "/")
  assert.equal(m.remoteRoot, "/")
  expectLocal(m, "/", ["root"])
  expectLocal(m, "/etc/passwd", ["root", "etc", "passwd"])
  expectLocal(m, "/home/a/b.txt", ["root", "home", "a", "b.txt"])
  for (const p of ["/", "/etc/passwd", "/home/a/b.txt", "/var/log/syslog"]) {
    assert.equal(m.toRemote(m.toLocal(p)), p, `round-trip failed for ${JSON.stringify(p)}`)
  }
})

await check("posix: mirrorBase is the workspace dir, not the namespace root", () => {
  const m = mapper("posix", "/home/zxk/proj")
  assert.equal(m.mirrorBase, path.join(m.mirrorNamespace, "root", "home", "zxk", "proj"))
  assert.equal(m.mirrorBase, m.toLocal(m.remoteRoot))
})

// ===========================================================================
// 2. mapping tables — windows
// ===========================================================================
const WINDOWS_TABLE = [
  ["C:/", ["C"]],
  ["C:/Users", ["C", "Users"]],
  ["C:/Users/zxk", ["C", "Users", "zxk"]],
  ["C:/Users/zxk/proj", ["C", "Users", "zxk", "proj"]],
  ["C:/Users/zxk/proj/src/a.ts", ["C", "Users", "zxk", "proj", "src", "a.ts"]],
  ["C:/Windows/System32/drivers/etc/hosts", ["C", "Windows", "System32", "drivers", "etc", "hosts"]],
  ["D:/", ["D"]],
  ["D:/data/x.txt", ["D", "data", "x.txt"]],
  ["D:/data/v2/report final.docx", ["D", "data", "v2", "report final.docx"]],
  ["C:/Program Files/App/x.dll", ["C", "Program Files", "App", "x.dll"]],
  ["C:/Users/zxk/AppData/Roaming/npm/cache/_cacache/tmp/a", ["C", "Users", "zxk", "AppData", "Roaming", "npm", "cache", "_cacache", "tmp", "a"]],
  ["C:/Users/zxk/proj/.gitignore", ["C", "Users", "zxk", "proj", ".gitignore"]],
  ["C:/Users/zxk/proj/src/üñï.ts", ["C", "Users", "zxk", "proj", "src", "üñï.ts"]],
  ["C:/Users/zxk/Desktop/新 文件.txt", ["C", "Users", "zxk", "Desktop", "新 文件.txt"]],
  ["C:/a.ts", ["C", "a.ts"]],
]

await check("windows: mapping table (in-workspace, out-of-workspace, drive root)", () => {
  const m = mapper("windows", "C:/Users/zxk/proj")
  for (const [remote, segments] of WINDOWS_TABLE) expectLocal(m, remote, segments)
})

await check("windows: toRemote(toLocal(p)) === p for the whole table", () => {
  const m = mapper("windows", "C:/Users/zxk/proj")
  for (const [remote] of WINDOWS_TABLE) {
    assert.equal(m.toRemote(m.toLocal(remote)), remote, `round-trip failed for ${JSON.stringify(remote)}`)
  }
})

await check("windows: lowercase drive / backslash input normalises before mapping", () => {
  // A case-sensitive local host, so the comparison below is purely about
  // normalisation and not about §5.2 collision suffixes.
  const m = mapper("windows", "C:/Users/zxk/proj", { localPlatform: "linux" })
  assert.equal(m.toLocal("c:\\Users\\zxk\\proj\\src\\a.ts"), m.toLocal("C:/Users/zxk/proj/src/a.ts"))
  assert.equal(m.toRemote(m.toLocal("c:\\Users\\zxk\\proj\\src\\a.ts")), "C:/Users/zxk/proj/src/a.ts")
  // Case of the *remote* path is preserved everywhere below the drive letter (§5.1).
  assert.notEqual(m.toLocal("C:/Users/zxk/proj/Src/a.ts"), m.toLocal("C:/Users/zxk/proj/src/a.ts"))
  // On a win32 local host those two spellings are the same file and therefore
  // collide → the second one gets the `~2` suffix (§5.2).
  const win = mapper("windows", "C:/Users/zxk/proj", { localPlatform: "win32" })
  assert.equal(path.basename(win.toLocal("C:/users/zxk/proj/src/a.ts")), "a.ts")
  assert.equal(path.basename(win.toLocal("C:/Users/zxk/proj/src/a.ts")), "a~2.ts")
})

await check("windows: root workdir 'C:/' maps every drive path under its own token", () => {
  const m = mapper("windows", "C:/")
  assert.equal(m.remoteRoot, "C:/")
  assert.equal(m.mirrorBase, path.join(m.mirrorNamespace, "C"))
  expectLocal(m, "C:/Users/x/a.ts", ["C", "Users", "x", "a.ts"])
  expectLocal(m, "D:/data/x.txt", ["D", "data", "x.txt"])
  assert.equal(m.toRemote(m.toLocal("C:/")), "C:/")
  assert.equal(m.toRemote(m.toLocal("D:/data/x.txt")), "D:/data/x.txt")
})

await check("windows: UNC paths get their own root token (best effort, §5.1)", () => {
  const m = mapper("windows", "C:/Users/zxk/proj")
  expectLocal(m, "//srv/share/a.ts", ["unc", "srv", "share", "a.ts"])
  assert.equal(m.toRemote(m.toLocal("//srv/share/a.ts")), "//srv/share/a.ts")
})

await check("windows: drive-relative and drive-less paths are rejected", () => {
  const m = mapper("windows", "C:/Users/zxk/proj")
  for (const bad of ["/Users/x", "C:foo", "relative/x.ts", ""]) {
    expectThrow(() => m.toLocal(bad), /absolute|non-empty/)
  }
})

// ===========================================================================
// 3. namespace shape
// ===========================================================================
await check("namespace: <mirrorRoot>/<hostSlug>-<hash6>", () => {
  const m = mapper("posix", "/home/zxk/proj")
  const name = path.basename(m.mirrorNamespace)
  assert.equal(name, `${SLUG}-${HASH6}`)
  assert.match(name, /^[a-z0-9-]+-[0-9a-f]{6}$/)
  assert.equal(path.dirname(m.mirrorNamespace), path.resolve(MIRROR_ROOT))
  assert.ok(m.mirrorBase.startsWith(m.mirrorNamespace + path.sep), "mirrorBase must live inside the namespace")
  assert.equal(m.manifestPath(), path.join(m.mirrorNamespace, "manifest.json"))
})

await check("namespace: slug is lowercase and non-alphanumerics become '-'", () => {
  const m = new PathMapper({
    mirrorRoot: MIRROR_ROOT,
    user: "Zhou.XiaoKang",
    host: "FRP-Use.COM",
    port: 22,
    remoteRoot: "/srv/app",
    ops: createPathOps("posix"),
  })
  assert.match(path.basename(m.mirrorNamespace), /^zhou-xiaokang-frp-use-com-[0-9a-f]{6}$/)
})

await check("namespace: port is part of the hash, so two ports never share a namespace", () => {
  const a = new PathMapper({ mirrorRoot: MIRROR_ROOT, user: USER, host: HOST, port: 22, remoteRoot: "/srv", ops: createPathOps("posix") })
  const b = new PathMapper({ mirrorRoot: MIRROR_ROOT, user: USER, host: HOST, port: 2222, remoteRoot: "/srv", ops: createPathOps("posix") })
  assert.notEqual(a.mirrorNamespace, b.mirrorNamespace)
})

await check("namespace: the same target in two workdirs shares the namespace but not mirrorBase", () => {
  const a = mapper("posix", "/home/zxk/proj")
  const b = mapper("posix", "/home/zxk/other")
  assert.equal(a.mirrorNamespace, b.mirrorNamespace)
  assert.notEqual(a.mirrorBase, b.mirrorBase)
})

// ===========================================================================
// 4. workspace boundary
// ===========================================================================
await check("boundary posix: inside vs sibling-prefix vs outside", () => {
  const m = mapper("posix", "/home/zxk/proj")
  for (const p of ["/home/zxk/proj", "/home/zxk/proj/a.ts", "/home/zxk/proj/src/x.ts", "/home/zxk/proj/src/../a.ts"]) {
    assert.equal(m.isWithinWorkspace(p), true, `expected inside: ${p}`)
  }
  for (const p of ["/home/project", "/home/zxk/proj2", "/home/zxk", "/etc/passwd", "/home/zxk/proj/../../etc", "relative/x", ""]) {
    assert.equal(m.isWithinWorkspace(p), false, `expected outside: ${p}`)
  }
})

await check("boundary posix: root workdir swallows everything", () => {
  const m = mapper("posix", "/")
  for (const p of ["/", "/etc/passwd", "/home/a/b.txt", "/tmp"]) {
    assert.equal(m.isWithinWorkspace(p), true, `expected inside: ${p}`)
  }
})

await check("boundary windows: case-insensitive containment (§5.2)", () => {
  const m = mapper("windows", "C:/users/x")
  for (const p of ["C:/users/x", "C:/Users/X/p", "C:/USERS/x/a/b.ts", "c:/users/x/p"]) {
    assert.equal(m.isWithinWorkspace(p), true, `expected inside: ${p}`)
  }
})

await check("boundary windows: sibling-prefix trap and drive escape", () => {
  const m = mapper("windows", "C:/Users/x")
  for (const p of ["C:/Users/xyz", "C:/Users/x2/p", "C:/Users", "D:/Users/x", "C:/Windows"]) {
    assert.equal(m.isWithinWorkspace(p), false, `expected outside: ${p}`)
  }
})

await check("boundary windows: root drive 'C:/' contains everything on C: only", () => {
  const m = mapper("windows", "C:/")
  assert.equal(m.isWithinWorkspace("C:/"), true)
  assert.equal(m.isWithinWorkspace("C:/Windows/System32"), true)
  assert.equal(m.isWithinWorkspace("c:/users/x"), true)
  assert.equal(m.isWithinWorkspace("D:/data"), false)
})

await check("boundary windows: drive-less absolute is not in the workspace", () => {
  const m = mapper("windows", "C:/Users/x")
  assert.equal(m.isWithinWorkspace("/Users/x/p"), false)
})

// ===========================================================================
// 5. escape guard
// ===========================================================================
await check("guard: toRemote rejects local paths outside the namespace", () => {
  const m = mapper("posix", "/home/zxk/proj")
  expectThrow(() => m.toRemote(path.join(HERE, "elsewhere", "x.txt")), /outside the mirror namespace/)
  expectThrow(() => m.toRemote(path.join(MIRROR_ROOT, "some-other-namespace", "root", "etc", "passwd")), /outside the mirror namespace/)
})

await check("guard: a local resolution that escapes the namespace throws (toLocal)", () => {
  const posix = posixPathOps
  let armed = false
  // A hostile/degenerate RemotePathOps that hands out ".." segments: the guard
  // must be a real check, not a by-product of normalisation.
  const evilOps = {
    ...posix,
    kind: "posix",
    normalize: (p) => p,
    isAbsolute: () => true,
    segments: () => (armed ? ["..", "..", "escaped"] : []),
  }
  const m = new PathMapper({
    mirrorRoot: MIRROR_ROOT,
    user: USER,
    host: HOST,
    port: PORT,
    remoteRoot: "/work",
    ops: evilOps,
  })
  armed = true
  expectThrow(() => m.toLocal("/work/x"), /escapes the mirror namespace/)
})

await check("guard: real '..' traffic can never leave the namespace", () => {
  const posix = mapper("posix", "/home/zxk/proj")
  for (const p of ["/home/zxk/proj/../../../../etc/passwd", "/../../etc/passwd", "/home/zxk/proj/src/../../.."]) {
    const local = posix.toLocal(p)
    assert.ok(local.startsWith(posix.mirrorNamespace + path.sep), `${p} -> ${local}`)
  }
  const win = mapper("windows", "C:/Users/zxk/proj")
  for (const p of ["C:/../Windows/x.dll", "C:/Users/zxk/proj/../../Windows"]) {
    const local = win.toLocal(p)
    assert.ok(local.startsWith(win.mirrorNamespace + path.sep), `${p} -> ${local}`)
  }
})

// ===========================================================================
// 6. case-insensitive collisions (§5.2 / risk S4)
// ===========================================================================
await check("collision: win32 local host suffixes the second path and stays reversible", () => {
  const m = mapper("windows", "C:/Users/x", { localPlatform: "win32" })
  const a = m.toLocal("C:/Users/x/a.ts")
  const b = m.toLocal("C:/Users/x/A.ts")
  const c = m.toLocal("C:/Users/x/a.TS")

  assert.equal(path.basename(a), "a.ts")
  assert.equal(path.basename(b), "A~2.ts")
  assert.equal(path.basename(c), "a~3.TS")

  assert.equal(m.toRemote(a), "C:/Users/x/a.ts")
  assert.equal(m.toRemote(b), "C:/Users/x/A.ts")
  assert.equal(m.toRemote(c), "C:/Users/x/a.TS")

  // Repeated lookups must be stable.
  assert.equal(m.toLocal("C:/Users/x/A.ts"), b)
  assert.equal(m.toLocal("C:/Users/x/a.ts"), a)
  // The ~2 file must not collide with a *real* remote file of that name.
  const real = m.toLocal("C:/Users/x/A~2.ts")
  assert.notEqual(real, b)
  assert.equal(m.toRemote(real), "C:/Users/x/A~2.ts")
})

await check("collision: a case-sensitive local host keeps a.ts and A.ts distinct", () => {
  const m = mapper("windows", "C:/Users/x", { localPlatform: "linux" })
  const a = m.toLocal("C:/Users/x/a.ts")
  const b = m.toLocal("C:/Users/x/A.ts")
  assert.notEqual(a, b)
  assert.equal(path.basename(b), "A.ts")
  assert.equal(m.toRemote(b), "C:/Users/x/A.ts")
})

// ===========================================================================
// 7. long local paths (risk S5)
// ===========================================================================
const LONG_REMOTE = `/data/${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}/${"g".repeat(60)}/file.ts`

await check("long path: win32 local host gets the \\\\?\\ prefix and still round-trips", () => {
  const m = mapper("posix", "/data", { localPlatform: "win32" })
  const local = m.toLocal(LONG_REMOTE)
  assert.ok(local.length > 250, `expected a >250 char local path, got ${local.length}`)
  assert.ok(local.startsWith("\\\\?\\"), `expected the extended-length prefix, got ${JSON.stringify(local.slice(0, 12))}`)
  assert.equal(local.slice(4).includes("/"), false, "a \\\\?\\ path must use backslashes only")
  assert.equal(m.toRemote(local), LONG_REMOTE)
  // Short paths stay plain on win32 too.
  const short = m.toLocal("/data/short.ts")
  assert.equal(short.startsWith("\\\\?\\"), false)
})

await check("long path: non-win32 local hosts never get the prefix", () => {
  const m = mapper("posix", "/data", { localPlatform: "linux" })
  const local = m.toLocal(LONG_REMOTE)
  assert.ok(local.length > 250)
  assert.equal(local.startsWith("\\\\?\\"), false)
  assert.equal(m.toRemote(local), LONG_REMOTE)
})

if (process.platform === "win32") {
  await check("long path: the real host (win32) applies the prefix", () => {
    const m = mapper("posix", "/data")
    const local = m.toLocal(LONG_REMOTE)
    assert.ok(local.length > 250)
    assert.ok(local.startsWith("\\\\?\\"))
    assert.equal(m.toRemote(local), LONG_REMOTE)
  })
} else {
  skip("long path: the real host (win32) applies the prefix", `host is ${process.platform}`)
}

// ===========================================================================
// 8. manifest v2
// ===========================================================================
const MANIFEST_REMOTE = "/home/zxk/proj/src/a.ts"
const ENTRY = { local: "root/home/zxk/proj/src/a.ts", size: 12, mtime: 1_700_000_000_000 }

await check("manifest: register / get / remove / remotePaths / localRelFor", async () => {
  const m = mapper("posix", "/home/zxk/proj")
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  const man = new ManifestManager(m)
  await man.load()

  assert.deepEqual(man.remotePaths(), [])
  assert.equal(man.get(MANIFEST_REMOTE), undefined)
  assert.equal(man.localRelFor(MANIFEST_REMOTE), ENTRY.local)

  man.register(MANIFEST_REMOTE, ENTRY)
  assert.deepEqual(man.remotePaths(), [MANIFEST_REMOTE])
  assert.deepEqual(man.get(MANIFEST_REMOTE), ENTRY)

  // Keys are canonicalised, so a backslash/'.' spelling finds the same entry.
  assert.deepEqual(man.get("/home/zxk/proj/src/./a.ts"), ENTRY)
  assert.deepEqual(man.get("/home/zxk/proj/src/x/../a.ts"), ENTRY)

  man.remove(MANIFEST_REMOTE)
  assert.deepEqual(man.remotePaths(), [])
  assert.equal(man.get(MANIFEST_REMOTE), undefined)
})

await check("manifest: atomic save + reload round-trip", async () => {
  const m = mapper("posix", "/home/zxk/proj")
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  const man = new ManifestManager(m)
  await man.load()
  man.register(MANIFEST_REMOTE, ENTRY)
  await man.save()

  const raw = await fs.readFile(m.manifestPath(), "utf8")
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, 2)
  assert.equal(parsed.remoteRoot, "/home/zxk/proj")
  assert.deepEqual(parsed.files[MANIFEST_REMOTE], ENTRY)

  // No temp file survives an atomic save.
  await assert.rejects(fs.access(`${m.manifestPath()}.tmp`), "the .tmp file must be renamed away")

  const reloaded = new ManifestManager(m)
  await reloaded.load()
  assert.deepEqual(reloaded.remotePaths(), [MANIFEST_REMOTE])
  assert.deepEqual(reloaded.get(MANIFEST_REMOTE), ENTRY)
  assert.equal(reloaded.localRelFor(MANIFEST_REMOTE), ENTRY.local)
})

await check("manifest: save() is a no-op when nothing changed", async () => {
  const m = mapper("posix", "/home/zxk/other")
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  await fs.mkdir(path.dirname(m.manifestPath()), { recursive: true })
  await fs.writeFile(m.manifestPath(), JSON.stringify({ version: 2, remoteRoot: "/home/zxk/other", files: {} }), "utf8")

  const man = new ManifestManager(m)
  await man.load()
  // Corrupt the file behind the manager's back; a clean save must not touch it.
  await fs.writeFile(m.manifestPath(), "SENTINEL", "utf8")
  await man.save()
  assert.equal(await fs.readFile(m.manifestPath(), "utf8"), "SENTINEL")

  // ...but a dirty one rewrites it.
  man.register("/home/zxk/other/b.ts", { local: "root/home/zxk/other/b.ts", size: 1, mtime: 2 })
  await man.save()
  const parsed = JSON.parse(await fs.readFile(m.manifestPath(), "utf8"))
  assert.equal(parsed.version, 2)
  assert.deepEqual(Object.keys(parsed.files), ["/home/zxk/other/b.ts"])
})

await check("manifest: a version-1 file is ignored (starts empty)", async () => {
  const m = mapper("posix", "/srv/v1")
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  await fs.mkdir(path.dirname(m.manifestPath()), { recursive: true })
  await fs.writeFile(
    m.manifestPath(),
    JSON.stringify({ remote_root: "/srv/v1", files: { "/srv/v1/a.ts": "a.ts" } }),
    "utf8"
  )
  const man = new ManifestManager(m)
  await man.load()
  assert.deepEqual(man.remotePaths(), [])
})

await check("manifest: wrong remoteRoot / garbage JSON are ignored", async () => {
  const m = mapper("posix", "/srv/v2")
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  await fs.mkdir(path.dirname(m.manifestPath()), { recursive: true })

  await fs.writeFile(
    m.manifestPath(),
    JSON.stringify({ version: 2, remoteRoot: "/srv/somewhere-else", files: { "/srv/somewhere-else/a.ts": ENTRY } }),
    "utf8"
  )
  const other = new ManifestManager(m)
  await other.load()
  assert.deepEqual(other.remotePaths(), [])

  await fs.writeFile(m.manifestPath(), "{not json", "utf8")
  const garbage = new ManifestManager(m)
  await garbage.load()
  assert.deepEqual(garbage.remotePaths(), [])
})

await check("manifest: a missing manifest is not an error", async () => {
  const m = mapper("posix", "/srv/missing")
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  const man = new ManifestManager(m)
  await man.load()
  assert.deepEqual(man.remotePaths(), [])
})

await check("manifest: collision names survive a reload (re-seeded claims)", async () => {
  const m = mapper("windows", "C:/Users/x", { localPlatform: "win32" })
  await fs.rm(m.mirrorNamespace, { recursive: true, force: true })
  const first = new ManifestManager(m)
  await first.load()
  const lower = first.localRelFor("C:/Users/x/a.ts")
  const upper = first.localRelFor("C:/Users/x/A.ts")
  assert.equal(lower, "C/Users/x/a.ts")
  assert.equal(upper, "C/Users/x/A~2.ts")
  first.register("C:/Users/x/a.ts", { local: lower, size: 1, mtime: 1 })
  first.register("C:/Users/x/A.ts", { local: upper, size: 2, mtime: 2 })
  await first.save()

  // A fresh mapper (new session) must reproduce the same two local names.
  const m2 = mapper("windows", "C:/Users/x", { localPlatform: "win32" })
  const second = new ManifestManager(m2)
  await second.load()
  assert.equal(m2.toLocal("C:/Users/x/a.ts"), path.join(m2.mirrorNamespace, "C", "Users", "x", "a.ts"))
  assert.equal(m2.toLocal("C:/Users/x/A.ts"), path.join(m2.mirrorNamespace, "C", "Users", "x", "A~2.ts"))
  assert.equal(second.localRelFor("C:/Users/x/A.ts"), upper)
})

// ===========================================================================
// 9. SyncEngine against an in-memory SyncFs
// ===========================================================================
const SYNC_REMOTE = "/home/zxk/proj/src/a.ts"

function createFakeFs(seed = {}) {
  const files = new Map()
  for (const [remote, value] of Object.entries(seed)) {
    files.set(remote, { data: Buffer.from(value.data), mtime: value.mtime })
  }
  const dirs = new Set()
  const calls = { readFile: 0, writeFile: 0, unlink: 0, rename: 0, mkdirp: 0, stat: 0 }
  let clock = 1_700_000_100_000

  return {
    files,
    dirs,
    calls,
    async realpath(p) {
      return p
    },
    async stat(p) {
      calls.stat++
      const entry = files.get(p)
      if (!entry) return null
      return { dir: false, file: true, symlink: false, size: entry.data.length, mtime: entry.mtime }
    },
    async readPrefix(p, bytes) {
      const entry = files.get(p)
      return entry ? entry.data.subarray(0, bytes) : Buffer.alloc(0)
    },
    async readFile(p) {
      // A real SFTP read is a round-trip; the delay makes a missing lock
      // (two concurrent transfers) observable instead of a timing accident.
      await new Promise((resolve) => setTimeout(resolve, 5))
      calls.readFile++
      const entry = files.get(p)
      if (!entry) throw new Error(`no such file: ${p}`)
      return Buffer.from(entry.data)
    },
    async writeFile(p, data) {
      calls.writeFile++
      files.set(p, { data: Buffer.from(data), mtime: ++clock })
    },
    async mkdirp(p) {
      calls.mkdirp++
      dirs.add(p)
    },
    async unlink(p) {
      calls.unlink++
      files.delete(p)
    },
    async rename(from, to) {
      calls.rename++
      const entry = files.get(from)
      if (!entry) throw new Error(`no such file: ${from}`)
      files.delete(from)
      files.set(to, entry)
    },
  }
}

const syncState = { fs: null, mapper: null, manifest: null, engine: null }

async function setupSync() {
  await fs.rm(TMP, { recursive: true, force: true })
  await fs.mkdir(MIRROR_ROOT, { recursive: true })

  syncState.fs = createFakeFs({
    [SYNC_REMOTE]: { data: "hello\n", mtime: 1_700_000_000_000 },
  })
  syncState.mapper = mapper("posix", "/home/zxk/proj")
  syncState.manifest = new ManifestManager(syncState.mapper)
  await syncState.manifest.load()
  syncState.engine = new SyncEngine(syncState.fs, syncState.mapper, syncState.manifest, () => {})
}

await setupSync()

function delta(before, after) {
  return {
    pulled: after.pulled - before.pulled,
    pushed: after.pushed - before.pushed,
    skipped: after.skipped - before.skipped,
  }
}

await check("sync: first ensureLocal pulls one file and registers it", async () => {
  const { engine, manifest, mapper: m, fs: remote } = syncState
  const before = engine.stats()
  const local = await engine.ensureLocal(SYNC_REMOTE)

  assert.equal(local, path.join(m.mirrorBase, "src", "a.ts"))
  assert.equal(await fs.readFile(local, "utf8"), "hello\n")
  assert.deepEqual(delta(before, engine.stats()), { pulled: 1, pushed: 0, skipped: 0 })

  const entry = manifest.get(SYNC_REMOTE)
  assert.ok(entry, "the manifest must track the file")
  assert.equal(entry.size, 6)
  assert.equal(entry.mtime, 1_700_000_000_000)
  assert.equal(entry.local, "root/home/zxk/proj/src/a.ts")
  assert.equal(remote.calls.readFile, 1)
})

await check("sync: a matching size+mtime skips the transfer entirely", async () => {
  const { engine, fs: remote } = syncState
  const before = engine.stats()
  const readBefore = remote.calls.readFile
  const local = await engine.ensureLocal(SYNC_REMOTE)

  assert.deepEqual(delta(before, engine.stats()), { pulled: 0, pushed: 0, skipped: 1 })
  assert.equal(remote.calls.readFile, readBefore, "no SFTP read may happen when the stat hits")
  assert.equal(await fs.readFile(local, "utf8"), "hello\n")
})

await check("sync: a changed remote size forces a re-pull", async () => {
  const { engine, manifest, mapper: m, fs: remote } = syncState
  remote.files.get(SYNC_REMOTE).data = Buffer.from("hello world\n")

  const before = engine.stats()
  const local = await engine.ensureLocal(SYNC_REMOTE)

  assert.deepEqual(delta(before, engine.stats()), { pulled: 1, pushed: 0, skipped: 0 })
  assert.equal(await fs.readFile(local, "utf8"), "hello world\n")
  assert.equal(manifest.get(SYNC_REMOTE).size, 12)
  assert.equal(local, path.join(m.mirrorBase, "src", "a.ts"))
})

await check("sync: commit pushes the local bytes and refreshes size/mtime", async () => {
  const { engine, manifest, mapper: m, fs: remote } = syncState
  const local = path.join(m.mirrorBase, "src", "a.ts")
  await fs.writeFile(local, "edited by the agent\n", "utf8")

  const before = engine.stats()
  await engine.commit(SYNC_REMOTE)

  assert.deepEqual(delta(before, engine.stats()), { pulled: 0, pushed: 1, skipped: 0 })
  assert.equal(remote.files.get(SYNC_REMOTE).data.toString("utf8"), "edited by the agent\n")
  assert.ok(remote.dirs.has("/home/zxk/proj/src"), "commit must mkdirp the remote parent over SFTP")
  const entry = manifest.get(SYNC_REMOTE)
  assert.equal(entry.size, remote.files.get(SYNC_REMOTE).data.length)
  assert.equal(entry.mtime, remote.files.get(SYNC_REMOTE).mtime)
})

await check("sync: after commit the next ensureLocal skips again", async () => {
  const { engine } = syncState
  const before = engine.stats()
  await engine.ensureLocal(SYNC_REMOTE)
  assert.deepEqual(delta(before, engine.stats()), { pulled: 0, pushed: 0, skipped: 1 })
})

await check("sync: a missing remote file yields an empty local file (add-file patches)", async () => {
  const { engine, manifest, mapper: m } = syncState
  const remotePath = "/home/zxk/proj/src/brand-new.ts"
  const local = await engine.ensureLocal(remotePath)

  assert.equal(local, path.join(m.mirrorBase, "src", "brand-new.ts"))
  assert.equal(await fs.readFile(local, "utf8"), "")
  const entry = manifest.get(remotePath)
  assert.ok(entry, "the new file must be registered so commit() finds it")
  assert.equal(entry.size, 0)
  assert.equal(entry.local, "root/home/zxk/proj/src/brand-new.ts")
})

await check("sync: rename moves both sides and rewrites the manifest", async () => {
  const { engine, manifest, mapper: m, fs: remote } = syncState
  const from = SYNC_REMOTE
  const to = "/home/zxk/proj/lib/b.ts"
  const fromLocal = path.join(m.mirrorBase, "src", "a.ts")
  const toLocal = path.join(m.mirrorBase, "lib", "b.ts")

  await engine.rename(from, to)

  assert.equal(remote.files.has(from), false)
  assert.equal(remote.files.get(to).data.toString("utf8"), "edited by the agent\n")
  assert.equal(await fs.readFile(toLocal, "utf8"), "edited by the agent\n")
  await assert.rejects(fs.access(fromLocal), "the old local copy must be gone")
  assert.equal(manifest.get(from), undefined)
  assert.ok(manifest.get(to), "the new path must be tracked")
  assert.equal(manifest.get(to).local, "root/home/zxk/proj/lib/b.ts")
})

await check("sync: concurrent ensureLocal on the same path transfers once", async () => {
  const { engine, fs: remote } = syncState
  const remotePath = "/home/zxk/lib/slow.ts"
  remote.files.set(remotePath, { data: Buffer.from("slow\n"), mtime: 1_700_000_500_000 })

  const before = engine.stats()
  const readBefore = remote.calls.readFile
  const [a, b] = await Promise.all([engine.ensureLocal(remotePath), engine.ensureLocal(remotePath)])

  assert.equal(a, b, "both callers must see the same local path")
  assert.equal(remote.calls.readFile - readBefore, 1, "the per-path mutex must prevent a double transfer")
  assert.deepEqual(delta(before, engine.stats()), { pulled: 1, pushed: 0, skipped: 1 })
})

await check("sync: remove deletes remote + local + manifest entry", async () => {
  const { engine, manifest, mapper: m, fs: remote } = syncState
  const remotePath = "/home/zxk/proj/src/brand-new.ts"
  const local = path.join(m.mirrorBase, "src", "brand-new.ts")
  remote.files.set(remotePath, { data: Buffer.from("x"), mtime: 1 })

  await engine.remove(remotePath)

  assert.equal(remote.files.has(remotePath), false)
  await assert.rejects(fs.access(local))
  assert.equal(manifest.get(remotePath), undefined)
})

await check("sync: a failing manifest save never fails the tool call", async () => {
  const { engine, mapper: m } = syncState
  // Point the manifest at a directory so the atomic write must fail.
  await fs.rm(m.manifestPath(), { force: true })
  await fs.mkdir(m.manifestPath(), { recursive: true })

  const remotePath = "/home/zxk/proj/src/err.ts"
  syncState.fs.files.set(remotePath, { data: Buffer.from("err\n"), mtime: 42 })
  const local = await engine.ensureLocal(remotePath)
  assert.equal(await fs.readFile(local, "utf8"), "err\n")
})

// ===========================================================================
// summary
// ===========================================================================
console.log("")
const total = pass + failures.length
console.log(`total: PASS=${pass} FAIL=${failures.length} SKIP=${skipped} (${total} checks)`)
if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED ${f.name}: ${f.message}`)
  console.log("RESULT: FAIL")
  process.exit(1)
}
console.log("RESULT: PASS")
process.exit(0)
