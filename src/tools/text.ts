/**
 * Line-ending helpers shared by `write`, `edit` and `patch` (DESIGN-V3 §7.3,
 * "行尾统一").
 *
 * V2 only kept CRLF in `edit.ts` (three private helpers at the top of the file);
 * `write.ts` and `patch.ts` re-encoded everything as LF, so every edit of a
 * Windows file silently rewrote its line endings. The policy now lives here and
 * is applied by all three tools:
 *
 *  - `edit`   → detect the ending of the *original* content, write back with it.
 *  - `write`  → same for an existing file; a brand-new file gets `"\n"`.
 *  - `patch`  → the incoming patch is parsed as LF, hunks are applied to the LF
 *               form of each target file, and the result is re-encoded with that
 *               file's own ending (new files get `"\n"`).
 *
 * Unified-diff *previews* are always generated from `normalizeToLf()` text — a
 * preview is for humans, so it must not carry `\r` (see `write.ts`/`edit.ts`).
 */

export type LineEnding = "\n" | "\r\n"

/** Number of non-overlapping occurrences of `needle` in `text`. */
function count(haystack: string, needle: string): number {
  let total = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    total++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return total
}

/**
 * `"\r\n"` when the text is CRLF-dominant, `"\n"` otherwise.
 *
 * CRLF wins ties (`>=`) and requires at least one CRLF, so a mixed file that
 * was CRLF and gained a few LF lines stays CRLF, while a pure-LF file (or an
 * empty one) never becomes CRLF.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = count(text, "\r\n")
  if (crlf === 0) return "\n"
  const lfOnly = count(text, "\n") - crlf
  return crlf >= lfOnly ? "\r\n" : "\n"
}

/** CRLF and lone-CR → LF. Idempotent; used before parsing and before diffing. */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Re-encode LF text with `ending` (normalising first, so it is safe to call twice). */
export function applyLineEnding(text: string, ending: LineEnding): string {
  const lf = normalizeToLf(text)
  return ending === "\n" ? lf : lf.replace(/\n/g, "\r\n")
}

/**
 * Split into lines *and* keep the two facts a lossless round-trip needs: the
 * dominant ending and whether the text ended with a newline.
 *
 * `splitLines("a\r\nb\r\n")` → `{ lines: ["a","b"], ending: "\r\n", finalNewline: true }`
 * `splitLines("")`           → `{ lines: [], ending: "\n", finalNewline: false }`
 */
export function splitLines(text: string): {
  lines: string[]
  ending: LineEnding
  finalNewline: boolean
} {
  const ending = detectLineEnding(text)
  const lf = normalizeToLf(text)
  const finalNewline = lf.endsWith("\n")
  const body = finalNewline ? lf.slice(0, -1) : lf
  const lines = body === "" ? [] : body.split("\n")
  return { lines, ending, finalNewline }
}

/** Inverse of `splitLines`. */
export function joinLines(lines: string[], ending: LineEnding, finalNewline: boolean): string {
  const body = lines.join("\n")
  const lf = finalNewline ? `${body}\n` : body
  return applyLineEnding(lf, ending)
}
