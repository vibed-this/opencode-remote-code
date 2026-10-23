import os from "os"
import path from "path"

export interface RemoteConfig {
  /** Raw SSH command string, e.g. "ssh -oHostKeyAlgorithms=+ssh-rsa root@host" */
  sshCommand: string
  /** Parsed SSH target host */
  host: string
  /** Parsed SSH user */
  user: string
  /** Parsed SSH port */
  port: number
  /** Parsed identity file (optional) */
  identity?: string
  /** Extra SSH -o options */
  extraOptions: string[]
  /** SSH login password (optional, uses sshpass) */
  password?: string
  /** Sudo password for remote commands (optional) */
  sudoPassword?: string
  /** Remote working directory (absolute path on remote) */
  remoteWorkdir: string
  /** Local mirror root directory */
  mirrorRoot: string
  /** Whether remote mode is active */
  active: boolean
}

/** Where a resolved config value came from (useful for logging / debugging). */
export type ConfigSource = "options" | "env" | "argv"

export interface ConfigResolution {
  value: string
  source: ConfigSource
}

type ConfigKey = "ssh" | "workdir" | "password" | "sudoPassword" | "mirror"

/**
 * Option key aliases accepted from `ctx.options` (opencode.jsonc plugin options).
 * camelCase is canonical, kebab-case is accepted for JSONC friendliness.
 */
const OPTION_KEYS: Record<ConfigKey, string[]> = {
  ssh: ["ssh", "sshCommand", "ssh-command"],
  workdir: ["workdir", "remoteWorkdir", "remote-workdir", "remote_workdir"],
  password: ["password", "sshPassword", "ssh-password"],
  sudoPassword: ["sudoPassword", "sudo-password", "sudo_password"],
  mirror: ["mirror", "mirrorRoot", "mirror-root"],
}

/** Environment variable fallbacks (V1 behaviour, kept for compatibility). */
const ENV_KEYS: Record<ConfigKey, string> = {
  ssh: "REMOTE_SSH",
  workdir: "REMOTE_WORKDIR",
  password: "REMOTE_PASSWORD",
  sudoPassword: "REMOTE_SUDO_PASSWORD",
  mirror: "REMOTE_MIRROR",
}

/** Legacy CLI argv fallbacks (`--remote`, `--remote-workdir`, ...). */
const ARGV_KEYS: Record<ConfigKey, string[]> = {
  ssh: ["--remote", "--remote-ssh"],
  workdir: ["--remote-workdir"],
  password: ["--remote-password"],
  sudoPassword: ["--remote-sudo-password"],
  mirror: ["--remote-mirror"],
}

function parseArgv(): Record<string, string | undefined> {
  const args: Record<string, string | undefined> = {}
  const argv = process.argv
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const key = arg
      const next = argv[i + 1]
      if (next && !next.startsWith("-")) {
        args[key] = next
        i++
      } else {
        args[key] = "true"
      }
    }
  }
  return args
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : value
}

function fromOptions(
  options: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!options) return undefined
  for (const key of keys) {
    const value = nonEmpty(options[key])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Resolve one config value.
 *
 * Priority (V2): `ctx.options` > env vars > legacy `--remote*` argv.
 * Plugin options win because OpenCode V2 plugins run inside a shared
 * background service where shell environment variables are not visible.
 */
export function resolveConfigValue(
  key: ConfigKey,
  options?: Record<string, unknown>,
  argv?: Record<string, string | undefined>
): ConfigResolution | undefined {
  const opt = fromOptions(options, OPTION_KEYS[key])
  if (opt !== undefined) return { value: opt, source: "options" }

  const env = nonEmpty(process.env[ENV_KEYS[key]])
  if (env !== undefined) return { value: env, source: "env" }

  const args = argv ?? parseArgv()
  for (const flag of ARGV_KEYS[key]) {
    const arg = nonEmpty(args[flag])
    if (arg !== undefined) return { value: arg, source: "argv" }
  }

  return undefined
}

function parseSshCommand(cmd: string): {
  host: string
  user: string
  port: number
  identity?: string
  extraOptions: string[]
} {
  const tokens = cmd.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] !== "ssh") {
    throw new Error(`Remote Code: SSH command must start with "ssh", got: ${cmd}`)
  }

  let host = ""
  let user = ""
  let port = 22
  let identity: string | undefined
  const extraOptions: string[] = []

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === "-p" || tok === "--port") {
      port = parseInt(tokens[++i], 10)
      if (isNaN(port)) throw new Error(`Remote Code: invalid port in SSH command`)
    } else if (tok === "-i") {
      identity = tokens[++i]
    } else if (tok.startsWith("-o")) {
      // Handle both `-oKey=Value` and `-o Key=Value`
      if (tok === "-o") {
        extraOptions.push("-o", tokens[++i])
      } else {
        extraOptions.push("-o", tok.slice(2))
      }
    } else if (tok.startsWith("-")) {
      // Other flags we don't explicitly parse; if they take args, skip next token heuristically
      // This is best-effort; users with exotic flags should rely on -o
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        i++
      }
    } else if (tok.includes("@")) {
      const at = tok.lastIndexOf("@")
      user = tok.slice(0, at)
      host = tok.slice(at + 1)
    } else {
      host = tok
    }
  }

  if (!host) {
    throw new Error(`Remote Code: could not parse host from SSH command: ${cmd}`)
  }
  if (!user) {
    user = "root"
  }

  return { host, user, port, identity, extraOptions }
}

/**
 * Load the remote config from plugin options, with env/argv compatibility
 * fallbacks. Returns `null` when remote mode is not configured — the plugin
 * then stays dormant and never touches SSH or the filesystem.
 */
export function loadConfig(options?: Record<string, unknown>): RemoteConfig | null {
  const argv = parseArgv()

  const ssh = resolveConfigValue("ssh", options, argv)
  if (!ssh) {
    return null
  }

  const parsed = parseSshCommand(ssh.value)

  const workdir = resolveConfigValue("workdir", options, argv)
  if (!workdir) {
    throw new Error(
      `Remote Code: remote SSH is configured but the remote working directory is missing. ` +
        `Provide it via plugin option "workdir" (or "remote-workdir"), the REMOTE_WORKDIR env var, or --remote-workdir.`
    )
  }

  // The remote workdir must be an absolute POSIX path: PathMapper derives the
  // local mirror layout from it, and a relative value would silently produce a
  // wrong mirror path (and a broken workspace boundary check).
  if (!path.posix.isAbsolute(path.posix.normalize(workdir.value))) {
    throw new Error(
      `Remote Code: remote working directory must be absolute, got "${workdir.value}" ` +
        `(set the "workdir" plugin option to something like "/home/project")`
    )
  }

  const mirror = resolveConfigValue("mirror", options, argv)
  const password = resolveConfigValue("password", options, argv)
  const sudoPassword = resolveConfigValue("sudoPassword", options, argv)

  return {
    sshCommand: ssh.value,
    ...parsed,
    password: password?.value,
    sudoPassword: sudoPassword?.value,
    remoteWorkdir: workdir.value,
    mirrorRoot: mirror?.value ?? path.join(os.homedir(), ".opencode", "mirrors"),
    active: true,
  }
}

/** Human-readable description of where each value came from (for debug logs). */
export function describeConfigSources(options?: Record<string, unknown>): string {
  const argv = parseArgv()
  const keys: ConfigKey[] = ["ssh", "workdir", "password", "sudoPassword", "mirror"]
  return keys
    .map((key) => {
      const resolved = resolveConfigValue(key, options, argv)
      return `${key}=${resolved ? resolved.source : "unset"}`
    })
    .join(" ")
}
