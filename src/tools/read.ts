/**
 * `read` over SFTP (DESIGN-V3 §7.3).
 *
 * V2 detected the remote type with a shell `test`/`ls -1pA` triple and sniffed
 * binaries with `file`, `dd` and `od` — all POSIX-only. V3 asks SFTP instead:
 *
 *   ctx.fs.stat(p)                -> missing / directory / file
 *   ctx.fs.readdir(p)             -> directory listing (`ls -1pA` replacement)
 *   ctx.fs.readdir(parent)        -> "did you mean" suggestions for a typo
 *   ctx.fs.readPrefix(p, 8 KiB)   -> NUL byte sniff (binary detection)
 *   ctx.sync.ensureLocal(p)       -> pull one file into the local mirror
 *   fs.readFile(localPath)        -> the bytes actually rendered
 *
 * The file itself is still read from the LOCAL mirror, not from the SFTP buffer:
 * that is what keeps `read`/`write`/`edit`/`patch` looking at the same bytes, and
 * it is the behaviour the existing BOM/e2e tests pin down (`ignoreBOM: true`
 * keeps a UTF-8 BOM as a printable character instead of silently dropping it).
 */
import fs from "node:fs/promises"

import { isBinaryExtension } from "../remote/search.js"
import type { RemoteToolDefinition } from "../v2-bridge.js"
import { resolveRemotePath, type RemoteToolContext } from "./context.js"

const DEFAULT_LIMIT = 2000
const MAX_BYTES = 50 * 1024
const MAX_LINE_LENGTH = 2000
/** Bytes inspected for NUL when sniffing for binary content (§7.3). */
const SNIFF_BYTES = 8 * 1024
const MAX_SUGGESTIONS = 3

/** How the file was refused, e.g. "binary extension (.png)". */
function binaryReason(fileName: string): string | null {
  if (isBinaryExtension(fileName)) {
    const dot = fileName.lastIndexOf(".")
    return dot <= 0 ? "binary extension" : `binary extension (${fileName.slice(dot)})`
  }
  return null
}

