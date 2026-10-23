/**
 * Per-file mirror synchronisation (DESIGN-V3 §8.3).
 *
 * V2's `pullAll()` / `pushAll()` transferred every tracked file before and after
 * every tool call (O(n) per edit). V3 pulls exactly the file being touched, and
 * only when the remote `size`+`mtime` differ from what the manifest recorded:
 *
 *   ensureLocal(remote)  remote stat -> manifest match? skip : pull one file
 *   commit(remote)       mkdirp remote parent -> push one file -> refresh manifest
 *
 * All remote IO goes through the injected `SyncFs` slice (never a remote shell:
 * no `mkdir -p`, §12), so the whole layer is testable without SSH. Locking:
 *
 *  - a per-path mutex serialises two tool calls that touch the same file;
 *  - one engine-wide mutex serialises the SFTP calls themselves, because the
 *    session/channel is shared.
 */
import fs from "node:fs/promises"
import path from "node:path"

import type { ManifestManager } from "./manifest.js"
import type { PathMapper } from "./path-mapper.js"

/**
 * The slice of `RemoteFs` this layer needs. Declared here on purpose: `RemoteFs`
 * (`src/remote/fs.ts`) is owned by another layer and satisfies this structurally,
 * so neither file has to import the other.
 */
export interface SyncFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<{ dir: boolean; file: boolean; symlink: boolean; size: number; mtime: number } | null>
  readPrefix(p: string, bytes: number): Promise<Buffer>
  readFile(p: string): Promise<Buffer>
  writeFile(p: string, data: Buffer): Promise<void>
  mkdirp(p: string): Promise<void>
  unlink(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface SyncStats {
  pulled: number
  pushed: number
  skipped: number
}

/** Minimal promise mutex: `run()` calls are serialised in arrival order. */
class Mutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

const EMPTY = Buffer.alloc(0)

export class SyncEngine {
  private readonly remote: SyncFs
  private readonly mapper: PathMapper
  private readonly manifest: ManifestManager
  private readonly log: (msg: string) => void

  /** Serialises the SFTP calls (one shared session). */
  private readonly sessionLock = new Mutex()
  /** Serialises tool calls that hit the same file. */
  private readonly pathLocks = new Map<string, Mutex>()

  private readonly counters: SyncStats = { pulled: 0, pushed: 0, skipped: 0 }

  constructor(
    remote: SyncFs,
    mapper: PathMapper,
    manifest: ManifestManager,
    log?: (msg: string) => void
  ) {
    this.remote = remote
    this.mapper = mapper
    this.manifest = manifest
    this.log = log ?? (() => {})
  }

  /** Test seam: current transfer counters (a snapshot copy). */
  stats(): SyncStats {
    return { ...this.counters }
  }

  /**
   * Track a remote path and make sure the local copy exists. Returns the (possibly
   * `\\?\`-prefixed) local path.
   *
   * A remote file that does not exist yields an empty local file — that is what
   * makes "add file" patches work: the tool writes the new content locally and
   * `commit()` creates it on the remote side.
   */
  async ensureLocal(remotePath: string): Promise<string> {
    const remote = this.mapper.canonicalRemote(remotePath)
    const local = this.mapper.toLocal(remote)

    return this.withPathLock(local, async () => {
      const stat = await this.sftp(() => this.remote.stat(remote))

      if (stat && stat.dir) {
        // A directory has no bytes to mirror; just materialise the local dir so
        // per-directory tooling (readdir of the mirror) behaves.
        await fs.mkdir(local, { recursive: true })
        this.counters.skipped++
        return local
      }

      if (!stat) {
        await fs.mkdir(path.dirname(local), { recursive: true })
        await fs.writeFile(local, EMPTY)
        this.register(remote, 0, await this.localMtime(local))
        this.counters.pulled++ // the local copy was created from remote state
        await this.persist()
        return local
      }

      const entry = this.manifest.get(remote)
      if (entry && entry.size === stat.size && entry.mtime === stat.mtime && (await this.exists(local))) {
        this.counters.skipped++
        return local
      }

      await fs.mkdir(path.dirname(local), { recursive: true })
      const data = await this.sftp(() => this.remote.readFile(remote))
      await fs.writeFile(local, data)
      this.register(remote, stat.size, stat.mtime)
      this.counters.pulled++
      await this.persist()
      return local
    })
  }

  /** Push the local copy back (creating the remote parent) and refresh the manifest. */
  async commit(remotePath: string): Promise<void> {
    const remote = this.mapper.canonicalRemote(remotePath)
    const local = this.mapper.toLocal(remote)

    await this.withPathLock(local, async () => {
      let data: Buffer
      try {
        data = await fs.readFile(local)
      } catch (err) {
        throw new Error(
          `Remote Code: nothing to push — the local mirror copy ${JSON.stringify(local)} ` +
            `for ${JSON.stringify(remote)} is unreadable (${messageOf(err)})`
        )
      }

      const parent = this.mapper.ops.dirname(remote)
      if (parent !== "" && !this.mapper.ops.equals(parent, remote)) {
        await this.sftp(() => this.remote.mkdirp(parent))
      }

      await this.sftp(() => this.remote.writeFile(remote, data))

      const stat = await this.sftp(() => this.remote.stat(remote))
      this.register(remote, stat ? stat.size : data.length, stat ? stat.mtime : await this.localMtime(local))
      this.counters.pushed++
      await this.persist()
    })
  }

  /** Delete the remote file, the local copy and the manifest entry. */
  async remove(remotePath: string): Promise<void> {
    const remote = this.mapper.canonicalRemote(remotePath)
    const local = this.mapper.toLocal(remote)

    await this.withPathLock(local, async () => {
      try {
        await this.sftp(() => this.remote.unlink(remote))
      } catch (err) {
        // Already gone remotely is not an error for a delete.
        this.log(`sync: unlink of ${remote} failed: ${messageOf(err)}`)
      }
      await fs.rm(local, { force: true }).catch(() => {})
      this.manifest.remove(remote)
      await this.persist()
    })
  }

  /** Remote rename + local rename + manifest update (patch "move to"). */
  async rename(fromRemote: string, toRemote: string): Promise<void> {
    const from = this.mapper.canonicalRemote(fromRemote)
    const to = this.mapper.canonicalRemote(toRemote)
    const fromLocal = this.mapper.toLocal(from)
    const toLocal = this.mapper.toLocal(to)

    await this.withPathLocks([fromLocal, toLocal], async () => {
      const parent = this.mapper.ops.dirname(to)
      if (parent !== "" && !this.mapper.ops.equals(parent, to)) {
        await this.sftp(() => this.remote.mkdirp(parent))
      }

      await this.sftp(() => this.remote.rename(from, to))

      await fs.mkdir(path.dirname(toLocal), { recursive: true })
      try {
        await fs.rename(fromLocal, toLocal)
      } catch (err) {
        // The remote move already happened; a missing/blocked local copy must not
        // turn the tool call into a failure (the next ensureLocal re-pulls it).
        this.log(`sync: local rename ${fromLocal} -> ${toLocal} failed: ${messageOf(err)}`)
      }

      this.manifest.remove(from)
      const stat = await this.sftp(() => this.remote.stat(to))
      this.register(to, stat ? stat.size : 0, stat ? stat.mtime : await this.localMtime(toLocal))
      await this.persist()
    })
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private register(remote: string, size: number, mtime: number): void {
    this.manifest.register(remote, { local: this.manifest.localRelFor(remote), size, mtime })
  }

  private async persist(): Promise<void> {
    try {
      await this.manifest.save()
    } catch (err) {
      // A manifest is a cache; never fail a tool call over it (§8.3).
      this.log(`sync: manifest save failed: ${messageOf(err)}`)
    }
  }

  private sftp<T>(fn: () => Promise<T>): Promise<T> {
    return this.sessionLock.run(fn)
  }

  private withPathLock<T>(localPath: string, fn: () => Promise<T>): Promise<T> {
    return this.lockFor(localPath).run(fn)
  }

  /** Takes several per-path locks in a stable order so two renames cannot deadlock. */
  private withPathLocks<T>(localPaths: string[], fn: () => Promise<T>): Promise<T> {
    const keys = [...new Set(localPaths)].sort()
    const acquire = (index: number): Promise<T> =>
      index >= keys.length ? fn() : this.lockFor(keys[index]!).run(() => acquire(index + 1))
    return acquire(0)
  }

  private lockFor(localPath: string): Mutex {
    let lock = this.pathLocks.get(localPath)
    if (!lock) {
      lock = new Mutex()
      this.pathLocks.set(localPath, lock)
    }
    return lock
  }

  private async exists(localPath: string): Promise<boolean> {
    try {
      await fs.stat(localPath)
      return true
    } catch {
      return false
    }
  }

  private async localMtime(localPath: string): Promise<number> {
    try {
      const stat = await fs.stat(localPath)
      return Math.trunc(stat.mtimeMs)
    } catch {
      return Date.now()
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
