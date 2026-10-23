/**
 * RemotePathOps — remote path semantics for POSIX and Windows (DESIGN-V3 §5).
 *
 * This is the ONLY file allowed to import `node:path` for remote paths. Every
 * other layer works with the canonical form:
 *
 *   - absolute
 *   - forward slashes only (`C:/Users/x/proj/src/a.ts`, `/home/x/proj/src/a.ts`)
 *   - no trailing slash (except the root: `C:/`, `/`)
 *   - `.` / `..` collapsed
 *   - drive letter uppercased, the rest of the casing preserved
 *
 * Backslashes therefore only ever appear on INPUT (agent/models type
 * `C:\Users\x`) and are normalised away immediately.
 *
 * Windows quirks that are deliberate (see §5.1):
 *   - `/Users/x` (drive-less absolute) and `C:foo` (drive-relative) are NOT
 *     absolute. `isAbsolute()` returns false; rejecting them with a clear error
 *     is the caller's job (`config.ts`).
 *   - `contains()` folds case, because NTFS is case-insensitive and otherwise
 *     `C:/Users/X/...` would be judged "outside the workspace".
 *   - `toSftp()` prefixes the drive form with `/` because Win32-OpenSSH's
 *     sftp-server speaks `/C:/Users/x`.
 */
import path from "node:path"

export type PlatformKind = "posix" | "windows"

export interface RemotePathOps {
  readonly kind: PlatformKind
  /** Canonical absolute form: forward slashes, no trailing slash (except root), "." / ".." collapsed. */
  normalize(p: string): string
  isAbsolute(p: string): boolean
  join(base: string, ...rel: string[]): string
  dirname(p: string): string
  basename(p: string): string
  /** Path equality honouring the platform's case rules (windows: case-insensitive). */
  equals(a: string, b: string): boolean
  /** Case-aware, boundary-safe containment test: root itself counts as inside. */
  contains(root: string, p: string): boolean
  /** "C:/Users/x" -> ["C:","Users","x"]; "C:/" -> ["C:"]; "/home/x" -> ["home","x"]; "/" -> []. */
  segments(p: string): string[]
  /** "C:/Users/x" -> "C:/" ; "/home/x" -> "/". */
  rootOf(p: string): string
  /** Wire format for SFTP: windows "C:/Users/x" -> "/C:/Users/x"; posix identity. */
  toSftp(p: string): string
  /** Inverse of toSftp; also accepts "/C:/x", "C:/x", "\\?\C:\x". */
  fromSftp(s: string): string
}

// ---------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------

function normalizePosix(p: string): string {
  const n = path.posix.normalize(p)
  if (n === "/") return "/"
  // path.posix.normalize keeps a trailing separator; the canonical form does not.
  const stripped = n.replace(/\/+$/, "")
  return stripped === "" ? "/" : stripped
}

const posixOps: RemotePathOps = {
  kind: "posix",

  normalize: normalizePosix,

  isAbsolute(p: string): boolean {
    return path.posix.isAbsolute(p)
  },

  join(base: string, ...rel: string[]): string {
    return normalizePosix(path.posix.join(base, ...rel))
  },

  dirname(p: string): string {
    return path.posix.dirname(p)
  },

  basename(p: string): string {
    return path.posix.basename(p)
  },

  equals(a: string, b: string): boolean {
    return normalizePosix(a) === normalizePosix(b)
  },

  contains(root: string, p: string): boolean {
    const r = normalizePosix(root)
    const q = normalizePosix(p)
    if (r === q) return true // the root itself, and "/" vs "/"
    const base = r.endsWith("/") ? r : `${r}/`
    return q.startsWith(base)
  },

  segments(p: string): string[] {
    const n = normalizePosix(p)
    if (n === "/" || n === ".") return []
    return n
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s !== "")
  },

  rootOf(p: string): string {
    return p.startsWith("/") ? "/" : ""
  },

  toSftp(p: string): string {
    return p
  },

  fromSftp(s: string): string {
    return s
  },
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * Input normalisation shared by every Windows entry point: backslashes become
 * forward slashes and NT long-path prefixes (`\\?\C:\x`, `\\?\UNC\srv\share`,
 * `\\.\C:\x`) are peeled off. Purely textual — safe on any string.
 */
