/**
 * test/remote-path.mjs — RemotePathOps conformance for BOTH platforms.
 *
 * Covers DESIGN-V3 §5 (path semantics) and §5.1 (the Windows semantics table):
 * canonical form, drive case, `..` escape from the drive root, case-insensitive
 * comparison/containment, root boundaries and the SFTP wire form.
 *
 *   npm run build && node test/remote-path.mjs      # exit 0 = all PASS
 */

import assert from "node:assert/strict"

import { createPathOps, posixPathOps, windowsPathOps } from "../dist/platform/path.js"

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

// ===========================================================================
// POSIX
// ===========================================================================
const p = posixPathOps

check("posix: createPathOps returns the posix ops", () => {
  assert.equal(createPathOps("posix").kind, "posix")
  assert.equal(createPathOps("posix"), p)
})

check("posix normalize: collapses // , . and .., strips trailing slash", () => {
  assert.equal(p.normalize("/home//x/../y/"), "/home/y")
  assert.equal(p.normalize("/home/x/./a.ts"), "/home/x/a.ts")
  assert.equal(p.normalize("/home/x/"), "/home/x")
  assert.equal(p.normalize("/home/x"), "/home/x")
})

check("posix normalize: root stays '/' and .. cannot escape it", () => {
  assert.equal(p.normalize("/"), "/")
  assert.equal(p.normalize("//"), "/")
  assert.equal(p.normalize("/../../etc"), "/etc")
})

check("posix normalize: backslashes are ordinary filename characters", () => {
  assert.equal(p.normalize("/home/a\\b"), "/home/a\\b")
})

check("posix isAbsolute", () => {
  assert.equal(p.isAbsolute("/x"), true)
  assert.equal(p.isAbsolute("/"), true)
  assert.equal(p.isAbsolute("x"), false)
  assert.equal(p.isAbsolute("./x"), false)
  assert.equal(p.isAbsolute(""), false)
})

check("posix join", () => {
  assert.equal(p.join("/home/x", "src", "a.ts"), "/home/x/src/a.ts")
  assert.equal(p.join("/", "etc"), "/etc")
  assert.equal(p.join("/home/x", "..", "y"), "/home/y")
  assert.equal(p.join("/home/x"), "/home/x")
})

check("posix dirname / basename", () => {
  assert.equal(p.dirname("/home/x/a.ts"), "/home/x")
  assert.equal(p.dirname("/home"), "/")
  assert.equal(p.basename("/home/x/a.ts"), "a.ts")
  assert.equal(p.basename("/home/x"), "x")
})

check("posix equals: exact, case-sensitive", () => {
  assert.equal(p.equals("/home/x", "/home/x"), true)
  assert.equal(p.equals("/home/x", "/home/x/"), true)
  assert.equal(p.equals("/home/x", "/home/X"), false)
})

check("posix contains: boundary-safe, root is inside", () => {
  assert.equal(p.contains("/home/x", "/home/x"), true)
  assert.equal(p.contains("/home/x", "/home/x/y.ts"), true)
  assert.equal(p.contains("/home/x", "/home/xyz"), false)
  assert.equal(p.contains("/home/x", "/home"), false)
  assert.equal(p.contains("/", "/etc/passwd"), true)
  assert.equal(p.contains("/", "/"), true)
})

check("posix segments / rootOf", () => {
  assert.deepEqual(p.segments("/home/x"), ["home", "x"])
  assert.deepEqual(p.segments("/"), [])
  assert.deepEqual(p.segments("/home/x/"), ["home", "x"])
  assert.equal(p.rootOf("/home/x"), "/")
  assert.equal(p.rootOf("/"), "/")
})

check("posix toSftp/fromSftp are identity and round-trip", () => {
  for (const path of ["/home/x/a.ts", "/", "/tmp/x"]) {
    assert.equal(p.toSftp(path), path)
    assert.equal(p.fromSftp(p.toSftp(path)), path)
  }
})

// ===========================================================================
// WINDOWS
// ===========================================================================
const w = windowsPathOps

check("windows: createPathOps returns the windows ops", () => {
  assert.equal(createPathOps("windows").kind, "windows")
  assert.equal(createPathOps("windows"), w)
})

check("windows normalize: backslashes -> forward slashes", () => {
  assert.equal(w.normalize("C:\\Users\\x\\a.ts"), "C:/Users/x/a.ts")
  assert.equal(w.normalize("C:\\Users\\x\\"), "C:/Users/x")
})

check("windows normalize: uppercases the drive letter only", () => {
  assert.equal(w.normalize("c:/users/X"), "C:/users/X")
  assert.equal(w.normalize("c:\\Users\\X"), "C:/Users/X")
  assert.equal(w.normalize("c:/users/x"), "C:/users/x")
})

check("windows normalize: collapses . and .. and trailing slash", () => {
  assert.equal(w.normalize("C:/Users/../x"), "C:/x")
  assert.equal(w.normalize("C:/a/./b"), "C:/a/b")
  assert.equal(w.normalize("C:/Users/x/"), "C:/Users/x")
  assert.equal(w.normalize("C:/Users/x//y///"), "C:/Users/x/y")
})

