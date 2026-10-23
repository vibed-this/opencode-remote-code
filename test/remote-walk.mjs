/**
 * test/remote-walk.mjs — `walk()`, `searchFiles()` and the SFTP error mapping of
 * `createRemoteFs()`, all against in-memory fakes (no SSH, no network).
 *
 * Covers DESIGN-V3 §7.1–§7.4:
 *   walk    depth limit, ignore list, symlinked dirs not followed, maxEntries
 *           truncation, includeDirs, unreadable directories, ordering, time budget
 *   search  glob include filtering, CRLF handling, binary skip (extension + NUL),
 *           large-file skip, match/byte/time/walk budgets, absolute paths,
 *           `(?i)` lifting and the regex error messages
 *   fs      code 2 (NO_SUCH_FILE) -> null / no-op, code 3 (PERMISSION_DENIED) ->
 *           Error naming the path, canonical <-> SFTP path conversion, mtime in ms
 *
 *   npm run build && node test/remote-walk.mjs      # exit 0 = all PASS
 */

import assert from "node:assert/strict"

import { posixPathOps, windowsPathOps } from "../dist/platform/path.js"
import { createRemoteFs } from "../dist/remote/fs.js"
import { compileSearchPattern, searchFiles } from "../dist/remote/search.js"
import { walk } from "../dist/remote/walk.js"

const ops = posixPathOps
const DEFAULT_MTIME = 1_700_000_000_000

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rels = (result) => result.files.map((f) => f.rel)

// ===========================================================================
// Fake in-memory RemoteFs
// ===========================================================================
/**
 * A `RemoteFs` backed by a Map, with the SFTP listing semantics that matter:
 * `readdir` reports lstat-like attributes (a symlink is `symlink: true`), and
 * paths that were never created simply do not exist.
 */
class FakeFs {
  constructor() {
    this.nodes = new Map()
    this.denied = new Set()
    this.readdirDelayMs = 0
    this.readDelayMs = 0
    this.readdirPaths = []
    this.readsInFlight = 0
    this.maxConcurrentReads = 0
  }

  put(p, spec = {}) {
    const path = ops.normalize(p)
    const parent = ops.dirname(path)
    if (parent !== path && !this.nodes.has(parent)) this.put(parent, { dir: true })
    this.nodes.set(path, {
      dir: spec.dir ?? false,
      symlink: spec.symlink ?? false,
      content: Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content ?? "", "utf8"),
      mtime: spec.mtime ?? DEFAULT_MTIME,
    })
    return this
  }

  dir(p, mtime) {
    return this.put(p, { dir: true, mtime })
  }

  file(p, content, mtime) {
    return this.put(p, { content, mtime })
  }

  /** A symlink that points at a directory (must never be traversed). */
  symlinkDir(p) {
    return this.put(p, { dir: true, symlink: true })
  }

  /** A symlink to a file: still a usable result, but never descended into. */
  symlinkFile(p) {
    return this.put(p, { symlink: true, content: "" })
  }

  deny(p) {
    this.denied.add(ops.normalize(p))
    return this
  }

  sizeOf(node) {
    return node.dir ? 0 : node.content.length
  }

  direntOf(path) {
    const node = this.nodes.get(path)
    return {
      name: ops.basename(path),
      dir: node.dir,
      symlink: node.symlink,
      size: this.sizeOf(node),
      mtime: node.mtime,
    }
  }

  // --- RemoteFs ------------------------------------------------------------
  async realpath(p) {
    return ops.normalize(p)
  }

  async stat(p) {
    return this.lstat(p)
  }

  async lstat(p) {
    const node = this.nodes.get(ops.normalize(p))
    if (node === undefined) return null
    return {
      dir: node.dir,
      file: !node.dir && !node.symlink,
      symlink: node.symlink,
      size: this.sizeOf(node),
      mtime: node.mtime,
    }
  }

  async readdir(p) {
    const path = ops.normalize(p)
    this.readdirPaths.push(path)
    if (this.readdirDelayMs > 0) await sleep(this.readdirDelayMs)
    if (this.denied.has(path)) throw new Error(`permission denied: ${path}`)
    const node = this.nodes.get(path)
    if (node === undefined || !node.dir) throw new Error(`not a directory: ${path}`)
    const out = []
    for (const key of this.nodes.keys()) {
      if (ops.dirname(key) === path) out.push(this.direntOf(key))
    }
    return out
  }

  async readPrefix(p, bytes) {
    const path = ops.normalize(p)
    this.readsInFlight += 1
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.readsInFlight)
    try {
      if (this.readDelayMs > 0) await sleep(this.readDelayMs)
      const node = this.nodes.get(path)
      if (node === undefined || node.dir) throw new Error(`no such file: ${p}`)
      return node.content.subarray(0, Math.max(0, bytes))
    } finally {
      this.readsInFlight -= 1
    }
  }

  async readFile(p) {
    return this.readPrefix(p, Number.MAX_SAFE_INTEGER)
  }

  async writeFile(p, data) {
    this.put(p, { content: data })
  }

  async mkdirp(p) {
    this.dir(p)
  }

  async unlink(p) {
    this.nodes.delete(ops.normalize(p))
  }

  async rename(from, to) {
    const node = this.nodes.get(ops.normalize(from))
    if (node === undefined) throw new Error(`no such file: ${from}`)
    this.nodes.delete(ops.normalize(from))
    this.nodes.set(ops.normalize(to), node)
  }
}

