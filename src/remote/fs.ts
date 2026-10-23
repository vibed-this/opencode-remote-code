/**
 * RemoteFs — the single filesystem primitive the tool layer is allowed to use
 * (DESIGN-V3 §3.2/§3.4, §7.1).
 *
 * Everything here goes through SFTP, so the same code works against a Windows
 * and a POSIX remote; nothing in this file (or in `walk`/`glob`/`search`) knows
 * which one it is talking to. Platform knowledge lives exclusively in
 * `RemotePathOps` (`src/platform/path.ts`):
 *
 *   - every input path is a *canonical* remote path (`C:/Users/x/a.ts`,
 *     `/home/x/a.ts`), converted on the way out with `ops.toSftp()`
 *   - every path coming back from the server (realpath, readdir entries) is
 *     converted with `ops.fromSftp()`
 *   - no remote shell is involved: `mkdir -p`, `rm -f`, `dd`, `od`, `file`,
 *     `ls` are all gone (they do not exist on Windows).
 *
 * Deliberate properties:
 *
 *   - **One SFTP session per public call** (`sshPool.withSftp`), because the
 *     pool hands out whole sessions; multi-step operations (open/read/close,
 *     the mkdirp loop) run inside a single session so a 10-level `mkdirp` is
 *     not 10 sessions.
 *   - **Bounded reads**: `readPrefix` never transfers more than the requested
 *     byte count, and `readFile` streams in 32 KiB chunks instead of asking the
 *     server for the whole file in one packet (also avoids `fastGet` to a local
 *     temp file, which would need a writable temp dir on the *local* machine).
 *   - **`mtime` is milliseconds since the epoch** (DESIGN §8.2 stores mtime in
 *     ms in the manifest). SFTP reports seconds, so it is scaled on the way in.
 */
import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2"
import type { RemotePathOps } from "../platform/path.js"
import type { SSHPool } from "../ssh-pool.js"

export interface RemoteStat {
  dir: boolean
  file: boolean
  symlink: boolean
  /** Size in bytes (0 for directories on most servers). */
  size: number
  /** Milliseconds since the Unix epoch. */
  mtime: number
}

export interface RemoteDirent {
  /** Entry name only — never a path, never `.` / `..`. */
  name: string
  /** Directory bit from the *listing* (i.e. lstat semantics: a symlink to a dir is not `dir`). */
  dir: boolean
  symlink: boolean
  size: number
  /** Milliseconds since the Unix epoch. */
  mtime: number
}

