/**
 * Content search (`grep`) over SFTP (DESIGN-V3 §7.3).
 *
 * V2 shelled out to `rg --json` with a `grep -Ern` fallback; neither exists on a
 * Windows remote, and two implementations meant two dialects. V3 reads files
 * over SFTP and matches with the JS `RegExp` engine, which is identical on both
 * platforms (§7.4).
 *
 * Budgets (all overridable) exist because this is the one tool that can read the
 * whole repository: 100 matches, 64 MiB actually transferred, 2 MiB per file and
 * 20 s wall clock. Hitting any of them returns *partial* results plus a reason,
 * which the tool renders as "narrow your pattern/path".
 *
 * Cost model per file: 1 SFTP `open` + ceil(size/32KiB) `read`s + 1 `close`.
 * The NUL sniff is taken from the *same* buffer as the content (first 8 KiB), so
 * binary detection costs no extra round trip.
 */
import type { RemotePathOps } from "../platform/path.js"
import type { RemoteFs } from "./fs.js"
import { matchGlob } from "./glob.js"
import { WALK_DEFAULTS, walk, type WalkLimits } from "./walk.js"

export interface SearchOptions {
  /** Absolute canonical directory to search. */
  root: string
  /** Pattern; may start with `(?i)` / `(?-i)` (see {@link compileSearchPattern}). */
  pattern: string
  /** Glob on the walk-relative path, e.g. `*.ts`, `*.{ts,tsx}`, `packages/x/src/*.ts`. */
  include?: string
  /** Directory names to skip. Defaults to `walk`'s list. */
  ignore?: string[]
  /** Default 100. */
  maxMatches?: number
  /** Total bytes allowed to be read, default 64 MiB. */
  maxBytes?: number
  /** Files larger than this are skipped entirely, default 2 MiB. */
  maxFileSize?: number
  /** Default 20_000 ms. */
  maxMillis?: number
  walkLimits?: WalkLimits
}

export interface SearchMatch {
  /** Absolute canonical remote path (`ops.join(root, rel)`). */
  path: string
  /** 1-based line number. */
  line: number
  /** Line content without the line terminator and without a trailing `\r`. */
  text: string
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
  reason?: "matches" | "bytes" | "time" | "walk"
  /**
   * The listing itself was cut short (depth / entries / time), independent of
   * `reason`: candidates that were never listed cannot be searched, so results
   * may be incomplete even when the read loop finished cleanly.
   */
  walkTruncated: boolean
  /** Why the walk stopped, when `walkTruncated` — lets the caller say which. */
  walkReason?: "entries" | "time" | "depth"
  /** Directory entries visited by the walk (files + dirs), for honest wording. */
  walkEntries: number
  /** Bytes actually transferred. */
  scannedBytes: number
  /** Files actually read. */
  scannedFiles: number
  /** Skipped as binary (extension blacklist or NUL in the first 8 KiB). */
  skippedBinary: number
  /** Skipped because `size > maxFileSize`. */
  skippedLarge: number
}

export const SEARCH_DEFAULTS = {
  maxMatches: 100,
  maxBytes: 64 * 1024 * 1024,
  maxFileSize: 2 * 1024 * 1024,
  // 45 s (not 20 s): over SFTP each directory costs a round trip, and a linked
  // (tunnelled) remote takes 0.3–0.8 s per round trip.
  maxMillis: 45_000,
} as const

/** How much of a file is inspected for NUL bytes. */
const SNIFF_BYTES = 8 * 1024

