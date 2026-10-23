# Remote Code — Agent Guide

## Project Overview

Remote Code is an OpenCode plugin that lets AI agents operate on remote machines over SSH, with zero footprint on the remote side. The remote machine only needs an SSH daemon; no agent, runtime, or dependency installation is required.

This fork targets **OpenCode V2** (`@opencode/plugin` ^2.1.2). It was ported from the V1 API (`@opencode-ai/plugin`, `{ id, server }`); see `MIGRATION-V2.md` for the verified API contract and `PORTING-NOTES.md` for the per-file change log and copy-pasteable config examples.

## Design Decisions

### SSH Argument Passing (Plugin Options First)

Remote mode is activated by the plugin's **`options`** in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "D:/path/to/opencode-remote-code",
      "options": {
        "ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa -p 22 user@192.0.2.10",
        "workdir": "/home/project",
        "password": "***",
        "sudoPassword": "***",
        "mirror": "C:/Users/you/.opencode/mirrors"
      }
    }
  ]
}
```

**Why options and not environment variables:** V2 plugins run inside a **shared background service** process, which is started independently of your shell. `export REMOTE_SSH=...` in the shell where you type `opencode` is therefore **not visible** to the plugin (`process.env.REMOTE_SSH` is `undefined` — measured). Only `opencode run --standalone` (which spawns a private service process that inherits the environment) sees those variables. Hence the resolution order in `src/config.ts`:

```
ctx.options  >  env vars  >  legacy --remote* argv
```

The env/argv paths are kept **only for backward compatibility** and for `--standalone` runs; they must not be the documented primary path.

Accepted `options` keys (aliases resolved by `OPTION_KEYS` in `src/config.ts`):

| Meaning | `options` keys | Env fallback | argv fallback |
| --- | --- | --- | --- |
| SSH command string | `ssh` / `sshCommand` / `ssh-command` | `REMOTE_SSH` | `--remote` / `--remote-ssh` |
| Remote working directory | `workdir` / `remoteWorkdir` / `remote-workdir` | `REMOTE_WORKDIR` | `--remote-workdir` |
| SSH password | `password` / `sshPassword` | `REMOTE_PASSWORD` | `--remote-password` |
| sudo password | `sudoPassword` / `sudo-password` | `REMOTE_SUDO_PASSWORD` | `--remote-sudo-password` |
| Local mirror root | `mirror` / `mirrorRoot` | `REMOTE_MIRROR` | `--remote-mirror` |

An `ssh` value without `workdir` is a configuration error: the plugin logs one `console.error` line and stays dormant (it never crashes the host). With **no** `ssh` at all the plugin is fully **dormant**: no SSH connection, no tool registration, no files written, OpenCode runs normally in local mode. This is a hard design requirement.

The `ssh` value is a **single SSH command string** exactly as a user would type in their terminal:

```jsonc
"ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa -i ~/.ssh/id_rsa -p 2222 user@192.0.2.10"
```

This gives users unlimited flexibility: any SSH option (`-o`, `-i`, `-p`, `-J` for jump hosts, `-v`, etc.) works without the plugin needing to know about it.

From this string we parse:

- `-o Key=Value` → extra SSH options
- `-i path` → identity file
- `-p port` → port (default 22)
- `user@host` → credentials and target

> **Note**: OpenCode's CLI does not recognize `--remote*` flags; they remain a best-effort legacy fallback that only works if those arguments actually reach the service process. Configure the plugin via `opencode.jsonc` `plugins[].options` instead.

### Session Persistence & Stable Working Directory

OpenCode's core ties sessions to the local working directory (`process.cwd()`). If you launch OpenCode from different local folders, your remote sessions appear to "disappear" because OpenCode filters sessions by the current directory.

To fix this, Remote Code ships a launcher strategy that keeps the working directory stable:

#### Launcher Scripts (always works)

Use the provided launcher scripts to always start OpenCode from a **stable local directory** derived from your remote target:

```bash
# Linux / macOS
chmod +x launchers/remote-opencode.sh
./launchers/remote-opencode.sh

