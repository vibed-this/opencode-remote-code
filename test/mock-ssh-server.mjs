/**
 * mock-ssh-server.mjs — a real (in-process) SSH server for end-to-end testing.
 *
 * Why: the plugin talks to a remote machine over `ssh2` (exec + SFTP). To test it
 * without a physical remote host we spin up a `ssh2.Server` that behaves enough
 * like a real OpenSSH box:
 *
 *   - password authentication (explicitly, because that is one of the things we
 *     must prove works)
 *   - persistent ed25519 host key cached in test/.hostkey
 *   - `exec` -> spawns Git-for-Windows bash (`bash.exe -lc "<command>"`) with cwd
 *     pinned to the "remote root" directory
 *   - `shell` -> accepts the channel but only fakes a tiny prompt
 *   - `sftp` -> a real file-system backed SFTP subset, with the virtual POSIX
 *     root mapped onto a Windows directory and path-escape protection
 *
 * Not touched: nothing here is imported by src/. This file is a test fixture.
 */

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import ssh2 from "ssh2"

const { Server, utils } = ssh2
const { OPEN_MODE, STATUS_CODE } = utils.sftp

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const HOSTKEY_PATH = path.join(HERE, ".hostkey")
export const DEFAULT_ROOT_DIR = path.join(HERE, "tmp", "remote")
export const DEFAULT_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
export const DEFAULT_USER = "testuser"
export const DEFAULT_PASSWORD = "testpass"

// POSIX-ish file type bits (SSH_FILEXFER_ATTR_PERMISSIONS wants a full mode).
const S_IFDIR = 0o040000
const S_IFREG = 0o100000

const READDIR_BATCH = 16
const MAX_READ = 64 * 1024

/* -------------------------------------------------------------------------- */
/* host key                                                                   */
/* -------------------------------------------------------------------------- */

function loadHostKey() {
  try {
    const txt = fs.readFileSync(HOSTKEY_PATH, "utf8")
    if (txt.includes("PRIVATE KEY")) return Buffer.from(txt)
  } catch {
    /* not cached yet */
  }
  const { private: privateKey } = utils.generateKeyPairSync("ed25519")
  fs.mkdirSync(HERE, { recursive: true })
  fs.writeFileSync(HOSTKEY_PATH, privateKey, { mode: 0o600 })
  return Buffer.from(privateKey)
}

/* -------------------------------------------------------------------------- */
/* POSIX <-> Windows path mapping (with escape protection)                    */
/* -------------------------------------------------------------------------- */

