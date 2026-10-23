/**
 * Plugin option parsing — DESIGN-V3 §9 (breaking rewrite).
 *
 * Two ways to describe a target, and **only** these two:
 *
 *   1. the ssh string (primary, documented):
 *        { "ssh": "ssh -p 48713 -i ~/.ssh/id_rsa zhouxiaokang@frp-use.com" }
 *   2. the structured form (fallback):
 *        { "host": "frp-use.com", "port": 48713, "user": "zhouxiaokang", "key": "…" }
 *
 * V2 also read `REMOTE_*` environment variables and legacy `--remote*` argv.
 * That is gone (§9.2): V2/V3 plugins run inside a shared background service that
 * is started independently of the user's shell, so those values are invisible
 * there — keeping the fallback only ever produced "why is my env ignored?"
 * confusion. `sudoPassword` is gone too: it is POSIX-only and the plugin never
 * escalates privileges.
 *
 * Contract that the rest of the plugin relies on:
 *
 *   - `loadConfig()` returns `null` and has **no side effects** (no warnings, no
 *     files, no sockets, never throws) when neither `ssh` nor `host` is set.
 *     That is what keeps the dormant path inert.
 *   - Shape validation of the remote workdir is deliberately NOT done here: the
 *     remote platform is unknown at this point. `platform/detect.ts` owns that
 *     (drive-absolute for Windows, `/x` otherwise).
 *   - SSH features ssh2 cannot emulate (`-J`, `ProxyCommand`, port forwards,
 *     pty allocation) are **hard errors** with an actionable message, not
 *     silently ignored options (V2 ignored them, then failed mysteriously).
 */
import os from "node:os"
import path from "node:path"

import { resolveIgnore, resolveLimits, type ToolLimits } from "./limits.js"

export interface RemoteConfig {
  /** The raw `ssh …` string as typed by the user (for logs only). */
  sshCommand?: string
  host: string
  port: number
  user: string
  /** Identity file path (local, expanded with `~`). */
  identity?: string
  password?: string
  /** OpenSSH options we could map onto ssh2, as `["-o","Key=Value", …]`. */
  extraOptions: string[]
  /** Remote workdir. Optional: when absent the plugin uses the login home. */
  workdir?: string
  /** "auto" probes the remote over SFTP (DESIGN §6.4). */
  platform: "auto" | "posix" | "windows"
  /** Explicit shell preference, e.g. "pwsh.exe" / "powershell.exe" / "bash". */
  shell?: string
  mirrorRoot: string
  debug: boolean
  ignore: string[]
  /** Fully resolved limits (see src/limits.ts). */
  limits: ToolLimits
  /** Default `shell` tool timeout in ms. */
  timeout: number
  /** SSH connection pool sizing (replaces REMOTE_POOL_* env vars). */
  pool: { command: number; file: number; stagger: number }
  /**
   * Local directories where the plugin is allowed to activate at all.
   *
   * Empty = always active (the historical behaviour). Non-empty = the plugin
   * only registers its tools when the session's local directory is inside one of
   * these prefixes, so a single global config can mean "remote tools inside
   * `~/.opencode/remote-sessions/*`, native local tools everywhere else".
   * The seven tools are name-overrides, so without this there is no way to reach
   * local files in the same session.
   */
  activateIn: string[]
}

/** Default SSH connection pool sizing (V2's REMOTE_POOL_* defaults). */
export const DEFAULT_POOL: Readonly<RemoteConfig["pool"]> = Object.freeze({
  command: 3,
  // 4, not 2: `walk()` issues up to 8 concurrent readdirs, and over a tunnelled
  // link (0.3–0.8 s per round trip) a 2-connection file pool serialised almost
  // all of that work.
  file: 4,
  stagger: 0,
})

/**
 * Option key aliases accepted from `ctx.options` (opencode.jsonc plugin options).
 * camelCase is canonical, kebab-case is accepted for JSONC friendliness.
 */
const OPTION_KEYS = {
  ssh: ["ssh", "sshCommand", "ssh-command"],
  host: ["host"],
  port: ["port"],
  user: ["user"],
  identity: ["key", "identityFile", "identity", "keyFile", "key-file", "identity-file"],
  password: ["password"],
  workdir: ["workdir", "remoteWorkdir", "remote-workdir", "remote_workdir"],
  platform: ["platform"],
  shell: ["shell"],
  mirrorRoot: ["mirror", "mirrorRoot", "mirror-root"],
  debug: ["debug"],
  ignore: ["ignore"],
  limits: ["limits"],
  timeout: ["timeout"],
  pool: ["pool"],
  activateIn: ["activateIn", "activate-in"],
} as const

