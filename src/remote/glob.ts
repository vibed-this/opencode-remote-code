/**
 * Glob → RegExp matcher (DESIGN-V3 §7.3/§7.4).
 *
 * Replaces `rg --glob` / `find -name`. The semantics are deliberately
 * ripgrep-flavoured, because that is what the model has been trained on:
 *
 * | pattern        | means                                                        |
 * | -------------- | ------------------------------------------------------------ |
 * | `*`            | any run of non-`/` characters (never crosses a separator)     |
 * | `?`            | exactly one non-`/` character                                 |
 * | `**`           | any run of characters, separators included                    |
 * | `**\/`         | zero *or more* complete directories (so it also matches the   |
 * |                | file directly inside the root)                                |
 * | `{a,b}`        | alternation; nested, and commas may be escaped by nesting     |
 * | `[abc]`        | character class; `[!abc]` / `[^abc]` negated (never matches `/`) |
 *
 * Two conveniences the tools depend on:
 *
 * 1. **A pattern without `/` is matched against the BASENAME**, so `*.ts` finds
 *    `src/deep/a.ts` (this is `rg --glob '*.ts'` behaviour). A pattern that
 *    contains `/` is matched against the whole relative path.
 * 2. **Backslashes in either the pattern or the path are treated as path
 *    separators**, not as escapes: models type `src\*.ts` on Windows and the
 *    canonical internal form is always `/`. (Consequence, documented as a
 *    limitation: a POSIX filename that literally contains `\` cannot be globbed.)
 *
 * Everything else is literal: `.` is escaped, so `a.b` never matches `axb`.
 */
export interface GlobOptions {
  /** Fold case. Callers pass `ops.kind === "windows"`; NTFS is case-insensitive. */
  caseInsensitive?: boolean
}

/** Bound for the compiled-pattern cache (tools call `matchGlob` once per file). */
const CACHE_LIMIT = 128

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/")
}

/** Repeated `./` prefixes are noise — §7.4 normalises them away before matching. */
function stripDotSlash(p: string): string {
  let out = p
  while (out.startsWith("./")) out = out.slice(2)
  return out
}

function normalizePattern(pattern: string): string {
  return stripDotSlash(toForwardSlashes(pattern))
}

function basenameOf(relPath: string): string {
  const i = relPath.lastIndexOf("/")
  return i === -1 ? relPath : relPath.slice(i + 1)
}

// ---------------------------------------------------------------------------
// Brace expansion
// ---------------------------------------------------------------------------

/**
 * `a{b,c}d` -> `a b d`... precisely: `["abd","acd"]`. Nested braces and commas
 * inside nested braces are handled; an unbalanced brace is left literal.
 */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{")
  if (open === -1) return [pattern]

  const close = findClosingBrace(pattern, open)
  if (close === -1) return [pattern]

  const prefix = pattern.slice(0, open)
  const body = pattern.slice(open + 1, close)
  const suffix = pattern.slice(close + 1)

  const out: string[] = []
  for (const alternative of splitTopLevel(body)) {
    // Recursion covers both `a{b,{c,d}}e` and a second brace later in the string.
    for (const expanded of expandBraces(prefix + alternative + suffix)) out.push(expanded)
  }
  return out
}

function findClosingBrace(pattern: string, open: number): number {
  let depth = 0
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ""
  for (const ch of body) {
    if (ch === "{") depth += 1
    else if (ch === "}") depth -= 1
    if (ch === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

// ---------------------------------------------------------------------------
// Pattern -> regex source
// ---------------------------------------------------------------------------

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/

function escapeLiteral(ch: string): string {
  return REGEX_METACHARS.test(ch) ? `\\${ch}` : ch
}

/** `[abc]`, `[!a-z]`, `[^a-z]`; returns `null` when the class is unterminated (then `[` is literal). */
function parseCharClass(
  pattern: string,
  start: number
): { source: string; next: number } | null {
  let i = start + 1
  let negate = false
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true
    i += 1
  }

  let body = ""
  let bodyHasSlash = false
  while (i < pattern.length) {
    const ch = pattern[i] as string
    if (ch === "]" && body !== "") {
      // A negated class must not match "/" either — `*` does not cross a
      // separator, so neither should `[!x]`.
      const negated = negate ? (bodyHasSlash ? "^" : "^/") : ""
      return { source: `[${negated}${body}]`, next: i + 1 }
    }
    if (ch === "\\" || ch === "]" || ch === "^") body += `\\${ch}`
    else {
      body += ch
      if (ch === "/") bodyHasSlash = true
    }
    i += 1
  }
  return null
}

function patternToSource(pattern: string): string {
  let out = ""
  let i = 0
  const n = pattern.length

  while (i < n) {
    const ch = pattern[i] as string

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/"
        if (atSegmentStart && pattern[i + 2] === "/") {
          // "**/" also matches zero directories: "**/a.ts" matches "a.ts".
          out += "(?:[^/]+/)*"
          i += 3
          continue
        }
        // Bare "**": crosses everything.
        out += ".*"
        i += 2
        continue
      }
      out += "[^/]*"
      i += 1
      continue
    }

    if (ch === "?") {
      out += "[^/]"
      i += 1
      continue
    }

    if (ch === "/") {
      // A trailing "/**" also matches the directory itself ("src/**" ~ "src"
      // and everything inside it) — matches gitignore/ripgrep intuition.
      if (pattern.slice(i + 1) === "**") {
        out += "(?:/.*)?"
        i = n
        continue
      }
      out += "/"
      i += 1
      continue
    }

    if (ch === "[") {
      const cls = parseCharClass(pattern, i)
      if (cls !== null) {
        out += cls.source
        i = cls.next
        continue
      }
      out += "\\["
      i += 1
      continue
    }

    out += escapeLiteral(ch)
    i += 1
  }

  return out
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a glob pattern to an **anchored** RegExp.
 *
 * Note: when the pattern contains no `/`, the regexp is meant to be applied to a
 * *basename* (see {@link matchGlob}); applying it to a full relative path would
 * never match.
 */
export function globToRegExp(pattern: string, opts: GlobOptions = {}): RegExp {
  const normalized = normalizePattern(pattern)
  const source = expandBraces(normalized).map(patternToSource).join("|")
  return new RegExp(`^(?:${source})$`, opts.caseInsensitive ? "i" : "")
}

interface CompiledMatcher {
  re: RegExp
  basenameOnly: boolean
}

const matcherCache = new Map<string, CompiledMatcher>()

function compile(pattern: string, opts: GlobOptions): CompiledMatcher {
  const key = `${opts.caseInsensitive ? "i" : "-"}\u0000${pattern}`
  const cached = matcherCache.get(key)
  if (cached !== undefined) return cached

  const normalized = normalizePattern(pattern)
  const alternatives = expandBraces(normalized)
  const matcher: CompiledMatcher = {
    re: globToRegExp(pattern, opts),
    basenameOnly: !alternatives.some((alt) => alt.includes("/")),
  }
  if (matcherCache.size >= CACHE_LIMIT) matcherCache.clear()
  matcherCache.set(key, matcher)
  return matcher
}

/** Does `relPath` (a walk-relative path, forward slashes) match `pattern`? */
export function matchGlob(pattern: string, relPath: string, opts: GlobOptions = {}): boolean {
  const matcher = compile(pattern, opts)
  const target = stripDotSlash(toForwardSlashes(relPath))
  return matcher.re.test(matcher.basenameOnly ? basenameOf(target) : target)
}
