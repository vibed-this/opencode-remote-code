# Migrating to Remote Code 3.0.0 (from 2.x)

**3.0.0 is a breaking release.** Version 2 could only drive a POSIX remote: `path.posix` was
used for every remote path, commands were built as `cd <cwd> && <cmd>`, and `glob` / `grep` /
`read` shelled out to `rg`, `find`, `grep`, `file`, `dd` and `od`. Version 3 makes the remote
platform a first-class concept (Windows via OpenSSH for Windows + PowerShell 5.1/7, or
Linux/macOS), and that rewrite is why configuration, the mirror layout and several internal
APIs changed.

- Design: [`DESIGN-V3.md`](DESIGN-V3.md) (Chinese), §9.2 is the breaking-change table.
- Behaviour reference: [`AGENTS.md`](AGENTS.md).
- Historical: [`MIGRATION-V2.md`](MIGRATION-V2.md) (V1 → V2 API contract),
  [`PORTING-NOTES.md`](PORTING-NOTES.md) (per-file port log).

---

## 1. Upgrade checklist

1. **Rewrite `options.workdir` if the remote is Windows.** A POSIX `workdir` is now rejected on
   a Windows remote (§3). This is the only change that stops the plugin from working at all.
2. **Delete `sudoPassword`** (and `--remote-sudo-password` / `REMOTE_SUDO_PASSWORD`).
3. **Delete `REMOTE_*` environment variables and `--remote*` arguments** — nothing reads them.
   Move the values into `opencode.jsonc` → `plugins[].options`.
4. **Move `REMOTE_CODE_DEBUG` to `options.debug`** and `REMOTE_POOL_*` to `options.pool`.
5. **Optional:** delete the old mirror cache directories; the new layout does not reuse them.
6. **Optional:** re-read `glob` / `grep` output expectations (§8) — the regex dialect and the
   traversal changed.

The dormant path is unchanged: no `ssh` and no `host` option → no SSH, no tools, no files,
OpenCode runs in local mode exactly as before.

---

## 2. Breaking-change table (DESIGN-V3 §9.2, as implemented)

| V2 | V3 | Action |
| --- | --- | --- |
| `REMOTE_SSH`, `REMOTE_WORKDIR`, `REMOTE_PASSWORD`, `REMOTE_MIRROR` env vars | **deleted** (`src/config.ts` reads only plugin options) | Move the values into `plugins[].options`. The launchers still accept `REMOTE_SSH` / `REMOTE_WORKDIR` to name their local session directory, but they cannot configure the plugin. |
| `REMOTE_SUDO_PASSWORD` env var | **deleted** | (Same row as `sudoPassword` below.) |
| `--remote`, `--remote-ssh`, `--remote-workdir`, `--remote-password`, `--remote-mirror`, `--remote-sudo-password` argv | **deleted** | OpenCode never recognised them anyway. |
| `sudoPassword` / `sudo-password` | **deleted** — the plugin never escalates privileges | Removed from the schema. If the key is still present, `loadConfig()` prints one `console.warn` naming it and continues. |
| `workdir` **required** | **optional** — defaults to the login home | Omit it unless you need a subdirectory. The home is discovered with one SFTP `realpath(".")`. |
| `workdir` must be a POSIX absolute path | **validated per detected platform** | On a Windows remote: drive-absolute only (`C:/Users/me/proj`). `/Users/x` and `C:foo` are rejected with an explicit error (§3). |
| `REMOTE_CODE_DEBUG=1` | `options.debug: true` | Env still honoured as a dev fallback, but in a background service it is usually invisible — use the option. |
| `REMOTE_POOL_COMMAND_SIZE`, `REMOTE_POOL_FILE_SIZE`, `REMOTE_POOL_STAGGER_MS` | `options.pool = { command, file, stagger }` (defaults `3 / 2 / 0`) | Same numbers, new home. |
| Mirror layout `~/.opencode/mirrors/<host_slug>/<remote_root_slug>/` | `<mirrorRoot>/<slug>-<hash6>/<drive-or-root>/<segments…>` | Old caches are **ignored** (different path) and can be deleted. Every start wipes the whole namespace anyway. |
| Manifest `{ remote_root, files: { path: rel } }` | Manifest **v2** `{ version: 2, remoteRoot, files: { path: { local, size, mtime } } }` | No migration: a non-v2 manifest is discarded and files are re-pulled on demand. |
| `SyncEngine.pullAll()` / `pushAll()` (O(n) per tool call) | `ensureLocal()` / `commit()` per file, skipping the transfer when remote `size`+`mtime` match the manifest | Internal; no user action. |
| `SSHPool.exec(cmd, { cwd })` | `SSHPool.exec(command, { timeout, decode })`, where `command` is produced by `RemoteDialect.buildCommand()` (`{ cwd }` is still accepted but deprecated) | Internal only. |
| `PathMapper` (`src/path-mapper.ts`, `outsidePaths` table, POSIX-only) | `src/mirror/path-mapper.ts`, namespace layout, `ops`-driven, `outsidePaths` deleted | Internal; `toLocal` / `toRemote` / `isWithinWorkspace` keep their meaning. |
| `src/test-e2e.ts`, `src/test-extended.ts` | **deleted** | They drove a real POSIX host with `REMOTE_*` env vars. Replaced by the offline suites in `test/` (§7). `.env.test.example` is gone with them. |
| `rg` / `find` / `grep` / `file` / `dd` / `od` / `mkdir -p` / `rm -f` on the remote | all replaced with SFTP + in-process JavaScript | The remote now needs **nothing but `sshd`** — and on Windows, that is the only thing it *can* have. |
| OpenSSH 5.3-era workarounds (`ssh-rsa`/SHA-1 host keys, stderr-based exit-code guessing) | removed; **OpenSSH ≥ 8.0 required** | Very old servers must be upgraded or fronted by a modern jump/tunnel. |

