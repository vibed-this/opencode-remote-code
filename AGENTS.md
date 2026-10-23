# Remote Code — Agent Guide

## Project Overview

Remote Code is an OpenCode plugin that lets AI agents operate on remote machines over SSH, with **zero footprint on the remote side**. The remote machine only needs an SSH daemon — no agent, runtime, or dependency installation.

**Version 3.0.0 is breaking** (see [`MIGRATION-V3.md`](MIGRATION-V3.md)). Two things changed:

1. The remote may now be **Windows** (OpenSSH for Windows, PowerShell 5.1 / 7+) as well as **Linux / macOS**. All platform knowledge lives in `src/platform/`; `src/tools/` contains no platform assumptions at all.
2. All configuration moved into the plugin's **`options`**. `REMOTE_*` env vars, `--remote*` argv and `sudoPassword` were deleted.

This fork targets **OpenCode V2** (`@opencode/plugin` ^2.1.2). Historical documents: [`MIGRATION-V2.md`](MIGRATION-V2.md) (verified V1→V2 API contract) and [`PORTING-NOTES.md`](PORTING-NOTES.md) (per-file V1→V2 port log). The authoritative design for the V3 refactor is [`DESIGN-V3.md`](DESIGN-V3.md) (Chinese).

## Design Decisions

### Configuration: plugin options only

Remote mode is activated by the plugin's **`options`** in `opencode.jsonc`. Nothing else is read — no environment variables, no argv. V2 plugins run inside a **shared background service** process started independently of your shell, so `export REMOTE_SSH=…` is invisible there (`process.env.REMOTE_SSH === undefined`, measured); keeping the fallback only produced "why is my env ignored?" bugs, so 3.0.0 deleted it.

With **no** `ssh` and no `host` option the plugin is fully **dormant**: no SSH connection, no tool registration, no files written, OpenCode runs normally in local mode. This is a hard design requirement, and `loadConfig()` has no side effects on that path (not even a log line).

A **misconfigured** target (unparseable ssh string, conflicting structured fields, an SSH feature ssh2 cannot emulate) throws out of `loadConfig()`; `src/index.ts` catches it, prints one `[remote-code] …` line to stderr and stays dormant. The plugin never crashes the host.

#### Local and remote in one config (`activateIn`)

All seven tools are **name overrides**, so an *active* plugin means the session has **no local file access at all** — there is no second `read` for the local disk. That is fine for a dedicated remote config, but it makes "one global `opencode.jsonc` that also drives my local projects" impossible… unless activation itself is scoped.

`activateIn` scopes activation to **local directories**:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
        "workdir": "C:/Users/zhouxiaokang/",
        "password": "***",
        "activateIn": "~/.opencode/remote-sessions"
      }
    }
  ]
}
```

- The plugin compares `ctx.location.directory` (the session's local working directory, exposed by V2) against the prefixes. Inside → all seven tools register as usual. Outside → `setup()` logs one line and returns, i.e. **dormant**, and OpenCode's native local tools are what the model sees.
- Accepts a string or an array; `~` is expanded; trailing separators are ignored.
- Matching is **boundary-safe** (`…/remote-sessions-archive` is *not* inside `…/remote-sessions`) and case-insensitive on Windows only. A missing/relative `ctx.location.directory` is treated as **outside** — guessing would silently strip a session's local tools.
- Empty/absent = always active, i.e. the historical behaviour.

This pairs with the launchers, which pin a stable session directory per target (`~/.opencode/remote-sessions/<host>_<workdir-slug>/`): remote tools inside launcher sessions, native local tools everywhere else, from one config. It is the *only* clean solution — a `coexist: true` mode (register the tools without overriding) was rejected, because two same-named tools make the model pick one at random and run it on the wrong machine.

#### Linux / macOS remote

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 60007 zxk@frp-oil.com",
        "workdir": "/Users/zxk/proj",
        "password": "***"
      }
    }
  ]
}
```

#### Windows remote (OpenSSH for Windows)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
        "workdir": "C:/Users/zhouxiaokang/proj",
        "password": "***"
      }
    }
  ]
}
```

`workdir` is optional in both cases: omit it and the plugin uses the login home it discovers over SFTP.

### The `ssh` string

`ssh` is a single command string, exactly as a user would type it. It is **parsed**, never executed — `ssh2` does the connecting, and every option that ssh2 cannot emulate is a hard error instead of a silently ignored setting.

Supported:

| Form | Notes |
| --- | --- |
| `ssh`, `ssh.exe`, `/usr/bin/ssh`, `C:\…\ssh.exe` | program name is dropped |
| `user@host`, `host`, `user@[::1]` | the positional target |
| `-p 2222`, `-p2222`, `--port 2222`, `--port=2222` | port (default 22) |
| `-i ~/.ssh/id_ed25519`, `-i/path/key`, `--identity <path>` | identity file; `~` is expanded locally |
| `-l user`, `-luser` | user |
| `-o Key=Value`, `-oKey=Value` | whitelisted, see below |
| `ssh://user@host:2222` | URL form; a password **in the URL** is rejected (it ends up in logs) and a path in the URL is ignored with a warning (that is what `workdir` is for) |
| `'…'` / `"…"` | quoted paths with spaces; outside quotes a backslash is literal, so `C:\Users\me\id_rsa` works |

