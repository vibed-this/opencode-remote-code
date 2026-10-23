/**
 * `grep` over SFTP (DESIGN-V3 §7.3/§7.4).
 *
 * V2 ran `rg --json` with a `grep -Ern` fallback; V3 walks the tree with bounded
 * SFTP `readdir`s, reads candidate files over SFTP and matches with the JS
 * `RegExp` engine (`remote/search.ts`). No remote shell, and therefore identical
 * semantics whether the remote is Linux, macOS or Windows.
 *
 * The rendered format is deliberately the one the model already knows from V2
 * (header, `path:`, `  Line <n>: <text>`, blank line between files) so existing
 * trajectories keep working:
 *
 *   Found 2 matches
 *   /home/x/proj/src/a.ts:
 *     Line 12: const x = 1
 *     Line 40: const y = 2
 *
 *   /home/x/proj/src/b.ts:
 *     Line 7: const z = 3
 *
 * Differences from the shell implementation that the model can observe:
 *   - the regex dialect is JavaScript (not Rust/PCRE); leading `(?i)`/`(?m)`/`(?s)`
 *     are lifted into `RegExp` flags, anything else illegal fails loudly;
 *   - the byte budget (64 MiB), per-file size cap (2 MiB), match cap (100) and
 *     wall-clock budget (20 s) can cut the search short, and the output then
 *     says so instead of pretending the repo contains nothing.
 */
import { compileSearchPattern, searchFiles } from "../remote/search.js"
import type { RemoteToolDefinition } from "../v2-bridge.js"
import { resolveRemotePath, truncationNote, type RemoteToolContext } from "./context.js"

/** Matched line text is cut here so one minified file cannot flood the context. */
const MAX_LINE_LENGTH = 2000

export function createGrepTool(ctx: RemoteToolContext): RemoteToolDefinition {
  return {
    name: "grep",
    description: `Search file contents on the remote machine.`,
    input: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "The regular expression (JavaScript syntax) to search for in file contents",
        },
        path: {
          type: "string",
          description:
            "The directory to search in (absolute path on the remote machine). Defaults to the workspace root.",
        },
        include: {
          type: "string",
          description: "File pattern to include in the search (e.g. '*.js', '*.{ts,tsx}')",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },

    async execute(args, _call) {
      const pattern = typeof args.pattern === "string" ? args.pattern : ""
      if (pattern.trim() === "") {
        throw new Error('Remote Code: grep requires a non-empty "pattern" string')
      }

      // Fail before any I/O, and put the pattern at the front of the message:
      // the model wrote it, so it is the thing it can actually fix (§7.4).
      try {
        compileSearchPattern(pattern)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`Pattern ${JSON.stringify(pattern)}: ${detail}`)
      }

      const searchDir = args.path ? resolveRemotePath(ctx, args.path) : ctx.remoteRoot
      const include = typeof args.include === "string" && args.include.trim() !== ""
        ? args.include
        : undefined

      const result = await searchFiles(ctx.fs, ctx.ops, {
        root: searchDir,
        pattern,
        include,
        ignore: ctx.ignore,
        maxMatches: ctx.limits.searchMatches,
        maxBytes: ctx.limits.searchBytes,
        maxFileSize: ctx.limits.searchFileSize,
        maxMillis: ctx.limits.searchMillis,
        walkLimits: {
          maxDepth: ctx.limits.walkDepth,
          maxEntries: ctx.limits.walkEntries,
        },
      })

      const { matches, truncated, reason } = result
      // "the match cap stopped us" is distinguishable from every other budget:
      // it is the only one where the match list itself is full.
      const capped = truncated && reason === "matches"

      const lines: string[] = []
      if (matches.length === 0) {
        if (!truncated) {
          lines.push("No files found")
        } else {
          lines.push(truncationNote(reason, budgetDetail(result), "grep"))
        }
      } else {
        lines.push(`Found ${matches.length} matches${capped ? ` (showing first ${matches.length})` : ""}`)

        let currentPath = ""
        for (const match of matches) {
          if (match.path !== currentPath) {
            if (currentPath !== "") lines.push("")
            currentPath = match.path
            lines.push(`${match.path}:`)
          }
          const text =
            match.text.length > MAX_LINE_LENGTH
              ? `${match.text.substring(0, MAX_LINE_LENGTH)}...`
              : match.text
          lines.push(`  Line ${match.line}: ${text}`)
        }

        if (truncated) {
          lines.push("")
          lines.push(truncationNote(reason, budgetDetail(result), "grep"))
        }
      }

      return {
        content: lines.join("\n"),
        metadata: {
          title: pattern,
          matches: matches.length,
          truncated,
        },
      }
    },
  }
}

/**
 * The `detail` half of `truncationNote()`. The match case wants a bare number
 * ("showing the first 100 matches"); every other budget reads better with the
 * amount of work that was actually done.
 */
function budgetDetail(result: {
  reason?: string
  matches: { length: number }
  scannedFiles: number
  scannedBytes: number
  walkEntries?: number
}): string {
  if (result.reason === "matches") return String(result.matches.length)
  if (result.reason === "bytes") {
    return `${result.scannedFiles} files scanned, ${Math.round(result.scannedBytes / (1024 * 1024))} MiB read`
  }
  if (result.reason === "walk" && typeof result.walkEntries === "number") {
    // Distinguishes "searched everything and found nothing" from "never got to
    // read the files you wanted", which is the common case on a drive root.
    return `${result.scannedFiles} files scanned, ${result.walkEntries} entries visited`
  }
  return `${result.scannedFiles} files scanned`
}
