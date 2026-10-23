/**
 * PathMapper v3 — unambiguous mirror namespace layout (DESIGN-V3 §8.1, §5.2).
 *
 * Layout:
 *
 *   <mirrorRoot>/<hostSlug>-<hash6>/<drive-or-root>/<remote segments…>
 *
 *   windows remote  C:/Users/zxk/proj/src/a.ts
 *     -> <mirrorRoot>/zxk-frp-oil-com-4f1c2a/C/Users/zxk/proj/src/a.ts
 *   posix remote    /home/zxk/proj/src/a.ts
 *     -> <mirrorRoot>/zxk-frp-oil-com-4f1c2a/root/home/zxk/proj/src/a.ts
 *
 * The `<drive-or-root>` token is what makes the mapping *textually invertible*:
 * a Windows drive becomes the bare letter (`C:` -> `C`), a POSIX path gets the
 * literal `root` token. Because in-workspace and out-of-workspace paths use the
 * exact same rule, V2's `outsidePaths` memory table (`/etc/passwd` and
 * `<root>/etc/passwd` used to collide) is gone.
 *
 * Rules that are easy to get wrong and are therefore spelled out here:
 *
 *  - Every remote path is canonicalised through `RemotePathOps` first, so
 *    backslashes, `..`, duplicate separators and drive-letter case never reach
 *    the mirror. `path.posix` is *never* used for remote paths (§3.3).
 *  - Local paths use the host's `node:path` (the mirror lives on the host), and a
 *    resolved local path that escapes the namespace always throws.
 *  - On a case-insensitive local host (`win32`) two remote paths can map to the
 *    same local path (`a.ts` vs `A.ts`). The second one gets a `~2`/`~3`… suffix
 *    on its basename; the substitution is remembered in this instance so
 *    `toRemote` stays exact (§5.2 / risk S4).
 *  - On a `win32` local host a resolved path longer than 250 chars is returned
 *    with the `\\?\` extended-length prefix (risk S5); `toRemote` strips it.
 */
import { createHash } from "node:crypto"
import path from "node:path"

import type { RemotePathOps } from "../platform/path.js"

/** Above this length a local path gets the `\\?\` extended-length prefix on win32. */
const LONG_PATH_LIMIT = 250

/** Basename suffixes tried for case-insensitive collisions: `~2`, `~3`, … */
const MAX_COLLISION_SUFFIX = 999

export interface PathMapperOptions {
  /** Local absolute directory that holds every mirror, e.g. "C:/Users/WIN11/.opencode/mirrors". */
  mirrorRoot: string
  user: string
  host: string
  port: number
  /** Canonical remote absolute workdir (already normalised, or normalisable). */
  remoteRoot: string
  ops: RemotePathOps
  /**
   * Override for the *local* platform (defaults to `process.platform`). Only a
   * test seam: it decides case-insensitive collision handling and the
   * extended-length prefix. Paths are still joined with the host's `node:path`.
   */
  localPlatform?: NodeJS.Platform
}

/**
 * Peel an extended-length prefix off a local path: `\\?\C:\x`, `//?/C:/x`,
 * `\\.\C:\x` and `\\?\UNC\srv\share` -> `C:\x` / `C:/x` / `C:\x` / `//srv/share`.
 * Purely textual; safe on any string.
 */
export function stripLongPathPrefix(localPath: string): string {
  if (/^\\\\\?\\UNC\\/i.test(localPath)) {
    return `//${localPath.slice("\\\\?\\UNC\\".length).replace(/\\/g, "/")}`
  }
  if (/^\/\/\?\/UNC\//i.test(localPath)) {
    return `//${localPath.slice("//?/UNC/".length)}`
  }
  if (/^\\\\\?\\/.test(localPath) || /^\\\\\.\\/.test(localPath)) {
    return localPath.slice(4)
  }
  if (localPath.startsWith("//?/") || localPath.startsWith("//./")) {
    return localPath.slice(4)
  }
  return localPath
}