// ===========================================================================
// walk()
// ===========================================================================
await check("walk: nested files get `/`-separated rel paths and a full listing", async () => {
  const f = new FakeFs()
  f.file("/root/a.txt", "hello")
  f.file("/root/b.md", "# b")
  f.file("/root/src/c.ts", "export const c = 1")
  f.file("/root/src/deep/d.ts", "export const d = 2")

  const r = await walk(f, ops, "/root")
  assert.deepEqual(rels(r), ["a.txt", "b.md", "src/c.ts", "src/deep/d.ts"])
  assert.equal(r.truncated, false)
  assert.equal(r.reason, undefined)
  // 3 entries in /root + 2 in /root/src + 1 in /root/src/deep
  assert.equal(r.entries, 6)
  for (const file of r.files) {
    assert.equal(file.rel.startsWith("./"), false, `rel must not start with ./ (${file.rel})`)
    assert.equal(file.rel.includes("\\"), false, `rel must use / (${file.rel})`)
  }
  assert.equal(r.files[0].dirent.size, 5)
  assert.equal(r.files[0].dirent.mtime, DEFAULT_MTIME)
})

await check("walk: results are sorted by rel regardless of listing order", async () => {
  const f = new FakeFs()
  f.file("/root/z.txt", "z")
  f.file("/root/m/n.txt", "n")
  f.file("/root/a.txt", "a")
  const r = await walk(f, ops, "/root")
  assert.deepEqual(rels(r), ["a.txt", "m/n.txt", "z.txt"])
})

await check("walk: default ignore list skips node_modules/.git/… at any depth", async () => {
  const f = new FakeFs()
  f.file("/root/keep.ts", "x")
  f.file("/root/node_modules/pkg/index.js", "x")
  f.file("/root/.git/HEAD", "x")
  f.file("/root/src/dist/bundle.js", "x")
  const r = await walk(f, ops, "/root")
  assert.deepEqual(rels(r), ["keep.ts"])
  assert.equal(r.truncated, false)
})

await check("walk: an explicit ignore list replaces the defaults", async () => {
  const f = new FakeFs()
  f.file("/root/node_modules/pkg/index.js", "x")
  f.file("/root/skip/y.js", "x")
  f.file("/root/keep.ts", "x")
  const r = await walk(f, ops, "/root", { ignore: ["skip"] })
  assert.deepEqual(rels(r), ["keep.ts", "node_modules/pkg/index.js"])
})

