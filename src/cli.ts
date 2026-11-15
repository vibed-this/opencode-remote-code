import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service, type Endpoint } from "@opencode/client/service"
import { RemoteRuntime, type RuntimeTarget } from "./rpc.js"

export const HELP = `Usage: remote-opencode [user@]host [options]

  --workdir PATH    Remote directory (default: login home)
  --user USER       SSH user (default: local OS user)
  --port PORT       SSH port (default: 22)
  --key PATH        Local private key instead of the calling terminal's SSH agent
  --session ID      Reconnect an existing session for this target
  --help           Show this help

Requires OpenCode V2 on PATH and the plugin registered with options.runtime=true.
Use a real hostname/IP: SSH config aliases, ProxyJump and ProxyCommand are not read.
The engine and credentials stay local. No remote OpenCode server is required.
`

export interface Arguments {
  host: string
  user: string
  port: number
  workdir: string
  key?: string
  sessionID?: string
}

export function parseArguments(args: string[]): Arguments | undefined {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return
  let host: string | undefined
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("-")) {
      if (!["--workdir", "--user", "--port", "--key", "--session"].includes(arg)) throw new Error(`Unknown option: ${arg}`)
      const value = args[++i]
      if (!value || value.startsWith("--") || value.includes("\0")) throw new Error(`Missing or invalid value for ${arg}`)
      if (values.has(arg)) throw new Error(`Repeated option: ${arg}`)
      values.set(arg, value)
    } else {
      if (host) throw new Error("Expected one SSH host")
      host = arg
    }
  }
  if (!host) throw new Error("An SSH host is required; use --help for usage")
  const match = /^(?:([^@\s]+)@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9_.:-]+)$/.exec(host)
  if (!match || match[2].startsWith("-")) throw new Error("Use [user@]hostname or an IP address, not an SSH command or URL")
  if (match[1] && values.has("--user") && match[1] !== values.get("--user")) throw new Error("Conflicting SSH users")
  const portText = values.get("--port") ?? "22"
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535")
  const user = values.get("--user") ?? match[1] ?? os.userInfo().username
  if (/\s|\0/.test(user)) throw new Error("Invalid SSH user")
  const sessionID = values.get("--session")
  if (sessionID && !/^ses[\w-]+$/.test(sessionID)) throw new Error("Invalid session ID")
  return { host: match[2].replace(/^\[|\]$/g, ""), user, port,
    workdir: values.get("--workdir") ?? "~", key: values.get("--key"), sessionID }
}

export function sessionDirectory(options: Arguments, home = os.homedir()): string {
  const hash = createHash("sha256").update(JSON.stringify([options.host, options.port, options.user, options.workdir])).digest("hex").slice(0, 20)
  const slug = options.host.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)
  return path.join(home, ".opencode", "remote-sessions", `${slug}-${hash}`)
}

/** Agent sockets are local paths, never send them to an arbitrary HTTP server. */
export function assertLocalEndpoint(endpoint: Endpoint): void {
  const url = new URL(endpoint.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Remote CLI requires the local OpenCode background service on loopback")
  }
  if (endpoint.auth && endpoint.auth.username !== "opencode") throw new Error("Unsupported local service authentication username")
}

export async function attach(endpoint: Endpoint, directory: string, sessionID: string, env: NodeJS.ProcessEnv): Promise<number> {
  // --server pins the same service used for RPC, even if CLI service settings differ.
  // V2's explicit-server authentication reads OPENCODE_PASSWORD (username opencode).
  const childEnv = { ...env }
  delete childEnv.OPENCODE_PASSWORD
  if (endpoint.auth) childEnv.OPENCODE_PASSWORD = endpoint.auth.password
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", [directory, "--server", endpoint.url, "--session", sessionID], {
      cwd: directory, env: childEnv, stdio: "inherit", shell: false,
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)))
  })
}

interface Dependencies {
  ensure: () => Promise<Endpoint>
  attach: typeof attach
  env: NodeJS.ProcessEnv
  home: string
  report: (text: string) => void
}

export async function runCLI(args: string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const options = parseArguments(args)
  const deps: Dependencies = { ensure: () => Service.ensure(), attach, env: process.env,
    home: os.homedir(), report: text => console.error(text), ...overrides }
  if (!options) { deps.report(HELP); return 0 }
  const target: RuntimeTarget = { host: options.host, user: options.user, port: options.port, workdir: options.workdir }
  if (options.key) target.key = path.resolve(options.key.startsWith("~/") ? path.join(deps.home, options.key.slice(2)) : options.key)
  else {
    const socket = deps.env.SSH_AUTH_SOCK
    if (!socket?.trim() || socket.includes("\0")) throw new Error("No SSH_AUTH_SOCK in this terminal; start/unlock an SSH agent or use --key")
    target.agentSocket = socket
  }
  const endpoint = await deps.ensure()
  assertLocalEndpoint(endpoint)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const directory = sessionDirectory(options, deps.home)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const location = { directory }
  const session = options.sessionID
    ? await client.session.get({ sessionID: options.sessionID })
    : await client.session.create({ location })
  if (path.resolve(session.location.directory) !== directory) throw new Error("Session belongs to another local target directory")
  const remote = client.rpc(RemoteRuntime)
  let phase: string | undefined
  try {
    // V2 initializes session plugins lazily. The plugin's status command loads
    // registrations without model execution; bare RPC/list requests do not.
    await client.session.command({ sessionID: session.id, name: "remote", text: "status" })
    phase = (await remote.status({ sessionID: session.id }, { location }) as { phase?: string }).phase
  } catch (cause) {
    throw new Error("Remote runtime unavailable. Register opencode-remote-code with options: { runtime: true } for the launcher directory (see README). No TUI was opened.", { cause })
  }
  if (phase === "connected" || phase === "connecting") {
    throw new Error("Session already has a remote connection. Use /remote disconnect in that session before reconnecting with --session.")
  }
  // Never disconnect on failure or TUI exit: disconnect explicitly enables local tools.
  // The runtime persists a fail-closed marker, so service restarts require reconnect.
  const result = await remote.connect({ sessionID: session.id, target }, { location }) as { phase?: string }
  if (result.phase !== "connected") throw new Error("Remote connection was not confirmed; no TUI was opened")
  deps.report(`Remote connected. Session: ${session.id}`)
  return deps.attach(endpoint, directory, session.id, deps.env)
}
