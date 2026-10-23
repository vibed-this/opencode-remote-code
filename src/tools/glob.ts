/**
 * `glob` over SFTP (DESIGN-V3 §7.3).
 *
 * V2 shelled out to `rg --files --sortr=modified`, with a `find + stat + sort`
 * fallback; neither exists on a Windows remote and the fallback could not
 * express braces. V3 walks the tree with bounded SFTP `readdir` calls (`walk.ts`)
 * and matches with the ripgrep-flavoured matcher in `remote/glob.ts`, so the same
 * semantics apply to every remote. No remote shell is involved at all (§3.2).
 *
 * Two behaviours worth knowing when reading the output:
 *
 * - **Newest first.** Results are ordered by mtime descending (V2's
 *   `--sortr=modified`), ties broken by path ascending so the output is stable.
 *   A recursive listing is the tool's main use ("what changed recently"), and a
 *   plain alphabetical listing buries it.
 * - **"No files found" is only ever printed when the walk really finished.** If
 *   the depth/entry/time budget cut the traversal short, or the result cap hid
 *   files, the tool says so instead — a silent "nothing here" after a truncated
 *   walk is the worst possible answer for a model.
 */
import { matchGlob } from "../remote/glob.js"
import { walk, type WalkFile } from "../remote/walk.js"
import type { RemoteToolDefinition } from "../v2-bridge.js"
import { resolveRemotePath, truncationNote, type RemoteToolContext } from "./context.js"

export function createGlobTool(ctx: RemoteToolContext): RemoteToolDefinition {
  return {
    name: "glob",
    description: `Find files matching a glob pattern on the remote machine.`,
    input: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against",
        },
        path: {
          type: "string",
          description:
            "The directory to search in (absolute path on the remote machine). Omit to search the workspace root.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },

    async execute(args, _call) {
      // The pattern is *only* ever a pattern — it is never fed to the path
      // layer. So an absolute-looking pattern (`/src/*.ts`, `C:/x/*.ts`) is
      // matched against the walk-relative path and simply finds nothing, which
      // is exactly what V2's `rg --glob` did; the directory lives in `path`.
      const pattern = typeof args.pattern === "string" ? args.pattern : ""
      if (pattern.trim() === "") {
        throw new Error('Remote Code: glob requires a non-empty "pattern" string')
      }

      // Resolved exactly once: every reported path is `join(searchDir, rel)`.
      const searchDir = args.path ? resolveRemotePath(ctx, args.path) : ctx.remoteRoot
      const limit = Math.max(1, ctx.limits.globResults)

      const walkResult = await walk(ctx.fs, ctx.ops, searchDir, {
        ignore: ctx.ignore,
        maxDepth: ctx.limits.walkDepth,
        maxEntries: ctx.limits.walkEntries,
        includeDirs: false,
      })

      // NTFS is case-insensitive, POSIX is not — `ops.kind` is the only place in
      // the plugin that fact is allowed to surface (§3.3).
      const caseInsensitive = ctx.ops.kind === "windows"
      const matched = walkResult.files.filter((file: WalkFile) =>
        matchGlob(pattern, file.rel, { caseInsensitive })
      )

      // Newest first, path ascending on ties (mtime granularity is 1 s over
      // SFTP, so ties are common in a fresh checkout).
      matched.sort((a, b) => {
        if (b.dirent.mtime !== a.dirent.mtime) return b.dirent.mtime - a.dirent.mtime
        return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
      })

      const shown = matched.slice(0, limit)
      const capped = matched.length > limit
      const truncated = capped || walkResult.truncated

      const lines: string[] = shown.map((file) => ctx.ops.join(searchDir, file.rel))

      if (truncated) {
        // Only reached with an empty `lines` when the walk was cut short before
        // finding anything at all — then the note *is* the whole answer.
        if (lines.length > 0) lines.push("")
        const reason = capped ? "cap" : (walkResult.reason ?? "walk")
        const detail = capped
          ? `${shown.length} of ${matched.length} files`
          : `${walkResult.entries} entries visited`
        lines.push(truncationNote(reason, detail, "glob"))
      } else if (lines.length === 0) {
        lines.push("No files found")
      }

      return {
        content: lines.join("\n"),
        metadata: {
          title: searchDir,
          count: shown.length,
          truncated,
        },
      }
    },
  }
}