await check("walk: maxDepth cuts the deepest level and reports reason `depth`", async () => {
  const f = new FakeFs()
  f.file("/root/a.txt", "a")
  f.file("/root/d1/f.ts", "f") // depth 2: kept
  f.file("/root/d1/d2/d3/deep.ts", "d") // depth 4: cut
  const r = await walk(f, ops, "/root", { maxDepth: 2 })
  assert.deepEqual(rels(r), ["a.txt", "d1/f.ts"])
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "depth")
})

await check("walk: symlinked directories are reported but never followed", async () => {
  const f = new FakeFs()
  f.file("/root/src/a.ts", "a")
  f.symlinkDir("/root/link")
  f.symlinkFile("/root/alias.ts")
  const r = await walk(f, ops, "/root")
  assert.deepEqual(rels(r), ["alias.ts", "src/a.ts"])
  assert.equal(
    f.readdirPaths.includes("/root/link"),
    false,
    "walk must not readdir a symlinked directory (infinite-loop protection)"
  )
})

await check("walk: maxEntries truncates and reports reason `entries`", async () => {
  const f = new FakeFs()
  for (let i = 0; i < 10; i++) f.file(`/root/f${i}.txt`, "x")
  const r = await walk(f, ops, "/root", { maxEntries: 3 })
  assert.equal(r.files.length, 3)
  assert.equal(r.entries, 4) // the 4th entry is the one that tripped the budget
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "entries")
})

await check("walk: includeDirs also reports directories", async () => {
  const f = new FakeFs()
  f.file("/root/src/a.ts", "a")
  const r = await walk(f, ops, "/root", { includeDirs: true })
  assert.deepEqual(rels(r), ["src", "src/a.ts"])
  assert.equal(r.files[0].dirent.dir, true)
  assert.equal(r.files[1].dirent.dir, false)
})

await check("walk: an unreadable directory is counted, skipped and not fatal", async () => {
  const f = new FakeFs()
  f.file("/root/ok.txt", "x")
  f.dir("/root/locked")
  f.file("/root/locked/secret.txt", "s")
  f.deny("/root/locked")
  const r = await walk(f, ops, "/root")
  assert.deepEqual(rels(r), ["ok.txt"])
  assert.equal(r.truncated, false)
  // ok.txt + locked (listed) + locked (unreadable, counted once more)
  assert.equal(r.entries, 3)
})

await check("walk: a root that is not a directory yields an empty, non-fatal result", async () => {
  const f = new FakeFs()
  f.file("/root/a.txt", "a")
  const r = await walk(f, ops, "/root/a.txt")
  assert.deepEqual(r.files, [])
  assert.equal(r.entries, 1)
  assert.equal(r.truncated, false)
})

await check("walk: the time budget stops the walk and reports reason `time`", async () => {
  const f = new FakeFs()
  f.file("/root/d1/a.ts", "a")
  f.file("/root/d2/b.ts", "b")
  f.readdirDelayMs = 40
  const r = await walk(f, ops, "/root", { maxMillis: 5, concurrency: 1 })
  assert.deepEqual(r.files, [])
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "time")
})

await check("walk: concurrency > 1 still produces a complete, sorted listing", async () => {
  const f = new FakeFs()
  for (let i = 0; i < 12; i++) f.file(`/root/d${i}/f.ts`, "x")
  const r = await walk(f, ops, "/root", { concurrency: 4 })
  assert.equal(r.files.length, 12)
  const sorted = [...rels(r)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  assert.deepEqual(rels(r), sorted)
})

// ===========================================================================
// searchFiles()
// ===========================================================================
await check("search: reports line numbers and absolute remote paths", async () => {
  const f = new FakeFs()
  f.file("/root/a.txt", "foo\nbar\nfoo again\n")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "foo" })
  assert.deepEqual(r.matches, [
    { path: "/root/a.txt", line: 1, text: "foo" },
    { path: "/root/a.txt", line: 3, text: "foo again" },
  ])
  assert.equal(r.truncated, false)
  assert.equal(r.reason, undefined)
  assert.equal(r.scannedFiles, 1)
  assert.ok(r.scannedBytes > 0)
})

