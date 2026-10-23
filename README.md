# 🌐 Remote Code

[中文](README.zh-CN.md)

> **Version 3.0.0 is a breaking release.** Two things changed since 2.x:
>
> 1. The remote may now be **Windows** (OpenSSH for Windows + PowerShell 5.1/7) as well as
>    **Linux / macOS**. All platform knowledge lives in `src/platform/`; the seven tools contain
>    none of it.
> 2. **All configuration moved into the plugin's `options`** in `opencode.jsonc`. The `REMOTE_*`
>    environment variables, the `--remote*` arguments and `sudoPassword` were deleted — V2 runs
>    plugins inside a shared background service that never inherits your shell environment.
>
> Upgrading from 2.x? Read **[MIGRATION-V3.md](MIGRATION-V3.md)** (ten-minute checklist).
> Behaviour reference: **[AGENTS.md](AGENTS.md)**. Design: **[DESIGN-V3.md](DESIGN-V3.md)**
> (Chinese). Historical: **[MIGRATION-V2.md](MIGRATION-V2.md)** (V1→V2 API contract),
> **[PORTING-NOTES.md](PORTING-NOTES.md)** (per-file V1→V2 port log).
>
> Forked from [zz6zz666/opencode-remote-code](https://github.com/zz6zz666/opencode-remote-code).

An OpenCode plugin that lets AI agents operate remote machines over SSH — with **zero footprint**
on the remote side. The remote machine only needs `sshd`; no agent, runtime, or dependency
installation is required.

The AI sees nothing different: it calls `shell`, `glob`, `grep`, `read`, `write`, `edit` and
`patch` exactly as it would locally (those are OpenCode V2's own tool names), and every call lands
on the remote machine.

---

## 💡 Why Remote Code?

I am an analog IC engineer. My daily work relies on the **Cadence IC6.1.7 design suite**, which
runs on an aging **CentOS 6 VM**. The glibc version on CentOS 6 is too old to install any modern
agent tools — Node.js, Python 3.11+, and most modern CLI tools simply won't run.

I need to use OpenCode on my local Windows host to control that VM — automating design flows,
batch-modifying schematic parameters, running simulation scripts. **Remote Code** makes this
possible: the AI thinks it is operating local files, but every command actually executes on that
ancient VM.

![pic](pic.png)

**Not a single file needs to be touched on the VM — only the SSH service must be running.**

| Scenario | Pain point | Remote Code solution |
| :--- | :--- | :--- |
| Legacy VMs (CentOS 6, RHEL 5) | Cannot install modern agents | Only needs SSH |
| Production servers | Strict compliance, no installs | Leaves no trace on remote |
| Embedded / edge devices | No package manager, resource constrained | All logic runs locally |
| **Remote Windows hosts** | You can't install an agent, but OpenSSH ships with Windows | One entry point for POSIX *and* Windows targets |
| Ephemeral containers | Don't want repeated setup | Connect on demand, zero residue |

Since 3.0.0 the same plugin drives a **Windows** target: the remote needs OpenSSH for Windows and
PowerShell (5.1 ships with Windows 10+), and nothing else.

---

## 🔌 Standalone MCP Server

This repository is the **OpenCode plugin** version:
<https://github.com/zz6zz666/opencode-remote-code>

There is also a standalone MCP server version planned for the same GitHub account:
<https://github.com/zz6zz666/mcp-remote-code>

The two projects share the same zero-footprint SSH motivation, but target different workflows:

- **OpenCode plugin**: tightly integrated with OpenCode. It overrides native tools so the remote
  machine is fully masqueraded as the agent workspace. The runtime environment is remote, and
  local directories are intentionally not part of the agent's normal view.
- **MCP server**: exposes namespaced `remote_*` tools to any MCP client. Local and remote work can
  coexist, so an agent can keep local design notes or lookup tables while running remote commands,
  edits, patches, pulls, pushes, and simulations on the SSH target.

---

## 📋 Prerequisites

- **OpenCode V2** (this fork targets `@opencode/plugin` ^2.1.2)
- **Node.js ≥ 20** (or Bun) — for building the plugin
- An **SSH daemon** on the remote machine (the *only* remote requirement)
  - POSIX remote: any `sh`/`bash` login shell
  - Windows remote: **OpenSSH for Windows** + PowerShell 5.1 or 7
- OpenSSH **≥ 8.0** on the server (older servers are no longer supported; the plugin trusts the SSH
  channel exit code instead of guessing from stderr)

> **Note**: the plugin uses the pure-Node.js `ssh2` library internally. You **do not** need to
> install `ssh`, `sshpass` or `rsync` locally, and the remote needs no `rg`, `git`, `node` or
> `python` — `glob`/`grep` are implemented over SFTP in plain JavaScript.

---

## 🚀 Quick start

```bash
# 1. Get the source and build it (the plugin has runtime deps, so a build is required)
git clone https://github.com/zz6zz666/opencode-remote-code.git
cd opencode-remote-code
npm install
npm run build            # tsc + scripts/postbuild.cjs (copies src/prompts → dist/prompts)
```

```jsonc
// 2. Add the plugin to your opencode.jsonc — this is the ONLY place remote mode is configured.
//    Linux / macOS remote:
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-remote-code",
      "options": {
        "ssh": "ssh -p 22 user@192.0.2.10",
        "workdir": "/home/project",   // optional → login home
        "password": "changeme"        // or "key": "~/.ssh/id_ed25519"
      }
    }
  ]
}
```

```jsonc
//    Windows remote (OpenSSH for Windows):
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
        "workdir": "C:/Users/zhouxiaokang/proj",   // drive letter mandatory
        "password": "***"
      }
    }
  ]
}
```

```bash
# 3. Restart OpenCode (or the background service) and use it normally
opencode run "list the files in the working directory and read the README"
```

That's it — no remote installation, no daemon, no state left behind. Optional: run it through a
launcher so sessions stay attached to a stable local directory (see
[Session persistence](#-session-persistence-the-launchers)).

`workdir` may be omitted on both platforms: the plugin discovers the login home with one SFTP
`realpath(".")`. A relative `workdir` (`proj`, `src/app`) or `~` is resolved against that home.

---

## 🔧 Installation details

### How OpenCode V2 resolves a local plugin directory

This is the single most common reason an install "silently does nothing":

1. **`package.json` `main` / `exports` are ignored.** For a local path, V2 only probes
   `<dir>/server.js` and `<dir>/index.js`. Without a root `index.js` the entry is dropped with *no*
   log line at all. This repo therefore ships a committed root `index.js` shim
   (`export * from "./dist/index.js"`).
2. **The path must be absolute and on a drive V2 actually probes.** On Windows, a plugin directory
   on a *different drive* than the project/config is ignored just as silently (measured: the same
   copy loads from `C:\…`, is never attempted from `D:\…`; a junction on `C:` pointing at `D:` is
   ignored too, because it is realpath'd).
3. **`plugins[].options` only reach the plugin when the entry is an object**
   (`{ "package": …, "options": { … } }`). Auto-discovered plugins under `.opencode/plugins/` get
   `options: {}`, which in 3.x means *dormant*, because options are the only configuration source.
4. **Loading is lazy.** `opencode api …` / `opencode debug config` do *not* load plugins; a real
   `opencode run` (or the TUI) does. Turn on `"debug": true` and watch
   `~/.opencode/remote-code-debug.log`, or run `opencode run --standalone --print-logs` and look
   for `msg="loading plugin"`.

`opencode plugin add` only accepts npm/Git specs, so a local checkout must be listed in `plugins`
by hand.

### Copy install (stable, works across drives)

Referencing the checkout directly is fine while it lives on the same drive as OpenCode. For a
stable install, copy the built artifacts next to the global config and install the runtime deps
there:

```powershell
$dst = "$env:USERPROFILE\.config\opencode\remote-code"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item <repo>\index.js,<repo>\package.json -Destination $dst
Copy-Item <repo>\dist -Destination $dst -Recurse
Copy-Item <repo>\launchers -Destination $dst -Recurse
cd $dst; npm install --omit=dev   # ssh2 + diff (the @opencode/plugin peer dep comes from the host)
```

Then point `plugins[].package` at `$dst`. Do **not** put the copy under
`~/.config/opencode/plugins/` — that directory is auto-discovered, so the plugin would load twice
(once without options, i.e. dormant).

POSIX hosts use the same steps with `cp -r` instead of `Copy-Item`.

---

## 🎯 Configuration

Remote mode is activated by the plugin's **`options`**, and by nothing else: no environment
variables, no argv. With **no** `ssh` and no `host` option the plugin is fully **dormant** — no SSH
connection, no tool registration, no files written, and OpenCode runs in local mode exactly as
before.

A **misconfigured** target (unparseable ssh string, conflicting structured fields, an SSH feature
ssh2 cannot emulate) prints one `[remote-code] …` line to stderr and stays dormant. The plugin
never takes OpenCode down.

### The `ssh` string

`ssh` is a single command string, exactly as you would type it. It is **parsed**, never executed —
`ssh2` does the connecting, and every option ssh2 cannot emulate is a hard error instead of a
silently ignored setting.

```jsonc
"ssh": "ssh -p 2222 -i C:/Users/me/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new me@host"
```

| Supported | Notes |
| :--- | :--- |
| `ssh`, `ssh.exe`, `/usr/bin/ssh`, `C:\…\ssh.exe` | program name is dropped |
| `user@host`, `host`, `user@[::1]` | the positional target |
| `-p 2222`, `-p2222`, `--port 2222`, `--port=2222` | port (default 22) |
| `-i ~/.ssh/id_ed25519`, `-i/path/key`, `--identity <path>` | identity file; `~` expanded locally |
| `-l user`, `-luser` | user |
| `-o Key=Value`, `-oKey=Value` | whitelisted: `StrictHostKeyChecking`, `UserKnownHostsFile`, `ConnectTimeout`, `ServerAliveInterval`, `ServerAliveCountMax`, `HostKeyAlgorithms`, `IdentitiesOnly` |
| `ssh://user@host:2222` | URL form (a password in the URL is rejected, a path in the URL is ignored with a warning) |
| `'…'` / `"…"` | quoted paths with spaces; outside quotes a backslash is literal, so `C:\Users\me\id_rsa` works |

Ignored on purpose: harmless flags (`-4 -6 -A -a -C -f -K -k -N -n -q -s -T -V -v -X -x -Y -y`)
and `-F <config>` (ssh2 does not read `ssh_config` — translate what you need into whitelisted
`-o` options). Unknown `-o` keys are warned about once and dropped.

**Hard errors** (the message spells out the alternative):

| Rejected | Do this instead |
| :--- | :--- |
| `-J`, `-ProxyJump`, `-o ProxyJump=…` | `ssh -N -L 2222:<target-host>:22 <jump-user>@<jump-host>` in another window, then `host: "127.0.0.1"`, `port: 2222` |
| `-o ProxyCommand=…` | bring the proxy up outside the plugin and point `host`/`port` at the local endpoint |
| `-L`, `-R`, `-D`, `-o LocalForward` / `RemoteForward` / `DynamicForward` | start the forward yourself in a separate terminal; the plugin needs none |
| `-t`, `-tt`, `-o RequestTTY` | every remote command runs without a pty; use a real terminal |

Structured form (alternative to the string — use one or the other):

```jsonc
{ "host": "192.0.2.10", "port": 22, "user": "me",
  "key": "C:/Users/me/.ssh/id_ed25519", "password": "***" }
```

If both forms are present and disagree on host / port / user / identity, `loadConfig()` throws
rather than picking a winner.

### Option reference

Aliases are resolved by `OPTION_KEYS` in `src/config.ts` (camelCase canonical, kebab-case accepted).

| Meaning | Option keys | Default |
| :--- | :--- | :--- |
| SSH command string | `ssh`, `sshCommand`, `ssh-command` | — (required unless `host`) |
| Host | `host` | required unless `ssh` |
| Port | `port` | `22` |
| User | `user` | your local OS user name |
| Identity file | `key`, `identityFile`, `identity`, `keyFile`, `key-file`, `identity-file` | none → ssh-agent / password |
| Password | `password` | none |
| Remote workdir | `workdir`, `remoteWorkdir`, `remote-workdir`, `remote_workdir` | login home (SFTP `realpath(".")`) |
| Platform | `platform` | `"auto"` (`auto` \| `windows` \| `posix`) |
| Shell | `shell` | `"auto"` → `pwsh.exe` if found, else `powershell.exe` (Windows); `bash` (POSIX) |
| Local mirror root | `mirror`, `mirrorRoot`, `mirror-root` | `~/.opencode/mirrors` |
| Debug log | `debug` | `false` → `~/.opencode/remote-code-debug.log` |
| Ignore names | `ignore` | **extends** the built-in list (never replaces it) |
| Tool limits | `limits` | see below |
| Default `shell` timeout | `timeout` | `120000` ms |
| Connection pool | `pool` | `{ "command": 3, "file": 4, "stagger": 0 }` |
| Activation scope | `activateIn`, `activate-in` | `[]` = always on; else a local directory (or array) — see [Local and remote in one config](#local-and-remote-in-one-config-activatein) |

`limits` keys and defaults (`src/limits.ts`; numbers may also be written as strings):

| Key | Default | Used by |
| :--- | :--- | :--- |
| `globResults` | `100` | `glob` result cap |
| `searchMatches` | `100` | `grep` match cap |
| `searchBytes` | `67108864` (64 MiB) | `grep` total bytes actually read |
| `searchFileSize` | `2097152` (2 MiB) | `grep` per-file skip threshold |
| `searchMillis` | `45000` | `grep` wall clock + the `glob`/`grep` traversal budget |
| `walkDepth` | `12` | `glob` + `grep` traversal depth |
| `walkEntries` | `20000` | `glob` + `grep` directory entries visited |
| `shellTimeout` | `120000` | `shell` (overridden by the `timeout` option) |

Built-in ignore names (20, matched against the directory *name* at any depth): `node_modules`,
`.git`, `.hg`, `.svn`, `dist`, `build`, `out`, `target`, `.venv`, `venv`, `vendor`, `__pycache__`,
`.next`, `.cache`, `.turbo`, plus the volume-root noise `$RECYCLE.BIN`,
`System Volume Information`, `Windows.old`, `.pnpm-store`, `.Trash`. Matching is case-insensitive
only when the remote is Windows. The last five matter because a remote workspace is often the login
home — or a whole drive — where those trees hold tens of thousands of unrelated entries.

Removed keys still get one loud message: `sudoPassword` → `console.warn` (the plugin never
escalates privileges); `jump` / `proxyJump` / `proxyCommand` → hard error.

### Local and remote in one config (`activateIn`)

All seven tools are **name overrides**, so while the plugin is active the session has **no local file
access at all** — there is no second `read` pointing at your own disk. That is fine for a dedicated
remote config, but it is what makes a single global `opencode.jsonc` awkward: turn the remote on and
your local projects lose their native tools.

`activateIn` scopes activation to **local directories**, so one config can do both:

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/you/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 48713 you@example.com",
        "workdir": "C:/Users/you/proj",
        "password": "***",
        "activateIn": "~/.opencode/remote-sessions"
      }
    }
  ]
}
```

- Inside one of the prefixes → the seven remote tools register as usual.
- Outside → `setup()` logs one line and returns: the plugin is **dormant**, and OpenCode's native
  local tools are exactly what the model sees.
- Accepts a string or an array, expands `~`, ignores trailing separators.
- Matching is **boundary-safe** (`…/remote-sessions-archive` is *not* inside `…/remote-sessions`) and
  case-insensitive on Windows only.
- A missing session directory counts as **outside** — guessing would silently strip a session's local
  tools.
- Absent/empty = always active (the 3.0.0 behaviour).

It pairs with the launchers, which pin a stable local session directory per target
(`~/.opencode/remote-sessions/<host>_<workdir-slug>/`): remote tools inside launcher sessions, native
local tools everywhere else, from **one** config. There is deliberately no `coexist: true` mode that
registers the tools without overriding them — two same-named tools make the model pick one at random
and then run it on the wrong machine.

### Windows remotes and `workdir`

The remote platform is detected with **one SFTP `realpath(".")`**: `/C:/Users/x` → `windows`,
`/home/x` → `posix`. Pin it with `"platform": "windows"` / `"posix"` when detection cannot know
(a chrooted SFTP server, a container).

`workdir` is validated after detection, because the shape rules differ:

| Input | POSIX remote | Windows remote |
| :--- | :--- | :--- |
| omitted | login home | login home |
| `/Users/x/proj` | ok | **error** — drive-less absolute |
| `C:/Users/x/proj` | error — not absolute | ok |
| `c:/users/x/proj` | — | ok → `C:/users/x/proj` (drive uppercased, rest of the casing kept) |
| `C:foo` | — | **error** — drive-relative |
| `proj`, `src/app`, `~`, `~/proj` | joined to the login home | joined to the login home |

The Windows rejection is deliberately explicit:

```
workdir "/Users/me/proj" is not an absolute Windows path: a drive letter is required
(e.g. "C:/Users/me/project"). Drive-relative ("C:foo") and drive-less ("/Users/x") forms
are not supported because their meaning depends on the shell's current drive.
```

---

## 🖥️ Platform support

| | Linux / macOS | Windows (OpenSSH for Windows) |
| :--- | :--- | :--- |
| Detection | `realpath(".")` → `/home/x` | `realpath(".")` → `/C:/Users/x` |
| Shell (`shell` tool only) | `bash`, `cd '<cwd>' && <script>` | `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(UTF-16LE)>` |
| Shell discovery | unchanged (the login shell) | `where.exe pwsh` → PowerShell 7, else PowerShell 5.1 (the floor) |
| Every other tool | SFTP | SFTP (`/C:/…` wire form) |
| Needs on the remote | `sshd` + a POSIX shell | `sshd` (Win32-OpenSSH) + PowerShell 5.1/7 |

The dialect is not cosmetic: it decides the tool description (`Execute commands in <shellName> on
the remote machine.`) and the system-prompt hint, so the model stops writing `ls -la`, `cat` or
`cd x && y` on Windows. Output is decoded as UTF-8 with a whole-stream `gb18030` fallback (a Chinese
Windows emits CP936) and PowerShell's CLIXML error serialisation is scrubbed. Scripts that would
make the command line too long (> 6000 base64 chars) are staged to
`%TEMP%/oc-<hex8>.ps1` over SFTP and deleted afterwards.

---

## ⚙️ How it works

### One invariant, three layers

> **Only `shell` touches the remote shell. `glob`, `grep`, `read`, `write`, `edit` and `patch` are
> pure SFTP.**

That single rule is what makes two platforms affordable:

| Layer | Files | Responsibility |
| :--- | :--- | :--- |
| **Platform** | `src/platform/*` | `RemotePathOps` (POSIX and Windows path semantics), `RemoteDialect` (script → one exec command, byte→text decoding, prompt hint), platform/shell/home detection |
| **Remote** | `src/remote/*` | `RemoteFs` over SFTP, a bounded tree walk, a ripgrep-flavoured glob matcher, the grep engine |
| **Mirror** | `src/mirror/*` | remote↔local namespace mapping, manifest v2, per-file pull/push |

Canonical remote paths are always absolute, `/`-separated, with a drive letter on Windows
(`C:/Users/x/proj/src/a.ts`). Backslashes only appear on *input* and are normalised away
immediately.

### Local mirror

Only files the AI actually touches are mirrored, under a namespace derived from the target:

```
~/.opencode/mirrors/<slug>-<hash6>/<drive-or-root>/<remote segments…>

POSIX    /home/zxk/proj/src/a.ts
      →  ~/.opencode/mirrors/zxk-frp-oil-com-4c1f2a/root/home/zxk/proj/src/a.ts
Windows  C:/Users/zhouxiaokang/proj/src/a.ts
      →  ~/.opencode/mirrors/zhouxiaokang-frp-use-com-9a3d1b/C/Users/zhouxiaokang/proj/src/a.ts
```

`slug` is `user@host` lowercased with every non-alphanumeric run collapsed to `-`; `hash6` is the
first six hex characters of `sha256("user@host:port")`, so the same host on two ports (or two
users) never shares a namespace. The literal `root` (POSIX) and `unc` (UNC paths) tokens keep
in-workspace and out-of-workspace paths on the same rule.

### Sync engine (manifest v2, per file)

`read`, `write`, `edit` and `patch` work on the local mirror and sync **one file at a time** — the
V2-era `pullAll()` / `pushAll()` full-tree passes are gone:

```
ensureLocal(remote)   stat → directory? materialise local dir
                      → missing? create an EMPTY local file
                      → manifest size+mtime match AND local copy exists? skip
                      → else: SFTP readFile → write local → register

commit(remote)        read local → SFTP mkdirp(parent) → writeFile → stat → register → save
```

`manifest.json` (version 2) lives inside the namespace and records `{ local, size, mtime }` per
remote path, with the **remote** file's size/mtime at the last successful transfer. A lost or
foreign manifest costs one re-transfer, nothing else. The whole namespace is wiped on every start
(correctness over caching).

### SSH connections

`ssh2` connection pools, no external binaries:

- **Command pool** (`pool.command`, default 3): `shell` execution plus the one-shot `where.exe pwsh`
  probe.
- **File pool** (`pool.file`, default 4): every SFTP session. It is 4, not 2, because `walk()` issues
  up to 8 concurrent `readdir` requests — over a tunnelled link (0.3–0.8 s per round trip) a
  2-connection pool serialised almost all of that work.
- **`pool.stagger`** (default 0 ms) delays sequential handshakes for servers that dislike bursts.

`"debug": true` appends to `~/.opencode/remote-code-debug.log`; nothing secret is ever logged
(`auth=password|key|agent`, never the password or the identity path).

---

## 📊 Tool matrix

All seven tools are **plugin tools that override OpenCode V2's built-in tools by name** (`shell` /
`patch` / `read` / `write` / `edit` / `glob` / `grep` — V1's `bash` / `apply_patch` do not exist in
V2).

| Tool | Transport | Behaviour | Limits |
| :--- | :--- | :--- | :--- |
| `shell` | SSH exec (dialect) | `workdir` defaults to the workspace root; a timeout is reported as its own failure (`Command timed out after <n>ms`), distinct from a non-zero exit; the exit code is authoritative | `timeout` (default 120 s) |
| `glob` | SFTP walk | `*`, `?`, `**`, `**/`, `{a,b}`, `[abc]`/`[!abc]`; a pattern without `/` matches the basename; backslashes are separators; newest-first (mtime desc) | depth 12 / 20 000 entries / 100 results |
| `grep` | SFTP read | JavaScript `RegExp` dialect; leading `(?i)` / `(?m)` / `(?s)` lifted into flags; `include` is a glob on the walk-relative path; results in walk order, grouped per file as `Line <n>: <text>` | 100 matches / 64 MiB / 2 MiB per file / 45 s |
| `read` | SFTP + mirror | `stat` → directory? `readdir` listing (`/` for dirs, `@` for symlinks) → missing? same-directory "did you mean" → binary gate (NUL in the first 8 KiB + extension blacklist) → `ensureLocal` → read the local copy so it is byte-identical to what `write`/`edit` will see | 2000 lines, 50 KB output, 2000 chars/line |
| `write` | mirror + per-file push | Keeps the file's own line ending (a new file gets `\n`), preserves BOM, shows a unified-diff preview in the permission request | — |
| `edit` | mirror + per-file push | Full OpenCode-native replacer set, per-file lock, CRLF preserved | — |
| `patch` | mirror + per-file push | Native `*** Begin Patch` **or** unified diff; parsed as LF, re-encoded with each target's own ending; "move to" is a real remote rename via SFTP | — |

Truncation is never silent: every budget that trips appends a sentence telling the model to narrow
the pattern or the path, and `glob` prints "No files found" only when the walk genuinely finished.

---

## 🧭 Session persistence: the launchers

OpenCode's core ties sessions to the **local working directory** (`process.cwd()`). Launch OpenCode
from different local folders and your remote sessions appear to "disappear".

`launchers/remote-opencode.{sh,ps1,bat}` pin a **stable local session directory derived from host +
remote workdir**, then start `opencode` there:

```
~/.opencode/remote-sessions/<host>_<workdir-slug>/
```

The launchers **do not configure the remote** — that is `opencode.jsonc` and the plugin `options`.
They accept `--ssh "<ssh command>"` / `--workdir "<remote path>"` (the legacy `REMOTE_SSH` /
`REMOTE_WORKDIR` environment names are still accepted for the same purpose), and those values are
used **only** to name the directory. Unrecognised arguments are forwarded to `opencode` unchanged,
and `--` forwards everything after it. Missing values are not an error: the placeholders `unknown`
and `no-workdir` are used and the launch proceeds.

```bash
# POSIX
cp launchers/remote-opencode.sh ~/bin/remote-opencode && chmod +x ~/bin/remote-opencode
remote-opencode --ssh "ssh -p 22 me@192.0.2.10" --workdir /home/project
```

```powershell
# Windows
Copy-Item launchers\remote-opencode.ps1 $env:USERPROFILE\bin\remote-opencode.ps1
.\remote-opencode.ps1 --ssh "ssh -p 48713 me@192.0.2.10" --workdir C:/Users/me/project
```

The workdir slug digests a Windows path as well as a POSIX one (this is the part that changed in
3.0.0):

| Input | Slug |
| :--- | :--- |
| `/home/x/proj` | `home_x_proj` |
| `C:/Users/x/proj` | `C_Users_x_proj` |
| `C:\Users\x\my proj` | `C_Users_x_my_proj` |
| `D:/a//b///c` | `D_a_b_c` |
| `/` or empty | `root` |

Rules: backslashes → `/`; a leading drive colon is dropped; every run of characters outside
`[A-Za-z0-9._-]` collapses to a single `_`; leading/trailing `_` are removed. A `/` (or a workdir
that slugs to nothing) becomes `root`; a *missing* workdir becomes the placeholder `no-workdir`.

---

## 🔒 Security

- **Path containment**: `PathMapper.toLocal()` throws if a resolved local path escapes the mirror
  namespace; relative and NUL-containing remote paths are rejected; `toRemote()` refuses the
  namespace root. Long mirror paths on a Windows host get the `\\?\` prefix above 250 characters.
- **Workspace boundary**: `RemotePathOps.contains()` is boundary-safe and case-folding on Windows,
  so `C:/Users/X/…` is not mistaken for "outside the workspace". Paths outside the workspace go
  through OpenCode's own permission prompt (`src/v2-bridge.ts` maps V2's `ctx.permission.assert`).
- **Command safety**: the `shell` script is passed to the dialect as *data* — on POSIX only the
  quoted `cwd` is interpolated, on Windows the body only ever travels inside base64.
- **Privilege scope**: remote operations run with the SSH user's permissions; the plugin never
  escalates (that is why `sudoPassword` is gone).
- **No secrets in logs**: `debug` logging records `auth=password|key|agent` and never the password
  or identity path.

---

## ⚠️ Limitations

| Limitation | Impact | Mitigation |
| :--- | :--- | :--- |
| No remote LSP | No language-server diagnostics for remote files (plugin tools cannot reach OpenCode's LSP service) | Acceptable for the primary use case; a future LSP-over-SSH bridge could change it |
| Large file first access | The first `read`/`edit` of a big file pays one SFTP transfer | Later calls skip it when remote `size`+`mtime` are unchanged (manifest v2) |
| SFTP traversal speed | `glob`/`grep` are slower than `rg` on very large trees (by design — one semantics, no remote dependencies) | Budgets + explicit truncation notices; narrow the path or pattern |
| Mixed CP936/UTF-8 output | A single stream mixing UTF-8 cmdlets and GBK native programs cannot be decoded perfectly | Whole-stream fallback; the prompt hint steers the model to native cmdlets |
| Concurrent sessions | Two sessions on the same remote directory share a mirror namespace; across sessions the last write wins | Per-file locks inside a session; use one session per target |
| `patch` delete hunks | A delete hunk writes an empty file instead of unlinking | Known gap (`SyncEngine.remove()` exists); remove the file with `shell` for now |
| UNC paths | Accepted and mirrored under the `unc` token, but untested against a real SMB-backed OpenSSH server | Treat as best-effort |
| Legacy SSH servers | OpenSSH < 8.0 and `ssh-rsa`/SHA-1-only host keys are unsupported | Upgrade the server or front it with a modern tunnel |

---

## 🧪 Testing

```bash
npm run build
node test/run-tests.mjs          # same as: npm test
```

One command runs everything offline: the unit suites as child processes, then — for each requested
remote dialect — an in-process mock SSH server (`ssh2.Server` with password auth and real SFTP), the
mock-server conformance checks and the plugin smoke test. It prints
`total: PASS=… FAIL=… SKIP=…` and exits non-zero on any failure.

| Flag | Effect |
| :--- | :--- |
| `--dialect=posix\|windows\|both` | which remote dialect(s) to exercise (default `both`) |
| `--skip-slow` | skip `test/ssh-pool-lifecycle.mjs` (~25 s of connection timers) |
| `--skip-plugin` | do not load `dist/index.js` (unit + mock-server checks only) |
| `--verbose` | print every SSH/SFTP request and full child-suite output |

Because the dev machine is Windows with a real PowerShell 5.1, the `windows` dialect runs the
plugin's generated `-EncodedCommand` through the real `powershell.exe` while SFTP speaks `/C:/…`
paths over a real directory — the dialect, path mapping, decoding and exit codes are all covered
locally. Every suite can also be run alone (`node test/<suite>.mjs`); see
[`test/README.md`](test/README.md) for the mock's path map and its documented limitations.

---

## 📄 License

MIT
