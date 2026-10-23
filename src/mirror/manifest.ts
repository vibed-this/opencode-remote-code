/**
 * Manifest v2 (DESIGN-V3 §8.2).
 *
 *   {
 *     "version": 2,
 *     "remoteRoot": "C:/Users/zxk/proj",
 *     "files": {
 *       "C:/Users/zxk/proj/src/a.ts": { "local": "C/Users/zxk/proj/src/a.ts", "size": 1234, "mtime": 1729550000123 }
 *     }
 *   }
 *
 * `local` is a *relative* path under `PathMapper.mirrorNamespace` (forward
 * slashes), never absolute — the mirror root may move between sessions (different
 * machine, different `options.mirror`, a copied install). `size`/`mtime` are the
 * **remote** file's size/mtime at the moment of the last successful transfer;
 * `SyncEngine` compares them against a fresh `stat()` and skips the transfer when
 * they match (§8.3).
 *
 * Anything that is not version 2 (including the V2 `{ remote_root, files: {p: rel} }`
 * shape) is ignored outright: the manifest is a cache, and re-pulling one file is
 * cheaper than migrating a stale one.
 */
import fs from "node:fs/promises"
import path from "node:path"

import { stripLongPathPrefix, type PathMapper } from "./path-mapper.js"

export interface ManifestEntry {
  /** Relative path under the mirror namespace, forward slashes, e.g. `C/Users/x/a.ts`. */
  local: string
  size: number
  mtime: number
}

export interface Manifest {
  version: 2
  remoteRoot: string
  files: Record<string, ManifestEntry>
}

export class ManifestManager {
  private readonly mapper: PathMapper
  private readonly file: string
  private readonly log?: (msg: string) => void
  private data: Manifest
  private dirty = false

  constructor(mapper: PathMapper, log?: (msg: string) => void) {
    this.mapper = mapper
    this.file = mapper.manifestPath()
    this.log = log
    this.data = { version: 2, remoteRoot: mapper.remoteRoot, files: {} }
  }

  /** Read the manifest. Missing/unparseable/wrong-version/wrong-root files start empty. */
  async load(): Promise<void> {
    this.data = { version: 2, remoteRoot: this.mapper.remoteRoot, files: {} }
    this.dirty = false

    let raw: string
    try {
      raw = await fs.readFile(this.file, "utf8")
    } catch {
      return // no manifest yet — the ordinary first-run path
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (err) {
      this.log?.(`manifest: ignoring unparseable ${this.file}: ${messageOf(err)}`)
      return
    }
    if (!parsed || typeof parsed !== "object") return

    const candidate = parsed as { version?: unknown; remoteRoot?: unknown; files?: unknown }
    if (candidate.version !== 2) {
      this.log?.(`manifest: ignoring version ${String(candidate.version)} of ${this.file} (expected 2)`)
      return
    }
    if (typeof candidate.remoteRoot !== "string" || !this.sameRoot(candidate.remoteRoot)) {
      this.log?.(
        `manifest: ignoring ${this.file} — it belongs to ${JSON.stringify(candidate.remoteRoot)}, ` +
          `not ${JSON.stringify(this.mapper.remoteRoot)}`
      )
      return
    }
    if (!candidate.files || typeof candidate.files !== "object") return

    for (const [remote, rawEntry] of Object.entries(candidate.files as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== "object") continue
      const entry = rawEntry as Partial<ManifestEntry>
      if (typeof entry.local !== "string" || typeof entry.size !== "number" || typeof entry.mtime !== "number") {
        continue
      }
      let canonical: string
      try {
        canonical = this.mapper.canonicalRemote(remote)
      } catch {
        continue // a key that is not an absolute remote path is useless to us
      }
      const local = toForwardSlashes(entry.local)
      // Re-seed the collision bookkeeping: a `~2` name recorded in a previous
      // session must keep belonging to the same remote path in this one.
      this.mapper.resolveCollision(this.absoluteLocal(local), canonical)
      this.data.files[canonical] = { local, size: entry.size, mtime: entry.mtime }
    }
  }

  /**
   * Atomically persist the manifest (write `.tmp` + rename). A no-op when nothing
   * changed. Never throws: losing the manifest only costs a re-transfer, and the
   * plugin must not break the host over a cache file.
   */
  async save(): Promise<void> {
    if (!this.dirty) return
    const tmp = `${this.file}.tmp`
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8")
      await fs.rename(tmp, this.file)
      this.dirty = false
    } catch (err) {
      this.log?.(`manifest: save of ${this.file} failed: ${messageOf(err)}`)
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }

  register(remotePath: string, entry: ManifestEntry): void {
    const remote = this.mapper.canonicalRemote(remotePath)
    this.data.files[remote] = {
      local: toForwardSlashes(entry.local),
      size: entry.size,
      mtime: entry.mtime,
    }
    this.dirty = true
  }

  get(remotePath: string): ManifestEntry | undefined {
    let remote: string
    try {
      remote = this.mapper.canonicalRemote(remotePath)
    } catch {
      return undefined
    }
    return this.data.files[remote]
  }

  remove(remotePath: string): void {
    let remote: string
    try {
      remote = this.mapper.canonicalRemote(remotePath)
    } catch {
      return
    }
    if (remote in this.data.files) {
      delete this.data.files[remote]
      this.dirty = true
    }
  }

  remotePaths(): string[] {
    return Object.keys(this.data.files)
  }

  /** Forward-slash relative path under the mirror namespace, e.g. `C/Users/x/a.ts`. */
  localRelFor(remotePath: string): string {
    const local = stripLongPathPrefix(this.mapper.toLocal(remotePath))
    const relative = path.relative(this.mapper.mirrorNamespace, local)
    return toForwardSlashes(relative)
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private sameRoot(other: string): boolean {
    try {
      return this.mapper.ops.equals(this.mapper.canonicalRemote(other), this.mapper.remoteRoot)
    } catch {
      return false
    }
  }

  private absoluteLocal(relative: string): string {
    return path.join(this.mapper.mirrorNamespace, ...relative.split("/").filter((s) => s !== ""))
  }
}

function toForwardSlashes(p: string): string {
  // Only the host separator is converted: on a POSIX local host a backslash is a
  // legal filename character and must survive.
  return p.split(path.sep).join("/")
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