---

## 3. The one required edit: `workdir` and the remote platform

`workdir` used to be a POSIX absolute path, checked with `path.posix.isAbsolute()`. It is now
canonicalised and validated **after** the platform is known:

| Input | POSIX remote | Windows remote |
| --- | --- | --- |
| *(omitted)* | login home, e.g. `/home/zxk` | login home, e.g. `C:/Users/zhouxiaokang` |
| `/Users/zxk/proj` | accepted | **rejected** — drive-less absolute |
| `C:/Users/zhouxiaokang/proj` | rejected (not absolute for POSIX) | accepted |
| `c:/users/x/proj` | n/a | accepted, canonicalised to `C:/users/x/proj` (drive letter uppercased, the rest of the casing preserved) |
| `C:foo` | n/a | **rejected** — drive-relative |
| `proj`, `src/app` | resolved against the login home | resolved against the login home |
| `~`, `~/proj` | resolved against the login home | resolved against the login home |

The Windows rejection message is explicit, because a silently wrong `workdir` would point every
tool at a directory that does not exist:

```
workdir "/Users/me/proj" is not an absolute Windows path: a drive letter is required
(e.g. "C:/Users/me/project"). Drive-relative ("C:foo") and drive-less ("/Users/x") forms
are not supported because their meaning depends on the shell's current drive.
```

**V2 config, Windows remote — broken:**

```jsonc
{ "package": "C:/Users/WIN11/.config/opencode/remote-code",
  "options": { "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
               "workdir": "/Users/zhouxiaokang/proj",      // ← rejected in 3.0.0
               "password": "***" } }
```

**V3 config — fixed:**

```jsonc
{ "package": "C:/Users/WIN11/.config/opencode/remote-code",
  "options": { "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
               "workdir": "C:/Users/zhouxiaokang/proj",
               "password": "***" } }
```

If the platform guess is wrong (a chrooted SFTP server, a container, a non-standard `sftp-server`
build), pin it: `"platform": "windows"` or `"platform": "posix"`. With an explicit `platform` the
detection probe is only used for the home directory, and a probe failure is no longer fatal.

---