/**
 * Structured keys that mean "the plugin would have to emulate an SSH feature it
 * cannot": jump hosts and proxy commands. Same hard error as `-J` /
 * `-o ProxyCommand=…`.
 */
const STRUCTURED_JUMP_KEYS = ["jump", "jumpHost", "jump-host", "proxyJump", "proxy-jump"] as const
const STRUCTURED_PROXY_KEYS = ["proxyCommand", "proxy-command"] as const

/**
 * `-o` options we can actually map onto ssh2. OpenSSH keywords are
 * case-insensitive, so we canonicalise through this table (lowercase → spelling)
 * and re-emit the canonical spelling in `extraOptions`.
 */
const CANONICAL_SSH_OPTIONS = new Map<string, string>(
  [
    "StrictHostKeyChecking",
    "UserKnownHostsFile",
    "ConnectTimeout",
    "ServerAliveInterval",
    "ServerAliveCountMax",
    "HostKeyAlgorithms",
    "IdentitiesOnly",
  ].map((name) => [name.toLowerCase(), name] as const)
)

/** `-o` options that ssh2 fundamentally cannot do → hard error, not a warning. */
const HARD_ERROR_SSH_OPTIONS: Record<string, () => Error> = {
  proxycommand: () => unsupportedProxyCommand(`the -o option "ProxyCommand"`),
  proxyjump: () => unsupportedJump(`the -o option "ProxyJump"`),
  localforward: () => unsupportedForward(`the -o option "LocalForward"`, "-L"),
  remoteforward: () => unsupportedForward(`the -o option "RemoteForward"`, "-R"),
  dynamicforward: () => unsupportedForward(`the -o option "DynamicForward"`, "-D"),
  requesttty: () => unsupportedTty(`the -o option "RequestTTY"`),
}

/** ssh short flags that consume the next token but mean nothing to us. */
const IGNORED_ARG_FLAGS = new Set(["-b", "-c", "-E", "-e", "-I", "-m", "-O", "-Q", "-S", "-W", "-w"])

/**
 * ssh flags that take no argument and that are harmless for a non-interactive,
 * single-host, non-forwarding client: `-T` for instance is exactly what we do.
 */
const IGNORED_BARE_FLAGS = new Set([
  "-4",
  "-6",
  "-A",
  "-a",
  "-C",
  "-f",
  "-K",
  "-k",
  "-N",
  "-n",
  "-q",
  "-s",
  "-T",
  "-V",
  "-v",
  "-X",
  "-x",
  "-Y",
  "-y",
])

