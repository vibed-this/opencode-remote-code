import path from "path"
import type { RemoteConfig } from "./config.js"

/**
 * Normalize a remote workdir into a canonical POSIX absolute path.
 *
 * - `path.posix.normalize` collapses duplicate slashes and resolves `.`/`..`
 * - Node's posix `normalize` *keeps* a trailing slash (`"/home/proj/"` stays
 *   `"/home/proj/"`), so it has to be dropped explicitly — otherwise every
 *   `startsWith(root + "/")` comparison in this file breaks.
 * - `"/"` is preserved as the only path that legitimately ends with a slash.
 */
function normalizeRemoteRoot(raw: string): string {
  let normalized = path.posix.normalize(raw)
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

export class PathMapper {
  readonly mirrorBase: string
  readonly remoteRoot: string

  /**
   * Local mirror path -> remote absolute path for files that were mapped from
   * *outside* the workspace. Inside-workspace paths are stored as their path
   * relative to remoteRoot, while outside paths are stored as their full path
   * with the leading "/" stripped (`/home/proj` + `/etc/passwd` both land on
   * `mirrorBase/etc/passwd`), so `toRemote()` cannot tell the two apart from
   * the local path alone. Remembering which absolute paths were mapped from
   * outside keeps `toRemote(toLocal(p)) === p` exact in both directions;
   * the most recent mapping of a local path wins (an inside mapping drops the
   * entry again).
   */
  private readonly outsidePaths = new Map<string, string>()

  constructor(config: RemoteConfig) {
    const remoteRoot = normalizeRemoteRoot(config.remoteWorkdir)
    if (!path.posix.isAbsolute(remoteRoot)) {
      throw new Error(
        `Remote Code: remote working directory must be absolute, got "${config.remoteWorkdir}" ` +
          `(set the "workdir" plugin option to something like "/home/project")`
      )
    }

    const hostSlug = this.slugify(`${config.user}_${config.host}`)
    const rootSlug = this.slugify(remoteRoot)
    this.mirrorBase = path.join(config.mirrorRoot, hostSlug, rootSlug)
    this.remoteRoot = remoteRoot
  }

  private slugify(input: string): string {
    const slug = input
      .replace(/^\//, "")
      .replace(/\/+$/, "")
      .replace(/\//g, "_")
      .replace(/[^a-zA-Z0-9_.@-]/g, "-")
    // An empty slug would shorten mirrorBase by one level (`mirrors/<host>`),
    // making it a prefix of other workdirs' mirror bases — and index.ts wipes
    // mirrorBase with `rm -rf` on every startup. `workdir: "/"` hits this case.
    return slug === "" ? "root" : slug
  }

  /**
   * Whether an already-normalized absolute remote path lives under remoteRoot.
   * `remoteRoot + "/"` can never match for `remoteRoot === "/"` (it becomes
   * `"//"`), so the root case is handled explicitly.
   */
  private isInsideRoot(normalized: string): boolean {
    const root = this.remoteRoot
    if (root === "/") return normalized.startsWith("/")
    return normalized === root || normalized.startsWith(root + "/")
  }

  /** Convert a remote absolute path to a local mirror absolute path */
  toLocal(remotePath: string): string {
    const normalized = path.posix.normalize(remotePath)
    if (!path.posix.isAbsolute(normalized)) {
      throw new Error(`Remote Code: path "${remotePath}" must be absolute`)
    }

    let relative: string
    const inside = this.isInsideRoot(normalized)
    if (inside) {
      relative = path.posix.relative(this.remoteRoot, normalized)
    } else {
      // Path outside remoteRoot: use full absolute path (strip leading /)
      relative = normalized.replace(/^\//, "")
    }

    const local = relative === "" ? this.mirrorBase : path.join(this.mirrorBase, ...relative.split("/"))
    // Security: ensure resolved path stays within mirrorBase
    const resolved = path.resolve(local)
    const baseResolved = path.resolve(this.mirrorBase)
    if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
      throw new Error(
        `Remote Code: resolved local path "${resolved}" escapes mirror base "${baseResolved}"`
      )
    }
    // Bookkeeping only (never affects the returned path): remember the remote
    // origin of local paths that came from outside the workspace.
    if (inside) {
      this.outsidePaths.delete(resolved)
    } else {
      this.outsidePaths.set(resolved, normalized)
    }
    return resolved
  }

  /** Convert a local mirror absolute path back to a remote absolute path */
  toRemote(localPath: string): string {
    const resolved = path.resolve(localPath)
    const baseResolved = path.resolve(this.mirrorBase)
    if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
      throw new Error(
        `Remote Code: local path "${localPath}" is outside mirror base "${baseResolved}"`
      )
    }
    const relative = path.relative(baseResolved, resolved)
    const posixRel = relative.split(path.sep).join("/")

    if (posixRel === "" || posixRel === ".") {
      return this.remoteRoot
    }

    // Exact round-trip for paths that were mapped from outside the workspace
    // (see `outsidePaths`).
    const rememberedOutside = this.outsidePaths.get(resolved)
    if (rememberedOutside !== undefined) {
      return rememberedOutside
    }

    // Determine whether this local path originated from inside remoteRoot.
    // For paths inside remoteRoot, the stored relative path is simply the
    // path relative to remoteRoot (e.g. "foo.txt" or "src/main.ts").
    // For external paths, the stored relative path is the full absolute
    // path without the leading slash (e.g. "boot/grub.conf").
    // `posix.join("/", "etc/passwd")` is `"/etc/passwd"`, so the root case
    // round-trips correctly without special handling.
    const candidateInside = path.posix.join(this.remoteRoot, posixRel)
    const localInside = candidateInside === this.remoteRoot
      ? this.mirrorBase
      : path.join(this.mirrorBase, ...path.posix.relative(this.remoteRoot, candidateInside).split("/"))

    if (path.resolve(localInside) === resolved) {
      return candidateInside
    }

    // Otherwise it was mapped from an external absolute path
    return "/" + posixRel
  }

  /** Check whether a remote path is within the configured remote workdir */
  isWithinWorkspace(remotePath: string): boolean {
    const normalized = path.posix.normalize(remotePath)
    return this.isInsideRoot(normalized)
  }

  /** Get the manifest file path for this mirror */
  manifestPath(): string {
    return path.join(this.mirrorBase, "manifest.json")
  }
}