# Windows PowerShell
.\launchers\remote-opencode.ps1

# Windows CMD
launchers\remote-opencode.bat
```

The launcher derives a unique local session directory from the remote host + remote workdir:

```
~/.opencode/remote-sessions/<host>_<remote_dir_slug>/
```

This ensures:
- Sessions are always bound to the same stable local path, regardless of where you invoke the launcher.
- Different remote machines / directories get isolated session directories automatically.
- No changes to OpenCode core or plugin code are required.

**Important (V2):** the launcher does **not** configure the remote target — that lives in `opencode.jsonc` plugin `options`. The launcher's only job is to pin the local session directory (and to export the `REMOTE_*` variables as a convenience for `opencode run --standalone`). It prints a reminder on startup, and missing `REMOTE_*` values are **not** an error: it falls back to the `unknown` / `no-workdir` placeholders for the directory name and launches normally.

The launcher also accepts the same values from environment variables or from `--ssh` / `--workdir` command-line arguments (`--ssh` / `--workdir` win over everything; anything else is forwarded to `opencode` unchanged). Values that are not SSH targets — like connection pool tuning — are only read from the environment:

| Variable | Description | Default |
|----------|-------------|---------|
| `REMOTE_POOL_COMMAND_SIZE` | SSH exec connection pool size | `3` |
| `REMOTE_POOL_FILE_SIZE` | SFTP connection pool size | `2` |
| `REMOTE_POOL_STAGGER_MS` | Delay between sequential SSH handshakes | `0` |

The `REMOTE_POOL_*` variables are still read from `process.env` only (they are not plugin options), so in V2 they are subject to the same background-service caveat as the other env vars.

### Tool Strategy: Full Override via Plugin Tools

All seven tools (`shell`, `glob`, `grep`, `read`, `write`, `edit`, `patch`) are implemented as **plugin tools that override built-in tools by name**.

**Tool names are V2-native.** V2's builtin set is `shell` / `patch` / `read` / `write` / `edit` / `glob` / `grep`; V1's `bash` / `apply_patch` **do not exist in V2**, so registering under the old names would silently add two unused tools and leave the real builtins untouched. The implementation file is still `src/tools/bash.ts`, but it exports the tool named `shell`.

Why full overrides instead of hooks for file operations:

- Plugin tool `execute` functions run outside OpenCode’s Effect system. They **cannot access internal services** (`LSP.Service`, `AppFileSystem.Service`, `Bus.Service`).
- This is actually desirable: file-editing plugin tools naturally avoid LSP diagnostics and file-watcher events that would otherwise fire against an incomplete local mirror and leak confusing output to the AI.
- `shell`/`glob`/`grep` must be fully rewritten anyway because their core execution logic (local shell / ripgrep) cannot be repurposed through hooks.
- For `read`/`write`/`edit`/`patch`, we rewrite them to operate on the local mirror and wrap each call with `pull` / `push` SFTP operations.

Registration is via V2's tool editor (the callback must be **synchronous**, `execute` may return a Promise):

```ts
await ctx.tool.transform((editor) => {
  for (const tool of tools) editor.add(tool)
})
```

Each tool declares a plain **JSON Schema** (`input: { type: "object", properties: ..., required: [...], additionalProperties: false }`) — no Zod, no Effect Schema. `execute` returns V2's `{ content, metadata }` shape; V1's `{ title, output }` has no `title` counterpart, so the old title string is carried in `metadata.title`.

### Local Mirror + On-Demand Sync

Only files the AI actually touches are synchronized. The mirror lives at:

```
~/.opencode/mirrors/<host_slug>/<remote_root_slug>/
```

- A `manifest.json` tracks which remote files have local copies.
- `SyncEngine.pullAll()` fetches the manifest’s files from remote to local (SFTP `fastGet`) before a read/edit.
- `SyncEngine.pushAll()` sends them back after a write/edit/patch (SFTP `fastPut`).
- We do not track "dirtiness"; we transfer unconditionally and let SFTP handle what is actually copied.

### Path Mapping

All paths visible to the AI are **remote absolute paths**. The plugin translates them to local mirror paths transparently:

```
Remote:  /home/project/src/main.ts
Local:   ~/.opencode/mirrors/root_192.168.1.3/home_project/home/project/src/main.ts
```

`PathMapper` provides:

- `toLocal(remotePath)` → local mirror path
- `toRemote(localPath)` → remote path
- `isWithinWorkspace(remotePath)` → security boundary check

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  OpenCode V2 Agent Engine + TUI Renderer                    │
│  (unchanged)                                                │
└────────┬────────────────────────┬───────────────────────────┘
         │ calls tools by name    │ loads TUI slots
         ▼                        ▼
┌──────────────────────┐  ┌─────────────────────────────────┐
│  Plugin (V2)         │  │  TUI Plugin                     │
│  Plugin.define({     │  │  (dist/tui.jsx)                 │
│    id, setup })      │  │                                 │
│  dist/index.js       │  │  ┌───────────────────────────┐  │
│                      │  │  │ session_prompt_right      │  │
│  ┌─────────────┐     │  │  │ home_prompt_right         │  │
│  │ Tool Overrides│    │  │  │ → "🌐 Remote: host /path" │  │
│  │ (shell/glob/ │    │  │  └───────────────────────────┘  │
│  │  grep/read/  │    │  └─────────────────────────────────┘
│  │  write/edit/ │    │
│  │  patch)      │    │
│  └──────┬───────┘     │
│         │             │
│         ▼             │
│  ┌─────────────────┐  │
│  │  PathMapper     │  │
│  │  SyncEngine     │  │
│  │  SSHPool        │  │
│  └─────────────────┘  │
└───────────┬───────────┘
            │
            ▼
┌──────────────────────────────────────────────┐
│  Local Mirror FS                             │
│  (read/write/edit/patch operate here)        │
└──────────────────────────────────────────────┘
         │
    SFTP over ssh2 persistent connections
         │
         ▼
┌──────────────────────────────────────────────┐
│  Remote Machine (sshd only)                  │
└──────────────────────────────────────────────┘
```