/** One warning per distinct key, so a 3-line config cannot flood the console. */
const warned = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[remote-code] ${message}`)
}

// ---------------------------------------------------------------------------
// Option readers
// ---------------------------------------------------------------------------

function readRaw(
  options: Record<string, unknown>,
  keys: readonly string[]
): { key: string; value: unknown } | undefined {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) continue
    const value = options[key]
    if (value === undefined || value === null) continue
    return { key, value }
  }
  return undefined
}

function readString(options: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const hit = readRaw(options, keys)
  if (!hit || typeof hit.value !== "string") return undefined
  const trimmed = hit.value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Numbers may arrive as numbers or numeric strings ("121000" in JSONC). */
function readNumber(options: Record<string, unknown>, keys: readonly string[]): number | undefined {
  const hit = readRaw(options, keys)
  if (!hit) return undefined
  const value = typeof hit.value === "string" ? Number(hit.value.trim()) : hit.value
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

function readBoolean(
  options: Record<string, unknown>,
  keys: readonly string[]
): boolean | undefined {
  const hit = readRaw(options, keys)
  if (!hit) return undefined
  const value = hit.value
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase()
    if (["1", "true", "yes", "on"].includes(lower)) return true
    if (["0", "false", "no", "off", ""].includes(lower)) return false
  }
  return undefined
}

/** Local paths only: `~`, `~/x` and `~\x` are expanded, nothing else changes. */
function expandHome(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "~") return os.homedir()
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * OpenSSH's own default when no `user@` is given: the local user name. We cannot
 * know the *remote* login name, and inventing "root" (V2's behaviour) silently
 * targets the wrong account on most non-root servers.
 */
function defaultUser(): string {
  try {
    const name = os.userInfo().username
    if (name) return name
  } catch {
    // os.userInfo() throws on some stripped-down environments.
  }
  return "root"
}

// ---------------------------------------------------------------------------
// Hard errors (actionable: each one names what to do instead)
// ---------------------------------------------------------------------------

function unsupportedJump(source: string): Error {
  return new Error(
    `Remote Code: ${source} is not supported — the plugin connects to exactly one host through ssh2, ` +
      `which cannot chain a jump host. Alternative: build the tunnel yourself and point the plugin at ` +
      `its local end, e.g. run "ssh -N -L 2222:<target-host>:22 <jump-user>@<jump-host>" in another ` +
      `window, then set options.host = "127.0.0.1" and options.port = 2222.`
  )
}

function unsupportedProxyCommand(source: string): Error {
  return new Error(
    `Remote Code: ${source} is not supported — ssh2 spawns no helper process, so an arbitrary proxy ` +
      `command ("nc", "connect", "cloudflared", …) cannot run. Alternative: bring the proxy up outside ` +
      `the plugin (e.g. "ssh -W <target-host>:22 <proxy-user>@<proxy-host> -p <local-port>") and point ` +
      `options.host / options.port at the resulting local endpoint.`
  )
}

function unsupportedForward(source: string, flag: string): Error {
  return new Error(
    `Remote Code: ${source} is not supported — the plugin only opens SFTP and one-shot exec channels, ` +
      `never forwarded ports. Alternative: start the forward yourself in a separate terminal ` +
      `("ssh ${flag} …") and use the forwarded endpoint directly; the plugin needs no port forwarding.`
  )
}

function unsupportedTty(source: string): Error {
  return new Error(
    `Remote Code: ${source} is not supported — every remote command runs without a pty, so an ` +
      `interactive shell would just hang. Alternative: drop the flag (the "shell" tool is for one-shot, ` +
      `non-interactive commands); for interactive work run "ssh …" in a normal terminal.`
  )
}

// ---------------------------------------------------------------------------
// ssh string parsing (DESIGN §9.3)
// ---------------------------------------------------------------------------

/** Minimal tokeniser that honours '…' and "…". */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let started = false
  let i = 0

  while (i < command.length) {
    const ch = command[i] as string

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      i++
      continue
    }

    if (ch === "'") {
      started = true
      i++
      let closed = false
      while (i < command.length) {
        if (command[i] === "'") {
          closed = true
          i++
          break
        }
        current += command[i]
        i++
      }
      if (!closed) {
        throw new Error(
          `Remote Code: unterminated single quote in the ssh command: ${command}. ` +
            `Close the quote, or drop the quoting if the path has no spaces.`
        )
      }
      continue
    }

    if (ch === '"') {
      started = true
      i++
      let closed = false
      while (i < command.length) {
        const inner = command[i] as string
        if (inner === '"') {
          closed = true
          i++
          break
        }
        // Inside double quotes only \" and \\ are escapes; everything else (in
        // particular Windows paths like "C:\Users\a b\id_rsa") stays literal.
        if (inner === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
          current += command[i + 1] as string
          i += 2
          continue
        }
        current += inner
        i++
      }
      if (!closed) {
        throw new Error(
          `Remote Code: unterminated double quote in the ssh command: ${command}. ` +
            `Close the quote, or drop the quoting if the path has no spaces.`
        )
      }
      continue
    }

    // Outside quotes a backslash is literal on purpose: `C:\Users\x` is a valid
    // Windows identity path as typed in opencode.jsonc.
    current += ch
    started = true
    i++
  }

  if (started) tokens.push(current)
  return tokens
}

function requireValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index + 1]
  if (value === undefined || value === "") {
    throw new Error(
      `Remote Code: "${flag}" in the ssh command requires a value ` +
        `(e.g. "ssh ${flag} <value> user@host").`
    )
  }
  return value
}

function parsePort(raw: string | number, where: string): number {
  const value = typeof raw === "number" ? raw : Number(raw.trim())
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Remote Code: invalid port ${JSON.stringify(raw)} in ${where}. Expected an integer between 1 and 65535.`
    )
  }
  return value
}