await check("search: CRLF is tolerated and the `\\r` is stripped from `text`", async () => {
  const f = new FakeFs()
  f.file("/root/crlf.txt", "alpha\r\nbeta\r\ngamma\r\n")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "beta$" })
  assert.equal(r.matches.length, 1)
  assert.equal(r.matches[0].line, 2)
  assert.equal(r.matches[0].text, "beta")
  assert.equal(r.matches[0].text.includes("\r"), false)
})

await check("search: `include` filters before reading anything", async () => {
  const f = new FakeFs()
  f.file("/root/a.ts", "needle")
  f.file("/root/b.md", "needle")
  f.file("/root/src/c.tsx", "needle")

  const ts = await searchFiles(f, ops, { root: "/root", pattern: "needle", include: "*.ts" })
  assert.deepEqual(ts.matches.map((m) => m.path), ["/root/a.ts"])
  assert.equal(ts.scannedFiles, 1)

  const braces = await searchFiles(f, ops, { root: "/root", pattern: "needle", include: "*.{ts,tsx}" })
  assert.deepEqual(braces.matches.map((m) => m.path), ["/root/a.ts", "/root/src/c.tsx"])
  assert.equal(braces.scannedFiles, 2)

  const paths = await searchFiles(f, ops, { root: "/root", pattern: "needle", include: "src/*.tsx" })
  assert.deepEqual(paths.matches.map((m) => m.path), ["/root/src/c.tsx"])
})

await check("search: a NUL byte in the first 8 KiB marks the file binary", async () => {
  const f = new FakeFs()
  f.file("/root/bin.dat", Buffer.from([0x6e, 0x00, 0x65])) // "n\0e"
  f.file("/root/text.txt", "needle")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "ne" })
  assert.deepEqual(r.matches.map((m) => m.path), ["/root/text.txt"])
  assert.equal(r.skippedBinary, 1)
  // `*.dat` is not on the extension blacklist, so the 3 bytes *were* transferred
  // before the NUL was seen: scannedFiles/scannedBytes count real transfers.
  assert.equal(r.scannedFiles, 2)
})

await check("search: a binary extension is skipped without being read", async () => {
  const f = new FakeFs()
  f.file("/root/img.png", "needle") // text content, binary extension
  f.file("/root/a.txt", "needle")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "needle" })
  assert.deepEqual(r.matches.map((m) => m.path), ["/root/a.txt"])
  assert.equal(r.skippedBinary, 1)
  assert.equal(r.scannedFiles, 1)
})

await check("search: files larger than maxFileSize are skipped and counted", async () => {
  const f = new FakeFs()
  f.file("/root/big.txt", "needle needle")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "needle", maxFileSize: 4 })
  assert.deepEqual(r.matches, [])
  assert.equal(r.skippedLarge, 1)
  assert.equal(r.scannedFiles, 0)
  assert.equal(r.truncated, false)
})

await check("search: maxMatches truncates and reports reason `matches`", async () => {
  const f = new FakeFs()
  f.file("/root/many.txt", "x\nx1\nx2\nx3\n")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "x", maxMatches: 2 })
  assert.equal(r.matches.length, 2)
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "matches")
})

await check("search: maxBytes stops before over-reading and reports reason `bytes`", async () => {
  const f = new FakeFs()
  f.file("/root/one.txt", "aaaaaaaa")
  f.file("/root/two.txt", "bbbbbbbb")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "a", maxBytes: 10 })
  assert.equal(r.scannedFiles, 1)
  assert.equal(r.scannedBytes, 8)
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "bytes")
})

await check("search: maxMillis stops the scan and reports reason `time`", async () => {
  const f = new FakeFs()
  f.file("/root/a.txt", "needle")
  f.file("/root/b.txt", "needle")
  f.readDelayMs = 40
  const r = await searchFiles(f, ops, { root: "/root", pattern: "needle", maxMillis: 5 })
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "time")
  assert.equal(r.scannedFiles, 1)
})

