/**
 * verify-mock-server.mjs — proves the mock SSH server is good enough for the
 * plugin: password auth, exec (stdout + exit codes), SFTP round trips, and
 * path-escape protection.
 *
 * Standalone:   node test/verify-mock-server.mjs
 * From runner:  import { runVerification } from "./verify-mock-server.mjs"
 *
 * Exits 0 when everything passes, 1 otherwise.
 */

import assert from "node:assert/strict"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import ssh2 from "ssh2"

import { startMockServer, DEFAULT_ROOT_DIR } from "./mock-ssh-server.mjs"

const { Client } = ssh2
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = path.join(HERE, "tmp", "local")

/* -------------------------------------------------------------------------- */
/* tiny promisified ssh2 helpers                                              */
/* -------------------------------------------------------------------------- */

function connect({ port, user, password, host = "127.0.0.1" }) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const timer = setTimeout(() => {
      client.end()
      reject(new Error("connect timeout"))
    }, 15_000)
    client
      .on("ready", () => {
        clearTimeout(timer)
        resolve(client)
      })
      .on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    client.connect({ host, port, username: user, password, readyTimeout: 15_000 })
  })
}

function execOn(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ""
      let stderr = ""
      stream
        .on("data", (d) => {
          stdout += d.toString("utf8")
        })
        .on("close", (code) => resolve({ stdout, stderr, code }))
        .on("error", reject)
      stream.stderr.on("data", (d) => {
        stderr += d.toString("utf8")
      })
    })
  })
}

const call = (obj, method, ...args) =>
  new Promise((resolve, reject) => {
    obj[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  })

const sftpOf = (client) => new Promise((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))))

/* -------------------------------------------------------------------------- */
/* runner                                                                     */
/* -------------------------------------------------------------------------- */

function createRunner(prefix = "") {
  const results = []
  async function check(name, fn) {
    try {
      await fn()
      results.push({ name, status: "pass" })
      console.log(`PASS ${prefix}${name}`)
    } catch (err) {
      results.push({ name, status: "fail", detail: (err && err.message) || String(err) })
      console.log(`FAIL ${prefix}${name}`)
      console.log(`     ${(err && err.message) || err}`)
    }
  }
  return { results, check }
}

/* -------------------------------------------------------------------------- */
/* verification                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} [opts.user]
 * @param {string} [opts.password]
 * @param {string} [opts.rootDir] remote root on disk (to look for leaked files)
 * @param {object} [opts.server] handle returned by startMockServer (for stats)
 * @param {string} [opts.prefix] printed before every test name
 * @returns {Promise<{results:Array<{name:string,status:string,detail?:string}>}>}
 */