function splitUserHost(token: string): { host: string; user: string } {
  const at = token.lastIndexOf("@")
  const user = at === -1 ? "" : token.slice(0, at)
  let host = at === -1 ? token : token.slice(at + 1)
  // `ssh user@[::1]` — brackets are address syntax, not part of the host.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  return { host, user }
}

/** Apply one `-o` payload (`Key=Value`); whitelist, warn, or throw. */
function applySshOption(spec: string, extraOptions: string[]): void {
  const eq = spec.indexOf("=")
  const rawKey = (eq === -1 ? spec : spec.slice(0, eq)).trim()
  const rawValue = eq === -1 ? "" : spec.slice(eq + 1).trim()
  if (rawKey === "") return

  const lower = rawKey.toLowerCase()

  const hardError = HARD_ERROR_SSH_OPTIONS[lower]
  if (hardError !== undefined) throw hardError()

  const canonical = CANONICAL_SSH_OPTIONS.get(lower)
  if (canonical === undefined) {
    warnOnce(
      `option:${lower}`,
      `options.ssh: ignoring the SSH option "${rawKey}" — it cannot be mapped onto ssh2. ` +
        `Supported -o options: ${[...CANONICAL_SSH_OPTIONS.values()].join(", ")}.`
    )
    return
  }

  if (rawValue === "") {
    warnOnce(
      `option-value:${lower}`,
      `options.ssh: ignoring "${rawKey}" because it has no value ` +
        `(write "-o${canonical}=<value>", e.g. "${canonical}=no").`
    )
    return
  }

  // ssh-pool.ts consumes this shape: ["-o", "Key=Value", "-o", "Key=Value", …]
  extraOptions.push("-o", `${canonical}=${rawValue}`)
}

function parseSshUrl(url: string): ParsedSshTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `Remote Code: could not parse the ssh URL "${url}". Expected something like ` +
        `"ssh://user@host" or "ssh://user@host:2222".`
    )
  }

  if (parsed.protocol.toLowerCase() !== "ssh:") {
    throw new Error(
      `Remote Code: unsupported URL scheme "${parsed.protocol}" — only "ssh://" is understood.`
    )
  }
  if (parsed.password !== "") {
    throw new Error(
      `Remote Code: passwords in the ssh URL are not supported (they end up in logs). ` +
        `Put the password in the plugin option "password" instead.`
    )
  }

  const host = parsed.hostname
  if (host === "") {
    throw new Error(
      `Remote Code: the ssh URL "${url}" has no host. Expected "ssh://user@host:port".`
    )
  }

  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    warnOnce(
      "url-path",
      `options.ssh: ignoring the path "${parsed.pathname}" in the ssh URL — the remote working ` +
        `directory is the separate plugin option "workdir" (omit it to use the login home).`
    )
  }

  return {
    host,
    port: parsed.port === "" ? undefined : parsePort(parsed.port, `the ssh URL "${url}"`),
    user: parsed.username === "" ? "" : decodeURIComponent(parsed.username),
    extraOptions: [],
  }
}

/** What the ssh string literally said; `user: ""` / `port: undefined` mean "not given". */
interface ParsedSshTarget {
  host: string
  port?: number
  user: string
  identity?: string
  extraOptions: string[]
}

/**
 * Parse an `ssh …` command string (DESIGN §9.3).
 *
 * Handles `-p/--port`, `-i`, `-o Key=Value` (space-separated or attached),
 * `user@host`, a bare `host`, `ssh://[user@]host[:port]`, and quoted paths
 * containing spaces. Anything ssh2 cannot emulate throws; everything else that
 * is unknown is warned about once and skipped.
 */
export function parseSshCommand(
  command: string
): Pick<RemoteConfig, "host" | "port" | "user" | "identity" | "extraOptions"> {
  const parsed = parseSshTarget(command)
  return {
    host: parsed.host,
    port: parsed.port ?? 22,
    // ssh's own default: the local user name. Nothing else is knowable here.
    user: parsed.user === "" ? defaultUser() : parsed.user,
    identity: parsed.identity,
    extraOptions: parsed.extraOptions,
  }
}

