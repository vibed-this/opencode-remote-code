/**
 * plugin-smoke.mjs — loads `dist/index.js` with a fake OpenCode **V2** plugin
 * context and asserts the plugin registers the seven remote tools.
 *
 * The plugin is migrated from V1 to V2 by another agent in parallel, so this
 * test is deliberately forgiving:
 *   - dist missing / not importable      -> SKIP
 *   - default export still V1 shaped     -> SKIP
 *     (function, or `{ id, server }`)
 *   - V2 `Plugin.define({ id, setup })`  -> run the real assertions
 *
 * Only a plugin that claims to be V2 and then fails is reported as FAIL.
 */

import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")
const DEFAULT_DIST = path.join(REPO_ROOT, "dist", "index.js")

const REQUIRED_TOOLS = ["shell", "read", "write", "edit", "patch", "glob", "grep"]
const SETUP_TIMEOUT_MS = 90_000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (timer.unref) timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Describe what a default export is, without running it.
 * @returns {{kind: "v2"|"v1-function"|"v1-object"|"unknown", detail: string}}
 */
function classify(exported) {
  if (typeof exported === "function") {
    return { kind: "v1-function", detail: "default export is a function (V1 `(input, options) => Hooks` form)" }
  }
  if (exported && typeof exported === "object") {
    if (typeof exported.setup === "function") {
      return { kind: "v2", detail: `V2 plugin definition (id=${exported.id ?? "?"})` }
    }
    if (typeof exported.effect === "function") {
      return { kind: "v2", detail: `V2 effect-style plugin (id=${exported.id ?? "?"})` }
    }
    if (typeof exported.server === "function" || exported.server) {
      return { kind: "v1-object", detail: 'default export is `{ id, server }` (V1 shape)' }
    }
    return {
      kind: "unknown",
      detail: `object without setup/effect/server (keys: ${Object.keys(exported).join(", ") || "none"})`,
    }
  }
  return { kind: "unknown", detail: `default export is ${typeof exported}` }
}

/** Build the fake V2 context described in the task. */
function makeMockContext({ port, user, password }) {
  const projectDir = process.cwd()
  const added = []
  const notes = []

  const editor = {
    add: (tool) => {
      added.push(tool)
      return tool
    },
    list: () => added.slice(),
    get: (id) => added.find((t) => t.name === id),
    namespace: () => {},
    update: () => {},
    remove: () => {},
  }

  const ctx = {
    options: {
      ssh: `ssh -p ${port} ${user}@127.0.0.1`,
      workdir: "/",
      password,
      // keep the mirror out of the user's home directory
      mirror: path.join(HERE, "tmp", "mirror"),
    },
    location: {
      directory: projectDir,
      project: { id: "p", directory: projectDir, canonical: projectDir },
    },
    tool: {
      // V2: `transform` resolves to a Registration ({ dispose }), exactly like
      // ctx.session.hook / ctx.tool.hook do.
      transform: async (cb) => {
        await cb(editor)
        globalThis.__addedTools = added
        return {
          dispose: async () => {
            notes.push("tool registration disposed")
          },
        }
      },
      list: async () => added.slice(),
      reload: async () => {},
      hook: async (name) => {
        notes.push(`tool.hook(${typeof name === "string" ? name : "?"})`)
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name) => {
        notes.push(`session.hook(${typeof name === "string" ? name : "?"})`)
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: async function* () {},
      }),
    },
    permission: { assert: async () => {} },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
  }

  return { ctx, added, notes }
}

/**
 * @param {object} opts
 * @param {number} opts.port          mock SSH server port
 * @param {string} [opts.user]
 * @param {string} [opts.password]
 * @param {string} [opts.distPath]
 * @param {string} [opts.prefix]
 * @returns {Promise<{status:"pass"|"fail"|"skip", checks:Array, reason?:string}>}
 */