check("windows normalize: drive root is 'C:/' and .. cannot escape it", () => {
  assert.equal(w.normalize("C:/"), "C:/")
  assert.equal(w.normalize("c:/"), "C:/")
  assert.equal(w.normalize("C:/Users/../../.."), "C:/")
})

check("windows normalize: UNC is best-effort preserved", () => {
  assert.equal(w.normalize("//srv/share/a"), "//srv/share/a")
  assert.equal(w.normalize("\\\\srv\\share\\a"), "//srv/share/a")
})

check("windows normalize: long-path prefix is peeled off", () => {
  assert.equal(w.normalize("\\\\?\\C:\\Users\\x"), "C:/Users/x")
})

check("windows isAbsolute: drive-absolute yes, everything ambiguous no", () => {
  assert.equal(w.isAbsolute("C:/x"), true)
  assert.equal(w.isAbsolute("C:\\x"), true)
  assert.equal(w.isAbsolute("C:/"), true)
  assert.equal(w.isAbsolute("/x"), false)
  assert.equal(w.isAbsolute("C:foo"), false)
  assert.equal(w.isAbsolute("foo"), false)
  assert.equal(w.isAbsolute("./x"), false)
})

check("windows join", () => {
  assert.equal(w.join("C:/Users/x", "src", "a.ts"), "C:/Users/x/src/a.ts")
  assert.equal(w.join("C:/", "Users"), "C:/Users")
  assert.equal(w.join("C:/Users/x", "..", "y"), "C:/Users/y")
  assert.equal(w.join("C:/Users/x", "..", "..", ".."), "C:/")
})

check("windows dirname / basename", () => {
  assert.equal(w.dirname("C:/Users/x/a.ts"), "C:/Users/x")
  assert.equal(w.dirname("C:/Users"), "C:/")
  assert.equal(w.dirname("C:/"), "C:/")
  assert.equal(w.basename("C:/Users/x/a.ts"), "a.ts")
  assert.equal(w.basename("C:/Users/x"), "x")
})

check("windows equals: case-insensitive, drive canonicalised", () => {
  assert.equal(w.equals("C:/Users/X", "c:/users/x"), true)
  assert.equal(w.equals("C:\\Users\\X\\a.ts", "C:/users/x/A.TS"), true)
  assert.equal(w.equals("C:/Users/x", "C:/Users/y"), false)
  assert.equal(w.equals("C:/Users/x", "/Users/x"), false)
})

check("windows contains: case-insensitive and root-boundary safe", () => {
  assert.equal(w.contains("C:/Users/x", "C:/Users/x"), true)
  assert.equal(w.contains("C:/Users/x", "C:/Users/X/src/a.ts"), true)
  assert.equal(w.contains("c:/users/x", "C:/Users/X/src/a.ts"), true)
  assert.equal(w.contains("C:/Users/x", "C:/Users/xy"), false)
  assert.equal(w.contains("C:/Users/x", "C:/Users"), false)
  assert.equal(w.contains("C:/", "C:/anything"), true)
  assert.equal(w.contains("C:/", "C:/Users/x"), true)
  assert.equal(w.contains("C:/Users", "D:/Users"), false)
})

check("windows segments / rootOf", () => {
  assert.deepEqual(w.segments("C:/Users/x"), ["C:", "Users", "x"])
  assert.deepEqual(w.segments("C:/"), ["C:"])
  assert.deepEqual(w.segments("c:/Users/x"), ["C:", "Users", "x"])
  assert.deepEqual(w.segments("/home/x"), ["home", "x"])
  assert.deepEqual(w.segments("/"), [])
  assert.equal(w.rootOf("C:/Users/x"), "C:/")
  assert.equal(w.rootOf("C:/"), "C:/")
})

check("windows toSftp/fromSftp round-trip", () => {
  assert.equal(w.toSftp("C:/Users/x"), "/C:/Users/x")
  assert.equal(w.fromSftp("/C:/Users/x"), "C:/Users/x")
  assert.equal(w.fromSftp("C:/x"), "C:/x")
  assert.equal(w.fromSftp("\\\\?\\C:\\Users\\x"), "C:/Users/x")
  assert.equal(w.fromSftp("/C:/"), "C:/")
  for (const path of ["C:/Users/x/a.ts", "C:/", "C:/Users"]) {
    assert.equal(w.fromSftp(w.toSftp(path)), path, `round-trip failed for ${path}`)
  }
})

// ===========================================================================
// summary
// ===========================================================================
console.log("")
console.log(`PASS=${pass} FAIL=${failures.length}`)
if (failures.length > 0) {
  console.error("RESULT: FAIL")
  for (const f of failures) console.error(`  - ${f.name}: ${f.message}`)
}
process.exit(failures.length ? 1 : 0)