Whitelisted `-o` keys (everything else is `console.warn`ed once and dropped): `StrictHostKeyChecking`, `UserKnownHostsFile`, `ConnectTimeout`, `ServerAliveInterval`, `ServerAliveCountMax`, `HostKeyAlgorithms`, `IdentitiesOnly`.

Harmless flags that are accepted and ignored: `-4 -6 -A -a -C -f -K -k -N -n -q -s -T -V -v -X -x -Y -y`.
Flags that take an argument and are warned about then skipped: `-b -c -E -e -I -m -O -Q -S -W -w`.
`-F <config>` is warned about and ignored: ssh2 does not read `ssh_config`, so translate what you need into whitelisted `-o` options or the structured form.

Hard errors (with the printed alternatives):

| Rejected | Message says to do this instead |
| --- | --- |
| `-J`, `-ProxyJump`, `-o ProxyJump=…`, `jump` / `proxyJump` option | `ssh -N -L 2222:<target-host>:22 <jump-user>@<jump-host>` in another window, then `host: "127.0.0.1"`, `port: 2222` |
| `-o ProxyCommand=…`, `proxyCommand` option | bring the proxy up outside the plugin (`ssh -W <target-host>:22 …`) and point `host`/`port` at the local endpoint |
| `-L`, `-R`, `-D`, `-o LocalForward` / `RemoteForward` / `DynamicForward` | start the forward yourself in a separate terminal; the plugin needs none |
| `-t`, `-tt`, `-o RequestTTY` | every remote command runs without a pty, so an interactive shell would just hang; use a real terminal |

Structured form (alternative to the string; use one or the other):

```jsonc
{ "host": "frp-use.com", "port": 48713, "user": "zhouxiaokang",
  "key": "C:/Users/WIN11/.ssh/id_ed25519", "password": "***" }
```

If both forms are present and **disagree** on host / port / user / identity, `loadConfig()` throws rather than picking a winner — that is exactly the kind of merge that produces "it connects to the wrong box".

### Remote platforms and `workdir` validation

The remote platform is detected with **one SFTP `realpath(".")`** (see `src/platform/detect.ts`):

| `realpath(".")` | Platform | Default workdir |
| --- | --- | --- |
| `/C:/Users/zhouxiaokang` | `windows` | `C:/Users/zhouxiaokang` |
| `/home/x`, `/Users/x` | `posix` | `/home/x`, `/Users/x` |

`options.platform` (`auto` \| `windows` \| `posix`, default `auto`) pins it. With an explicit platform the probe is only a home lookup, and a probe failure is not fatal.

`workdir` is validated **after** detection, because the shape rules differ:

| Input | POSIX | Windows |
| --- | --- | --- |
| omitted | login home | login home |
| `/Users/x/proj` | ok | **error** (drive-less absolute) |
| `C:/Users/x/proj` | error (not absolute) | ok |
| `c:/users/x/proj` | — | ok → `C:/users/x/proj` (drive uppercased, rest of the casing preserved) |
| `C:foo` | — | **error** (drive-relative) |
| `proj`, `src/app` | joined to the login home | joined to the login home |
| `~`, `~/proj`, `~\proj` | joined to the login home | joined to the login home |

The Windows error is deliberately explicit:

```
workdir "/Users/me/proj" is not an absolute Windows path: a drive letter is required
(e.g. "C:/Users/me/project"). Drive-relative ("C:foo") and drive-less ("/Users/x") forms
are not supported because their meaning depends on the shell's current drive.
```

### Configuration reference

Aliases are resolved by `OPTION_KEYS` in `src/config.ts` (camelCase canonical, kebab-case accepted).