> Note: this fork only ships the plugin entry point (`dist/index.js`). The TUI-slot
> box above is upstream design with no implementation in this repository — there is no
> `dist/tui.jsx` and no "🌐 Remote: host /path" toolbar indicator here.

The V1 entry point (`{ id, server: async (input, options) => Hooks }`) is gone. V2 uses:

```ts
export default Plugin.define({
  id: "remote-code",
  async setup(ctx) {
    // ... read ctx.options, build mirror/pool, register tools + context hook
    return async () => { /* dispose hooks/tools, save manifest, close pool */ }
  },
})
```

`setup` returning a cleanup function replaces V1's `dispose` / `session.deleted` event handler. Tool registration uses `ctx.tool.transform(editor => editor.add(...))`, permissions use `ctx.permission.assert(...)`, and the system prompt is injected with `ctx.session.hook("context", ...)` (`event.system` is an array of `{ type: "text", text }` parts, not `string[]`).

## Key Implementation Details

### SSH Connection Pools

The plugin uses the pure-Node.js `ssh2` library to maintain persistent SSH connections:

- **Command pool** (3 connections, configurable via `REMOTE_POOL_COMMAND_SIZE`): for `shell`, `glob`, `grep` execution via `exec()`
- **File pool** (2 connections, configurable via `REMOTE_POOL_FILE_SIZE`): for SFTP file transfers via `sftp()`
- Pool sizes are deliberately conservative for legacy SSH servers (e.g. OpenSSH 5.3) that struggle with concurrent handshakes.

No external `ssh`, `sshpass`, or `rsync` binaries are required. Password authentication is handled natively by `ssh2`.

Debug logging is off by default and enabled by `REMOTE_CODE_DEBUG=1`; it automatically turns on once remote mode is active. The log is `~/.opencode/remote-code-debug.log`. The dormant path writes nothing.

### Tool Behaviors

