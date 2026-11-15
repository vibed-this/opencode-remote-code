import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode/client"
import { parseArguments, sessionDirectory, assertLocalEndpoint, runCLI, attach } from "../dist/cli.js"

const parsed = parseArguments(["alice@[::1]", "--workdir", "C:/My Project", "--port", "2222"])
assert.deepEqual(parseArguments(["host"]), {
  host: "host", user: os.userInfo().username, port: 22, workdir: "~", key: undefined, sessionID: undefined,
})
assert.equal(parsed.host, "::1")
assert.equal(parsed.user, "alice")
assert.equal(parsed.workdir, "C:/My Project")
assert.equal(parsed.port, 2222)
assert.equal(parseArguments(["--help"]), undefined)
for (const args of [[], ["host", "--workdir"], ["host", "--port", "0"], ["host", "--port", "1e3"],
  ["host", "--port", "65536"], ["host", "--server", "http://elsewhere"], ["host", "--", "--standalone"],
  ["host", "extra"], ["a@host", "--user", "b"], ["ssh://host"], ["host", "--workdir", "a", "--workdir", "b"]]) {
  assert.throws(() => parseArguments(args), undefined, JSON.stringify(args))
}
assert.notEqual(sessionDirectory(parsed), sessionDirectory({ ...parsed, port: 22 }))
assert.notEqual(sessionDirectory(parsed), sessionDirectory({ ...parsed, workdir: "C:/My_Project" }))
assert.notEqual(sessionDirectory(parsed), sessionDirectory({ ...parsed, user: "bob" }))
for (const url of ["https://example.com", "http://192.0.2.1", "http://localhost.evil", "http://a:b@localhost"]) {
  assert.throws(() => assertLocalEndpoint({ url }))
}
assertLocalEndpoint({ url: "http://127.0.0.1:1234" })
await assert.rejects(runCLI(["host"], { env: {}, ensure: () => assert.fail("must not start service") }), /SSH_AUTH_SOCK/)
assert.equal(await runCLI(["--help"], { ensure: () => assert.fail("help must not start service"), report() {} }), 0)
console.log("PASS CLI arguments, target directory identity, local endpoint boundary, missing terminal agent")

const root = fileURLToPath(new URL("../tmp_test_artifacts/", import.meta.url))
await fs.mkdir(root, { recursive: true })
const home = await fs.mkdtemp(path.join(root, "cli-flow-"))
const make = Object.getOwnPropertyDescriptor(OpenCode, "make")
try {
  const directory = sessionDirectory(parseArguments(["host"]), home)
  const endpoint = { url: "http://127.0.0.1:1234" }
  const location = { directory }
  let connected = false, fail = false, attached = 0
  Object.defineProperty(OpenCode, "make", { configurable: true, value: options => {
    assert.equal(options.baseUrl, endpoint.url)
    return {
      session: {
        create: async input => { assert.deepEqual(input, { location }); return { id: "ses_test", location } },
        command: async input => assert.deepEqual(input, { sessionID: "ses_test", name: "remote", text: "status" }),
      },
      rpc: () => ({
        status: async () => ({ phase: "disconnected" }),
        connect: async (input, context) => {
          assert.deepEqual(input, { sessionID: "ses_test", target: {
            host: "host", user: os.userInfo().username, port: 22, workdir: "~", agentSocket: "/caller/agent",
          } })
          assert.deepEqual(context, { location })
          if (fail) throw Error("connect failed")
          connected = true
          return { phase: "connected" }
        },
      }),
    }
  } })
  const deps = { home, env: { SSH_AUTH_SOCK: "/caller/agent" }, ensure: async () => endpoint, report() {},
    attach: async (...args) => {
      assert.equal(connected, true)
      assert.deepEqual(args, [endpoint, directory, "ses_test", deps.env])
      attached++
      return 7
    } }
  assert.equal(await runCLI(["host"], deps), 7)
  fail = true; connected = false
  await assert.rejects(runCLI(["host"], deps), /connect failed/)
  assert.equal(attached, 1, "connect failure must not open the TUI")
  console.log("PASS CLI caller agent, connect-before-attach, service/session selection, failed connect")
} finally {
  Object.defineProperty(OpenCode, "make", make)
  await fs.rm(home, { recursive: true, force: true })
}

if (process.platform !== "win32") {
  const tmp = await fs.mkdtemp(path.join(root, "cli-attach-"))
  try {
    const report = path.join(tmp, "report.json")
    await fs.writeFile(path.join(tmp, "opencode"), `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(process.env.ATTACH_REPORT, JSON.stringify({argv:process.argv.slice(2), cwd:process.cwd(), password:process.env.OPENCODE_PASSWORD}));
process.exit(9);
`, { mode: 0o700 })
    const env = { ...process.env, PATH: tmp, ATTACH_REPORT: report, OPENCODE_PASSWORD: "wrong inherited password" }
    const endpoint = { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "opencode", password: "test service secret" } }
    assert.equal(await attach(endpoint, tmp, "ses_test", env), 9)
    const result = JSON.parse(await fs.readFile(report, "utf8"))
    assert.deepEqual(result.argv, [tmp, "--server", endpoint.url, "--session", "ses_test"])
    assert.equal(result.cwd, tmp)
    assert.equal(result.password, endpoint.auth.password)
    assert.equal(await attach({ url: endpoint.url }, tmp, "ses_test", env), 9)
    assert.equal(JSON.parse(await fs.readFile(report, "utf8")).password, undefined)
    await assert.rejects(attach(endpoint, tmp, "ses_test", { PATH: path.join(tmp, "missing") }), /ENOENT/)
    console.log("PASS CLI attachment pins service/session, env-only authentication, exit status, spawn failure")
  } finally { await fs.rm(tmp, { recursive: true, force: true }) }
}
