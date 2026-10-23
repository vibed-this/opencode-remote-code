/**
 * Remote platform detection (DESIGN-V3 §6.4).
 *
 * Deliberately a **pure function over `DetectProbe`** — it must not import
 * `ssh2` (or anything transport-related), so it can be unit-tested and so the
 * transport layer stays swappable.
 *
 * Why SFTP `realpath(".")` instead of `uname -s` / `ver`: SFTP is guaranteed to
 * exist (we need it anyway), it needs a single round trip, and it answers both
 * "is this Windows?" and "what is the login default directory?" at once.
 * Win32-OpenSSH answers `/C:/Users/zhouxiaokang`; a POSIX box answers `/home/x`.
 */
import { createPathOps, type PlatformKind, type RemotePathOps } from "./path.js"
import type { ExecResult } from "./dialect.js"

export interface DetectProbe {
  /** SFTP realpath of "." on the remote. */
  realpath(p: string): Promise<string>
  /** Raw exec through the remote default shell (used only for `where.exe pwsh`). */
  exec(command: string, opts?: { timeout?: number }): Promise<ExecResult>
}

export interface DetectOptions {
  platform?: "auto" | PlatformKind
  workdir?: string
  shell?: string
  timeout?: number
}

export interface DetectResult {
  kind: PlatformKind
  pathOps: RemotePathOps
  /** Canonical login home, e.g. "C:/Users/zhouxiaokang" or "/home/zxk". */
  home: string
  /** Canonical absolute remote workdir (options.workdir expanded/resolved, else home). */
  workdir: string
  /** Scratch dir remote-side, windows: "<home>/AppData/Local/Temp", posix: "/tmp". */
  tempDir: string
  /** "bash" | "sh" | "powershell.exe" | "pwsh.exe" etc. */
  shell: string
  pwshAvailable: boolean
}

/** Win32-OpenSSH reports "/C:/Users/x"; a POSIX host never matches this. */
const WINDOWS_REALPATH_RE = /^\/[A-Za-z]:(\/|$)/

const POSIX_DEFAULT_HOME = "/"

export async function detectRemote(probe: DetectProbe, opts: DetectOptions = {}): Promise<DetectResult> {
  const requested = opts.platform ?? "auto"
  const explicit = requested === "windows" || requested === "posix"

  // ---- 1/2. platform + home --------------------------------------------
  // `home` needs the realpath regardless, so we always ask for it; when
  // `platform` is explicit the *shape* of the answer is simply ignored for
  // detection (the probe is then only a home lookup, and a failure is not fatal
  // as long as we can derive something sane).
  let rawHome: string | null = null
  try {
    rawHome = await probe.realpath(".")
  } catch (err) {
    if (!explicit) {
      throw new Error(
        `Cannot detect the remote platform: SFTP realpath(".") failed (${(err as Error).message}). ` +
          `Set options.platform to "windows" or "posix" to skip detection.`
      )
    }
  }

  let kind: PlatformKind
  if (explicit) {
    kind = requested as PlatformKind
  } else {
    kind = rawHome !== null && WINDOWS_REALPATH_RE.test(rawHome) ? "windows" : "posix"
  }

  const pathOps = createPathOps(kind)

  // ---- 3. canonical home -----------------------------------------------
  let home: string
  if (rawHome !== null && rawHome !== "") {
    home = pathOps.normalize(pathOps.fromSftp(rawHome))
  } else if (opts.workdir && pathOps.isAbsolute(opts.workdir)) {
    // realpath was unavailable (explicit platform): fall back to the workdir's root.
    home = pathOps.rootOf(pathOps.normalize(opts.workdir)) || POSIX_DEFAULT_HOME
  } else {
    throw new Error(
      `Cannot determine the remote home directory: realpath(".") returned nothing and no absolute options.workdir was given.`
    )
  }

  // ---- 4. PowerShell discovery (windows only) --------------------------
  let pwshAvailable = false
  if (kind === "windows") {
    try {
      // `where` alone would hit the `Where-Object` alias inside PowerShell, so
      // the executable name must be spelled out with `.exe`.
      const res = await Promise.resolve(
        opts.timeout === undefined
          ? probe.exec("where.exe pwsh")
          : probe.exec("where.exe pwsh", { timeout: opts.timeout })
      )
      pwshAvailable = res.exitCode === 0 && res.stdout.trim() !== ""
    } catch {
      pwshAvailable = false
    }
  }

  // ---- 5. shell ---------------------------------------------------------
  const shell =
    opts.shell && opts.shell !== "" && opts.shell !== "auto"
      ? opts.shell
      : kind === "windows"
        ? pwshAvailable
          ? "pwsh.exe"
          : "powershell.exe"
        : "bash"

  // ---- 6. workdir -------------------------------------------------------
  let workdir: string
  if (opts.workdir && opts.workdir !== "") {
    let w = opts.workdir
    if (w === "~" || w.startsWith("~/") || w.startsWith("~\\")) {
      // "~" / "~/proj" -> home + "/proj" (home never ends with a separator)
      w = `${home}${w.slice(1)}`
    }
    if (kind === "windows") {
      // Reject the two ambiguous Windows shapes instead of silently guessing:
      // "/Users/x" means "root of whatever drive we are on" and "C:foo" means
      // "foo relative to the current directory of drive C".
      const slashed = w.replace(/\\/g, "/")
      const driveRelative = /^[A-Za-z]:/.test(slashed) && !/^[A-Za-z]:\//.test(slashed)
      const driveLessAbsolute = slashed.startsWith("/") && !slashed.startsWith("//")
      if (driveRelative || driveLessAbsolute) {
        throw new Error(
          `workdir "${opts.workdir}" is not an absolute Windows path: a drive letter is required ` +
            `(e.g. "C:/Users/me/project"). Drive-relative ("C:foo") and drive-less ("/Users/x") ` +
            `forms are not supported because their meaning depends on the shell's current drive.`
        )
      }
    }
    // Plain relative paths ("proj", "src/app") are resolved against the login home.
    if (!pathOps.isAbsolute(w)) {
      w = pathOps.join(home, w)
    }
    workdir = pathOps.normalize(w)
    if (kind === "windows" && !pathOps.isAbsolute(workdir)) {
      throw new Error(
        `workdir "${opts.workdir}" resolved to "${workdir}", which is not an absolute Windows path.`
      )
    }
  } else {
    workdir = home
  }

  // ---- 7. scratch dir ---------------------------------------------------
  const tempDir = kind === "windows" ? pathOps.normalize(pathOps.join(home, "AppData/Local/Temp")) : "/tmp"

  return { kind, pathOps, home, workdir, tempDir, shell, pwshAvailable }
}