function toForwardSlashes(input: string): string {
  let p = input.replace(/\\/g, "/")
  if (/^\/\/\?\/UNC\//i.test(p)) {
    // \\?\UNC\srv\share\x  ->  //srv/share/x
    p = `//${p.slice("//?/UNC/".length)}`
  } else if (p.startsWith("//?/") || p.startsWith("//./")) {
    p = p.slice(4)
  }
  return p
}

function upperDrive(p: string): string {
  return p.replace(/^([A-Za-z]):/, (_m: string, d: string) => `${d.toUpperCase()}:`)
}

function normalizeWin(p: string): string {
  const slashed = toForwardSlashes(p)
  if (slashed === "") return "."
  // A bare drive ("C:") is drive-relative; path.win32 would render it "C:.".
  // Treat it as the drive root so callers can still compare/derive safely.
  if (/^[A-Za-z]:$/.test(slashed)) return `${slashed.charAt(0).toUpperCase()}:/`

  let out = path.win32.normalize(slashed).replace(/\\/g, "/")
  out = upperDrive(out)

  if (out.length > 1) {
    if (/^[A-Za-z]:\/$/.test(out)) return out // drive root stays "C:/"
    out = out.replace(/\/+$/, "")
    if (/^[A-Za-z]:$/.test(out)) out = `${out}/`
  }
  return out === "" ? "/" : out
}

function isAbsoluteWin(p: string): boolean {
  const slashed = toForwardSlashes(p)
  // Drive-absolute: "C:/x", "C:/" (but not "C:foo").
  if (/^[A-Za-z]:\//.test(slashed)) return true
  // UNC: "//server/share" (best effort, see §5.1).
  if (/^\/\/[^/]/.test(slashed)) return true
  // "/x" is drive-relative on Windows ("root of the current drive") and "foo"
  // is plain relative: neither is acceptable as a remote absolute path.
  return false
}

const windowsOps: RemotePathOps = {
  kind: "windows",

  normalize: normalizeWin,

  isAbsolute: isAbsoluteWin,

  join(base: string, ...rel: string[]): string {
    if (rel.length === 0) return normalizeWin(base)
    return normalizeWin(path.win32.join(base, ...rel))
  },

  dirname(p: string): string {
    return normalizeWin(path.win32.dirname(toForwardSlashes(p)))
  },

  basename(p: string): string {
    return path.win32.basename(toForwardSlashes(p))
  },

  equals(a: string, b: string): boolean {
    return normalizeWin(a).toLowerCase() === normalizeWin(b).toLowerCase()
  },

  contains(root: string, p: string): boolean {
    const r = normalizeWin(root).toLowerCase()
    const q = normalizeWin(p).toLowerCase()
    if (r === q) return true
    // Root boundary: "C:/" and "/" already end with the separator, so a naive
    // `r + "/"` would produce "C://" and never match (§5.1).
    const base = r.endsWith("/") ? r : `${r}/`
    return q.startsWith(base)
  },

  segments(p: string): string[] {
    const n = normalizeWin(p)
    const drive = n.match(/^([A-Za-z]:)(\/|$)/)
    if (drive) {
      const head = drive[1] as string
      const rest = n.slice(head.length).replace(/^\/+/, "")
      const parts = rest.split("/").filter((s) => s !== "")
      return [head, ...parts]
    }
    return n
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s !== "" && s !== ".")
  },

  rootOf(p: string): string {
    const n = normalizeWin(p)
    const drive = n.match(/^[A-Za-z]:/)
    if (drive) return `${drive[0]}/`
    const unc = n.match(/^\/\/[^/]+\/[^/]+/)
    if (unc) return `${unc[0]}/`
    return n.startsWith("/") ? "/" : ""
  },

  toSftp(p: string): string {
    const n = normalizeWin(p)
    // Win32-OpenSSH's sftp-server exposes "C:/Users/x" as "/C:/Users/x".
    if (/^[A-Za-z]:\//.test(n)) return `/${n}`
    return n
  },

  fromSftp(s: string): string {
    const slashed = toForwardSlashes(s)
    // Win32-OpenSSH exposes "C:/Users/x" as "/C:/Users/x" (realpath, readdir, …).
    if (/^\/[A-Za-z]:(\/|$)/.test(slashed)) return normalizeWin(slashed.slice(1))
    return normalizeWin(slashed)
  },
}

export const posixPathOps: RemotePathOps = posixOps
export const windowsPathOps: RemotePathOps = windowsOps

export function createPathOps(kind: PlatformKind): RemotePathOps {
  return kind === "windows" ? windowsOps : posixOps
}