await check("search: a truncated walk is surfaced as reason `walk`", async () => {
  const f = new FakeFs()
  f.file("/root/a.txt", "nothing here")
  f.file("/root/b.txt", "nothing here")
  f.file("/root/c.txt", "nothing here")
  const r = await searchFiles(f, ops, {
    root: "/root",
    pattern: "absent",
    walkLimits: { maxEntries: 2 },
  })
  assert.deepEqual(r.matches, [])
  assert.equal(r.truncated, true)
  assert.equal(r.reason, "walk")
})

await check("search: ignore list is forwarded to the walk", async () => {
  const f = new FakeFs()
  f.file("/root/src/a.ts", "needle")
  f.file("/root/node_modules/x.ts", "needle")
  const r = await searchFiles(f, ops, { root: "/root", pattern: "needle", include: "*.ts" })
  assert.deepEqual(r.matches.map((m) => m.path), ["/root/src/a.ts"])
})

await check("search: reads files concurrently but keeps matches in walk order", async () => {
  const f = new FakeFs()
  for (const name of ["a", "b", "c", "d", "e", "f"]) f.file(`/root/${name}.txt`, "needle\n")
  f.readDelayMs = 5
  const r = await searchFiles(f, ops, {
    root: "/root",
    pattern: "needle",
    walkLimits: { concurrency: 3 },
  })
  assert.deepEqual(
    r.matches.map((m) => m.path),
    ["a", "b", "c", "d", "e", "f"].map((n) => `/root/${n}.txt`)
  )
  assert.equal(r.scannedFiles, 6)
  assert.ok(f.maxConcurrentReads > 1, `expected read-ahead, saw ${f.maxConcurrentReads}`)
  assert.ok(f.maxConcurrentReads <= 3, `window must be bounded, saw ${f.maxConcurrentReads}`)
})

await check("search: concurrency 1 reads strictly one file at a time", async () => {
  const f = new FakeFs()
  for (const name of ["a", "b", "c"]) f.file(`/root/${name}.txt`, "needle\n")
  f.readDelayMs = 3
  const r = await searchFiles(f, ops, {
    root: "/root",
    pattern: "needle",
    walkLimits: { concurrency: 1 },
  })
  assert.equal(r.scannedFiles, 3)
  assert.equal(f.maxConcurrentReads, 1)
})

// ===========================================================================
// compileSearchPattern()
// ===========================================================================
await check("compileSearchPattern: a leading (?i) is lifted into the flag", async () => {
  const re = compileSearchPattern("(?i)foo")
  assert.equal(re.flags.includes("i"), true)
  assert.equal(re.source, "foo")
  assert.equal(re.test("FOO"), true)
  assert.equal(re.test("Foo"), true)
})

await check("compileSearchPattern: leading (?im) and (?-i) are handled", async () => {
  const multi = compileSearchPattern("(?im)^foo$")
  assert.equal(multi.flags.includes("i"), true)
  assert.equal(multi.flags.includes("m"), true)
  assert.equal(multi.test("x\nFOO\ny"), true)

  const off = compileSearchPattern("(?-i)foo")
  assert.equal(off.flags.includes("i"), false)
  assert.equal(off.test("FOO"), false)
})

await check("compileSearchPattern: lookbehind and groups still work", async () => {
  assert.equal(compileSearchPattern("(?<=a)b").test("ab"), true)
  assert.equal(compileSearchPattern("(?:x|y)z").test("yz"), true)
})

await check("compileSearchPattern: invalid regex throws a clear error", async () => {
  assert.throws(() => compileSearchPattern("(unclosed"), /Invalid regular expression/)
  assert.throws(() => compileSearchPattern("a{2,1}"), /Invalid regular expression/)
  assert.throws(() => compileSearchPattern(""), /Empty search pattern/)
  assert.throws(() => compileSearchPattern("(?i)"), /only inline flags/)
})

await check("compileSearchPattern: a non-leading (?i) explains what to do", async () => {
  assert.throws(
    () => compileSearchPattern("foo(?i)bar"),
    /only supported at the very start of the pattern/
  )
})