/** Internal: like `parseSshCommand`, but `undefined`/`""` = "not specified". */
function parseSshTarget(command: string): ParsedSshTarget {
  const raw = command.trim()
  if (raw === "") {
    throw new Error(
      `Remote Code: the "ssh" option is empty. Provide a full command such as ` +
        `"ssh -p 2222 user@host", or use the structured form (host / port / user / key).`
    )
  }

  if (/^ssh:\/\//i.test(raw)) return parseSshUrl(raw)

  const tokens = tokenize(raw)

  // Drop the program name (`ssh`, `ssh.exe`, `/usr/bin/ssh`, `C:\…\ssh.exe`).
  const first = tokens[0]
  if (first !== undefined && /^(?:.*[\\/])?ssh(?:\.exe)?$/i.test(first)) tokens.shift()

  let user = ""
  let port: number | undefined
  let identity: string | undefined
  const extraOptions: string[] = []
  const positionals: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string

    if (token === "--") {
      for (let j = i + 1; j < tokens.length; j++) positionals.push(tokens[j] as string)
      break
    }

    // ---- port ----------------------------------------------------------
    if (token === "-p" || token === "--port") {
      port = parsePort(requireValue(tokens, i, token), `"${token}"`)
      i++
      continue
    }
    if (token.startsWith("--port=")) {
      port = parsePort(token.slice("--port=".length), `"${token}"`)
      continue
    }
    const attachedPort = /^-p(\d+)$/.exec(token)
    if (attachedPort !== null) {
      port = parsePort(attachedPort[1] as string, `"${token}"`)
      continue
    }

    // ---- identity ------------------------------------------------------
    if (token === "-i" || token === "--identity") {
      identity = requireValue(tokens, i, token)
      i++
      continue
    }
    const attachedIdentity = /^-i(.+)$/.exec(token)
    if (attachedIdentity !== null) {
      identity = attachedIdentity[1] as string
      continue
    }

    // ---- -o options ----------------------------------------------------
    if (token === "-o") {
      applySshOption(requireValue(tokens, i, token), extraOptions)
      i++
      continue
    }
    const attachedOption = /^-o(.+)$/.exec(token)
    if (attachedOption !== null) {
      applySshOption(attachedOption[1] as string, extraOptions)
      continue
    }

    // ---- features ssh2 cannot emulate: hard errors, never silent skips --
    if (token.startsWith("-J") || token === "-ProxyJump" || token.startsWith("--proxy-jump")) {
      throw unsupportedJump(`The ssh option "-J" / ProxyJump`)
    }
    if (token === "-L" || /^-L./.test(token)) throw unsupportedForward(`The ssh option "-L"`, "-L")
    if (token === "-R" || /^-R./.test(token)) throw unsupportedForward(`The ssh option "-R"`, "-R")
    if (token === "-D" || /^-D./.test(token)) throw unsupportedForward(`The ssh option "-D"`, "-D")
    if (token === "-t" || token === "-tt") throw unsupportedTty(`The ssh option "-t"`)

    // ---- -l user -------------------------------------------------------
    if (token === "-l") {
      user = requireValue(tokens, i, token)
      i++
      continue
    }
    const attachedUser = /^-l(.+)$/.exec(token)
    if (attachedUser !== null) {
      user = attachedUser[1] as string
      continue
    }

    // ---- -F config file: silently ignored by V2, warned about here -----
    if (token === "-F" || /^-F.+/.test(token)) {
      const file = token === "-F" ? (tokens[i + 1] ?? "") : token.slice(2)
      if (token === "-F") i++
      warnOnce(
        "flag:-F",
        `options.ssh: ignoring "-F ${file}" — ssh2 does not read OpenSSH config files. ` +
          `Translate the settings you need into whitelisted -o options ` +
          `(${[...CANONICAL_SSH_OPTIONS.values()].join(", ")}) or into the structured ` +
          `host / port / user / key options.`
      )
      continue
    }

    // ---- other flags that take an argument: warned about and skipped ----
    if (IGNORED_ARG_FLAGS.has(token)) {
      const value = tokens[i + 1]
      if (value !== undefined && !value.startsWith("-")) i++
      warnOnce(
        `flag:${token}`,
        `options.ssh: ignoring the ssh flag "${token}" — it has no ssh2 equivalent.`
      )
      continue
    }

    // ---- harmless flags -------------------------------------------------
    if (IGNORED_BARE_FLAGS.has(token)) continue

    // ---- anything else that looks like a flag ---------------------------
    if (token.startsWith("-") && token !== "-") {
      warnOnce(
        `flag:${token}`,
        `options.ssh: ignoring the unknown ssh flag "${token}". If it stands for something ` +
          `the plugin should honour, express it as a whitelisted -o option.`
      )
      continue
    }

    // ---- positional (user@host, host) ----------------------------------
    positionals.push(token)
  }

  const target = positionals[0]
  if (target === undefined) {
    throw new Error(
      `Remote Code: no host found in the ssh command "${raw}". Expected something like ` +
        `"ssh -p 2222 user@host", or use the structured form (host / port / user / key).`
    )
  }

  if (positionals.length > 1) {
    warnOnce(
      "trailing-positional",
      `options.ssh: ignoring the trailing arguments after the host ` +
        `(${positionals.slice(1).join(" ")}) — the plugin runs its own commands.`
    )
  }

  const split = splitUserHost(target)
  const host = split.host
  if (split.user !== "") user = split.user

  if (host === "") {
    throw new Error(
      `Remote Code: could not parse the host out of "${target}" in the ssh command "${raw}". ` +
        `Expected "user@host" or "host".`
    )
  }

  return {
    host,
    ...(port === undefined ? {} : { port }),
    user,
    identity: identity === undefined ? undefined : expandHome(identity),
    extraOptions,
  }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load the remote config from plugin options.
 *
 * Returns `null` when remote mode is not configured — the plugin then stays
 * dormant: no SSH connection, no tool registration, no file written, not even a
 * log line. Misconfiguration (bad ssh string, conflicting forms, unsupported
 * SSH features) **throws**; `src/index.ts` catches it, logs it loudly and stays
 * dormant rather than crashing the host.
 */
export function loadConfig(options?: Record<string, unknown>): RemoteConfig | null {
  const opts: Record<string, unknown> = options ?? {}

  const sshString = readString(opts, OPTION_KEYS.ssh)
  const structuredHost = readString(opts, OPTION_KEYS.host)

  // Dormant: no target configured at all. Nothing below runs.
  if (sshString === undefined && structuredHost === undefined) return null

  // Removed in V3 (§9.2) — warn instead of silently accepting a useless option.
  for (const key of ["sudoPassword", "sudo-password", "sudo_password"]) {
    if (Object.prototype.hasOwnProperty.call(opts, key)) {
      warnOnce(
        `removed:${key}`,
        `plugin option "${key}" was removed in Remote Code V3 (it only ever made sense on POSIX ` +
          `remotes and the plugin never escalates privileges). Delete it.`
      )
    }
  }

  // Structured keys that ask for an SSH feature we cannot emulate.
  for (const key of STRUCTURED_JUMP_KEYS) {
    const value = readString(opts, [key])
    if (value !== undefined) throw unsupportedJump(`The plugin option "${key}"`)
  }
  for (const key of STRUCTURED_PROXY_KEYS) {
    const value = readString(opts, [key])
    if (value !== undefined) throw unsupportedProxyCommand(`The plugin option "${key}"`)
  }

  const structuredPort = readNumber(opts, OPTION_KEYS.port)
  const structuredUser = readString(opts, OPTION_KEYS.user)
  const structuredIdentity = readString(opts, OPTION_KEYS.identity)
  const structuredPassword = readString(opts, OPTION_KEYS.password)

  const fromSsh = sshString === undefined ? undefined : parseSshTarget(sshString)

  // ---- merge the two forms --------------------------------------------
  // The structured fields win where they are set, but they must AGREE with the
  // ssh string: silently letting `ssh -p 22 …` override (or be overridden by)
  // `port: 2222` is exactly the kind of merge that produces "it connects to the
  // wrong box" bugs. Only fields the ssh string actually *named* can conflict —
  // its own defaults (port 22, local user) are not a statement of intent.
  const conflicts: string[] = []
  if (fromSsh !== undefined && structuredHost !== undefined && fromSsh.host !== structuredHost) {
    conflicts.push(`host ("${fromSsh.host}" vs "${structuredHost}")`)
  }
  if (
    fromSsh?.port !== undefined &&
    structuredPort !== undefined &&
    fromSsh.port !== Math.floor(structuredPort)
  ) {
    conflicts.push(`port ("${fromSsh.port}" vs "${structuredPort}")`)
  }
  if (fromSsh !== undefined && fromSsh.user !== "" && structuredUser !== undefined && fromSsh.user !== structuredUser) {
    conflicts.push(`user ("${fromSsh.user}" vs "${structuredUser}")`)
  }
  if (
    fromSsh?.identity !== undefined &&
    structuredIdentity !== undefined &&
    fromSsh.identity !== expandHome(structuredIdentity)
  ) {
    conflicts.push(`identity file ("${fromSsh.identity}" vs "${structuredIdentity}")`)
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Remote Code: the "ssh" string and the structured options describe different targets ` +
        `(${conflicts.join("; ")}). Use exactly one form — either the whole "ssh" command or the ` +
        `structured host / port / user / key fields — not a merge of both.`
    )
  }

  const host = structuredHost ?? fromSsh?.host
  if (host === undefined) {
    throw new Error(
      `Remote Code: remote mode is configured but no host could be determined. Set the "ssh" ` +
        `plugin option ("ssh -p 2222 user@host") or the structured "host" option.`
    )
  }

  const port =
    structuredPort === undefined ? (fromSsh?.port ?? 22) : parsePort(structuredPort, `the "port" option`)

  const user =
    structuredUser ?? (fromSsh !== undefined && fromSsh.user !== "" ? fromSsh.user : defaultUser())
  const identity = structuredIdentity === undefined ? fromSsh?.identity : expandHome(structuredIdentity)

  // ---- platform / shell ------------------------------------------------
  const platform = parsePlatform(readString(opts, OPTION_KEYS.platform))
  const rawShell = readString(opts, OPTION_KEYS.shell)
  const shell = rawShell === undefined || rawShell.toLowerCase() === "auto" ? undefined : rawShell

  // ---- limits / ignore / timeout --------------------------------------
  const limits = resolveLimits(
    typeof opts["limits"] === "object" && opts["limits"] !== null
      ? (opts["limits"] as Record<string, unknown>)
      : undefined
  )
  const ignore = resolveIgnore(opts["ignore"])

  let timeout = limits.shellTimeout
  const timeoutHit = readRaw(opts, OPTION_KEYS.timeout)
  if (timeoutHit !== undefined) {
    const value = typeof timeoutHit.value === "string" ? Number(timeoutHit.value.trim()) : timeoutHit.value
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      timeout = Math.floor(value)
    } else {
      warnOnce(
        `timeout`,
        `plugin option "${timeoutHit.key}" must be a positive number of milliseconds; ` +
          `using the default ${limits.shellTimeout} instead.`
      )
    }
  }

  // ---- mirror / debug --------------------------------------------------
  const mirrorRaw = readString(opts, OPTION_KEYS.mirrorRoot)
  const mirrorRoot =
    mirrorRaw === undefined
      ? path.join(os.homedir(), ".opencode", "mirrors")
      : expandHome(mirrorRaw)

  // `options.debug` is the supported switch (§9.2). REMOTE_CODE_DEBUG=1 is kept
  // as a BEST-EFFORT dev convenience only: in a shared background service the
  // environment is not the user's shell, so it is frequently invisible. Never
  // rely on it in documentation or support.
  const explicitDebug = readBoolean(opts, OPTION_KEYS.debug)
  const debug = explicitDebug ?? process.env["REMOTE_CODE_DEBUG"] === "1"

  const pool = resolvePool(opts["pool"])

  const activateIn = resolveActivateIn(readRaw(opts, OPTION_KEYS.activateIn)?.value)

  // Not validated here on purpose: the remote platform is unknown until
  // `detect.ts` has probed it (drive-absolute for Windows, "/x" for POSIX).
  const workdir = readString(opts, OPTION_KEYS.workdir)

  return {
    ...(sshString === undefined ? {} : { sshCommand: sshString }),
    host,
    port,
    user,
    ...(identity === undefined ? {} : { identity }),
    ...(structuredPassword === undefined ? {} : { password: structuredPassword }),
    extraOptions: fromSsh?.extraOptions ?? [],
    ...(workdir === undefined ? {} : { workdir }),
    platform,
    ...(shell === undefined ? {} : { shell }),
    mirrorRoot,
    debug,
    ignore,
    limits,
    timeout,
    pool,
    activateIn,
  }
}

/**
 * Normalise the local directories the plugin may activate in.
 *
 * Accepts a single string or an array, expands `~`, resolves relative entries
 * against the current working directory and drops a trailing separator so
 * prefix matching stays boundary-safe (`C:/a/b/` -> `C:/a/b`).
 */
export function resolveActivateIn(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== "string" || item.trim() === "") continue
    const resolved = path.resolve(expandHome(item.trim()))
    out.push(resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved)
  }
  return out
}

/**
 * Is `directory` inside (or equal to) one of the `activateIn` roots?
 *
 * Boundary-safe and case-insensitive on Windows (the session directory arrives
 * with whatever casing the shell used: `c:/users/…` vs `C:/Users/…`), and the
 * extended-length `\\?\` prefix is stripped first. A missing directory is
 * "outside": guessing would silently strip the session's local tools.
 */
export function isWithinActivateIn(roots: string[], directory: string | undefined): boolean {
  if (typeof directory !== "string" || directory.trim() === "") return false

  const fold = (value: string): string => {
    const stripped = value.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "")
    const resolved = path.resolve(stripped === "" ? value : stripped)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }

  const target = fold(directory)
  for (const root of roots) {
    const base = fold(root)
    if (target === base) return true
    const relative = path.relative(base, target)
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) return true
  }
  return false
}

function parsePlatform(value: string | undefined): RemoteConfig["platform"] {
  if (value === undefined) return "auto"
  const lower = value.toLowerCase()
  if (lower === "auto" || lower === "posix" || lower === "windows") return lower
  throw new Error(
    `Remote Code: invalid "platform" option ${JSON.stringify(value)}. ` +
      `Use "auto" (probe over SFTP, the default), "posix" or "windows".`
  )
}

function resolvePool(raw: unknown): RemoteConfig["pool"] {
  const pool = { ...DEFAULT_POOL }
  if (raw === undefined || raw === null) return pool
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnOnce(
      "pool",
      `plugin option "pool" must be an object like { "command": 3, "file": 2, "stagger": 0 }; ` +
        `using the defaults.`
    )
    return pool
  }

  const record = raw as Record<string, unknown>
  const read = (key: keyof RemoteConfig["pool"], min: number): void => {
    const value = record[key]
    if (value === undefined || value === null) return
    const num = typeof value === "string" ? Number(value.trim()) : value
    if (typeof num === "number" && Number.isFinite(num) && num >= min) {
      pool[key] = Math.floor(num)
      return
    }
    warnOnce(
      `pool:${key}`,
      `plugin option "pool.${key}" must be a number >= ${min}; using the default ${pool[key]} instead.`
    )
  }

  read("command", 1)
  read("file", 1)
  read("stagger", 0)
  return pool
}

// ---------------------------------------------------------------------------
// describeConfig
// ---------------------------------------------------------------------------

/**
 * One-line summary for the debug log — **never** the password (or the identity
 * file path): `auth=password|key|agent` is all the diagnostics need.
 *
 * Accepts the same `ctx.options` as `loadConfig()`, and never throws: a broken
 * config renders as `remote=error(…)`, an unconfigured one as `remote=off`.
 */
export function describeConfig(options?: Record<string, unknown>): string {
  let config: RemoteConfig | null
  try {
    config = loadConfig(options)
  } catch (error) {
    return `remote=error(${(error as Error).message})`
  }
  if (config === null) return "remote=off"
  return describeRemoteConfig(config)
}

/** Same one-liner, for callers that already hold a resolved config. */
export function describeRemoteConfig(config: RemoteConfig): string {
  const auth = config.identity !== undefined ? "key" : config.password !== undefined ? "password" : "agent"
  const parts = [
    `host=${config.host}:${config.port}`,
    `user=${config.user}`,
    `auth=${auth}`,
    `workdir=${config.workdir ?? "(detect)"}`,
    `platform=${config.platform}`,
  ]
  if (config.shell !== undefined) parts.push(`shell=${config.shell}`)
  parts.push(
    `mirror=${config.mirrorRoot}`,
    `timeout=${config.timeout}ms`,
    `pool=${config.pool.command}/${config.pool.file}/${config.pool.stagger}`,
    `scope=${config.activateIn.length === 0 ? "always" : config.activateIn.join(",")}`,
    `debug=${config.debug ? "on" : "off"}`
  )
  if (config.extraOptions.length > 0) {
    parts.push(`sshOptions=${config.extraOptions.filter((token) => token !== "-o").join(",")}`)
  }
  return parts.join(" ")
}
