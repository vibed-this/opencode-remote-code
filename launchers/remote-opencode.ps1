# Launcher for OpenCode with the Remote Code plugin (PowerShell, OpenCode V2).
#
# IMPORTANT (V2): the real remote configuration lives in `opencode.jsonc`, under
# the plugin's `options`:
#
#   "plugins": [{
#     "package": "D:/path/to/opencode-remote-code",
#     "options": {
#       "ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa user@192.0.2.10",
#       "workdir": "/home/project",
#       "password": "changeme"
#     }
#   }]
#
# V2 plugins run inside a shared BACKGROUND service that does not inherit your
# shell environment, so setting REMOTE_* here is normally not enough to activate
# remote mode. Only `opencode run --standalone` (a private service process)
# inherits these variables. See PORTING-NOTES.md for a working config.
#
# What this script still does: it pins a stable local working directory derived
# from the remote target, so OpenCode sessions do not "disappear" when you launch
# from different folders (OpenCode binds sessions to process.cwd()).
#
# Usage:
#   1. Optionally edit the "User Configuration" block below.
#   2. Run: .\remote-opencode.ps1
#      or: .\remote-opencode.ps1 --ssh "ssh user@192.0.2.10" --workdir /home/project
#
# --ssh / --workdir win over environment variables; unparsed arguments are
# forwarded to opencode unchanged.

# ==========================
# === User Configuration ===
# ==========================
# Optional. Prefer the `opencode.jsonc` plugin options for the actual remote
# target; these values only affect the local session directory name and the
# legacy REMOTE_* exports.
#
# Uncomment and edit to pin a target here instead of using the environment.
# 192.0.2.0/24 is the RFC 5737 documentation range (never a real device) and
# "changeme" is an obvious placeholder. YOU MUST REPLACE THESE VALUES.
#
# $REMOTE_SSH = "ssh -oHostKeyAlgorithms=+ssh-rsa user@192.0.2.10"
# $REMOTE_WORKDIR = "/home/project"
# $REMOTE_PASSWORD = "changeme"
# $REMOTE_SUDO_PASSWORD = "changeme"

$REMOTE_SSH = $env:REMOTE_SSH
$REMOTE_WORKDIR = $env:REMOTE_WORKDIR
$REMOTE_PASSWORD = $env:REMOTE_PASSWORD
$REMOTE_SUDO_PASSWORD = $env:REMOTE_SUDO_PASSWORD
# ==========================

# SSH connection pool tuning (environment only, uncomment in your shell).
# These are still read from process.env, so they inherit the same V2 caveat as
# the REMOTE_* variables above (reliable only with `opencode run --standalone`).
# $env:REMOTE_POOL_COMMAND_SIZE = 3
# $env:REMOTE_POOL_FILE_SIZE = 2
# $env:REMOTE_POOL_STAGGER_MS = 0

# Optional CLI arguments: --ssh <command> / --workdir <path>.
# Anything else (including everything after "--") is forwarded to opencode.
$opencodeArgs = @()
$forwardOnly = $false
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($forwardOnly) {
        $opencodeArgs += $args[$i]
        continue
    }
    switch -Regex ($args[$i]) {
        '^--ssh$' {
            $REMOTE_SSH = $args[++$i]
        }
        '^--workdir$' {
            $REMOTE_WORKDIR = $args[++$i]
        }
        '^--$' {
            $forwardOnly = $true
        }
        default {
            $opencodeArgs += $args[$i]
        }
    }
}

# Derive a stable local session directory from remote config.
# Format: ~/.opencode/remote-sessions/<host>_<remote_dir_slug>
# Missing values are not an error: we still launch, with a placeholder name.
$hostOnly = "unknown"
if ($REMOTE_SSH) {
    $match = [regex]::Match($REMOTE_SSH, '([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)')
    if ($match.Success) {
        $hostOnly = $match.Groups[2].Value
    }
}

$dirSlug = "no-workdir"
if ($REMOTE_WORKDIR) {
    $dirSlug = $REMOTE_WORKDIR.TrimStart('/') -replace '/', '_'
    if (-not $dirSlug) { $dirSlug = "root" }
}

$sessionDir = Join-Path $env:USERPROFILE ".opencode/remote-sessions/${hostOnly}_${dirSlug}"

New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
Set-Location $sessionDir

# Exported for compatibility only: these reach the plugin only under
# `opencode run --standalone`. Empty values are left unset on purpose so that a
# placeholder cannot accidentally activate remote mode.
if ($REMOTE_SSH) { $env:REMOTE_SSH = $REMOTE_SSH }
if ($REMOTE_WORKDIR) { $env:REMOTE_WORKDIR = $REMOTE_WORKDIR }
if ($REMOTE_PASSWORD) { $env:REMOTE_PASSWORD = $REMOTE_PASSWORD }
if ($REMOTE_SUDO_PASSWORD) { $env:REMOTE_SUDO_PASSWORD = $REMOTE_SUDO_PASSWORD }

Write-Host "[remote-opencode] note: remote config lives in opencode.jsonc plugin options (see PORTING-NOTES.md)."
Write-Host "[remote-opencode] REMOTE_* exports only take effect with 'opencode run --standalone'."

& opencode @opencodeArgs