// ===========================================================================
// createRemoteFs(): SFTP error mapping and path conversion
// ===========================================================================
/**
 * A stub `SFTPWrapper` + `SSHPool`. `createRemoteFs` only needs `withSftp`, so a
 * plain object is enough — this is the cheap way to pin the error mapping
 * without ssh2 or a server.
 */
function makeStub({
  content = Buffer.alloc(0),
  statMissing = false,
  realpathResult = null,
  readdirDenied = false,
} = {}) {
  const record = []
  let closed = false
  const dirAttrs = {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    size: 0,
    mtime: 1_700_000_000,
  }
  const fileAttrs = {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    size: content.length,
    mtime: 1_700_000_000,
  }
  const noSuchFile = () => Object.assign(new Error("No such file"), { code: 2 })
  const permissionDenied = () => Object.assign(new Error("Permission denied"), { code: 3 })

  const sftp = {
    stat(p, cb) {
      record.push(["stat", p])
      if (statMissing) cb(noSuchFile())
      else cb(undefined, fileAttrs)
    },
    lstat(p, cb) {
      record.push(["lstat", p])
      if (statMissing) cb(noSuchFile())
      else cb(undefined, fileAttrs)
    },
    readdir(p, cb) {
      record.push(["readdir", p])
      if (readdirDenied) cb(permissionDenied())
      else cb(undefined, [
        { filename: ".", longname: ".", attrs: dirAttrs },
        { filename: "..", longname: "..", attrs: dirAttrs },
        { filename: "a.txt", longname: "a.txt", attrs: fileAttrs },
      ])
    },
    realpath(p, cb) {
      record.push(["realpath", p])
      cb(undefined, realpathResult ?? p)
    },
    open(p, flags, cb) {
      record.push(["open", p, flags])
      cb(undefined, Buffer.from([0x01]))
    },
    read(handle, buf, offset, length, position, cb) {
      record.push(["read", position, length])
      const slice = content.subarray(position, position + length)
      slice.copy(buf, offset)
      cb(undefined, slice.length, buf, position)
    },
    write(handle, buf, offset, length, position, cb) {
      record.push(["write", position, length])
      cb(undefined)
    },
    close(handle, cb) {
      closed = true
      cb(undefined)
    },
    mkdir(p, cb) {
      record.push(["mkdir", p])
      cb(undefined)
    },
    unlink(p, cb) {
      record.push(["unlink", p])
      if (statMissing) cb(noSuchFile())
      else cb(undefined)
    },
    rename(from, to, cb) {
      record.push(["rename", from, to])
      cb(undefined)
    },
  }

  const pool = {
    async withSftp(fn) {
      return fn(sftp)
    },
  }
  return { pool, record, wasClosed: () => closed }
}

await check("createRemoteFs: SFTP code 2 (NO_SUCH_FILE) -> stat/lstat return null", async () => {
  const { pool } = makeStub({ statMissing: true })
  const fsApi = createRemoteFs(pool, ops)
  assert.equal(await fsApi.stat("/home/x/missing.txt"), null)
  assert.equal(await fsApi.lstat("/home/x/missing.txt"), null)
})

await check("createRemoteFs: SFTP code 2 on unlink is a silent no-op", async () => {
  const { pool } = makeStub({ statMissing: true })
  const fsApi = createRemoteFs(pool, ops)
  await fsApi.unlink("/home/x/missing.txt") // must resolve
})

await check("createRemoteFs: SFTP code 3 names the path in the error", async () => {
  const { pool } = makeStub({ readdirDenied: true })
  const fsApi = createRemoteFs(pool, ops)
  await assert.rejects(
    () => fsApi.readdir("/home/x/locked"),
    (err) => {
      assert.match(err.message, /permission denied/)
      assert.match(err.message, /\/home\/x\/locked/)
      return true
    }
  )
})

await check("createRemoteFs: readdir drops `.`/`..` and maps attributes", async () => {
  const { pool } = makeStub({ content: Buffer.from("0123456789") })
  const fsApi = createRemoteFs(pool, ops)
  const list = await fsApi.readdir("/home/x")
  assert.deepEqual(list, [
    { name: "a.txt", dir: false, symlink: false, size: 10, mtime: 1_700_000_000_000 },
  ])
})

