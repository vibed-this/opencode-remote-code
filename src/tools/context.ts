/**
 * The dependency bundle handed to every remote tool factory (DESIGN-V3 §7.3).
 *
 * Tools are framework-free objects (`{ name, description, input, execute }`), so
 * everything they need is passed in here instead of being imported at module
 * scope. Keeping the bundle explicit is what lets the same tool code run against
 * a Windows or a POSIX remote: `ops` carries the path semantics and `dialect`
 * carries the shell semantics.
 */
import type { RemotePathOps } from "../platform/path.js"
import type { RemoteDialect } from "../platform/dialect.js"
import type { RemoteFs } from "../remote/fs.js"
import type { PathMapper } from "../mirror/path-mapper.js"
import type { SyncEngine } from "../mirror/sync.js"
import type { SSHPool } from "../ssh-pool.js"
import type { ToolLimits } from "../limits.js"
import type { PermissionGateway } from "../v2-bridge.js"

export interface RemoteToolContext {
  /** SSH command pool — only `shell` uses it (all other tools go through `fs`). */
  pool: SSHPool
  /** Path semantics for the remote platform. */
  ops: RemotePathOps
  /** Canonical remote workdir (the workspace root). */
  remoteRoot: string
  /** Shell semantics — only `shell` uses it. */
  dialect: RemoteDialect
  /** SFTP-backed remote filesystem. */
  fs: RemoteFs
  /** Remote path <-> local mirror path. */
  mapper: PathMapper
  /** Per-file mirror synchronisation. */
  sync: SyncEngine
  permission: PermissionGateway
  limits: ToolLimits
  ignore: string[]
  /** Debug logger (never throws). */
  log: (msg: string) => void
}

/**
 * Turn a model-supplied path into a canonical absolute remote path.
 *
 * Relative input is resolved against the workspace root (models routinely pass
 * `src/main.ts`), and anything that is still not absolute is rejected loudly
 * rather than being silently mapped somewhere unexpected.
 */
export function resolveRemotePath(
  ctx: Pick<RemoteToolContext, "ops" | "remoteRoot">,
  input: string,
  base?: string
): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Remote Code: an absolute remote path is required")
  }
  const normalized = ctx.ops.normalize(input)
  if (ctx.ops.isAbsolute(normalized)) return normalized

  const root = base ? ctx.ops.normalize(base) : ctx.ops.normalize(ctx.remoteRoot)
  const joined = ctx.ops.normalize(ctx.ops.join(root, normalized))
  if (!ctx.ops.isAbsolute(joined)) {
    throw new Error(
      `Remote Code: path "${input}" is not absolute and could not be resolved against "${root}"`
    )
  }
  return joined
}

/**
 * Human-readable note appended to a truncated tool result.
 *
 * Every reason string maps to one actionable sentence: the model cannot see
 * *why* a listing/search stopped unless we say so, and "no results" must never
 * be reported when the traverse was cut short.
 */
export function truncationNote(reason: string | undefined, detail?: string): string {
  const suffix = detail ? ` (${detail})` : ""
  switch (reason) {
    case "matches":
      return `(Results truncated: showing the first ${detail ?? "N"} matches. Use a more specific pattern or a smaller path.)`
    case "bytes":
      return `(Search stopped after reading the byte budget${suffix}. Restrict "include" or the search path.)`
    case "time":
      return `(Search stopped on the time budget${suffix}. Narrow the search path or pattern.)`
    case "walk":
    case "entries":
      return `(Directory listing was truncated${suffix}. Pass a smaller "path" or a more specific pattern.)`
    case "depth":
      return `(Maximum traversal depth reached${suffix}. Search a deeper subdirectory directly.)`
    default:
      return `(Results truncated${suffix}.)`
  }
}