| Tool            | Strategy                                                                                                                                                                                                                      | Sync Trigger                                 |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------- |
| `shell`        | SSH exec; stdout/stderr separated; SSH noise filtered; non-zero exit throws. Falls back to stderr heuristics when the remote shell reports an error but the exit code channel is not usable (rare, depends on ssh2 behavior). | none                                         |
| `glob`        | SSH `rg --files --sortr=modified` (fallback: `find + stat + sort`)                                                                                                                                                        | none                                         |
| `grep`        | SSH `rg --json` (fallback: `grep -rn`)                                                                                                                                                                                    | none                                         |
| `read`        | Read local mirror; binary detection; BOM preserved                                                                                                                                                                            | `pullAll()` before read                    |
| `write`       | Write local mirror; BOM preserved; unified diff preview in permission request                                                                                                                                                 | `pullAll()` if exists, `pushAll()` after |
| `edit`        | Edit local mirror; 9 fallback replacers (full OpenCode native set); per-file lock; BOM preserved; unified diff preview                                                                                                        | `pullAll()` before, `pushAll()` after    |
| `patch` | Apply unified diff OR native OpenCode patch to local mirror; BOM preserved                                                                                                                                                    | `pullAll()` before, `pushAll()` after    |

### Permissions

V1's `ctx.ask({ permission, patterns, always })` does not exist in V2. `src/v2-bridge.ts` exposes `createPermissionGateway(ctx.permission)`, which maps:

| V1 | V2 |
| --- | --- |
| `permission` | `action` |
| `patterns` | `resources` |
| `always` | `save` |
| — | `sessionID` (required, from the tool call context) |
| — | `source: { type: "tool", messageID, id }` |

`read` asks with action `read`; `write` / `edit` / `patch` ask with action `edit` and pass a unified-diff preview in `metadata.diff`.

### System Prompt Injection

V1 replaced the system prompt through `experimental.chat.system.transform` (`output.system: string[]`); V2 has no such hook. Instead `setup` registers `ctx.session.hook("context", ...)` and rewrites `event.system`, which is an array of `{ type: "text", text }` parts — so callers must use `part.text` where V1 used the string directly.

The logic stays equivalent to V1: the remote prompt is built by `buildRemoteSystemPrompt()` (working directory, platform, git flag, model family prompt from `src/prompts/*.txt`, remote `AGENTS.md` if it exists). The model's "You are a title generator" system part is preserved in place and everything else is replaced; a title-only request (a single system part containing that marker) is left untouched so generating a title does not trigger an extra SSH round-trip.

### Concurrency

- `SyncEngine` uses a per-mirror mutex so only one SFTP operation runs at a time.
- `edit` tool uses per-file promise locks so concurrent edits on the same file are serialized.
- `SSHPool` queues SSH exec commands when all connections in the pool are busy.

### Security

- `PathMapper.isWithinWorkspace()` prevents `../` escapes before any filesystem or SSH operation.
- `shell` tool arguments are passed directly to SSH without intermediate shell parsing when possible; if shell features are needed, we rely on the remote shell and escape user-controlled strings.
- Remote file operations are bounded by the SSH user’s permissions; no privilege escalation.

## Technology Stack

- **Runtime**: Node.js / Bun (OpenCode runs on Bun; plugin uses standard `fs`, `child_process`)
- **Plugin API**: `@opencode/plugin` ^2.1.2 (peer dependency)
- **SSH**: `ssh2` (pure Node.js SSH library; bundled)
- **Sync**: SFTP via `ssh2` (no external `rsync` required)
- **Diff**: `diff` (unified diff generation for previews and `patch`)
- **Language**: TypeScript
- **Schema**: hand-written JSON Schema (V2 `Tool.Info.input`); `zod` and `effect` are **not** dependencies
- **TUI Framework**: none in this fork — `@opentui/solid` is not a dependency and no TUI entry point is built (upstream only)
- **JSX**: `"jsx": "preserve"` is kept in `tsconfig.json` for compatibility, but this fork contains no JSX sources

## Open Questions / TODOs

