/**
 * Bounded remote tree walk, shared by `glob` and `grep` (DESIGN-V3 §7.2).
 *
 * Pure SFTP: `RemoteFs.readdir` calls only, no `find`, no shell. Two things
 * matter here and both are about not hanging the agent:
 *
 * 1. **Every dimension is bounded** — depth, entry count, wall-clock time and
 *    the number of in-flight `readdir` requests. A pathological tree (a 500k
 *    file `node_modules`, a network share that takes 30 s per listing) must
 *    produce a *partial* answer plus `truncated: true`, never a hang.
 * 2. **Breadth-first with a worker pool of `concurrency`**. SFTP is
 *    request/response over one multiplexed channel, so 8 outstanding `readdir`
 *    requests make a big tree ~8x faster; more than that just queues in the
 *    transport. BFS also means the depth limit cuts the *deepest* entries, which
 *    is the useful half of the tree to keep.
 *
 * Symlinked directories are never followed: SFTP `readdir` reports listing
 * attributes, so a symlink shows up with `symlink: true` (and `dir: false` on
 * most servers). Following it would make `a -> ..` loop forever.
 */
import type { RemotePathOps } from "../platform/path.js"
import type { RemoteDirent, RemoteFs } from "./fs.js"

export interface WalkLimits {
  /** Directory levels below `root`. `root` itself is depth 0. Default 12. */
  maxDepth?: number
  /** Upper bound on directory entries *seen* (files + dirs + unreadable dirs). Default 20000. */
  maxEntries?: number
  /** Wall-clock budget for the whole walk. Default 20000 ms. */
  maxMillis?: number
  /** Concurrent `readdir` requests. Default 8. */
  concurrency?: number
}

export interface WalkOptions extends WalkLimits {
  /** Directory *names* to skip entirely. Defaults to {@link DEFAULT_WALK_IGNORE}. */
  ignore?: string[]
  /** Also report directories (as `WalkFile` entries). Default false. */
  includeDirs?: boolean
}

export interface WalkFile {
  /** Path relative to the walk root: forward slashes, no leading `./`. */
  rel: string
  dirent: RemoteDirent
}

export interface WalkResult {
  /** Sorted by `rel` (byte order) so callers can produce stable output. */
  files: WalkFile[]
  /** Directory entries seen; unreadable directories count as 1 each. */
  entries: number
  truncated: boolean
  reason?: "entries" | "time" | "depth"
}

/**
 * DESIGN §7.2 defaults: build output, VCS metadata, caches and vendored
 * dependencies. Matched against the directory *name* at any depth.
 */
export const DEFAULT_WALK_IGNORE: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "vendor",
  "__pycache__",
  ".next",
  "$RECYCLE.BIN",
  "System Volume Information",
  "Windows.old",
  ".pnpm-store",
  ".Trash",
]

export const WALK_DEFAULTS = {
  maxDepth: 12,
  maxEntries: 20_000,
  // 45 s, not 20 s — see `limits.ts`. Over a tunnelled link each `readdir`
  // costs 0.3–0.8 s, so 20 s buys very little tree.
  maxMillis: 45_000,
  concurrency: 8,
} as const

interface DirTask {
  /** Absolute canonical path. */
  abs: string
  /** Path relative to the walk root ("" for the root itself). */
  rel: string
  /** 0 for the root. */
  depth: number
}

export async function walk(
  remoteFs: RemoteFs,
  ops: RemotePathOps,
  root: string,
  opts: WalkOptions = {}
): Promise<WalkResult> {
  const maxDepth = Math.max(0, opts.maxDepth ?? WALK_DEFAULTS.maxDepth)
  const maxEntries = Math.max(1, opts.maxEntries ?? WALK_DEFAULTS.maxEntries)
  const maxMillis = Math.max(0, opts.maxMillis ?? WALK_DEFAULTS.maxMillis)
  const concurrency = Math.max(1, opts.concurrency ?? WALK_DEFAULTS.concurrency)
  const includeDirs = opts.includeDirs ?? false

  // Ignored names are compared case-insensitively on a Windows remote only:
  // NTFS is case-insensitive, POSIX is not, and `ops.kind` is the only place
  // that fact is allowed to surface (§3.3).
  const fold = ops.kind === "windows"
    ? (s: string): string => s.toLowerCase()
    : (s: string): string => s
  const ignore = new Set((opts.ignore ?? DEFAULT_WALK_IGNORE).map(fold))

  const startAbs = ops.normalize(root)
  const startedAt = Date.now()

  const files: WalkFile[] = []
  const queue: DirTask[] = [{ abs: startAbs, rel: "", depth: 0 }]
  let entries = 0
  let truncated = false
  let reason: WalkResult["reason"]
  let stopped = false

  /** A budget ran out: stop handing out new work, report why. */
  const stopFor = (why: "entries" | "time"): void => {
    truncated = true
    reason = why
    stopped = true
  }

  /** A branch was pruned by `maxDepth`: results are incomplete but the walk continues. */
  const noteDepthCut = (): void => {
    truncated = true
    if (reason === undefined) reason = "depth"
  }

  const visit = async (task: DirTask): Promise<void> => {
    if (stopped) return
    if (Date.now() - startedAt > maxMillis) {
      stopFor("time")
      return
    }
    if (entries >= maxEntries) {
      stopFor("entries")
      return
    }

    let list: RemoteDirent[]
    try {
      list = await remoteFs.readdir(task.abs)
    } catch {
      // Unreadable directory (permissions, a race with a delete, a dangling
      // mount). One lost subtree must never fail the whole listing.
      entries += 1
      return
    }

    for (const dirent of list) {
      if (stopped) return
      if (dirent.name === "." || dirent.name === "..") continue

      entries += 1
      if (entries > maxEntries) {
        stopFor("entries")
        return
      }

      const rel = task.rel === "" ? dirent.name : `${task.rel}/${dirent.name}`

      if (!dirent.dir) {
        files.push({ rel, dirent })
        continue
      }

      // A symlink that points at a directory: never traversed (loop protection).
      if (dirent.symlink) {
        if (includeDirs) files.push({ rel, dirent })
        continue
      }
      if (ignore.has(fold(dirent.name))) continue
      if (includeDirs) files.push({ rel, dirent })

      // Children of this directory would live at depth+1; stop one level early.
      if (task.depth >= maxDepth) {
        noteDepthCut()
        continue
      }
      queue.push({ abs: ops.join(task.abs, dirent.name), rel, depth: task.depth + 1 })
    }
  }

  let inflight = 0
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const pump = (): void => {
    while (!stopped && inflight < concurrency && queue.length > 0) {
      const task = queue.shift() as DirTask
      inflight += 1
      // `visit` swallows its own errors; the catch is only a belt-and-braces
      // guard so a programming error cannot leave the walk unresolved.
      void visit(task).then(
        () => {
          inflight -= 1
          pump()
        },
        () => {
          inflight -= 1
          pump()
        }
      )
    }
    if (inflight === 0 && (stopped || queue.length === 0)) resolveDone()
  }

  pump()
  await done

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files, entries, truncated, reason }
}