export interface RemoteFs {
  /** Canonical path of an existing path (symlinks resolved). Throws when missing. */
  realpath(p: string): Promise<string>
  /** Follows symlinks. `null` when the path does not exist. */
  stat(p: string): Promise<RemoteStat | null>
  /** Does not follow symlinks. `null` when the path does not exist. */
  lstat(p: string): Promise<RemoteStat | null>
  /** Directory listing, `.`/`..` filtered out, otherwise server order. */
  readdir(p: string): Promise<RemoteDirent[]>
  /** First `bytes` bytes; stops at EOF; never transfers more than requested. */
  readPrefix(p: string, bytes: number): Promise<Buffer>
  readFile(p: string): Promise<Buffer>
  /** Creates or truncates. Parent directory must exist. */
  writeFile(p: string, data: Buffer): Promise<void>
  /** Idempotent, recursive. No remote shell involved. */
  mkdirp(p: string): Promise<void>
  /** Removes a file or symlink. A missing path is a no-op. */
  unlink(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

// SFTP protocol status codes (draft-ietf-secsh-filexfer). Win32-OpenSSH and
// OpenSSH both use these; ssh2 surfaces them as `err.code` (a number).
const SFTP_NO_SUCH_FILE = 2
const SFTP_PERMISSION_DENIED = 3

/** Chunk size for read/write loops: SFTP max packet is 32 KiB on most servers. */
const SFTP_CHUNK = 32 * 1024

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function sftpCode(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const code = (err as { code?: unknown }).code
  if (typeof code === "number") return code
  if (typeof code === "string") {
    // Some ssh2 code paths surface fs-style codes.
    switch (code.toUpperCase()) {
      case "ENOENT":
        return SFTP_NO_SUCH_FILE
      case "EACCES":
      case "EPERM":
        return SFTP_PERMISSION_DENIED
      default:
        return undefined
    }
  }
  return undefined
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Marks errors that already carry an operation + path, so nesting cannot double-wrap them. */
const WRAPPED = Symbol("RemoteFs.wrapped")

/**
 * Uniform failure shape: the message always names the operation and the path,
 * so a tool can put it straight in front of the model ("permission denied" is
 * called out explicitly because it is by far the most common and the most
 * actionable). The SFTP code is preserved on `code` for callers that care.
 */
function fsError(err: unknown, op: string, p: string): Error {
  const code = sftpCode(err)
  const detail = describeError(err)
  const e =
    code === SFTP_PERMISSION_DENIED
      ? new Error(`permission denied: cannot ${op} ${p} (${detail})`)
      : new Error(`cannot ${op} ${p}: ${detail}`)
  const tagged = e as Error & { code?: number; [WRAPPED]?: boolean }
  tagged.code = code
  tagged[WRAPPED] = true
  return e
}

/** Wrap only if the error is not already an `fsError` (avoids "cannot read x: cannot read x: …"). */
function rethrow(err: unknown, op: string, p: string): never {
  if (typeof err === "object" && err !== null && (err as { [WRAPPED]?: boolean })[WRAPPED]) {
    throw err
  }
  throw fsError(err, op, p)
}

function toMillis(seconds: number): number {
  return Math.round(seconds * 1000)
}

function toRemoteStat(s: Stats): RemoteStat {
  return {
    dir: s.isDirectory(),
    file: s.isFile(),
    symlink: s.isSymbolicLink(),
    size: s.size,
    mtime: toMillis(s.mtime),
  }
}

// ---------------------------------------------------------------------------
// Promise shims — they reject with the *raw* ssh2 error so `sftpCode()` works.
// ---------------------------------------------------------------------------

function pStat(sftp: SFTPWrapper, wire: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(wire, (err: Error | undefined, stats: Stats) => {
      if (!err) {
        resolve(stats ?? null)
        return
      }
      if (sftpCode(err) === SFTP_NO_SUCH_FILE) {
        resolve(null)
        return
      }
      reject(err)
    })
  })
}

function pLstat(sftp: SFTPWrapper, wire: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.lstat(wire, (err: Error | undefined, stats: Stats) => {
      if (!err) {
        resolve(stats ?? null)
        return
      }
      if (sftpCode(err) === SFTP_NO_SUCH_FILE) {
        resolve(null)
        return
      }
      reject(err)
    })
  })
}

function pReaddir(sftp: SFTPWrapper, wire: string): Promise<FileEntryWithStats[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(wire, (err: Error | undefined, list: FileEntryWithStats[]) => {
      if (err) {
        reject(err)
        return
      }
      resolve(list ?? [])
    })
  })
}

function pRealpath(sftp: SFTPWrapper, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(wire, (err: Error | undefined, absPath: string) => {
      if (err) {
        reject(err)
        return
      }
      resolve(absPath)
    })
  })
}

function pOpen(sftp: SFTPWrapper, wire: string, flags: "r" | "w"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(wire, flags, (err: Error | undefined, handle: Buffer) => {
      if (err) {
        reject(err)
        return
      }
      resolve(handle)
    })
  })
}

function pClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    // A failing close must never mask the real error from the read/write loop.
    sftp.close(handle, () => resolve())
  })
}

function pRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buf: Buffer,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buf, 0, length, position, (err: Error | undefined, bytesRead: number) => {
      if (err) {
        reject(err)
        return
      }
      resolve(bytesRead ?? 0)
    })
  })
}