1. **LSP for remote files**: Plugin tools cannot access OpenCode’s LSP service. Remote projects will not get LSP diagnostics. This is acceptable for the primary use case (legacy embedded systems) but may be revisited later via an LSP-over-SSH bridge.
2. ~~Directory reads via `read`~~ **(FIXED)**: `read` now lists directories over SSH (`ls -1pA`) so the full remote directory contents are visible, regardless of the local mirror state.
3. ~~Binary file handling~~ **(FIXED)**: `read` detects binary files by extension blacklist + content heuristic (null bytes or >30% non-printable chars in first 4KB).
4. **Mirror wipe on init**: To avoid stale files from previous sessions confusing the AI, `index.ts` wipes the local mirror base (`rm -rf`) and resets the manifest on every plugin load. This trades caching efficiency for correctness. A future enhancement could implement selective cleanup (remove only files not in the new manifest) or manifest snapshot/restore for rollback.
5. **Concurrent multi-session**: If two local OpenCode sessions target the same remote directory, their mirrors may conflict. The `edit` tool now has per-file locks to prevent concurrent edits on the same file within a single session. Cross-session conflicts still follow "last write wins" semantics.
6. ~~SSH password auth~~ **(FIXED)**: Password auth is supported natively by `ssh2`. Provide the `password` plugin option (or `REMOTE_PASSWORD` in standalone mode) and `ssh2` will authenticate without `sshpass`.
7. **Windows remote targets**: The plugin is developed from a Windows host perspective. Remote Windows with OpenSSH should work for `shell` (PowerShell) but `glob`/`grep` may need remote `findstr` / `rg.exe` adjustments.
8. **V2 background service and env vars**: Documented above — env-based configuration only reliably works under `opencode run --standalone`. There is no plugin-side workaround; `opencode.jsonc` options are the supported path.
9. **`workdir: "/"` boundary bug** (unfixed, `path-mapper.ts`): `isWithinWorkspace()` compares against `remoteRoot + "/"`, so a root workdir treats every path as outside the workspace and asks for permission more often. Use a subdirectory such as `/home/project`.

## Build & Install

### Prerequisites

- Node.js >= 20 (Bun works too)
- OpenCode V2

### Build

```bash
npm install
npm run build
```

`npm run build` runs `tsc` and then `scripts/postbuild.cjs`, which copies `src/prompts/*.txt` to `dist/prompts/` (the runtime loads prompt fragments from there, so a bare `tsc` is not enough).

### Install