export async function runVerification(opts) {
  const {
    port,
    user = "testuser",
    password = "testpass",
    rootDir = DEFAULT_ROOT_DIR,
    server = null,
    prefix = "",
  } = opts

  const { results, check } = createRunner(prefix)

  await fsp.mkdir(LOCAL_DIR, { recursive: true })
  await fsp.mkdir(rootDir, { recursive: true })

  /* ------------------------------ auth ---------------------------------- */

  await check("auth: correct password connects", async () => {
    const client = await connect({ port, user, password })
    client.end()
  })

  await check("auth: wrong password is rejected", async () => {
    let error = null
    try {
      const client = await connect({ port, user, password: password + "-wrong" })
      client.end()
    } catch (err) {
      error = err
    }
    assert.ok(error, "connection with a wrong password should fail")
    assert.match(String(error.message), /auth|permission|denied|fail/i)
  })

  await check("auth: unknown user is rejected", async () => {
    let error = null
    try {
      const client = await connect({ port, user: "nobody-" + user, password })
      client.end()
    } catch (err) {
      error = err
    }
    assert.ok(error, "connection with an unknown user should fail")
  })

  /* ------------------------------ exec ---------------------------------- */

  const client = await connect({ port, user, password })

  await check("exec: echo hello returns stdout", async () => {
    const res = await execOn(client, "echo hello")
    assert.equal(res.stdout.trim(), "hello")
    assert.equal(res.code, 0)
  })

  await check("exec: exit code 0 is reported", async () => {
    const res = await execOn(client, "true")
    assert.equal(res.code, 0)
  })

  await check("exec: non-zero exit code is propagated", async () => {
    const res = await execOn(client, "echo boom >&2; exit 7")
    assert.equal(res.code, 7)
    assert.match(res.stderr, /boom/)
  })

  await check("exec: cwd is the remote root", async () => {
    const res = await execOn(client, "pwd")
    const pwd = res.stdout.trim().replace(/\\/g, "/").toLowerCase()
    assert.ok(pwd.endsWith("test/tmp/remote"), `unexpected pwd: ${pwd}`)
  })

  await check("exec: stderr is separated from stdout", async () => {
    const res = await execOn(client, "echo out; echo err >&2")
    assert.equal(res.stdout.trim(), "out")
    assert.equal(res.stderr.trim(), "err")
  })

  /* ------------------------------ sftp ---------------------------------- */

  const sftp = await sftpOf(client)
  const remoteFile = "/hello.txt"
  const remoteNested = "/sub/nested.txt"
  const uploadedBody = "hello mock sftp\nline2 with unicode: 你好\n"
  const localSource = path.join(LOCAL_DIR, "upload.txt")
  const localTarget = path.join(LOCAL_DIR, "download.txt")
  await fsp.writeFile(localSource, uploadedBody, "utf8")

  await check("sftp: realpath('/') is the virtual root", async () => {
    const real = await call(sftp, "realpath", "/")
    assert.equal(real, "/")
  })

  await check("sftp: fastPut uploads a file", async () => {
    await call(sftp, "fastPut", localSource, remoteFile)
    const st = await call(sftp, "stat", remoteFile)
    assert.equal(st.size, Buffer.byteLength(uploadedBody))
  })

  await check("sftp: fastGet downloads identical content", async () => {
    await call(sftp, "fastGet", remoteFile, localTarget)
    const fetched = await fsp.readFile(localTarget, "utf8")
    assert.equal(fetched, uploadedBody)
  })

  await check("sftp: writeFile/readFile round trip", async () => {
    await call(sftp, "writeFile", "/inline.txt", "alpha\nbeta\n")
    const content = (await call(sftp, "readFile", "/inline.txt")).toString("utf8")
    assert.equal(content, "alpha\nbeta\n")
  })

  await check("sftp: opening with 'w' truncates an existing file", async () => {
    await call(sftp, "writeFile", "/trunc.txt", "0123456789")
    const handle = await call(sftp, "open", "/trunc.txt", "w")
    await call(sftp, "write", handle, Buffer.from("abc"), 0, 3, 0)
    await call(sftp, "close", handle)
    const content = (await call(sftp, "readFile", "/trunc.txt")).toString("utf8")
    assert.equal(content, "abc", "flags TRUNC|CREAT|WRITE must truncate")
    await call(sftp, "unlink", "/trunc.txt")
  })

  await check("sftp: on-disk file really exists under the remote root", async () => {
    const onDisk = path.join(rootDir, "hello.txt")
    const content = await fsp.readFile(onDisk, "utf8")
    assert.equal(content, uploadedBody)
  })

  await check("sftp: readdir lists entries with attrs", async () => {
    const list = await call(sftp, "readdir", "/")
    const names = list.map((e) => e.filename)
    assert.ok(names.includes("hello.txt"), `missing hello.txt in ${names}`)
    assert.ok(names.includes("inline.txt"), `missing inline.txt in ${names}`)
    const entry = list.find((e) => e.filename === "hello.txt")
    assert.ok(entry.attrs && typeof entry.attrs.size === "number")
    assert.ok(entry.longname.length > 0)
  })

  await check("sftp: mkdir creates a directory", async () => {
    await call(sftp, "mkdir", "/sub")
    const st = await call(sftp, "stat", "/sub")
    assert.equal(st.isDirectory(), true)
  })

  await check("sftp: mkdir of an existing directory fails", async () => {
    let error = null
    try {
      await call(sftp, "mkdir", "/sub")
    } catch (err) {
      error = err
    }
    assert.ok(error, "mkdir on existing dir should fail")
  })

  await check("sftp: rename moves a file", async () => {
    await call(sftp, "writeFile", remoteNested, "nested\n")
    await call(sftp, "rename", remoteNested, "/sub/renamed.txt")
    const content = (await call(sftp, "readFile", "/sub/renamed.txt")).toString("utf8")
    assert.equal(content, "nested\n")
    let gone = false
    try {
      await call(sftp, "stat", remoteNested)
    } catch {
      gone = true
    }
    assert.ok(gone, "old path should not exist after rename")
  })

  await check("sftp: lstat works", async () => {
    const st = await call(sftp, "lstat", "/hello.txt")
    assert.equal(st.isFile(), true)
  })

  await check("sftp: remove deletes a file", async () => {
    await call(sftp, "unlink", "/inline.txt")
    let gone = false
    try {
      await call(sftp, "stat", "/inline.txt")
    } catch {
      gone = true
    }
    assert.ok(gone, "file should be gone after unlink")
  })

  await check("sftp: rmdir removes an empty directory", async () => {
    await call(sftp, "unlink", "/sub/renamed.txt")
    await call(sftp, "rmdir", "/sub")
    let gone = false
    try {
      await call(sftp, "stat", "/sub")
    } catch {
      gone = true
    }
    assert.ok(gone, "dir should be gone after rmdir")
  })

  await check("sftp: rmdir on a non-empty directory fails", async () => {
    await call(sftp, "mkdir", "/full")
    await call(sftp, "writeFile", "/full/keep.txt", "keep\n")
    let error = null
    try {
      await call(sftp, "rmdir", "/full")
    } catch (err) {
      error = err
    }
    assert.ok(error, "rmdir on a non-empty dir should fail")
    await call(sftp, "unlink", "/full/keep.txt")
    await call(sftp, "rmdir", "/full")
  })

  await check("sftp: stat of a missing file reports no-such-file", async () => {
    let error = null
    try {
      await call(sftp, "stat", "/does-not-exist")
    } catch (err) {
      error = err
    }
    assert.ok(error, "stat on a missing file should fail")
    assert.equal(error.code, 2, `expected NO_SUCH_FILE(2), got ${error.code}`)
  })

  /* --------------------------- path traversal --------------------------- */

  const escapeAttempts = [
    "../../../etc/passwd",
    "/../../../../etc/passwd",
    "/../Windows/win.ini",
    "sub/../../../../Windows/win.ini",
    "/foo/../../../../etc/hosts",
  ]

  await check("sftp: multi-chunk fastPut/fastGet round trip", async () => {
    // 768 KiB forces many 32 KiB SFTP writes with the client's default
    // concurrency of 64, which is where offset/handle bugs show up.
    const { randomBytes } = await import("node:crypto")
    const blob = randomBytes(768 * 1024)
    const bigSource = path.join(LOCAL_DIR, "big.bin")
    const bigTarget = path.join(LOCAL_DIR, "big.back.bin")
    await fsp.writeFile(bigSource, blob)
    await call(sftp, "fastPut", bigSource, "/big.bin")
    await call(sftp, "fastGet", "/big.bin", bigTarget)
    const back = await fsp.readFile(bigTarget)
    assert.equal(back.length, blob.length)
    assert.equal(Buffer.compare(back, blob), 0, "big file content differs after round trip")
    const st = await call(sftp, "stat", "/big.bin")
    assert.equal(st.size, blob.length)
    await call(sftp, "unlink", "/big.bin")
  })

  await check("traversal: readFile outside the root is refused", async () => {
    for (const p of escapeAttempts) {
      let error = null
      try {
        await call(sftp, "readFile", p)
      } catch (err) {
        error = err
      }
      assert.ok(error, `readFile(${p}) should fail`)
    }
  })

  await check("traversal: fastGet outside the root is refused", async () => {
    let error = null
    try {
      await call(sftp, "fastGet", "../../../etc/passwd", path.join(LOCAL_DIR, "leak.txt"))
    } catch (err) {
      error = err
    }
    assert.ok(error, "fastGet of ../../../etc/passwd should fail")
  })

  await check("traversal: writeFile outside the root is refused", async () => {
    let error = null
    try {
      await call(sftp, "writeFile", "/../../evil-outside-root.txt", "pwned")
    } catch (err) {
      error = err
    }
    assert.ok(error, "writeFile escaping the root should fail")
    const leaked = path.join(rootDir, "..", "..", "evil-outside-root.txt")
    let exists = true
    try {
      await fsp.stat(leaked)
    } catch {
      exists = false
    }
    assert.equal(exists, false, `file escaped the root: ${leaked}`)
  })

  await check("traversal: stat/opendir outside the root is refused", async () => {
    for (const method of ["stat", "lstat", "readdir"]) {
      let error = null
      try {
        await call(sftp, method, "/../../..")
      } catch (err) {
        error = err
      }
      assert.ok(error, `${method}("/../../..") should fail`)
    }
  })

  await check("traversal: attempts are recorded by the server", async () => {
    if (!server) return // standalone mode without stats handle: nothing to assert
    assert.ok(
      server.stats.pathViolations === 0 || server.stats.blockedPaths.length >= 0,
      "stats getter broken"
    )
    assert.ok(
      server.stats.blockedPaths.some((p) => String(p).includes("..")),
      `expected recorded escape attempts, got ${JSON.stringify(server.stats.blockedPaths)}`
    )
  })

  sftp.end()
  client.end()

  return { results }
}

/* -------------------------------------------------------------------------- */
/* standalone entry point                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const rootDir = DEFAULT_ROOT_DIR
  await fsp.rm(rootDir, { recursive: true, force: true })
  await fsp.mkdir(rootDir, { recursive: true })

  const server = await startMockServer({ rootDir })
  console.log(`mock ssh server listening on 127.0.0.1:${server.port} (root=${server.rootDir})`)
  console.log("")

  let results
  try {
    ;({ results } = await runVerification({
      port: server.port,
      user: server.user,
      password: server.password,
      rootDir: server.rootDir,
      server,
    }))
  } finally {
    await server.close()
  }

  const passed = results.filter((r) => r.status === "pass").length
  const failed = results.filter((r) => r.status === "fail")
  console.log("")
  if (failed.length === 0) {
    console.log(`PASS verify-mock-server: ${passed}/${results.length} checks passed`)
    process.exit(0)
  }
  console.log(`FAIL verify-mock-server: ${failed.length} of ${results.length} checks failed`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("FATAL", err)
    process.exit(1)
  })
}
