/**
 * test/glob-matcher.mjs — pure tests for the SFTP-era glob matcher.
 *
 * Covers DESIGN-V3 §7.4 and the semantics `glob` / `grep --include` depend on:
 * `*` / `?` never cross `/`, `**` (and `**\/` = zero or more dirs) does,
 * `{a,b}` alternation (nested), `[abc]` / `[!abc]` classes, basename-only
 * patterns, patterns containing `/`, `./` normalisation, backslash separators,
 * case-insensitive mode, and regex-metacharacter escaping.
 *
 * Uses `posixPathOps` only to prove the matcher never needs a real filesystem.
 *
 *   npm run build && node test/glob-matcher.mjs      # exit 0 = all PASS
 */

import assert from "node:assert/strict"

import { expandBraces, globToRegExp, matchGlob } from "../dist/remote/glob.js"

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

function yes(pattern, path, opts) {
  assert.equal(matchGlob(pattern, path, opts), true, `expected ${JSON.stringify(pattern)} to match ${JSON.stringify(path)}`)
}

function no(pattern, path, opts) {
  assert.equal(matchGlob(pattern, path, opts), false, `expected ${JSON.stringify(pattern)} NOT to match ${JSON.stringify(path)}`)
}

// ===========================================================================
// expandBraces
// ===========================================================================
check("expandBraces: no braces returns the pattern unchanged", () => {
  assert.deepEqual(expandBraces("*.ts"), ["*.ts"])
  assert.deepEqual(expandBraces("src/**/a.ts"), ["src/**/a.ts"])
})

check("expandBraces: simple alternation", () => {
  assert.deepEqual(expandBraces("*.{ts,tsx}"), ["*.ts", "*.tsx"])
  assert.deepEqual(expandBraces("{a,b,c}.ts"), ["a.ts", "b.ts", "c.ts"])
})

check("expandBraces: two groups multiply", () => {
  assert.deepEqual(expandBraces("{a,b}.{c,d}"), ["a.c", "a.d", "b.c", "b.d"])
})

check("expandBraces: nested groups", () => {
  assert.deepEqual(expandBraces("x{a,{b,c}y}"), ["xa", "xby", "xcy"])
})

check("expandBraces: unmatched brace stays literal", () => {
  assert.deepEqual(expandBraces("a{b"), ["a{b"])
  assert.deepEqual(expandBraces("a}b"), ["a}b"])
})

// ===========================================================================
// `*` — never crosses a separator
// ===========================================================================
check("*: matches a plain name, not another extension", () => {
  yes("*.ts", "a.ts")
  no("*.ts", "a.js")
})

check("*: a bare `*` does not cross `/`", () => {
  assert.equal(globToRegExp("a*b").test("a/b"), false)
  assert.equal(globToRegExp("a*b").test("axb"), true)
})

check("*: `src/*.ts` matches one level only", () => {
  yes("src/*.ts", "src/a.ts")
  no("src/*.ts", "src/deep/a.ts")
  no("src/*.ts", "other/a.ts")
})

// ===========================================================================
// `?`
// ===========================================================================
check("?: matches exactly one character", () => {
  yes("a?.ts", "ab.ts")
  no("a?.ts", "abc.ts")
  no("a?.ts", "a.ts")
})

check("?: does not cross `/`", () => {
  assert.equal(globToRegExp("a?b").test("a/b"), false)
  assert.equal(globToRegExp("a?b").test("axb"), true)
})

// ===========================================================================
// `**`
// ===========================================================================
check("**: `**/*.ts` matches at any depth, including zero directories", () => {
  yes("**/*.ts", "a.ts")
  yes("**/*.ts", "src/a.ts")
  yes("**/*.ts", "src/x/y/a.ts")
  no("**/*.ts", "src/x/y/a.js")
})

check("**: mid-pattern `**/` also matches zero directories", () => {
  yes("a/**/b.ts", "a/b.ts")
  yes("a/**/b.ts", "a/x/b.ts")
  yes("a/**/b.ts", "a/x/y/z/b.ts")
  no("a/**/b.ts", "a/b.js")
})

check("**: a bare `**` matches everything", () => {
  yes("**", "a.ts")
  yes("**", "deep/x/y.ts")
})

check("**: trailing `/**` matches the directory contents", () => {
  yes("src/**", "src/a.ts")
  yes("src/**", "src/x/y/a.ts")
  no("src/**", "other/a.ts")
})