function createPathMap(rootDir) {
  const absRoot = path.resolve(rootDir)
  const normRoot = absRoot.toLowerCase()
  const blocked = []

  /**
   * Map a virtual POSIX path (what the SSH client sees) to a real Windows path
   * under `rootDir`. Returns null (and records the attempt) if the request tries
   * to leave the root, e.g. "../../../etc/passwd" or "D:/Windows".
   */
  function resolveVirtual(inputPath) {
    const raw = typeof inputPath === "string" ? inputPath : ""
    const parts = raw.replace(/\\/g, "/").split("/")
    const segs = []

    for (const part of parts) {
      if (part === "" || part === ".") continue
      if (part === "..") {
        if (segs.length === 0) {
          blocked.push(raw)
          return null
        }
        segs.pop()
        continue
      }
      // Drive letters / NTFS stream separators / wildcards are never valid in a
      // POSIX remote path and are the easiest way to reach outside the root.
      if (/[\u0000:*?"<>|]/.test(part)) {
        blocked.push(raw)
        return null
      }
      segs.push(part)
    }

    const virtualPath = "/" + segs.join("/")
    const localPath = segs.length ? path.resolve(absRoot, ...segs) : absRoot
    const normLocal = localPath.toLowerCase()
    if (normLocal !== normRoot && !normLocal.startsWith(normRoot + path.sep)) {
      blocked.push(raw)
      return null
    }
    return { virtualPath, localPath }
  }

  /**
   * Like resolveVirtual() but ".." is clamped at the root instead of being
   * refused. Used by REALPATH, which real OpenSSH also answers with "/" for
   * "/.." instead of an error.
   */
  function clampVirtual(inputPath) {
    const raw = typeof inputPath === "string" ? inputPath : ""
    const segs = []
    for (const part of raw.replace(/\\/g, "/").split("/")) {
      if (part === "" || part === ".") continue
      if (part === "..") {
        segs.pop()
        continue
      }
      segs.push(part)
    }
    const target = resolveVirtual("/" + segs.join("/"))
    if (target) return target
    return { virtualPath: "/", localPath: absRoot }
  }

  return { rootDir: absRoot, resolveVirtual, clampVirtual, blocked }
}

/* -------------------------------------------------------------------------- */
/* SFTP attribute helpers                                                     */
/* -------------------------------------------------------------------------- */

function attrsFromStats(st) {
  const mode = st.isDirectory() ? S_IFDIR | 0o755 : S_IFREG | 0o644
  return {
    mode,
    uid: 0,
    gid: 0,
    size: st.isDirectory() ? 0 : st.size,
    atime: Math.floor((st.atimeMs || Date.now()) / 1000),
    mtime: Math.floor((st.mtimeMs || Date.now()) / 1000),
  }
}

function longnameFor(name, st) {
  const isDir = st.isDirectory()
  const perms = isDir ? "drwxr-xr-x" : "-rw-r--r--"
  const size = isDir ? 4096 : st.size
  const iso = new Date(st.mtimeMs || Date.now()).toISOString()
  return `${perms} 1 testuser testuser ${String(size).padStart(8)} ${iso.slice(0, 10)} ${iso.slice(11, 16)} ${name}`
}

function statusForError(err) {
  switch (err && err.code) {
    case "ENOENT":
    case "ENOTDIR":
      return STATUS_CODE.NO_SUCH_FILE
    case "EACCES":
    case "EPERM":
      return STATUS_CODE.PERMISSION_DENIED
    default:
      return STATUS_CODE.FAILURE
  }
}

/** SFTP pflags -> fs.open() flag string. */
function openFlagsToNode(flags) {
  const readable = Boolean(flags & OPEN_MODE.READ)
  const writable = Boolean(flags & OPEN_MODE.WRITE)
  const append = Boolean(flags & OPEN_MODE.APPEND)
  const creat = Boolean(flags & OPEN_MODE.CREAT)
  const trunc = Boolean(flags & OPEN_MODE.TRUNC)
  const excl = Boolean(flags & OPEN_MODE.EXCL)

  if (!writable) return "r"
  if (append) return (readable ? "a+" : "a") + (excl ? "x" : "")
  if (trunc || excl) return (readable ? "w+" : "w") + (excl ? "x" : "")
  // Write without truncate: open for update, creating if `creat` is set.
  return creat ? "r+" : "r+"
}

/* -------------------------------------------------------------------------- */
/* SFTP subsystem                                                             */
/* -------------------------------------------------------------------------- */

function attachSftp(sftp, { pathMap, log }) {
  const handles = new Map()
  let nextId = 1

  const status = (reqid, code, message) => {
    try {
      sftp.status(reqid, code, message ? String(message) : undefined)
    } catch {
      /* channel gone */
    }
  }

  function newHandle(kind, data) {
    const id = nextId++
    handles.set(id, { kind, ...data })
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id, 0)
    return buf
  }

  function getHandle(buf, kind) {
    if (!Buffer.isBuffer(buf) || buf.length !== 4) return null
    const h = handles.get(buf.readUInt32BE(0))
    if (!h) return null
    if (kind && !(Array.isArray(kind) ? kind.includes(h.kind) : h.kind === kind)) return null
    return h
  }

  /** Kick off an async handler; any rejection becomes an SFTP status reply. */
  function wrap(fn) {
    return (reqid, ...rest) => {
      Promise.resolve()
        .then(() => fn(reqid, ...rest))
        .catch((err) => {
          log(`sftp error: ${err && err.message}`)
          status(reqid, statusForError(err), (err && err.message) || "failure")
        })
    }
  }
  function resolve(reqid, p) {
    const target = pathMap.resolveVirtual(p)
    if (!target) {
      log(`blocked path escape attempt: ${JSON.stringify(p)}`)
      status(reqid, STATUS_CODE.PERMISSION_DENIED, "path escapes remote root")
      return null
    }
    return target
  }

  /* ---- REALPATH ---------------------------------------------------------- */

  sftp.on(
    "REALPATH",
    wrap(async (reqid, p) => {
      const target = pathMap.clampVirtual(p || "/")
      let attrs
      try {
        attrs = attrsFromStats(await fsp.stat(target.localPath))
      } catch {
        attrs = undefined
      }
      sftp.name(reqid, [
        {
          filename: target.virtualPath,
          longname: target.virtualPath,
          attrs,
        },
      ])
    })
  )

  /* ---- files ------------------------------------------------------------- */

  sftp.on(
    "OPEN",
    wrap(async (reqid, filename, flags) => {
      const target = resolve(reqid, filename)
      if (!target) return
      const mode = openFlagsToNode(flags)
      let fh
      try {
        fh = await fsp.open(target.localPath, mode)
      } catch (err) {
        // create-if-missing without truncate: "r+" fails on a new file.
        if (err.code === "ENOENT" && flags & OPEN_MODE.CREAT) {
          fh = await fsp.open(target.localPath, flags & OPEN_MODE.READ ? "w+" : "w")
        } else {
          throw err
        }
      }
      const handle = newHandle("file", { fh, localPath: target.localPath })
      log(`OPEN ${target.virtualPath} (${mode})`)
      sftp.handle(reqid, handle)
    })
  )

  sftp.on(
    "READ",
    wrap(async (reqid, handleBuf, offset, length) => {
      const h = getHandle(handleBuf, "file")
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      const len = Math.max(0, Math.min(length, MAX_READ))
      const buf = Buffer.alloc(len)
      const { bytesRead } = await h.fh.read(buf, 0, len, offset)
      if (bytesRead <= 0) return status(reqid, STATUS_CODE.EOF)
      sftp.data(reqid, buf.subarray(0, bytesRead))
    })
  )

  sftp.on(
    "WRITE",
    wrap(async (reqid, handleBuf, offset, data) => {
      const h = getHandle(handleBuf, "file")
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      await h.fh.write(data, 0, data.length, offset)
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "CLOSE",
    wrap(async (reqid, handleBuf) => {
      // Real OpenSSH clients close directory handles with a plain CLOSE
      // (ssh2's own readdir() does exactly that), so accept both kinds.
      const h = getHandle(handleBuf)
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      handles.delete(handleBuf.readUInt32BE(0))
      if (h.kind === "file") await h.fh.close().catch(() => {})
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "FSTAT",
    wrap(async (reqid, handleBuf) => {
      const h = getHandle(handleBuf, "file")
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      sftp.attrs(reqid, attrsFromStats(await h.fh.stat()))
    })
  )

  const onStat = (method) =>
    wrap(async (reqid, p) => {
      const target = resolve(reqid, p)
      if (!target) return
      const st = await fsp[method](target.localPath)
      sftp.attrs(reqid, attrsFromStats(st))
    })

  sftp.on("STAT", onStat("stat"))
  sftp.on("LSTAT", onStat("lstat"))

  sftp.on(
    "SETSTAT",
    wrap(async (reqid, p, attrs) => {
      const target = resolve(reqid, p)
      if (!target) return
      await applyAttrs(target.localPath, attrs)
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "FSETSTAT",
    wrap(async (reqid, handleBuf, attrs) => {
      const h = getHandle(handleBuf, "file")
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      await applyAttrs(h.localPath, attrs, h.fh)
      status(reqid, STATUS_CODE.OK)
    })
  )

  async function applyAttrs(localPath, attrs, fh) {
    if (!attrs) return
    if (typeof attrs.size === "number") {
      if (fh) await fh.truncate(attrs.size)
      else await fsp.truncate(localPath, attrs.size)
    }
    // chmod is a no-op on Windows for the most part, best effort only.
    if (typeof attrs.mode === "number") {
      await fsp.chmod(localPath, attrs.mode & 0o777).catch(() => {})
    }
  }

  /* ---- directories ------------------------------------------------------- */

  sftp.on(
    "OPENDIR",
    wrap(async (reqid, p) => {
      const target = resolve(reqid, p)
      if (!target) return
      const dirents = await fsp.readdir(target.localPath, { withFileTypes: true })
      const entries = []
      for (const dirent of dirents) {
        const childLocal = path.join(target.localPath, dirent.name)
        let st
        try {
          st = await fsp.lstat(childLocal)
        } catch {
          continue
        }
        entries.push({
          name: dirent.name,
          virtualPath: path.posix.join(target.virtualPath, dirent.name),
          attrs: attrsFromStats(st),
          longname: longnameFor(dirent.name, st),
        })
      }
      const handle = newHandle("dir", { entries, pos: 0, virtualPath: target.virtualPath })
      log(`OPENDIR ${target.virtualPath} (${entries.length} entries)`)
      sftp.handle(reqid, handle)
    })
  )

  sftp.on(
    "READDIR",
    wrap(async (reqid, handleBuf) => {
      const h = getHandle(handleBuf, "dir")
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      if (h.pos >= h.entries.length) return status(reqid, STATUS_CODE.EOF)
      const slice = h.entries.slice(h.pos, h.pos + READDIR_BATCH)
      h.pos += slice.length
      sftp.name(
        reqid,
        slice.map((e) => ({
          filename: e.name,
          longname: e.longname,
          attrs: e.attrs,
        }))
      )
    })
  )

  sftp.on(
    "CLOSEDIR",
    wrap(async (reqid, handleBuf) => {
      const h = getHandle(handleBuf, "dir")
      if (!h) return status(reqid, STATUS_CODE.FAILURE, "bad handle")
      handles.delete(handleBuf.readUInt32BE(0))
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "MKDIR",
    wrap(async (reqid, p) => {
      const target = resolve(reqid, p)
      if (!target) return
      await fsp.mkdir(target.localPath)
      log(`MKDIR ${target.virtualPath}`)
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "RMDIR",
    wrap(async (reqid, p) => {
      const target = resolve(reqid, p)
      if (!target) return
      await fsp.rmdir(target.localPath)
      status(reqid, STATUS_CODE.OK)
    })
  )

  /* ---- files / links ----------------------------------------------------- */

  sftp.on(
    "REMOVE",
    wrap(async (reqid, p) => {
      const target = resolve(reqid, p)
      if (!target) return
      await fsp.unlink(target.localPath)
      log(`REMOVE ${target.virtualPath}`)
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "RENAME",
    wrap(async (reqid, oldPath, newPath) => {
      const from = resolve(reqid, oldPath)
      if (!from) return
      const to = resolve(reqid, newPath)
      if (!to) return
      await fsp.rename(from.localPath, to.localPath)
      log(`RENAME ${from.virtualPath} -> ${to.virtualPath}`)
      status(reqid, STATUS_CODE.OK)
    })
  )

  sftp.on(
    "READLINK",
    wrap(async (reqid, p) => {
      const target = resolve(reqid, p)
      if (!target) return
      const link = await fsp.readlink(target.localPath)
      sftp.name(reqid, [{ filename: link.replace(/\\/g, "/"), longname: link, attrs: {} }])
    })
  )

  /* ---- OpenSSH extensions ------------------------------------------------ */

  sftp.on(
    "EXTENDED",
    wrap(async (reqid, extName, extData) => {
      if (extName === "posix-rename@openssh.com") {
        const [oldPath, newPath] = readTwoStrings(extData)
        if (!oldPath || !newPath) return status(reqid, STATUS_CODE.BAD_MESSAGE, "bad payload")
        const from = resolve(reqid, oldPath)
        if (!from) return
        const to = resolve(reqid, newPath)
        if (!to) return
        await fsp.rm(from.localPath, { force: true }).catch(() => {})
        await fsp.rename(from.localPath, to.localPath)
        return status(reqid, STATUS_CODE.OK)
      }
      status(reqid, STATUS_CODE.OP_UNSUPPORTED, `unsupported extension ${extName}`)
    })
  )

  sftp.on("close", () => {
    for (const h of handles.values()) {
      if (h.kind === "file") h.fh.close().catch(() => {})
    }
    handles.clear()
  })
}

function readTwoStrings(buf) {
  if (!Buffer.isBuffer(buf)) return []
  const out = []
  let p = 0
  while (p + 4 <= buf.length && out.length < 2) {
    const len = buf.readUInt32BE(p)
    p += 4
    if (p + len > buf.length) break
    out.push(buf.toString("utf8", p, p + len))
    p += len
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* shell subsystem (fake, only for completeness)                              */
/* -------------------------------------------------------------------------- */

function attachShell(stream) {
  stream.write("mock-ssh-server: interactive shell is not a real shell; use exec\r\n")
  stream.write("$ ")
  let buffered = ""
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8")
    let idx
    while ((idx = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, idx).replace(/\r$/, "")
      buffered = buffered.slice(idx + 1)
      const cmd = line.trim()
      if (!cmd) {
        stream.write("$ ")
        continue
      }
      if (cmd === "exit" || cmd === "logout") {
        stream.exit(0)
        stream.end()
        return
      }
      if (cmd === "pwd") stream.write("/\r\n$ ")
      else if (cmd.startsWith("echo ")) stream.write(`${cmd.slice(5)}\r\n$ `)
      else stream.write(`mock-shell: cannot run "${cmd}" (use exec)\r\n$ `)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* server                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Start the mock SSH server.
 *
 * @param {object} [options]
 * @param {string} [options.rootDir]  "remote root" directory (default test/tmp/remote)
 * @param {string} [options.user]     required username (default "testuser")
 * @param {string} [options.password] required password (default "testpass")
 * @param {string} [options.host]     listen address (default 127.0.0.1)
 * @param {string} [options.bashPath] bash to use for exec
 * @param {boolean}[options.verbose]  log every request
 * @returns {Promise<{port:number,host:string,user:string,password:string,rootDir:string,stats:object,close:()=>Promise<void>}>}
 */
export async function startMockServer(options = {}) {
  const {
    rootDir = DEFAULT_ROOT_DIR,
    user = process.env.MOCK_SSH_USER || DEFAULT_USER,
    password = process.env.MOCK_SSH_PASSWORD || DEFAULT_PASSWORD,
    host = "127.0.0.1",
    bashPath = process.env.MOCK_SSH_BASH || DEFAULT_BASH,
    verbose = Boolean(process.env.MOCK_SSH_VERBOSE),
  } = options

  const log = verbose ? (...args) => console.log("[mock-ssh]", ...args) : () => {}

  await fsp.mkdir(rootDir, { recursive: true })
  const pathMap = createPathMap(rootDir)
  const hostKey = loadHostKey()

  const stats = {
    connections: 0,
    authAttempts: 0,
    authFailures: 0,
    execs: 0,
    sftpSessions: 0,
  }
  // Live views of the path mapper's escape-blocked list.
  Object.defineProperty(stats, "pathViolations", {
    enumerable: true,
    get: () => pathMap.blocked.length,
  })
  Object.defineProperty(stats, "blockedPaths", {
    enumerable: true,
    get: () => pathMap.blocked.slice(),
  })

  const clients = new Set()
  const children = new Set()

  const server = new Server(
    { hostKeys: [hostKey], ident: "OpenSSH_9.6-mock" },
    (client) => {
      clients.add(client)
      stats.connections++
      log("client connected")

      client
        .on("authentication", (ctx) => {
          stats.authAttempts++
          log(`auth method=${ctx.method} user=${ctx.username}`)

          if (ctx.method !== "password") {
            // `none` and every other method are refused on purpose.
            log(`rejecting auth method ${ctx.method}`)
            return ctx.reject(["password"])
          }
          if (ctx.username !== user || ctx.password !== password) {
            stats.authFailures++
            log("auth rejected")
            return ctx.reject()
          }
          ctx.accept()
        })
        .on("ready", () => {
          log("client authenticated")
          client.on("session", (accept, reject) => {
            const session = accept()

            session.on("pty", (acceptPty) => acceptPty())
            session.on("window-change", (acceptWindow) => acceptWindow && acceptWindow())

            session.on("exec", (acceptExec, _reject, info) => {
              const stream = acceptExec()
              runExec(stream, info && info.command, { bashPath, rootDir, children, log, stats })
            })

            session.on("shell", (acceptShell) => {
              const stream = acceptShell()
              attachShell(stream)
            })

            session.on("sftp", (acceptSftp) => {
              stats.sftpSessions++
              log("sftp session opened")
              attachSftp(acceptSftp(), { pathMap, log })
            })
          })
        })
        .on("close", () => {
          clients.delete(client)
          log("client disconnected")
        })
        .on("error", (err) => {
          log(`client error: ${err && err.message}`)
          clients.delete(client)
        })
    }
  )

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, host, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const port = address.port
  log(`listening on ${host}:${port} root=${rootDir}`)

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    for (const child of children) {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    children.clear()
    for (const client of clients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    clients.clear()
    await new Promise((resolve) => server.close(() => resolve()))
  }

  /** Live view of blocked escape attempts (used by the verifier). */
  return {
    port,
    host,
    user,
    password,
    rootDir: path.resolve(rootDir),
    bashPath,
    stats,
    close,
  }
}

/* -------------------------------------------------------------------------- */
/* exec                                                                       */
/* -------------------------------------------------------------------------- */

function runExec(stream, command, { bashPath, rootDir, children, log, stats }) {
  stats.execs++
  log(`exec: ${command}`)

  let child
  try {
    child = spawn(bashPath, ["-lc", String(command ?? "")], {
      cwd: rootDir,
      env: { ...process.env, TERM: "dumb" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    stream.stderr.write(`mock-ssh-server: failed to spawn bash: ${err.message}\n`)
    stream.exit(127)
    stream.end()
    return
  }

  children.add(child)

  child.stdout.on("data", (chunk) => {
    try {
      stream.write(chunk)
    } catch {
      /* channel closed */
    }
  })
  child.stderr.on("data", (chunk) => {
    try {
      stream.stderr.write(chunk)
    } catch {
      /* channel closed */
    }
  })
  child.on("error", (err) => {
    children.delete(child)
    try {
      stream.stderr.write(`mock-ssh-server: ${err.message}\n`)
      stream.exit(127)
      stream.end()
    } catch {
      /* channel closed */
    }
  })
  child.on("close", (code, signal) => {
    children.delete(child)
    const exitCode = typeof code === "number" ? code : signal ? 128 : 0
    try {
      stream.exit(exitCode)
      stream.end()
    } catch {
      /* channel closed */
    }
  })

  stream.on("close", () => {
    if (!child.killed) {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
  })
}

export default startMockServer

/** Alias for `startMockServer` (task spec calls it `start`). */
export const start = startMockServer