## 4. Configuration reference (what a V3 config looks like)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
      "options": {
        // --- target -------------------------------------------------------
        "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",  // or host/port/user/key
        "password": "***",                                // or "key": "C:/Users/me/.ssh/id_ed25519"
        "workdir": "C:/Users/zhouxiaokang/proj",          // optional → login home
        "platform": "auto",                               // auto | windows | posix
        "shell": "auto",                                  // auto | pwsh | powershell | bash | sh

        // --- local side ---------------------------------------------------
        "mirror": "C:/Users/WIN11/.opencode/mirrors",      // optional, this is the default
        "debug": true,                                     // → ~/.opencode/remote-code-debug.log
        "timeout": 120000,                                 // default `shell` tool timeout (ms)
        "ignore": ["node_modules", ".git"],                // EXTENDS the built-in list
        "limits": { "globResults": 100, "searchMatches": 100, "walkDepth": 12 },
        "pool": { "command": 3, "file": 4, "stagger": 0 },

        // --- activation (3.0.1, optional) ---------------------------------
        // Register the remote tools ONLY inside these local directories; every
        // other directory stays dormant, i.e. keeps the native local tools.
        // Absent/empty = always active.
        "activateIn": "~/.opencode/remote-sessions"
      }
    }
  ]
}
```

Every alias and default is listed in [`AGENTS.md`](AGENTS.md#configuration-reference). Two former
env vars are worth calling out because they are easy to forget:

```jsonc
// V2                                   // V3
// REMOTE_CODE_DEBUG=1                  "debug": true
// REMOTE_POOL_COMMAND_SIZE=3           "pool": { "command": 3 }
```

---

## 5. Old mirror caches

```
V2:  ~/.opencode/mirrors/<user_host>/<home_project>/home/project/src/a.ts
V3:  ~/.opencode/mirrors/<user-host-hash6>/root/home/project/src/a.ts     (POSIX remote)
     ~/.opencode/mirrors/<user-host-hash6>/C/Users/x/project/src/a.ts     (Windows remote)