/**
 * Extension blacklist — same list the `read` tool uses (DESIGN §7.3: "扩展名黑名单
 * + readPrefix(8KB) 含 NUL"). Checked *before* any read, so a directory full of
 * build artefacts costs zero bytes.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // archives
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".jar", ".war",
  // executables / objects
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".obj", ".lib", ".class", ".wasm",
  // images
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff", ".psd",
  // documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt",
  // media
  ".mp3", ".mp4", ".m4a", ".avi", ".mov", ".mkv", ".wav", ".flac", ".ogg", ".webm",
  // fonts / misc
  ".ttf", ".otf", ".woff", ".woff2", ".eot", ".pyc", ".pyo", ".pdb", ".sqlite", ".db",
])

/** `true` when the file name's extension is on the binary blacklist. */
export function isBinaryExtension(fileName: string): boolean {
  const slash = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"))
  const name = slash === -1 ? fileName : fileName.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return false
  return BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

function hasNulByte(buf: Buffer): boolean {
  return buf.subarray(0, SNIFF_BYTES).includes(0)
}

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

/** `(?i)`, `(?im)`, `(?-i)`, … as produced by ripgrep/Python users. */
const LEADING_FLAGS = /^\(\?([a-zA-Z]+|-?[a-zA-Z]*)\)/

/**
 * Compile a search pattern, lifting leading inline flags into `RegExp` flags
 * (DESIGN §7.4: JS has no `(?i)`).
 *
 *   "(?i)foo"    -> /foo/i
 *   "(?i)foo(?-i)" -> /foo/i   (only the *leading* group is lifted; a later
 *                               `(?-i)` is left to the engine, which rejects it)
 *
 * Anything the engine cannot parse throws an Error that names the pattern and,
 * for the two common traps (`(?i)` in the middle, unbalanced group), says what
 * to do instead.
 */
export function compileSearchPattern(pattern: string): RegExp {
  if (pattern === "") throw new Error("Empty search pattern: provide a regular expression to match")

  let source = pattern
  let flags = ""

  for (;;) {
    const m = LEADING_FLAGS.exec(source)
    if (m === null) break
    const group = m[1] as string
    // Only accept pure flag groups (i / m / s, optionally a "-" and more of
    // them). `(?:`, `(?=`, `(?<name>` must fall through to the engine.
    if (!/^-?[ims]*$/.test(group) || group === "-") break
    const negated = group.startsWith("-")
    const letters = negated ? group.slice(1) : group
    if (letters === "") break
    for (const letter of letters) {
      const known = "ims".includes(letter)
      if (!known) {
        throw new Error(
          `Unsupported inline flag (?${letter}) in pattern ${JSON.stringify(pattern)}: ` +
            `only (?i), (?m) and (?s) can be lifted into JavaScript regex flags`
        )
      }
      if (negated) flags = flags.replace(letter, "")
      else if (!flags.includes(letter)) flags += letter
    }
    source = source.slice(m[0].length)
  }

  if (source === "") {
    throw new Error(`Pattern ${JSON.stringify(pattern)} contains only inline flags and nothing to match`)
  }

  try {
    return new RegExp(source, flags)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    if (/\(\?[a-zA-Z-]+\)/.test(source)) {
      throw new Error(
        `Invalid regular expression ${JSON.stringify(pattern)}: ${detail}. ` +
          `Inline flags like (?i) are only supported at the very start of the pattern.`
      )
    }
    throw new Error(`Invalid regular expression ${JSON.stringify(pattern)}: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A file that survived every no-I/O filter and may be read. */
interface Candidate {
  /** Absolute canonical remote path. */
  absolute: string
  /** Bytes to request (min(size, maxFileSize)). */
  want: number
}

interface PendingRead {
  candidate: Candidate
  /** Resolves to `null` when the file became unreadable — never rejects. */
  promise: Promise<Buffer | null>
}

export async function searchFiles(
  remoteFs: RemoteFs,
  ops: RemotePathOps,
  opts: SearchOptions
): Promise<SearchResult> {
  const maxMatches = Math.max(1, opts.maxMatches ?? SEARCH_DEFAULTS.maxMatches)
  const maxBytes = Math.max(0, opts.maxBytes ?? SEARCH_DEFAULTS.maxBytes)
  const maxFileSize = Math.max(0, opts.maxFileSize ?? SEARCH_DEFAULTS.maxFileSize)
  const maxMillis = Math.max(0, opts.maxMillis ?? SEARCH_DEFAULTS.maxMillis)

  // Compiled before walking: an invalid pattern must fail before any I/O.
  const re = compileSearchPattern(opts.pattern)
  const caseInsensitiveGlob = ops.kind === "windows"
  const startedAt = Date.now()

  const walkResult = await walk(remoteFs, ops, opts.root, {
    ...(opts.walkLimits ?? {}),
    maxMillis: opts.walkLimits?.maxMillis ?? maxMillis,
    ignore: opts.ignore,
  })

  const matches: SearchMatch[] = []
  let scannedBytes = 0
  let scannedFiles = 0
  let skippedBinary = 0
  let skippedLarge = 0
  let truncated = false
  let reason: SearchResult["reason"]

  const walkTruncated = walkResult.truncated
  const walkReason = walkResult.reason
  const walkEntries = walkResult.entries

  /**
   * Blame the right budget. If the *listing* was already cut short and nothing
   * has been read yet, the honest reason is the walk — reporting "time" there
   * produced "0 files scanned" plus a message about narrowing the search.
   */
  const stopReasonForTime = (): NonNullable<SearchResult["reason"]> =>
    walkTruncated && scannedFiles === 0 ? "walk" : "time"

  let stopped = false
  let matchCapHit = false
  const stopFor = (why: NonNullable<SearchResult["reason"]>): void => {
    if (stopped) return
    truncated = true
    reason = why
    stopped = true
  }

  // ---------------------------------------------------------------------
  // Candidate set — every filter that costs no I/O happens first, so the
  // `include` glob and the binary/size heuristics never touch the wire.
  // ---------------------------------------------------------------------
  const candidates: Candidate[] = []
  for (const file of walkResult.files) {
    if (file.dirent.dir) continue
    if (opts.include !== undefined && opts.include !== "") {
      if (!matchGlob(opts.include, file.rel, { caseInsensitive: caseInsensitiveGlob })) continue
    }
    if (isBinaryExtension(file.rel)) {
      skippedBinary += 1
      continue
    }
    if (file.dirent.size > maxFileSize) {
      skippedLarge += 1
      continue
    }
    candidates.push({
      absolute: ops.join(opts.root, file.rel),
      // `size === 0` is "unknown" for a few servers; asking for the cap then
      // costs a single EOF read instead of silently searching nothing.
      want: file.dirent.size > 0 ? Math.min(file.dirent.size, maxFileSize) : maxFileSize,
    })
  }

  // ---------------------------------------------------------------------
  // Bounded read-ahead. SFTP is request/response: one file costs
  // open + ceil(size/32KiB) reads + close, i.e. ~3 round trips for a small
  // file. Reading `window` files at a time is what makes grep on a real
  // checkout finish inside the time budget; matches are still *appended in
  // walk order* because the window is drained FIFO.
  // ---------------------------------------------------------------------
  const window = Math.max(1, opts.walkLimits?.concurrency ?? WALK_DEFAULTS.concurrency)
  const inFlight: PendingRead[] = []
  let nextIndex = 0
  let admittedBytes = 0

  const fill = (): void => {
    while (!stopped && inFlight.length < window && nextIndex < candidates.length) {
      if (Date.now() - startedAt > maxMillis) {
        stopFor(stopReasonForTime())
        return
      }
      const candidate = candidates[nextIndex] as Candidate
      if (admittedBytes + candidate.want > maxBytes) {
        stopFor("bytes")
        return
      }
      nextIndex += 1
      admittedBytes += candidate.want
      inFlight.push({
        candidate,
        // A file that vanished between listing and read must not abort a
        // whole-tree search.
        promise: remoteFs.readPrefix(candidate.absolute, candidate.want).catch(() => null),
      })
    }
  }

  fill()
  // `stopped` only prevents *new* reads from being launched: buffers already in
  // hand are still scanned (their bytes are already paid for).
  while (inFlight.length > 0) {
    if (Date.now() - startedAt > maxMillis) {
      stopFor(stopReasonForTime())
      break
    }
    const entry = inFlight.shift() as PendingRead
    const buf = await entry.promise
    if (buf === null) {
      fill()
      continue
    }

    scannedFiles += 1
    scannedBytes += buf.length

    if (hasNulByte(buf)) {
      skippedBinary += 1
      fill()
      continue
    }

    // Non-fatal UTF-8: invalid sequences become U+FFFD rather than throwing.
    const text = new TextDecoder("utf-8").decode(buf)
    const lines = text.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] as string
      // CRLF tolerant: the model never wants the `\r`.
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
      if (!re.test(line)) continue
      if (matches.length >= maxMatches) {
        matchCapHit = true
        break
      }
      matches.push({ path: entry.candidate.absolute, line: i + 1, text: line })
    }
    if (matchCapHit) {
      stopFor("matches")
      break
    }
    fill()
  }

  // Drain whatever was already in flight when a budget tripped: the reads are
  // cached with `.catch()`, this just avoids leaving SFTP sessions open behind
  // the caller's back.
  await Promise.allSettled(inFlight.map((entry) => entry.promise))

  if (!truncated && walkTruncated) {
    // The listing itself was cut short (depth/entries/time) — the caller must
    // tell the model, otherwise "no matches" would be a lie.
    stopFor("walk")
  }

  return {
    matches,
    truncated,
    reason,
    walkTruncated,
    walkReason,
    walkEntries,
    scannedBytes,
    scannedFiles,
    skippedBinary,
    skippedLarge,
  }
}
