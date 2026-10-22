import fs from "fs/promises"
import path from "path"
import type { PathMapper } from "../path-mapper.js"
import type { SyncEngine } from "../sync-engine.js"
import { createTwoFilesPatch } from "diff"
import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"
import type { PermissionGateway, RemoteToolDefinition } from "../v2-bridge.js"

export function createWriteTool(
  pathMapper: PathMapper,
  syncEngine: SyncEngine,
  permission: PermissionGateway
): RemoteToolDefinition {
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
    async execute(args, ctx) {
      let remotePath = path.posix.normalize(args.filePath)
      if (!path.posix.isAbsolute(remotePath)) {
        remotePath = path.posix.join(pathMapper.remoteRoot, remotePath)
      }
      if (!pathMapper.isWithinWorkspace(remotePath)) {
        await permission(ctx, {
          action: "edit",
          resources: [remotePath],
          save: [remotePath],
          metadata: {},
        })
      }

      const localPath = pathMapper.toLocal(remotePath)
      const existed = await fs.stat(localPath).then((s) => s.isFile(), () => false)

      // Preserve BOM: source.bom || next.bom (OpenCode semantics)
      let bom = false
      let oldContent = ""
      if (existed) {
        await syncEngine.register(remotePath)
        await syncEngine.pullAll()
        try {
          const existing = await readFileWithBom(fs, localPath)
          bom = existing.bom
          oldContent = existing.text
        } catch {}
      }
      bom = bom || splitBom(args.content).bom

      // Build diff preview for permission request
      const diffPreview = existed
        ? generateDiffPreview(remotePath, oldContent, args.content)
        : `A ${remotePath}\n+ ${args.content.split("\n").slice(0, 10).join("\n+ ")}`

      await permission(ctx, {
        action: "edit",
        resources: [remotePath],
        save: [remotePath],
        metadata: { diff: diffPreview },
      })

      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.writeFile(localPath, joinBom(args.content, bom), "utf-8")

      // Register and push to remote
      await syncEngine.register(remotePath)
      await syncEngine.pushAll()

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
