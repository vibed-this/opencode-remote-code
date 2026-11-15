// Isolated real-agent integration: never connects to or modifies the user's agent.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import ssh2 from "ssh2"
import { loadConfig } from "../dist/config.js"
import { resolveSSHAuth } from "../dist/ssh-auth.js"
import { createSSHPool } from "../dist/ssh-pool.js"

const { Server, utils } = ssh2

assert.equal(loadConfig({ agentSocket: 42 }), null)
assert.throws(() => loadConfig({ host: "host", agentSocket: 42 }), /agentSocket/)
assert.equal(loadConfig({ host: "host", "agent-socket": "/test/socket" }).agentSocket, "/test/socket")
assert.throws(() => resolveSSHAuth({}, {}), /no SSH-agent socket.*background service/)
console.log("PASS agent configuration and missing environment")

if (process.platform === "win32") {
  console.log("SKIP real Unix SSH-agent integration (requires POSIX OpenSSH tools)")
  process.exit(0)
}
for (const tool of ["ssh-agent", "ssh-add", "ssh-keygen"]) {
  try { execFileSync("which", [tool], { stdio: "ignore" }) }
  catch { console.log(`SKIP real SSH-agent integration (${tool} unavailable)`); process.exit(0) }
}

const root = fileURLToPath(new URL("../tmp_test_artifacts/", import.meta.url))
mkdirSync(root, { recursive: true })
const dir = mkdtempSync(path.join(root, "auth-"))
const socket = path.join(dir, "agent")
const key = path.join(dir, "key")
const env = { ...process.env, SSH_AUTH_SOCK: socket }
const previousSocket = process.env.SSH_AUTH_SOCK
let agentPid
let server
const clients = new Set()
let signatures = 0
let forwards = 0
let allowKey = true
let pool
try {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key])
  const output = execFileSync("ssh-agent", ["-s", "-a", socket], { env, encoding: "utf8" })
  agentPid = Number(/SSH_AGENT_PID=(\d+)/.exec(output)[1])
  execFileSync("ssh-add", [key], { env, stdio: "pipe" })
  const parsed = utils.parseKey(readFileSync(key))
  server = new Server({ hostKeys: [readFileSync(key)] }, client => {
    clients.add(client)
    client.on("error", () => {})
    client.on("close", () => clients.delete(client))
    client.on("authentication", ctx => {
      if (ctx.username !== "test") return ctx.reject()
      if (ctx.method === "password" && ctx.password === "test-password") return ctx.accept()
      if (allowKey && ctx.method === "publickey" && ctx.key.data.equals(parsed.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept()
        if (parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) {
          signatures++
          return ctx.accept()
        }
      }
      ctx.reject(["publickey", "password"])
    })
    client.on("ready", () => client.on("session", accept => {
      const session = accept()
      session.on("auth-agent", (_accept, reject) => { forwards++; reject() })
      session.on("exec", accept => {
        const stream = accept()
        stream.write("authenticated")
        stream.exit(0)
        stream.end()
      })
      session.on("sftp", accept => {
        const sftp = accept()
        sftp.on("REALPATH", id => sftp.name(id, [{ filename: "/home/test", longname: "", attrs: {} }]))
      })
    }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const config = extra => loadConfig({ host: "127.0.0.1", port: server.address().port,
    user: "test", pool: { command: 1, file: 1 }, ...extra })
  async function connect(extra) {
    pool = await createSSHPool(config(extra))
    try {
      assert.equal((await pool.exec("test")).stdout, "authenticated")
      assert.equal(await pool.withSftp(sftp => new Promise((resolve, reject) =>
        sftp.realpath(".", (err, value) => err ? reject(err) : resolve(value)))), "/home/test")
    } finally { await pool.close(); pool = undefined }
  }
  process.env.SSH_AUTH_SOCK = path.join(dir, "missing")
  await connect({ agentSocket: socket })
  assert.equal(signatures, 2, "both pools must prove possession via agent signatures")
  assert.equal(forwards, 0)
  console.log("PASS explicit agent socket overrides environment; signed exec and SFTP, no forwarding")

  process.env.SSH_AUTH_SOCK = socket
  await connect({})
  assert.equal(signatures, 4)
  console.log("PASS SSH_AUTH_SOCK default authenticates both pools")

  allowKey = false
  await assert.rejects(createSSHPool(config({})), /SSH-agent authentication failed.*server authorizes/)
  allowKey = true
  execFileSync("ssh-add", ["-D"], { env, stdio: "pipe" })
  await assert.rejects(createSSHPool(config({})), /SSH-agent authentication failed.*unlocked key/)
  console.log("PASS rejected key and empty agent give actionable errors")

  await connect({ key, password: "wrong", agentSocket: path.join(dir, "missing") })
  await connect({ password: "test-password", agentSocket: path.join(dir, "missing") })
  console.log("PASS key/password precedence ignores unavailable agent")

  await assert.rejects(createSSHPool(config({ agentSocket: path.join(dir, "missing") })), /SSH-agent socket is unavailable/)
  await assert.rejects(createSSHPool(config({ agentSocket: key })), /not a socket/)
  process.kill(agentPid, "SIGTERM")
  agentPid = undefined
  await assert.rejects(createSSHPool(config({ agentSocket: socket })), /SSH-agent (socket is unavailable|authentication failed)/)
  console.log("PASS unavailable, non-socket and stopped agent fail clearly")
} finally {
  if (previousSocket === undefined) delete process.env.SSH_AUTH_SOCK
  else process.env.SSH_AUTH_SOCK = previousSocket
  await pool?.close()
  for (const client of clients) client.end()
  if (server) await new Promise(resolve => server.close(resolve))
  if (agentPid) process.kill(agentPid, "SIGTERM")
  rmSync(dir, { recursive: true, force: true })
}
