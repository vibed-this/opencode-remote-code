/**
 * `write` — create or overwrite one remote file via the local mirror.
 *
 * V3 plumbing (DESIGN-V3 §7.3 / §8.3): the remote path is canonicalised by
 * `RemotePathOps` (through `resolveRemotePath`), the single file being written is
 * pulled with `SyncEngine.ensureLocal()` and pushed back with
 * `SyncEngine.commit()`. V2 re-sent every tracked file on every call; V3 touches
 * exactly one file per operation.
 *
 * Line endings: an existing file keeps its own ending (a CRLF file stays CRLF);
 * a new file is written with `"\n"` — never invent CRLF for a file we create.
 * The permission preview is built from LF-normalised text so it stays readable.
 */
import fs from "node:fs/promises"
import path from "node:path"

import { createTwoFilesPatch } from "diff"

import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"
import type { RemoteToolDefinition } from "../v2-bridge.js"
import { resolveRemotePath, type RemoteToolContext } from "./context.js"
import { applyLineEnding, detectLineEnding, normalizeToLf } from "./text.js"

export function createWriteTool(ctx: RemoteToolContext): RemoteToolDefinition {
  return {
    name: "write",
    description: `Write content to a file on the remote machine.`,
    input: {
      type: "object",
      properties: {
        content: { type: "string", description: "The content to write to the file" },
        filePath: {
          type: "string",
          description: "The absolute path to the file to write (must be absolute)",
        },
      },
      required: ["content", "filePath"],
      additionalProperties: false,
    },
    async execute(args, identity) {
      const remotePath = resolveRemotePath(ctx, args.filePath)
      if (!ctx.mapper.isWithinWorkspace(remotePath)) {
        await ctx.permission(identity, {
          action: "edit",
          resources: [remotePath],
          save: [remotePath],
          metadata: {},
        })
      }

      // `ensureLocal()` deliberately materialises an *empty* local file when the
      // remote one does not exist (that is how add-file works), so remote state —
      // not the local mirror — decides whether this is a create or an overwrite.
      const stat = await ctx.fs.stat(remotePath)
      if (stat && stat.dir) {
        throw new Error(`Remote Code: ${remotePath} is a directory, not a file`)
      }
      const existed = stat !== null

      const localPath = await ctx.sync.ensureLocal(remotePath)

      // Preserve BOM: source.bom || next.bom (OpenCode semantics)
      let bom = false
      let oldContent = ""
      if (existed) {
        try {
          const existing = await readFileWithBom(fs, localPath)
          bom = existing.bom
          oldContent = existing.text
        } catch {}
      }
      bom = bom || splitBom(args.content).bom

      // Keep the file's own line ending; a new file defaults to LF.
      const ending = existed ? detectLineEnding(oldContent) : "\n"
      const newContent = applyLineEnding(args.content, ending)

      // Build diff preview for permission request (LF-normalised: never show \r)
      const newForPreview = normalizeToLf(args.content)
      const diffPreview = existed
        ? generateDiffPreview(remotePath, normalizeToLf(oldContent), newForPreview)
        : `A ${remotePath}\n+ ${newForPreview.split("\n").slice(0, 10).join("\n+ ")}`

      await ctx.permission(identity, {
        action: "edit",
        resources: [remotePath],
        save: [remotePath],
        metadata: { diff: diffPreview },
      })

      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, joinBom(newContent, bom), "utf-8")

      // Push just this file (creates the remote parent as needed)
      await ctx.sync.commit(remotePath)

      return {
        content: "Wrote file successfully.",
        metadata: {
          title: remotePath,
          filepath: remotePath,
          exists: existed,
        },
      }
    },
  }
}

function generateDiffPreview(filePath: string, oldText: string, newText: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText))
}