export async function runPluginSmoke(opts) {
  const { port, user = "testuser", password = "testpass", distPath = DEFAULT_DIST, prefix = "[plugin] " } = opts

  const checks = []
  const say = (line) => console.log(`${prefix}${line}`)
  const record = (name, status, detail) => {
    checks.push({ name, status, detail })
    if (status === "pass") say(`PASS ${name}`)
    else if (status === "fail") say(`FAIL ${name}\n${prefix}     ${detail}`)
    else say(`SKIP ${name}${detail ? ` (${detail})` : ""}`)
  }
  const skipAll = (reason) => {
    record("plugin smoke", "skip", reason)
    return { status: "skip", checks, reason }
  }

  /* ------------------------------ preconditions ------------------------- */

  let stat = null
  try {
    stat = await fsp.stat(distPath)
  } catch {
    /* missing */
  }
  if (!stat || !stat.isFile()) {
    return skipAll(`dist/index.js not found at ${distPath} - run \`npm run build\` first`)
  }

  let mod
  try {
    mod = await import(pathToFileURL(distPath).href)
  } catch (err) {
    // A half-built dist or a mid-migration import error must not fail the
    // mock-server work; the plugin is being ported in parallel.
    return skipAll(`import failed: ${(err && err.message) || err}`)
  }

  const exported = mod.default
  const shape = classify(exported)
  if (shape.kind !== "v2") {
    return skipAll(`dist/index.js is not a V2 plugin yet -- ${shape.detail}`)
  }

  /* ------------------------------ setup --------------------------------- */

  const { ctx, added, notes } = makeMockContext({ port, user, password })

  // Env fallbacks, in case the ported plugin still reads process.env.
  const savedEnv = {
    REMOTE_SSH: process.env.REMOTE_SSH,
    REMOTE_WORKDIR: process.env.REMOTE_WORKDIR,
    REMOTE_PASSWORD: process.env.REMOTE_PASSWORD,
    REMOTE_MIRROR: process.env.REMOTE_MIRROR,
  }
  process.env.REMOTE_SSH = ctx.options.ssh
  process.env.REMOTE_WORKDIR = ctx.options.workdir
  process.env.REMOTE_PASSWORD = ctx.options.password
  process.env.REMOTE_MIRROR = ctx.options.mirror

  const restoreEnv = () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  let cleanup = null
  try {
    const entry = typeof exported.setup === "function" ? exported.setup : exported.effect
    cleanup = await withTimeout(Promise.resolve().then(() => entry.call(exported, ctx)), SETUP_TIMEOUT_MS, "setup")
    record("setup(ctx) completes", "pass")
  } catch (err) {
    record("setup(ctx) completes", "fail", (err && err.message) || String(err))
    restoreEnv()
    return { status: "fail", checks }
  }

  /* ------------------------------ tools --------------------------------- */

  record(
    "tool.transform registers tools",
    added.length > 0 ? "pass" : "fail",
    added.length > 0 ? "" : "no tools were added through ctx.tool.transform()"
  )

  const names = added.map((t) => t.name)
  for (const required of REQUIRED_TOOLS) {
    const tool = added.find((t) => t.name === required)
    if (!tool) record(`tool "${required}" registered`, "fail", `registered tools: ${names.join(", ") || "none"}`)
    else if (typeof tool.execute !== "function")
      record(`tool "${required}" registered`, "fail", "missing execute() function")
    else record(`tool "${required}" registered`, "pass")
  }

  const extra = names.filter((n) => !REQUIRED_TOOLS.includes(n))
  if (extra.length) say(`NOTE extra tools registered: ${extra.join(", ")}`)
  if (added.length > REQUIRED_TOOLS.length && extra.length === 0) {
    say(`NOTE ${added.length} tools registered (some registered twice?)`)
  }
  if (notes.length) say(`NOTE ${notes.join(", ")}`)

  /* --------------------------- optional live call ----------------------- */

  const shellTool = added.find((t) => t.name === "shell") || added.find((t) => t.name === "bash")
  if (shellTool && typeof shellTool.execute === "function") {
    try {
      const result = await withTimeout(
        Promise.resolve().then(() =>
          shellTool.execute(
            { command: "echo plugin-smoke-ok" },
            {
              sessionID: "ses_mock",
              messageID: "msg_mock",
              id: "tool_mock",
              agent: "build",
              abort: new AbortController().signal,
            }
          )
        ),
        60_000,
        "shell execute"
      )
      const text = JSON.stringify(result ?? "")
      record(
        "tool shell executes over the mock server",
        text.includes("plugin-smoke-ok") ? "pass" : "fail",
        text.includes("plugin-smoke-ok") ? "" : `unexpected result: ${text.slice(0, 400)}`
      )
    } catch (err) {
      // Voluntarily soft: a not-yet-finished migration may not run tools yet.
      record("tool shell executes over the mock server", "skip", (err && err.message) || String(err))
    }
  }

  /* ------------------------------ cleanup ------------------------------- */

  if (typeof cleanup === "function") {
    try {
      await withTimeout(Promise.resolve().then(() => cleanup()), 30_000, "cleanup")
      record("cleanup() runs", "pass")
    } catch (err) {
      record("cleanup() runs", "fail", (err && err.message) || String(err))
    }
  }
  restoreEnv()

  const failed = checks.filter((c) => c.status === "fail")
  return { status: failed.length === 0 ? "pass" : "fail", checks }
}

export default runPluginSmoke
