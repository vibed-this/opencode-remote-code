import { readFileSync, statSync } from "node:fs"
import type { ConnectConfig } from "ssh2"

/** Shared by plugin configuration and future runtime connection callers. */
export interface SSHAuthOptions {
  identity?: string
  password?: string
  agentSocket?: string
}

const AGENT_HELP = "Set agentSocket to a live local SSH-agent socket accessible to the OpenCode background service, " +
  "or supply key/password. SSH_AUTH_SOCK is read from the service environment, not the calling terminal."

/** Resolve at connection time; explicit credentials retain their existing precedence. */
export function resolveSSHAuth(
  options: SSHAuthOptions,
  env: NodeJS.ProcessEnv = process.env,
): Pick<ConnectConfig, "privateKey" | "password" | "agent" | "agentForward"> {
  if (options.identity) return { privateKey: readFileSync(options.identity), agentForward: false }
  if (options.password) return { password: options.password, agentForward: false }
  const socket = options.agentSocket ?? env["SSH_AUTH_SOCK"]
  if (typeof socket !== "string" || !socket.trim() || socket.includes("\0")) {
    throw new Error(`Remote Code: no SSH-agent socket available. ${AGENT_HELP}`)
  }
  // Named pipes on Windows are not filesystem entries. On POSIX this gives an
  // actionable error before opening SSH connections (including stale sockets).
  if (process.platform !== "win32") {
    try {
      if (!statSync(socket).isSocket()) throw new Error("not a socket")
    } catch {
      throw new Error(`Remote Code: SSH-agent socket is unavailable or is not a socket. ${AGENT_HELP}`)
    }
  }
  return { agent: socket, agentForward: false }
}

export function agentAuthenticationError(error: Error): Error {
  return new Error(`Remote Code: SSH-agent authentication failed: ${error.message}. ` +
    `Check that the agent is reachable, has an unlocked key, and that the server authorizes that key. ${AGENT_HELP}`,
    { cause: error })
}