// ===========================================================================
// braces through the matcher
// ===========================================================================
check("{a,b}: extension alternation", () => {
  yes("*.{ts,tsx}", "a.ts")
  yes("*.{ts,tsx}", "deep/a.tsx")
  no("*.{ts,tsx}", "a.js")
})

check("{a,b}: alternation inside a path", () => {
  yes("src/{a,b}/*.ts", "src/a/x.ts")
  yes("src/{a,b}/*.ts", "src/b/x.ts")
  no("src/{a,b}/*.ts", "src/c/x.ts")
})

// ===========================================================================
// character classes
// ===========================================================================
check("[abc]: positive class", () => {
  yes("[abc].ts", "b.ts")
  no("[abc].ts", "d.ts")
  yes("file[0-9].txt", "file3.txt")
  no("file[0-9].txt", "filex.txt")
})

check("[!abc]: negated class", () => {
  yes("file[!0-9].txt", "filex.txt")
  no("file[!0-9].txt", "file3.txt")
})

check("[!abc]: a negated class never matches `/`", () => {
  assert.equal(globToRegExp("a[!x]b").test("a/b"), false)
})

// ===========================================================================
// basename-only patterns vs whole-path patterns
// ===========================================================================
check("basename: a pattern without `/` matches the basename at any depth", () => {
  yes("*.md", "readme.md")
  yes("*.md", "docs/readme.md")
  yes("*.md", "docs/a/b/readme.md")
  no("*.md", "docs/readme.txt")
})

check("whole path: a pattern containing `/` must match the whole relative path", () => {
  yes("docs/*.md", "docs/readme.md")
  no("docs/*.md", "other/readme.md")
  no("docs/*.md", "docs/a/readme.md")
})

// ===========================================================================
// `./` normalisation
// ===========================================================================
check("./: leading `./` is normalised away", () => {
  yes("./a.ts", "a.ts")
  yes("./*.ts", "a.ts")
  yes("./**/*.ts", "src/a.ts")
  yes("./src/*.ts", "src/a.ts")
  yes("././src/*.ts", "src/a.ts")
  assert.equal(globToRegExp("./src/*.ts").test("src/a.ts"), true)
})

check("./: leading `./` on the input path is normalised away too", () => {
  yes("*.ts", "./a.ts")
  yes("src/*.ts", "./src/a.ts")
})

// ===========================================================================
// separators
// ===========================================================================
check("separators: backslashes in the pattern are separators", () => {
  yes("src\\*.ts", "src/a.ts")
  yes("src\\deep\\*.ts", "src/deep/a.ts")
})

check("separators: backslashes in the path are separators", () => {
  yes("src/*.ts", "src\\a.ts")
  yes("**/*.ts", "src\\deep\\a.ts")
})

// ===========================================================================
// case sensitivity
// ===========================================================================
check("case: sensitive by default", () => {
  no("*.TS", "a.ts")
  no("src/*.ts", "SRC/a.ts")
})

check("case: caseInsensitive mode folds both sides", () => {
  yes("*.TS", "a.ts", { caseInsensitive: true })
  yes("*.ts", "A.TS", { caseInsensitive: true })
  yes("SRC/*.ts", "src/a.ts", { caseInsensitive: true })
  // the cache must not leak the flag between calls
  no("*.TS", "a.ts")
  no("SRC/*.ts", "src/a.ts")
})

// ===========================================================================
// regex metacharacters must be literal
// ===========================================================================
check("metachars: `.` is literal", () => {
  yes("a.b", "a.b")
  no("a.b", "axb")
})

check("metachars: `+`, `(`, `)`, `|`, `^`, `$` are literal", () => {
  yes("a+b", "a+b")
  no("a+b", "aab")
  yes("(x)", "(x)")
  no("(x)", "x")
  no("a|b", "a")
  no("a^b", "axb")
  no("a$b", "ab")
})

check("metachars: the compiled regexp is anchored", () => {
  assert.equal(globToRegExp("a.ts").test("xa.ts"), false)
  assert.equal(globToRegExp("a.ts").test("a.tsx"), false)
  assert.equal(globToRegExp("*.ts").test("a.ts"), true)
  assert.equal(globToRegExp("*.ts").test("a.tsx"), false)
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