await check("createRemoteFs: readPrefix transfers at most N bytes and closes the handle", async () => {
  const stub = makeStub({ content: Buffer.from("0123456789") })
  const fsApi = createRemoteFs(stub.pool, ops)
  const buf = await fsApi.readPrefix("/home/x/a.txt", 4)
  assert.equal(buf.toString("utf8"), "0123")
  assert.equal(stub.wasClosed(), true)
  assert.equal(stub.record.filter((r) => r[0] === "read").length, 1)

  const empty = await fsApi.readPrefix("/home/x/a.txt", 0)
  assert.equal(empty.length, 0)
})

await check("createRemoteFs: readFile reads to EOF in chunks", async () => {
  const content = Buffer.alloc(70_000, 0x41) // 2 chunks + a partial one
  const stub = makeStub({ content })
  const fsApi = createRemoteFs(stub.pool, ops)
  const buf = await fsApi.readFile("/home/x/big.txt")
  assert.equal(buf.length, content.length)
  assert.equal(stub.wasClosed(), true)
})

await check("createRemoteFs: windows paths go out as /C:/… and realpath comes back canonical", async () => {
  const stub = makeStub({ realpathResult: "/C:/Users/x/proj" })
  const fsApi = createRemoteFs(stub.pool, windowsPathOps)

  await fsApi.stat("C:/Users/x/proj/a.ts")
  const statCall = stub.record.find((r) => r[0] === "stat")
  assert.deepEqual(statCall, ["stat", "/C:/Users/x/proj/a.ts"])

  assert.equal(await fsApi.realpath("C:/Users/x/proj"), "C:/Users/x/proj")
})

await check("createRemoteFs: posix paths pass through unchanged", async () => {
  const stub = makeStub({ realpathResult: "/home/x/proj" })
  const fsApi = createRemoteFs(stub.pool, ops)
  assert.equal(await fsApi.realpath("/home/x/proj"), "/home/x/proj")
  const call = stub.record.find((r) => r[0] === "realpath")
  assert.deepEqual(call, ["realpath", "/home/x/proj"])
})

await check("createRemoteFs: mkdirp creates every level in order, windows form first", async () => {
  const stub = makeStub({ statMissing: true })
  const fsApi = createRemoteFs(stub.pool, windowsPathOps)
  await fsApi.mkdirp("C:/Users/test/proj/src")
  const mkdirs = stub.record.filter((r) => r[0] === "mkdir").map((r) => r[1])
  assert.deepEqual(mkdirs, [
    "/C:/Users",
    "/C:/Users/test",
    "/C:/Users/test/proj",
    "/C:/Users/test/proj/src",
  ])
})

await check("createRemoteFs: mkdirp is one round trip when the directory exists", async () => {
  const calls = []
  const stubPool = {
    async withSftp(fn) {
      return fn({
        stat: (p, cb) => {
          calls.push(["stat", p])
          cb(undefined, {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
            size: 0,
            mtime: 0,
          })
        },
      })
    },
  }
  const fsApi = createRemoteFs(stubPool, ops)
  await fsApi.mkdirp("/home/x/proj")
  assert.deepEqual(calls, [["stat", "/home/x/proj"]])
})

await check("createRemoteFs: writeFile streams the buffer in 32 KiB chunks", async () => {
  const stub = makeStub()
  const fsApi = createRemoteFs(stub.pool, ops)
  await fsApi.writeFile("/home/x/blob.bin", Buffer.alloc(70_000, 0x42))
  const writes = stub.record.filter((r) => r[0] === "write")
  assert.equal(writes.length, 3)
  assert.equal(stub.wasClosed(), true)
})

// ===========================================================================
// summary
// ===========================================================================
console.log("")
const total = pass + failures.length
console.log(`total: PASS=${pass} FAIL=${failures.length} (${total} checks)`)
if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED ${f.name}: ${f.message}`)
  process.exit(1)
}
process.exit(0)