```

The namespace directory is `<user>@<host>` lowercased with every non-alphanumeric run collapsed to
`-`, plus `-` and the first six hex characters of `sha256("user@host:port")`, so two targets with
the same host but different ports or users never collide. The old V2 directories are simply not
looked at any more; delete `~/.opencode/mirrors/*` whenever convenient (a fresh pull costs one
SFTP `stat` per file plus the reads you actually ask for).

`manifest.json` is version 2 and lives inside the namespace. Anything that is not version 2 — the
whole V2 shape included — is ignored and rebuilt.

---

## 6. Deleted/renamed source files (for anyone with a fork or a patch)

| V2 path | V3 |
| --- | --- |
| `src/path-mapper.ts` | `src/mirror/path-mapper.ts` (rewritten) |
| `src/manifest.ts` | `src/mirror/manifest.ts` (manifest v2) |
| `src/sync-engine.ts` | `src/mirror/sync.ts` (per-file) |
| `src/remote-system-prompt.ts` | `src/system-prompt.ts` (pure, no IO) |
| `src/tools/bash.ts` | `src/tools/shell.ts` |
| `src/resolve-git-tool.ts` | deleted (dead code) |
| `src/test-e2e.ts`, `src/test-extended.ts`, `.env.test.example` | deleted |
| — | new: `src/limits.ts`, `src/log.ts`, `src/tools/context.ts`, `src/tools/text.ts`, `src/platform/*`, `src/remote/*` |

`src/shell-quote.ts` survives but is now used by exactly one file (`src/platform/dialect-posix.ts`).

---

## 7. Internal API changes

Only relevant if you import the plugin's internals (nobody should, but forks do):

```ts
// V2
pool.exec("ls -la /home/x", { cwd: "/home/x" })
mapper = new PathMapper({ mirrorRoot, remoteRoot, hostSlug })
await sync.pullAll(); await sync.pushAll()

// V3
const staged = await dialect.buildCommand("ls -la", { cwd: "C:/Users/x", timeout })  // or POSIX
await pool.exec(staged.command, { timeout, decode: (b) => dialect.decode(b) })
await staged.cleanup?.()

mapper = new PathMapper({ mirrorRoot, user, host, port, remoteRoot, ops })  // ops: RemotePathOps
await sync.ensureLocal(remotePath)   // pull one file if remote size+mtime changed
await sync.commit(remotePath)        // push one file, refresh the manifest
await sync.rename(from, to)          // real remote rename (patch "move to")
await sync.remove(remotePath)        // unlink remote + local + manifest entry
```

`SSHPool` itself only lost its path knowledge: `exec` takes a complete command string and never
prefixes `cd`, and `withSftp(fn)` hands out whole SFTP sessions (`remote/fs.ts` owns the
stat/read/write/mkdirp/unlink/rename surface).

---

## 8. Behaviour differences a session will notice

| Area | V2 | V3 |
| --- | --- | --- |
| `shell` description | always "bash" | names the real shell (`bash`, `PowerShell 5.1`, `PowerShell 7 (pwsh)`), so the model stops writing `ls -la` on Windows |
| `glob` | remote `rg --files --sortr=modified`, `find` fallback | bounded SFTP walk (depth 12, 20 000 entries, 100 results), still newest-first, braces supported |
| `grep` | remote `rg --json`, `grep -Ern` fallback | bounded SFTP read + JavaScript `RegExp`; `(?i)` only as a leading flag; 100 matches / 64 MiB / 2 MiB per file / 45 s |
| `grep` result order | rg/find order | walk order (path ascending), **not** mtime |
| binaries | `file`, `dd`+`od` sniff | extension blacklist, then a NUL byte in the first 8 KiB |
| `read` on a directory | `ls -1pA` | SFTP `readdir`; `/` for directories, `@` for symlinks |
| line endings | only `edit` kept CRLF | `write`, `edit` **and** `patch` keep the file's own ending; new files get `\n` |
| exit codes | stderr heuristics for old OpenSSH | channel exit code is authoritative; a timeout is reported separately from a non-zero exit |
| ssh options ssh2 cannot do (`-J`, `-o ProxyCommand`, `-L`, `-R`, `-D`, `-t`) | silently ignored | **hard error** with the alternative spelled out (`ssh -N -L 2222:host:22 jump`, etc.) |
| unknown `-o` / `-F` | ignored silently | one `console.warn` each, then ignored |
| default SSH user | `root` when no `user@` | your local user name (OpenSSH's own default) |
| `workdir: "/"` permission spam | every path counted as "outside" | `contains()` handles the root boundary; `C:/` likewise |
| Windows/macOS remote | unsupported | supported; `glob`/`grep` ignore-name matching becomes case-insensitive |

---

## 9. Verifying the upgrade

```bash
npm run build
node test/run-tests.mjs            # offline: unit suites + mock SSH server + plugin smoke
```

Then, in a real session:

```bash
opencode run --standalone --print-logs "print the remote working directory"
```

- `options.debug: true` writes `~/.opencode/remote-code-debug.log`; the first two lines are
  `Plugin loaded` and the one-line config summary
  `host=…:… user=… auth=password|key|agent workdir=… platform=… mirror=… timeout=…ms pool=…
  debug=on`. Nothing secret (no password, no identity path) is ever logged.
- A misconfigured target prints exactly one `[remote-code] …` line to stderr and stays dormant;
  it never takes OpenCode down.
- `shell` should answer with the platform's own command (`Get-Location` on Windows, `pwd` on
  POSIX) — if the tool description still says `bash` on a Windows remote, an old `dist/` is
  being loaded.

---

## 10. 3.0.1 (additive, no breaking changes)

Everything here is backward compatible; an unchanged 3.0.0 config behaves exactly as before except
for the new defaults below.

| Change | Detail |
| --- | --- |
| **`activateIn`** (new) | Scope activation to local directories. All seven tools are name overrides, so an active plugin means the session has **no** local tools; with `"activateIn": "~/.opencode/remote-sessions"` the plugin registers them only in launcher session directories and stays dormant elsewhere, giving you remote **and** local use from one config. Accepts a string or an array, expands `~`, matches boundary-safely (case-insensitive on Windows only), and treats a missing session directory as *outside*. Absent/empty = always active. |
| Traversal budget | `limits.searchMillis` 20 000 → **45 000 ms**, shared by `grep`'s read loop and the `glob`/`grep` walk. Measured on a tunnelled link: 0.3–0.8 s per SFTP round trip, so 20 s ran out before a large tree was even listed. |
| File pool | `pool.file` 2 → **4**. `walk()` issues up to 8 concurrent `readdir` requests; two connections serialised almost all of them. |
| Ignore list | Adds volume-root noise: `$RECYCLE.BIN`, `System Volume Information`, `Windows.old`, `.pnpm-store`, `.Trash`. A remote workspace is often the login home or a whole drive. |
| Truncation wording | `glob` and `grep` no longer share one sentence: a listing says "Listing…", a search says "Search…". Truncation caused by the **traversal** is now reported separately (`walkTruncated` / `walkReason` on `SearchResult`), so "0 files scanned" no longer masquerades as "the search was too slow". |
| System prompt | Names the remote workspace explicitly, tells the model to pass `path` to `glob`/`grep` instead of walking the root, and states that any absolute path — including other Windows volumes (`D:/`, `F:/`) — is reachable. |
| `describeRemoteConfig` | Adds `scope=always|<paths>` to the logged config summary. |