export function createReadTool(ctx: RemoteToolContext): RemoteToolDefinition {
  return {
    name: "read",
    description: `Read the contents of a file or list a directory on the remote machine.`,
    input: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The absolute path to the file or directory to read",
        },
        offset: {
          type: "number",
          description: "The line number to start reading from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "The maximum number of lines to read (defaults to 2000)",
        },
      },
      required: ["filePath"],
      additionalProperties: false,
    },

    async execute(args, call) {
      const p = resolveRemotePath(ctx, args.filePath)

      // Reading outside the workspace is allowed but asked for (§Permissions).
      if (!ctx.mapper.isWithinWorkspace(p)) {
        await ctx.permission(call, {
          action: "read",
          resources: [p],
          save: [p],
          metadata: {},
        })
      }

      const limit = countOr(args.limit, DEFAULT_LIMIT, 1)
      // 1-indexed on the way in, 0-indexed internally; a negative/NaN offset is
      // clamped rather than indexing past the start of the array.
      const offset = countOr(args.offset, 1, 1) - 1

      // ---- type detection: SFTP only -------------------------------------
      const stat = await ctx.fs.stat(p)

      if (stat === null) return await missingPath(ctx, p)

      if (stat.dir) {
        const entries = await ctx.fs.readdir(p)
        // `ls -1pA` suffixes: `/` for a directory, `@` for a symlink. A listing
        // attribute is lstat-like, so a symlink shows up as `@` even when it
        // points at a directory.
        const names = entries
          .map((entry) => (entry.dir ? `${entry.name}/` : entry.symlink ? `${entry.name}@` : entry.name))
          .sort((a, b) => a.localeCompare(b))

        const sliced = names.slice(offset, offset + limit)
        const truncated = offset + sliced.length < names.length

        return {
          content: [
            `<path>${p}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${names.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length + 1})`
              : `\n(${names.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            title: p,
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
          },
        }
      }

      // ---- binary gate (before the file is pulled over the wire) ---------
      const reason = binaryReason(p)
      if (reason !== null) {
        throw new Error(
          `Cannot read binary file: ${p}\n\nReason: ${reason}. Use the shell tool to inspect it if needed.`
        )
      }

      const prefix = await ctx.fs.readPrefix(p, SNIFF_BYTES)
      if (prefix.includes(0)) {
        throw new Error(
          `Cannot read binary file: ${p}\n\nReason: NUL byte in the first ${SNIFF_BYTES} bytes. Use the shell tool to inspect it if needed.`
        )
      }

      // ---- text: pull the single file into the mirror, read it locally ---
      const localPath = await ctx.sync.ensureLocal(p)
      const buf = await fs.readFile(localPath)
      // ignoreBOM: true preserves the BOM as a regular character in the output
      // (false consumes it, which is what the editing tools do instead).
      const content = new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf)
      const lines = content.split("\n")

      // Offset validation
      if (offset > lines.length && lines.length > 0) {
        throw new Error(`Offset ${args.offset} is out of range (file has ${lines.length} lines)`)
      }

      const start = offset
      let bytes = 0
      const out: string[] = []
      let cut = false
      let more = false

      for (let i = start; i < lines.length; i++) {
        if (out.length >= limit) {
          more = true
          break
        }
        let line = lines[i] as string
        // Line length truncation
        if (line.length > MAX_LINE_LENGTH) {
          line = `${line.substring(0, MAX_LINE_LENGTH)} ... (line truncated)`
        }
        const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
        if (bytes + size > MAX_BYTES) {
          cut = true
          more = true
          break
        }
        out.push(line)
        bytes += size
      }

      let output = [`<path>${p}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += out.map((line, i) => `${i + start + 1}: ${line}`).join("\n")
      const last = start + out.length
      if (cut) {
        output += `\n\n(Output capped at ${MAX_BYTES / 1024} KB. Showing lines ${start + 1}-${last}. Use offset=${last + 1} to continue.)`
      } else if (more) {
        output += `\n\n(Showing lines ${start + 1}-${last} of ${lines.length}. Use offset=${last + 1} to continue.)`
      } else {
        output += `\n\n(End of file - total ${lines.length} lines)`
      }
      output += "\n</content>"

      return {
        content: output,
        metadata: {
          title: p,
          preview: out.slice(0, 20).join("\n"),
          truncated: more || cut,
        },
      }
    },
  }
}

/**
 * Missing path: list the parent over SFTP and offer up to three near-misses.
 * A model that typos `reacd.ts` recovers in one turn instead of two.
 */
async function missingPath(
  ctx: RemoteToolContext,
  p: string
): Promise<never> {
  const parent = ctx.ops.dirname(p)
  const wanted = ctx.ops.basename(p).toLowerCase()

  let suggestions: string[] = []
  try {
    const entries = await ctx.fs.readdir(parent)
    // `ops.dirname(p) === p` at a filesystem root, where readdir is useless.
    if (!ctx.ops.equals(parent, p) && wanted !== "") {
      suggestions = entries
        .map((entry) => entry.name)
        .filter((name) => {
          const lower = name.toLowerCase()
          // Prefix or substring, in either direction: `main` finds `main.ts`
          // and `index.tsx` is still offered for `index.ts`.
          return lower.includes(wanted) || wanted.includes(lower)
        })
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_SUGGESTIONS)
    }
  } catch {
    // Unreadable/absent parent: no suggestions, but never a different error —
    // the useful message is "this file does not exist".
  }

  if (suggestions.length > 0) {
    throw new Error(
      `File not found: ${p}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
    )
  }
  throw new Error(`File not found: ${p}`)
}

/**
 * Coerce a model-supplied count. The JSON Schema says "number", but a schema is
 * a hint, not a guarantee: `NaN`, `Infinity`, `-3` and `"10"` all arrive in
 * practice, and any of them would either render garbage or throw a RangeError
 * from `Array.prototype.slice`.
 */
function countOr(value: unknown, fallback: number, minimum: number): number {
  const num = typeof value === "string" ? Number(value) : value
  if (typeof num !== "number" || !Number.isFinite(num)) return fallback
  return Math.max(minimum, Math.trunc(num))
}