Add the plugin to `opencode.jsonc` — either the built local directory or the package name:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "D:/path/to/opencode-remote-code",
      "options": {
        "ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa root@192.0.2.10",
        "workdir": "/home/project",
        "password": "changeme"
      }
    }
  ]
}
```

`package` points at the directory containing `index.js` + `dist/` (or at a published package name). Restart OpenCode (or the background service) after changing the config.

#### How V2 resolves a local plugin directory (measured on v2.1.0)

This is the single most common reason an install "silently does nothing", so read it before reporting a bug:

1. **`package.json` `main` / `exports` are ignored.** For a local path V2 only probes `<dir>/server.js` and `<dir>/index.js` (`PluginModule` → `entrypoint` resolver). Without a root `index.js` the entry is dropped with *no* log line at all — not even `failed to load plugin`. That is why this repo ships a committed root `index.js` shim (`export * from "./dist/index.js"`); `test/plugin-entry.mjs` guards it.
2. **The path must be absolute and on a drive V2 actually probes.** On Windows, a plugin directory on a *different drive* than the project/config is ignored the same silent way (measured: identical copy loads from `C:\…`, never attempted from `D:\…`; a junction on `C:` pointing to `D:` is ignored too, because it is realpath'd). Install a real copy on the same drive you run OpenCode from.
3. **Config `plugins[].options` only reach the plugin when the entry is an object** (`{ "package": …, "options": { … } }`). Auto-discovered plugins under `.opencode/plugins/` get `options: {}`.
4. **Loading is lazy.** `opencode api …` / `opencode debug config` do *not* load plugins; a real `opencode run` (or the TUI) does. Log in the plugin's own `~/.opencode/remote-code-debug.log`, or run `opencode run --standalone --print-logs` and look for `msg="loading plugin"`.

`opencode plugin add` only accepts npm/Git specs, so a local checkout must be listed in `plugins` by hand.

#### Copy install (stable, works across drives)

Referencing the checkout directly is fine while it lives on the same drive as OpenCode. For a stable install, copy the built artifacts next to the global config and install the runtime deps there:

```powershell
$dst = "$env:USERPROFILE\.config\opencode\remote-code"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item <repo>\index.js,<repo>\package.json -Destination $dst
Copy-Item <repo>\dist -Destination $dst -Recurse
Copy-Item <repo>\launchers -Destination $dst -Recurse
cd $dst; npm install --omit=dev   # ssh2 + diff (peer dep @opencode/plugin comes from the host)
```

Then point `plugins[].package` at `$dst`. Do **not** put the copy under `~/.config/opencode/plugins/` — that directory is auto-discovered, so the plugin would load twice (once without options).

Unconfigured (`options.ssh` absent and no `REMOTE_SSH`) → plugin dormant, local mode: no tools, no SSH, no files written.

### Usage with Launcher

1. Copy `launchers/remote-opencode.sh` (or `.ps1` / `.bat`) to a location in your `$PATH`.
2. Configure the remote target in `opencode.jsonc` (see above). The launcher's config block only exists to derive the stable local session directory; the values may also come from environment variables or launcher arguments.
3. Run the launcher instead of `opencode` directly. It `cd`s into `~/.opencode/remote-sessions/<host>_<remote_dir_slug>/` and starts OpenCode there. The exported `REMOTE_*` variables only take effect for `opencode run --standalone`.

## Testing

### Local test suite (default, no remote host needed)

```bash
npm run build                  # the suites import from dist/
node test/run-tests.mjs        # everything: ~35s
node test/run-tests.mjs --skip-slow   # skips the ssh-pool timer suite (~25s of it)
```

It runs three things:

1. **Standalone unit suites**, spawned as child processes: `test/path-mapper.mjs` (mirror path mapping, `workdir: "/"` boundaries) and `test/ssh-pool-lifecycle.mjs` (no leaked timers on a failed connect, idempotent `close()`, queued `acquire()` callers get rejected). Each is also runnable on its own.
2. **Mock-server conformance checks** against a real local SSH server started in-process (`ssh2.Server`, password auth only, real SFTP).
3. **V2 plugin smoke test** — loads `dist/index.js` with a fake V2 context and asserts the seven tools register and `shell` really executes over SSH.

Output looks like:

```
total: PASS=42 FAIL=0 SKIP=0 (34.4s)
RESULT: PASS
```

### Real-host test suites (legacy, optional)

These two suites talk to an actual SSH target and require a `.env.test` (gitignored) with `REMOTE_SSH`, `REMOTE_WORKDIR`, `REMOTE_PASSWORD`, `REMOTE_SUDO_PASSWORD`:

```bash
npx tsx src/test-e2e.ts        # full tool coverage
npx tsx src/test-extended.ts   # strict assertions, BOM, diff, security
```

Both fail early with a clear message if `REMOTE_SSH` is missing. They still use the V1-style env vars because they run as plain scripts, not inside OpenCode.

### What Each Suite Covers

| Suite                | Focus                                                                                                                                                                                                              |
| :------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/run-tests.mjs` | Mock SSH server (auth, exec, SFTP, path-traversal guard) + plugin smoke: `setup(ctx)`, `tool.transform` registration, `shell` over the mock server, cleanup |
| `test-e2e.ts`      | Connection pools, shell/glob/grep/read/write/edit/patch/sync/health — broad functional coverage                                                                                                                    |
| `test-extended.ts` | BOM preservation, unified diff format, strict content matching, patch move,`isWithinWorkspace` boundary security, `quoteShell` injection safety, read pagination, glob brace expansion, edit replacer fallback |

### Test Artifacts

Temporary files created during debugging (e.g. `tmp_test_*.js`) should be placed in `tmp_test_artifacts/` (already gitignored via `tmp_*`).