function pWrite(
  sftp: SFTPWrapper,
  handle: Buffer,
  data: Buffer,
  length: number,
  position: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, data, 0, length, position, (err?: Error | null) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function pMkdir(sftp: SFTPWrapper, wire: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(wire, (err?: Error | null) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function pUnlink(sftp: SFTPWrapper, wire: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(wire, (err?: Error | null) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

function pRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err?: Error | null) => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Read loops
// ---------------------------------------------------------------------------

/**
 * Reads at most `want` bytes, in 32 KiB chunks, stopping at EOF. Used by both
 * `readPrefix` (bounded) and `readFile` (until EOF) so there is exactly one
 * code path with an off-by-one bug to find.
 */
async function readLoop(
  sftp: SFTPWrapper,
  handle: Buffer,
  want: number,
  p: string,
  op: string
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let got = 0
  while (got < want) {
    const size = Math.min(SFTP_CHUNK, want - got)
    const buf = Buffer.alloc(size)
    let read: number
    try {
      read = await pRead(sftp, handle, buf, size, got)
    } catch (err) {
      throw fsError(err, op, p)
    }
    if (read <= 0) break // EOF
    chunks.push(read === size ? buf : buf.subarray(0, read))
    got += read
  }
  return Buffer.concat(chunks, got)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRemoteFs(sshPool: SSHPool, ops: RemotePathOps): RemoteFs {
  const realpath = async (p: string): Promise<string> => {
    const wire = ops.toSftp(p)
    try {
      const resolved = await sshPool.withSftp((sftp) => pRealpath(sftp, wire))
      return ops.fromSftp(resolved)
    } catch (err) {
      throw fsError(err, "resolve", p)
    }
  }

  const statInternal = async (p: string, follow: boolean): Promise<RemoteStat | null> => {
    const wire = ops.toSftp(p)
    try {
      const stats = await sshPool.withSftp((sftp) =>
        follow ? pStat(sftp, wire) : pLstat(sftp, wire)
      )
      return stats === null ? null : toRemoteStat(stats)
    } catch (err) {
      throw fsError(err, follow ? "stat" : "lstat", p)
    }
  }

  const stat = (p: string): Promise<RemoteStat | null> => statInternal(p, true)
  const lstat = (p: string): Promise<RemoteStat | null> => statInternal(p, false)

  const readdir = async (p: string): Promise<RemoteDirent[]> => {
    const wire = ops.toSftp(p)
    let list: FileEntryWithStats[]
    try {
      list = await sshPool.withSftp((sftp) => pReaddir(sftp, wire))
    } catch (err) {
      throw fsError(err, "list", p)
    }
    const out: RemoteDirent[] = []
    for (const entry of list) {
      const name = entry.filename
      // Servers are inconsistent about whether they include these.
      if (name === "." || name === "..") continue
      out.push({
        name,
        // Listing attributes are lstat-like: a symlink to a directory is
        // reported as a symlink, not as a directory. `walk` relies on that.
        dir: entry.attrs.isDirectory(),
        symlink: entry.attrs.isSymbolicLink(),
        size: entry.attrs.size,
        mtime: toMillis(entry.attrs.mtime),
      })
    }
    // `entry.filename` is a name, not a path: no ops.fromSftp() here.
    return out
  }

  const readPrefix = async (p: string, bytes: number): Promise<Buffer> => {
    const want = Math.max(0, Math.floor(bytes))
    if (want === 0) return Buffer.alloc(0)
    const wire = ops.toSftp(p)
    try {
      return await sshPool.withSftp(async (sftp) => {
        const handle = await pOpen(sftp, wire, "r").catch((err: unknown) => {
          throw fsError(err, "read", p)
        })
        try {
          return await readLoop(sftp, handle, want, p, "read")
        } finally {
          await pClose(sftp, handle)
        }
      })
    } catch (err) {
      rethrow(err, "read", p)
    }
  }

  const readFile = async (p: string): Promise<Buffer> => {
    const wire = ops.toSftp(p)
    try {
      return await sshPool.withSftp(async (sftp) => {
        const handle = await pOpen(sftp, wire, "r").catch((err: unknown) => {
          throw fsError(err, "read", p)
        })
        try {
          return await readLoop(sftp, handle, Number.MAX_SAFE_INTEGER, p, "read")
        } finally {
          await pClose(sftp, handle)
        }
      })
    } catch (err) {
      rethrow(err, "read", p)
    }
  }

  const writeFile = async (p: string, data: Buffer): Promise<void> => {
    const wire = ops.toSftp(p)
    try {
      await sshPool.withSftp(async (sftp) => {
        const handle = await pOpen(sftp, wire, "w").catch((err: unknown) => {
          throw fsError(err, "write", p)
        })
        try {
          let written = 0
          while (written < data.length) {
            const size = Math.min(SFTP_CHUNK, data.length - written)
            try {
              await pWrite(sftp, handle, data.subarray(written, written + size), size, written)
            } catch (err) {
              throw fsError(err, "write", p)
            }
            written += size
          }
        } finally {
          await pClose(sftp, handle)
        }
      })
    } catch (err) {
      rethrow(err, "write", p)
    }
  }

  /**
   * Recursive `mkdir`, without any remote shell (`mkdir -p` is forbidden —
   * §3.2 keeps every write on SFTP).
   *
   * Cost model: the overwhelmingly common case ("the directory already
   * exists") is 1 round trip (`stat`). Otherwise the missing prefixes are
   * created inside a single SFTP session; SFTP has no "already exists" status
   * code (servers report a generic SSH_FX_FAILURE), so a failed `mkdir` is
   * disambiguated with a `stat` instead of by sniffing the message text.
   */
  const mkdirp = async (p: string): Promise<void> => {
    const canon = ops.normalize(p)
    const existing = await stat(canon)
    if (existing !== null && existing.dir) return

    // Build the prefixes by string-slicing at `rootOf()` rather than by walking
    // `ops.segments()`: a Windows segment list starts with the drive ("C:") and a
    // UNC path spans two segments ("srv","share"), so segment-joining from the
    // root would duplicate or lose a component. Slicing at the root is exact for
    // "/", "C:/" and "//srv/share/" alike.
    const root = ops.rootOf(canon)
    const segments = canon.slice(root.length).split("/").filter((s) => s !== "")
    if (segments.length === 0) return // the root itself always exists

    const prefixes: string[] = []
    let current = root
    for (const segment of segments) {
      current = ops.join(current, segment)
      prefixes.push(current)
    }

    try {
      await sshPool.withSftp(async (sftp) => {
        for (const prefix of prefixes) {
          const wire = ops.toSftp(prefix)
          try {
            await pMkdir(sftp, wire)
          } catch (err) {
            const already = await pStat(sftp, wire).catch(() => null)
            if (already !== null && already.isDirectory()) continue
            throw fsError(err, "create directory", prefix)
          }
        }
      })
    } catch (err) {
      rethrow(err, "create directory", canon)
    }
  }

  const unlink = async (p: string): Promise<void> => {
    const wire = ops.toSftp(p)
    try {
      await sshPool.withSftp(async (sftp) => {
        try {
          await pUnlink(sftp, wire)
        } catch (err) {
          if (sftpCode(err) === SFTP_NO_SUCH_FILE) return // already gone
          throw fsError(err, "delete", p)
        }
      })
    } catch (err) {
      rethrow(err, "delete", p)
    }
  }

  const rename = async (from: string, to: string): Promise<void> => {
    const fromWire = ops.toSftp(from)
    const toWire = ops.toSftp(to)
    try {
      await sshPool.withSftp((sftp) => pRename(sftp, fromWire, toWire))
    } catch (err) {
      throw fsError(err, "rename", `${from} -> ${to}`)
    }
  }

  return {
    realpath,
    stat,
    lstat,
    readdir,
    readPrefix,
    readFile,
    writeFile,
    mkdirp,
    unlink,
    rename,
  }
}