| Meaning | Option keys | Default |
| --- | --- | --- |
| SSH command string | `ssh`, `sshCommand`, `ssh-command` | — (required unless `host`) |
| Host | `host` | required unless `ssh` |
| Port | `port` | `22` |
| User | `user` | the local OS user name (OpenSSH's own default) |
| Identity file | `key`, `identityFile`, `identity`, `keyFile`, `key-file`, `identity-file` | none → ssh-agent / password |
| Password | `password` | none |
| Remote workdir | `workdir`, `remoteWorkdir`, `remote-workdir`, `remote_workdir` | login home |
| Platform | `platform` | `"auto"` (`auto` \| `windows` \| `posix`; anything else throws) |
| Shell | `shell` | `"auto"` → `pwsh.exe` when found, else `powershell.exe` (Windows); `bash` (POSIX) |
| Local mirror root | `mirror`, `mirrorRoot`, `mirror-root` | `~/.opencode/mirrors` |
| Debug log | `debug` | `false` (accepts `true/false`, `1/0`, `"yes"/"no"`, `"on"/"off"`; `REMOTE_CODE_DEBUG=1` is still honoured as a best-effort dev fallback) |
| Ignore names | `ignore` | **extends** the built-in list, never replaces it |
| Tool limits | `limits` | see below |
| Default `shell` timeout | `timeout` | `120000` ms (`limits.shellTimeout`) |
| Connection pool | `pool` | `{ "command": 3, "file": 4, "stagger": 0 }` |
| Activation scope | `activateIn`, `activate-in` | `[]` = always active; otherwise a local directory or array of them (see below) |

`limits` keys and defaults (`src/limits.ts`; numbers may also be given as strings):

| Key | Default | Used by |
| --- | --- | --- |
| `globResults` | `100` | `glob` result cap |
| `searchMatches` | `100` | `grep` match cap |
| `searchBytes` | `67108864` (64 MiB) | `grep` total bytes actually read |
| `searchFileSize` | `2097152` (2 MiB) | `grep` per-file skip threshold |
| `searchMillis` | `45000` | `grep` wall clock, and the `glob`/`grep` traversal budget |
| `walkDepth` | `12` | `glob` + `grep` traversal depth |
| `walkEntries` | `20000` | `glob` + `grep` directory entries visited |
| `shellTimeout` | `120000` | `shell` (overridden by the `timeout` option) |

Built-in ignore names (20, matched against the directory *name* at any depth): `node_modules`, `.git`, `.hg`, `.svn`, `dist`, `build`, `out`, `target`, `.venv`, `venv`, `vendor`, `__pycache__`, `.next`, `.cache`, `.turbo`, plus the volume-root noise `$RECYCLE.BIN`, `System Volume Information`, `Windows.old`, `.pnpm-store`, `.Trash`. Matching is case-insensitive only when the remote is Windows. The last five exist because a remote workspace is often the login home or a whole drive, where those trees hold tens of thousands of unrelated entries that would burn the traversal budget before reaching the project.

Removed keys still get one loud message: `sudoPassword` / `sudo-password` → `console.warn` (it only ever made sense on POSIX and the plugin never escalates); `jump` / `jumpHost` / `proxyJump` / `proxyCommand` → hard error.

### Three layers, one invariant

The invariant that makes two platforms affordable:

> **Only `shell` touches the remote shell. `glob`, `grep`, `read`, `write`, `edit` and `patch` are pure SFTP.**

Everything else follows from it:

| Layer | Files | Responsibility |
| --- | --- | --- |
| **Platform** | `platform/path.ts`, `platform/dialect.ts`, `platform/dialect-posix.ts`, `platform/dialect-windows.ts`, `platform/detect.ts` | `RemotePathOps` (both path dialects), `RemoteDialect` (script → one exec command string + byte→text decoding + a prompt hint), platform/shell/home detection |
| **Remote** | `remote/fs.ts`, `remote/walk.ts`, `remote/glob.ts`, `remote/search.ts` | `RemoteFs` over SFTP, a bounded tree walk, a ripgrep-flavoured glob matcher, and the grep engine |
| **Mirror** | `mirror/path-mapper.ts`, `mirror/manifest.ts`, `mirror/sync.ts` | remote↔local namespace mapping, manifest v2, per-file pull/push |

`src/tools/` and `src/mirror/` are not allowed to use `path.posix`, `quoteShell` or `cd … && …`. `src/shell-quote.ts` is imported by exactly one file: `platform/dialect-posix.ts`.

Canonical remote paths are always **absolute, `/`-separated, with a drive letter on Windows** (`C:/Users/x/proj/src/a.ts`). Backslashes only ever appear on **input** (models type `C:\Users\x`) and are normalised away immediately. `RemotePathOps.toSftp()` converts to the wire form Win32-OpenSSH expects (`/C:/Users/x`); `fromSftp()` converts back (also accepting `\\?\C:\x`).

### Tool Strategy: Full Override via Plugin Tools

All seven tools (`shell`, `glob`, `grep`, `read`, `write`, `edit`, `patch`) are **plugin tools that override built-in tools by name**.

**Tool names are V2-native.** V2's builtin set is `shell` / `patch` / `read` / `write` / `edit` / `glob` / `grep`; V1's `bash` / `apply_patch` do not exist in V2, so registering under the old names would silently add two unused tools and leave the real builtins untouched. The implementation file is `src/tools/shell.ts`.

Why full overrides instead of hooks for file operations:

- Plugin tool `execute` functions run outside OpenCode's Effect system. They **cannot access internal services** (`LSP.Service`, `AppFileSystem.Service`, `Bus.Service`).
- This is actually desirable: file-editing plugin tools naturally avoid LSP diagnostics and file-watcher events that would otherwise fire against an incomplete local mirror and leak confusing output to the AI.
- `shell` / `glob` / `grep` had to be rewritten anyway (their core logic — local shell, ripgrep — cannot be repurposed through hooks).
- `read` / `write` / `edit` / `patch` operate on the local mirror and wrap each call with a per-file pull/push.

Registration is via V2's tool editor (the callback must be **synchronous**, `execute` may return a Promise):

```ts
await ctx.tool.transform((editor) => {
  for (const tool of tools) editor.add(tool)
})
```

Each tool declares a plain **JSON Schema** (`input: { type: "object", properties, required, additionalProperties: false }`) — no Zod, no Effect Schema. `execute` returns V2's `{ content, metadata }` shape; V1's title string lives in `metadata.title`.

### Mirror namespace and per-file sync

```
<mirrorRoot>/<slug>-<hash6>/<drive-or-root>/<remote segments…>

POSIX    /home/zxk/proj/src/a.ts
      →   ~/.opencode/mirrors/zxk-frp-oil-com-4c1f2a/root/home/zxk/proj/src/a.ts
Windows  C:/Users/zhouxiaokang/proj/src/a.ts
      →   ~/.opencode/mirrors/zhouxiaokang-frp-use-com-9a3d1b/C/Users/zhouxiaokang/proj/src/a.ts
UNC      //srv/share/a.ts
      →   …/unc/srv/share/a.ts
```

- `slug` = `user@host` lowercased with every non-alphanumeric run collapsed to `-`; `hash6` = first six hex characters of `sha256("user@host:port")`, so the same host on two ports (or two users) never shares a namespace.
- `<drive-or-root>` is the bare drive letter (`C`), the literal `unc`, or the literal `root` for POSIX. Because in-workspace and out-of-workspace paths follow the identical rule, V2's `outsidePaths` memory table (which existed because `/etc/passwd` and `<root>/etc/passwd` collided) is gone.
- `manifest.json` sits **inside** the namespace (outside the mirrored tree) and records `{ local, size, mtime }` per remote path, where `local` is a *relative* path under the namespace and `size`/`mtime` are the **remote** file's values at the last successful transfer.

`SyncEngine` never transfers a whole tree:

```
ensureLocal(remote)   stat → dir? materialise local dir
                      → missing? create an EMPTY local file (that is how add-file works)
                      → manifest size+mtime match AND local copy exists? skip
                      → else: SFTP readFile → write local → register

commit(remote)        read local → SFTP mkdirp(parent) → writeFile → stat → register → save
```

`remove()` and `rename()` (used by `patch` "move to") are also SFTP-only. The manifest is written atomically (`.tmp` + rename), never throws, and a lost manifest only costs a re-transfer. The whole namespace is wiped on every start (correctness over caching), which is why the wipe happens *before* the manifest is loaded.

### Session persistence: the launchers

OpenCode's core ties sessions to the local working directory (`process.cwd()`). Launch OpenCode from different local folders and your remote sessions appear to "disappear". `launchers/remote-opencode.{sh,ps1,bat}` pin a **stable local session directory derived from host + remote workdir**, so a given target always gets the same directory:

```
~/.opencode/remote-sessions/<host>_<workdir-slug>/
```

They do **not** configure the remote (that is `opencode.jsonc`). They accept `--ssh` / `--workdir` and read `REMOTE_SSH` / `REMOTE_WORKDIR` when you prefer that; both values are used **only** to name the directory. Unrecognised arguments are forwarded to `opencode` unchanged, and `--` forwards everything after it. Missing values are not an error — the placeholders `unknown` / `no-workdir` are used and the launch proceeds.

The workdir slug has to digest a Windows path as well as a POSIX one (this is why the launchers changed in 3.0.0):

| Input | Slug |
| --- | --- |
| `/home/x/proj` | `home_x_proj` |
| `C:/Users/x/proj` | `C_Users_x_proj` |
| `C:\Users\x\my proj` | `C_Users_x_my_proj` |
| `D:/a//b///c` | `D_a_b_c` |
| `/` or empty | `root` |

Rules: backslashes → `/`; a leading drive colon is dropped; every run of characters outside `[A-Za-z0-9._-]` collapses to a single `_`; leading/trailing `_` are removed; an empty result is never used as a directory name (`/` slugs to the empty string in `.sh`/`.ps1` and the caller substitutes `root`; `.bat` substitutes it inline). A *missing* `workdir` — as opposed to `/` — yields the placeholder `no-workdir`. All three launchers implement the same rule (`.sh` uses `tr`/`sed`, `.ps1` a regex chain, `.bat` a `set` substitution table plus collapse/trim loops) — verified to produce identical output on the inputs above.

## Architecture

```
agent (OpenCode V2 engine)  ──calls tools by name──▶  plugin entry: src/index.ts setup()
                                                       │
  ┌────────────────────────────────────────────────────┼──────────────────────────────────────┐
  │ platform/  (only place with platform knowledge)    │                                      │
  │   path.ts            RemotePathOps  posix | windows│                                      │
  │   dialect.ts         buildCommand(script) + decode │                                      │
  │   dialect-posix.ts   cd '<cwd>' && <script>        │                                      │
  │   dialect-windows.ts powershell -EncodedCommand …  │                                      │
  │   detect.ts          realpath(".") → kind/home/shell                                      │
  └───────────────┬────────────────────────────────────┴──────────────────────────────────────┘
                  │
     only `shell` │                             the other six tools
                  ▼                                        │
        ssh2 exec channel (1 command)                      ▼
                  │                            ┌────────────────────────────────┐
                  │                            │ remote/  (pure SFTP)           │
                  │                            │   fs.ts      stat/read/write   │
                  │                            │   walk.ts    bounded BFS       │
                  │                            │   glob.ts    pattern → RegExp  │
                  │                            │   search.ts  grep engine       │
                  │                            └───────────────┬────────────────┘
                  │                                            │ mirror/ (local side)
                  │                                            ▼
                  │                            ┌────────────────────────────────┐
                  │                            │   path-mapper.ts  namespace    │
                  │                            │   manifest.ts     v2 cache     │
                  │                            │   sync.ts         per file     │
                  │                            └───────────────┬────────────────┘
                  │                          SFTP pull/push    │
                  └──────────────────┬─────────────────────────┘
                                     ▼
                       ssh2 SFTP channel (persistent)
                                     ▼
        remote machine:  sshd + (POSIX sh/bash  |  PowerShell 5.1 / 7)
                         nothing else installed, nothing left behind
```

The V1 entry point (`{ id, server: async (input, options) => Hooks }`) is gone. V2 uses:

```ts
export default Plugin.define({
  id: "remote-code",
  async setup(ctx) {
    // loadConfig → detectRemote → RemoteFs/PathMapper/Manifest/Sync → 7 tools + context hook
    return async () => { /* dispose hook/tools, save manifest, close pool */ }
  },
})
```

`setup` returning a cleanup function replaces V1's `dispose` / `session.deleted` handler. Tool registration uses `ctx.tool.transform(editor => editor.add(...))`, permissions use `ctx.permission.assert(...)` (via `src/v2-bridge.ts`), and the system prompt is injected with `ctx.session.hook("context", ...)` (`event.system` is an array of `{ type: "text", text }` parts, not `string[]`). A title-only request (a single system part containing "You are a title generator") is left untouched, so generating a title costs no extra SSH round trip.

## Key Implementation Details

### SSH connection pools

The plugin uses the pure-Node.js `ssh2` library; no external `ssh`, `sshpass` or `rsync` binary is needed, and password auth is native.

- **Command pool** (`options.pool.command`, default 3): `shell` execution, plus the one-shot `where.exe pwsh` probe.
- **File pool** (`options.pool.file`, default 4): every SFTP session. It is 4, not 2, because `walk()` issues up to 8 concurrent `readdir` requests: over a tunnelled link (0.3–0.8 s per round trip) a 2-connection pool serialised almost all of that work.
- `options.pool.stagger` (default 0 ms) delays sequential handshakes for servers that dislike connection bursts.

Pool defaults are deliberately conservative. A pool whose connect fails rejects all waiters and leaves no timers behind (`test/ssh-pool-lifecycle.mjs` guards that).

`options.debug: true` appends to `~/.opencode/remote-code-debug.log` (the directory is created lazily; logging never throws; when disabled `log()` is a no-op). Nothing secret is logged — `auth=password|key|agent`, never the password or the identity path.

### The PowerShell dialect (validated on real PS 5.1 — do not "simplify" this)

The command shape is fixed:

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(UTF-16LE(template))>
```

The template (`src/platform/dialect-windows.ts`), with the user's script embedded **verbatim** (no re-indentation — a here-string terminator must start at column 0):

```powershell
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$OutputEncoding=[Text.Encoding]::UTF8
$global:LASTEXITCODE=0
try {
  Set-Location -LiteralPath 'C:/Users/x/proj'
<script>
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

**Why `-EncodedCommand` and not `-Command "<text>"`:** the script body crosses `cmd.exe`, the SSH channel and PowerShell's own parser. Base64 of UTF-16LE needs no quoting rule at all. The only interpolated value is `cwd`, where single quotes are doubled (`''`).

**Three measured PS 5.1 pitfalls** — each of these was observed, and each explains a line of the template:

1. **An uncaught `Write-Error` turns stderr into CLIXML.** PowerShell serialises the error object (`#< CLIXML <Objs Version=…>…`), source lines included, and the model sees garbage instead of the message. Hence `$ErrorActionPreference='Stop'` + `try/catch` + `[Console]::Error.WriteLine(...)`, which writes the plain message to the *real* stderr. `$ProgressPreference='SilentlyContinue'` covers the other polluter: the first-run "Preparing modules for first use" progress record. `decode()` still scrubs CLIXML defensively (and un-escapes `_x000D__x000A_`) for output produced by other means.
2. **`powershell -Command "cmd /c exit 3"` exits 1, not 3.** The process exit code is lost unless the script re-exits with the native code, hence the explicit `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`.
3. **A trailing `exit 0` discards unflushed output.** On PS 5.1, `exit` tears the host down before the format engine flushes: a bare `Get-Location` prints *nothing* when stdout is redirected. So the success path deliberately ends **without** `exit` — the process exits 0 naturally and the output survives. (Corollary for tests/示例: use `(Get-Location).Path`, not bare `Get-Location`.)

**`[Console]::OutputEncoding=[Text.Encoding]::UTF8`** is what stops `Get-ChildItem` from emitting CP936 for Chinese file names on a Chinese Windows; the client decodes as UTF-8.

**Oversized scripts.** `-EncodedCommand` inflates the script ≈2.67× (UTF-16 + base64) and Windows `exec` runs through `cmd.exe /c` (~8191-character command line), so:

```
base64 length <= 6000  →  -EncodedCommand (one round trip)
otherwise              →  SFTP write <home>/AppData/Local/Temp/oc-<hex8>.ps1 (UTF-8 with BOM)
                       →  powershell.exe … -File "<path>"
                       →  SFTP unlink afterwards (a `cleanup` callback the shell tool runs in a `finally`)
```

**Output decoding** (`RemoteDialect.decode`): decode as UTF-8 first; if the result contains U+FFFD, also decode as `gb18030` and keep whichever has fewer replacement characters; then strip CLIXML. Whole-stream fallback only — a single mixed CP936/UTF-8 stream cannot be recovered perfectly (documented limitation; the mitigation is the prompt hint steering the model towards native cmdlets).

**Shell discovery.** On a Windows remote the plugin probes `where.exe pwsh` — spelled with `.exe` on purpose, because bare `where` inside PowerShell is the `Where-Object` alias. Found → `pwsh.exe` (PS 7, friendlier UTF-8) and the tool describes itself as `PowerShell 7 (pwsh)`; not found → `powershell.exe` and `PowerShell 5.1`. **PS 5.1 is the floor**: it ships with Windows 10+, so it is always assumed to exist. There is no `cmd.exe` dialect, by design.

### Tool behaviours

| Tool | Transport | Behaviour | Limits |
| --- | --- | --- | --- |
| `shell` | SSH exec (dialect) | Description is `Execute commands in <shellName> on the remote machine.`; `workdir` defaults to the workspace root; a timeout is reported as its own failure (`Command timed out after <n>ms`), distinct from a non-zero exit; SSH banner noise is filtered; the exit code is trusted (no stderr heuristics — OpenSSH ≥ 8.0 required) | `timeout` (default 120 s); oversized PS scripts staged as above |
| `glob` | SFTP walk | ripgrep-flavoured matcher: `*`, `?`, `**`, `**/`, `{a,b}`, `[abc]`/`[!abc]`; a pattern without `/` matches the **basename**; backslashes in the pattern are separators; results newest-first (mtime desc, path asc on ties) | depth 12 / 20 000 entries / 100 results |
| `grep` | SFTP read | **JavaScript `RegExp` dialect** (`rg` and `grep -Ern` are gone); leading `(?i)` / `(?m)` / `(?s)` are lifted into flags and are the *only* place inline flags are accepted; `include` is a glob on the walk-relative path; results in **walk order**, grouped per file, `Line <n>: <text>` | 100 matches / 64 MiB read / 2 MiB per file / 45 s |
| `read` | SFTP + mirror | `stat` → directory? `readdir` (dirs get `/`, symlinks get `@`) → missing? `readdir(parent)` for "did you mean" → binary gate (`readPrefix(8 KiB)` NUL, plus an extension blacklist) → `ensureLocal` → read the **local** copy so it is byte-identical to what `write`/`edit` will see | 2000 lines, 50 KB output, 2000 chars/line |
| `write` | mirror + per-file push | Keeps the file's own line ending, a new file gets `\n`; BOM preserved; unified-diff preview in the permission request | — |
| `edit` | mirror + per-file push | 9 fallback replacers (full OpenCode native set), per-file lock, CRLF preserved, whole-line `\r` normalisation via `tools/text.ts` | — |
| `patch` | mirror + per-file push | Native `*** Begin Patch` **or** unified diff; parsed as LF and re-encoded with each target's own ending; "move to" is a **real remote rename** (`SyncEngine.rename`) | — |

Truncation is never silent: every budget that trips appends a sentence telling the model to narrow the pattern or the path, and `glob` prints "No files found" **only** when the walk genuinely finished (`truncationNote()` in `src/tools/context.ts`).

### Permissions

V1's `ctx.ask({ permission, patterns, always })` does not exist in V2. `src/v2-bridge.ts` exposes `createPermissionGateway(ctx.permission)`:

| V1 | V2 |
| --- | --- |
| `permission` | `action` |
| `patterns` | `resources` |
| `always` | `save` |
| — | `sessionID` (required, from the tool call context) |
| — | `source: { type: "tool", messageID, id }` |

`read` asks with action `read`; `write` / `edit` / `patch` ask with action `edit` and pass a unified-diff preview in `metadata.diff`. Only paths **outside** the workspace are asserted explicitly (matching V2 behaviour; V2's default for `external_directory` is allow, so the workspace boundary is the plugin's own job).

### System prompt injection

`src/system-prompt.ts` is a **pure string builder** — the caller has already probed the remote and read `<workdir>/AGENTS.md` over SFTP (≤ 256 KiB, skipped if it contains a NUL byte). No `cat`, no `uname`, no `git rev-parse` (`<workdir>/.git` is a SFTP `stat`).

```
You are powered by the model named …
<env>
  Working directory: C:/Users/zhouxiaokang/proj
  Workspace root folder: C:/Users/zhouxiaokang/proj
  Platform: windows
  Shell: PowerShell 5.1 (use PowerShell syntax; path separators may be /)
  Is directory a git repo: yes
  Today's date: …
</env>
```

On Windows a dialect paragraph follows (`RemoteDialect.promptHint()`), which is what stops the model writing `ls -la`, `cat` or `cd x && y`:

```
The remote shell is PowerShell. Prefer native cmdlets (Get-ChildItem, Get-Content,
Select-String, Test-Path, New-Item); `&&` is unavailable, use `;` to chain commands.
Quote paths with single quotes. Paths may use forward slashes.
```

The model's skills section is preserved by searching the system parts from the end (`Skills provide specialized instructions…`), because a tool description earlier in the prompt could contain the same sentence.

### Concurrency

- `SyncEngine` holds a session-wide mutex (the SFTP channel is shared) **and** a per-path mutex; `rename()` takes two path locks in sorted order so two moves cannot deadlock.
- `edit` keeps its own per-file promise lock, so concurrent edits on one file serialise.
- `walk()` runs 8 concurrent `readdir` requests (BFS, so a depth cut removes the deepest entries).
- `searchFiles()` reads a window of files ahead but appends matches in walk order.
- `SSHPool` queues exec commands when every connection is busy.

### Security

- `PathMapper.canonicalRemote()` rejects relative and NUL-containing paths; `toLocal()` throws if a resolved local path escapes the namespace; `toRemote()` refuses the namespace root.
- `RemotePathOps.contains()` is boundary-safe and case-folding on Windows — otherwise `C:/Users/X/...` would be judged "outside the workspace" and prompt forever.
- The `shell` tool's script is passed to the dialect as *data*; on POSIX the only interpolated value is the quoted cwd, on Windows the body only ever travels inside base64.
- Remote file operations are bounded by the SSH user's permissions; the plugin never escalates (that is why `sudoPassword` is gone).
- Long local mirror paths on a Windows host get the `\\?\` prefix above 250 characters (`toRemote()` strips it again).

## Technology Stack

- **Runtime**: Node.js / Bun (OpenCode runs on Bun; the plugin uses standard `fs`/`crypto`)
- **Plugin API**: `@opencode/plugin` ^2.1.2 (peer dependency)
- **SSH/SFTP**: `ssh2` (pure Node.js; bundled) — the only transport, in both directions
- **Diff**: `diff` (unified diff previews for `write`/`edit`/`patch`)
- **Language**: TypeScript
- **Schema**: hand-written JSON Schema (V2 `Tool.Info.input`); `zod` and `effect` are **not** dependencies
- **TUI**: none in this fork — `@opentui/solid` is not a dependency and no TUI entry point is built (upstream only)
- **Remote requirements**: `sshd` only. POSIX: a `sh`/`bash` login shell. Windows: OpenSSH for Windows + PowerShell 5.1 or 7. No `rg`, `git`, `node`, `python` or anything else.

## Open Questions / TODOs

1. **LSP for remote files**: plugin tools cannot access OpenCode's LSP service, so remote projects get no language-server diagnostics. Acceptable for the primary use case; a future LSP-over-SSH bridge could change that.
2. **Concurrent multi-session**: two local sessions on the same remote directory share a mirror namespace. `edit` serialises within a session and `SyncEngine` serialises per path, but across sessions the last write wins, and each `setup()` wipes the namespace for the session that starts last.
3. **`patch` delete hunks** still write an **empty file** instead of unlinking (`src/tools/patch.ts`, `{ type: "delete" }` maps to `apply: () => ""`). `SyncEngine.remove()` exists and would be the correct call — deliberate behaviour change to be scheduled, not a bug in the rewrite.
4. **UNC paths are best-effort**: `//srv/share/x` is accepted and mirrored under the `unc` token, but is untested against a real SMB-backed OpenSSH server.
5. **Mixed CP936/UTF-8 in one stream** (a PS cmdlet writing UTF-8 plus a native program writing GBK) cannot be decoded perfectly; decoding is whole-stream fallback only.
6. **SFTP traversal speed**: `glob`/`grep` are pure SFTP by decision (DESIGN-V3 §14 Q3). On very large trees they are slower than `rg`; the budgets and truncation notices make that visible instead of hanging.
7. **Remote `shell` needs no remote runtime**: worth restating, because it is the whole point — no `bash`-only tooling is assumed anywhere except a POSIX shell existing.
8. **Legacy SSH servers**: OpenSSH < 8.0 (and `ssh-rsa`/SHA-1-only host keys) are no longer supported; the V2 workarounds were deleted on purpose (DESIGN-V3 §12).

## Build & Install

### Prerequisites

- Node.js ≥ 20 (Bun works too)
- OpenCode V2
- A reachable SSH target; for Windows, OpenSSH for Windows

### Build

```bash
npm install
npm run build
```

`npm run build` runs `tsc` and then `scripts/postbuild.cjs`, which copies `src/prompts/*.txt` into `dist/prompts/` (the runtime loads prompt fragments from there, so a bare `tsc` is not enough).

### Install

`package` points at the directory containing `index.js` + `dist/` (or at a published package name). Restart OpenCode (or the background service) after changing the config.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/you/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 22 user@192.0.2.10",
        "workdir": "/home/project",
        "password": "changeme"
      }
    }
  ]
}
```

#### How V2 resolves a local plugin directory (measured on v2.1.0)

This is the single most common reason an install "silently does nothing", so read it before reporting a bug:

1. **`package.json` `main` / `exports` are ignored.** For a local path V2 only probes `<dir>/server.js` and `<dir>/index.js` (`PluginModule` → `entrypoint` resolver). Without a root `index.js` the entry is dropped with *no* log line at all — not even `failed to load plugin`. That is why this repo ships a committed root `index.js` shim (`export * from "./dist/index.js"`); `test/plugin-entry.mjs` guards it.
2. **The path must be absolute and on a drive V2 actually probes.** On Windows, a plugin directory on a *different drive* than the project/config is ignored the same silent way (measured: identical copy loads from `C:\…`, never attempted from `D:\…`; a junction on `C:` pointing to `D:` is ignored too, because it is realpath'd). Install a real copy on the same drive you run OpenCode from.
3. **Config `plugins[].options` only reach the plugin when the entry is an object** (`{ "package": …, "options": { … } }`). Auto-discovered plugins under `.opencode/plugins/` get `options: {}` — which in 3.x means *dormant*, since options are the only configuration source.
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

Then point `plugins[].package` at `$dst`. Do **not** put the copy under `~/.config/opencode/plugins/` — that directory is auto-discovered, so the plugin would load twice (once without options, i.e. dormant).

### Usage with the launcher

1. Copy `launchers/remote-opencode.sh` (or `.ps1` / `.bat`) somewhere on your `$PATH`.
2. Configure the remote target in `opencode.jsonc` (above). The launcher's config block exists only to derive the stable local session directory.
3. Run the launcher instead of `opencode`. It `cd`s into `~/.opencode/remote-sessions/<host>_<workdir-slug>/` and starts OpenCode there, so sessions stay attached to the same local directory no matter where you invoke it from.

## Testing

### Single entry point

```bash
npm run build                  # every suite imports from dist/
node test/run-tests.mjs        # (or: npm test)
```

`node test/run-tests.mjs` is the one command: it wipes `test/tmp/{remote,local,mirror}`, runs the standalone unit suites as child processes, then — **once per requested remote dialect** — starts the in-process mock SSH server (`ssh2.Server`, password auth, real SFTP), runs the mock-server conformance checks and that dialect's plugin smoke test (`plugin-smoke.mjs` for posix, `plugin-smoke-windows.mjs` for windows), and finally prints `total: PASS=… FAIL=… SKIP=…` plus a per-dialect tally. It exits non-zero if anything failed.

Flags:

| Flag | Effect |
| --- | --- |
| `--dialect=posix\|windows\|both` | which dialect(s) to exercise (DESIGN-V3 §11.2; default `both`) — each one gets a fresh `test/tmp` and its own mock server |
| `--skip-slow` | skip `test/ssh-pool-lifecycle.mjs`, which waits ~25 s on connection timers |
| `--skip-plugin` | do not load `dist/index.js` (unit + mock-server checks only) |
| `--verbose` | print every SSH/SFTP request and the full child-suite output |

The dialect matrix lives in the runner, not in the unit suites: those run once and parameterise themselves (`remote-path.mjs` covers both dialects internally). Under the `windows` dialect three POSIX-shaped checks of `verify-mock-server.mjs` (POSIX redirection, `realpath("/")`) are reported as SKIP — they are listed in `POSIX_ONLY_VERIFICATION` in the runner, so a rename in the mock suite cannot silently resurrect them.

Every suite is also runnable alone (`node test/<suite>.mjs`, exit 0 = all PASS):

| Suite | Covers |
| --- | --- |
| `remote-path.mjs` | `RemotePathOps` for both dialects: canonical form, drive case, `..` escape from a drive root, case-insensitive comparison/containment, root boundaries, `toSftp`/`fromSftp` |
| `dialect.mjs` | PS template generation, base64/UTF-16LE, the 6000-char staging split and cleanup, GB18030 fallback, CLIXML scrubbing, exit-code semantics |
| `glob-matcher.mjs` | `*`/`?`/`**`/`{a,b}`/`[..]`, basename-only patterns, backslash separators, case folding, metacharacter escaping |
| `path-mapper.mjs` | namespace layout, `toLocal`↔`toRemote` round trip, workspace boundary, long paths, collision suffixes |
| `remote-walk.mjs` | `walk()` depth/ignore/symlink/entry/time budgets, `searchFiles()` budgets and `(?i)` lifting, `RemoteFs` SFTP error mapping |
| `config-activate.mjs` | `activateIn` parsing/matching (`~`, boundary safety, Windows-only case folding), the `scope=` log field, and the 3.0.1 defaults (45 s, `pool.file` 4, volume-root ignore names) |
| `plugin-entry.mjs` | the root `index.js` shim and V2's directory-entry resolution rules |
| `ssh-pool-lifecycle.mjs` | no leaked timers on a failed connect, process exits by itself, idempotent `close()`, queued waiters rejected |
| `verify-mock-server.mjs` | the mock server itself: password auth, exec stdout/exit codes, SFTP round trips, path-escape protection |
| `plugin-smoke.mjs` | loads `dist/index.js` with a fake V2 context, asserts the seven tools register, drives `shell` over the mock server, calls cleanup |
| `plugin-smoke-windows.mjs` | the same, against a **Windows** remote: real `powershell.exe`, `/C:/…` SFTP, `realpath(".")` → `/C:/Users/test/proj`, detection exercised end to end |
| `spike-windows.mjs` | transport-only proof of the Windows dialect, hand-building the §6.2 command (needs neither `src/` nor `dist/`; not part of the `--dialect` matrix — run it on its own) |

Because the dev machine is Windows with a real PowerShell 5.1, the mock server can emulate Win32-OpenSSH faithfully: `exec` decodes the plugin's `-EncodedCommand`/`-File` command and runs it with the real `powershell.exe`, while SFTP speaks `/C:/…` paths over a real directory. See `test/README.md` for the mock's path map and its documented limitations.

### Test artifacts

Temporary files created while debugging should go in `tmp_test_artifacts/` (gitignored via `tmp_*`). `test/tmp/` is rebuilt from scratch on every run and may be deleted at any time.