/** `user@host` lowercased, every non-alphanumeric run collapsed to a single `-`. */
function hostSlugOf(user: string, host: string): string {
  const slug = `${user}@${host}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug === "" ? "host" : slug
}

/** First 6 hex chars of sha256(`user@host:port`). */
function hash6Of(user: string, host: string, port: number): string {
  return createHash("sha256").update(`${user}@${host}:${port}`, "utf8").digest("hex").slice(0, 6)
}

/** `a.tar.gz` -> { stem: "a.tar", ext: ".gz" }; `.gitignore` -> { stem: ".gitignore", ext: "" }. */
function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return { stem: name, ext: "" }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

export class PathMapper {
  /** The remote path semantics this mapper was built for. */
  readonly ops: RemotePathOps
  /** Canonical remote workdir, e.g. `C:/Users/zxk/proj` or `/home/zxk/proj`. */
  readonly remoteRoot: string
  /** `<mirrorRoot>/<hostSlug>-<hash6>` — one directory per SSH target. */
  readonly mirrorNamespace: string
  /** `toLocal(remoteRoot)` — the local directory that mirrors the remote workdir. */
  readonly mirrorBase: string

  private readonly localPlatform: NodeJS.Platform
  private readonly caseInsensitive: boolean
  /**
   * local path (collision key) -> remote path. Doubles as the reverse index used
   * by `toRemote` so collision suffixes (and any other non-textual mapping) stay
   * reversible.
   */
  private readonly claims = new Map<string, string>()

  constructor(opts: PathMapperOptions) {
    if (!opts || typeof opts.mirrorRoot !== "string" || opts.mirrorRoot.trim() === "") {
      throw new Error('Remote Code: PathMapper requires a local "mirrorRoot" directory')
    }
    if (!opts.ops) throw new Error("Remote Code: PathMapper requires RemotePathOps")
    if (typeof opts.host !== "string" || opts.host.trim() === "") {
      throw new Error('Remote Code: PathMapper requires a remote "host"')
    }
    if (typeof opts.user !== "string" || opts.user.trim() === "") {
      throw new Error('Remote Code: PathMapper requires a remote "user"')
    }

    this.ops = opts.ops
    this.localPlatform = opts.localPlatform ?? (process.platform as NodeJS.Platform)
    this.caseInsensitive = this.localPlatform === "win32"

    // Throws for relative / ill-formed workdirs (see canonicalRemote).
    this.remoteRoot = this.canonicalRemote(opts.remoteRoot)

    const namespace = `${hostSlugOf(opts.user, opts.host)}-${hash6Of(opts.user, opts.host, opts.port)}`
    this.mirrorNamespace = path.resolve(path.join(stripLongPathPrefix(opts.mirrorRoot), namespace))

    // §8.1: mirrorBase is by definition toLocal(remoteRoot).
    this.mirrorBase = this.toLocal(this.remoteRoot)
  }

  // -------------------------------------------------------------------------
  // remote -> local
  // -------------------------------------------------------------------------

  /** Canonicalise an absolute remote path; throws on relative / ill-formed input. */
  canonicalRemote(remotePath: string): string {
    if (typeof remotePath !== "string" || remotePath.trim() === "") {
      throw new Error(
        `Remote Code: remote path must be a non-empty string, got ${JSON.stringify(remotePath)}`
      )
    }
    if (remotePath.includes("\0")) {
      throw new Error(`Remote Code: remote path ${JSON.stringify(remotePath)} contains a NUL byte`)
    }
    const normalized = this.ops.normalize(remotePath)
    if (!this.ops.isAbsolute(normalized)) {
      throw new Error(
        `Remote Code: remote path ${JSON.stringify(remotePath)} must be absolute ` +
          (this.ops.kind === "windows"
            ? '(expected something like "C:/Users/me/project/src/a.ts")'
            : '(expected something like "/home/me/project/src/a.ts")')
      )
    }
    return normalized
  }

  /** Any absolute remote path -> local mirror path (in or out of the workspace). */
  toLocal(remotePath: string): string {
    const remote = this.canonicalRemote(remotePath)
    const segments = this.localSegments(remote)
    const resolved = path.resolve(path.join(this.mirrorNamespace, ...segments))

    if (!this.isInsideNamespace(resolved)) {
      throw new Error(
        `Remote Code: remote path ${JSON.stringify(remotePath)} resolves to the local path ` +
          `${JSON.stringify(resolved)}, which escapes the mirror namespace ` +
          `${JSON.stringify(this.mirrorNamespace)}`
      )
    }

    const claimed = this.resolveCollision(resolved, remote)
    return this.withLongPathPrefix(claimed)
  }

  /**
   * Case-insensitive collision handling (§5.2 / risk S4).
   *
   * `localPath` is the *resolved, unprefixed* local path candidate. The first
   * remote path to claim a local path keeps it; a later, different remote path
   * gets `~2` (then `~3`, …) appended to the basename. Every claim is remembered,
   * which is what makes `toRemote` exact in both directions.
   */
  resolveCollision(localPath: string, remotePath: string): string {
    const base = path.resolve(stripLongPathPrefix(localPath))
    const key = this.claimKey(base)
    const existing = this.claims.get(key)

    if (existing === undefined) {
      this.claims.set(key, remotePath)
      return base
    }
    if (existing === remotePath) return base

    // Only a case-insensitive local filesystem can produce a real collision.
    // (`claimKey` already folds case there, so reaching this point on a
    // case-sensitive host means the exact same local path for two remotes —
    // still handled the same way rather than silently overwriting.)
    const dir = path.dirname(base)
    const { stem, ext } = splitExt(path.basename(base))
    for (let n = 2; n <= MAX_COLLISION_SUFFIX; n++) {
      const candidate = path.join(dir, `${stem}~${n}${ext}`)
      const candidateKey = this.claimKey(candidate)
      const owner = this.claims.get(candidateKey)
      if (owner === undefined) {
        this.claims.set(candidateKey, remotePath)
        return candidate
      }
      if (owner === remotePath) return candidate
    }
    throw new Error(
      `Remote Code: too many local mirror collisions for ${JSON.stringify(remotePath)} ` +
        `(> ${MAX_COLLISION_SUFFIX} variants of ${JSON.stringify(base)})`
    )
  }

  // -------------------------------------------------------------------------
  // local -> remote
  // -------------------------------------------------------------------------

  /** Exact inverse of `toLocal`; also accepts `\\?\`-prefixed local paths. */
  toRemote(localPath: string): string {
    if (typeof localPath !== "string" || localPath.trim() === "") {
      throw new Error(`Remote Code: local path must be a non-empty string, got ${JSON.stringify(localPath)}`)
    }
    const resolved = path.resolve(stripLongPathPrefix(localPath))

    if (!this.isInsideNamespace(resolved)) {
      throw new Error(
        `Remote Code: local path ${JSON.stringify(localPath)} is outside the mirror namespace ` +
          `${JSON.stringify(this.mirrorNamespace)}`
      )
    }

    // Remembered mapping wins: this is what keeps collision suffixes exact.
    const claimed = this.claims.get(this.claimKey(resolved))
    if (claimed !== undefined) return claimed

    const relative = path.relative(this.mirrorNamespace, resolved)
    const segments = relative.split(path.sep).filter((s) => s !== "")
    if (segments.length === 0) {
      throw new Error(
        `Remote Code: local path ${JSON.stringify(localPath)} is the mirror namespace root, ` +
          `not a mirrored remote path`
      )
    }
    return this.remoteFromSegments(segments)
  }

  // -------------------------------------------------------------------------
  // workspace helpers
  // -------------------------------------------------------------------------

  /** Whether a remote path is the workdir or lives under it (§5.2 case folding). */
  isWithinWorkspace(remotePath: string): boolean {
    let remote: string
    try {
      remote = this.canonicalRemote(remotePath)
    } catch {
      return false
    }
    return this.ops.contains(this.remoteRoot, remote)
  }

  /** `<mirrorNamespace>/manifest.json` — deliberately *outside* the mirrored tree. */
  manifestPath(): string {
    return path.join(this.mirrorNamespace, "manifest.json")
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Local path segments for a canonical remote path: `[<drive-or-root>, ...rest]`. */
  private localSegments(remote: string): string[] {
    if (this.ops.kind === "windows") {
      const drive = /^([A-Za-z]):(\/|$)/.exec(remote)
      if (drive) {
        return [drive[1]!.toUpperCase(), ...this.ops.segments(remote).slice(1)]
      }
      // `//srv/share/x` (UNC, best effort per §5.1) gets its own root token so
      // it cannot be confused with a POSIX path (`root/…`) or a drive (`C/…`).
      if (remote.startsWith("//")) return ["unc", ...this.ops.segments(remote)]
      throw new Error(
        `Remote Code: cannot mirror Windows path ${JSON.stringify(remote)} ` +
          `(expected a drive-absolute path such as "C:/Users/me/project")`
      )
    }
    return ["root", ...this.ops.segments(remote)]
  }

  /** Inverse of `localSegments`. */
  private remoteFromSegments(segments: string[]): string {
    const token = segments[0]
    if (token === undefined) {
      throw new Error("Remote Code: empty mirror path relative to the namespace")
    }
    const rest = segments.slice(1)

    if (this.ops.kind === "windows") {
      if (/^[A-Za-z]$/.test(token)) {
        const drive = token.toUpperCase()
        return rest.length === 0 ? `${drive}:/` : `${drive}:/${rest.join("/")}`
      }
      if (token === "unc") return `//${rest.join("/")}`
      throw new Error(
        `Remote Code: local mirror path has an unknown Windows root segment ` +
          `${JSON.stringify(token)} (expected a drive letter like "C" or "unc")`
      )
    }

    if (token !== "root") {
      throw new Error(
        `Remote Code: local mirror path has an unknown POSIX root segment ` +
          `${JSON.stringify(token)} (expected "root")`
      )
    }
    return rest.length === 0 ? "/" : `/${rest.join("/")}`
  }

  private claimKey(localPath: string): string {
    return this.caseInsensitive ? localPath.toLowerCase() : localPath
  }

  private isInsideNamespace(resolvedLocal: string): boolean {
    const candidate = this.caseInsensitive ? resolvedLocal.toLowerCase() : resolvedLocal
    const base = this.caseInsensitive ? this.mirrorNamespace.toLowerCase() : this.mirrorNamespace
    return (
      candidate === base ||
      candidate.startsWith(base + path.sep) ||
      candidate.startsWith(base + "/") ||
      candidate.startsWith(base + "\\")
    )
  }

  /** Risk S5: local Windows mirrors can exceed MAX_PATH, so use the `\\?\` form. */
  private withLongPathPrefix(localPath: string): string {
    if (this.localPlatform !== "win32") return localPath
    if (localPath.length <= LONG_PATH_LIMIT) return localPath
    if (/^\\\\\?\\/.test(localPath) || localPath.startsWith("//?/")) return localPath
    if (localPath.startsWith("//")) {
      return `\\\\?\\UNC\\${localPath.slice(2).replace(/\//g, "\\")}`
    }
    return `\\\\?\\${localPath.replace(/\//g, "\\")}`
  }
}
