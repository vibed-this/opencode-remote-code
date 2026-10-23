# Launcher for OpenCode with the Remote Code plugin (PowerShell, plugin 3.x, OpenCode V2).
#
# The remote target is configured ONLY by the plugin `options` in
# `opencode.jsonc`:
#
#   "plugins": [{
#     "package": "C:/Users/you/.config/opencode/remote-code",
#     "options": {
#       "ssh": "ssh -p 48713 you@192.0.2.10",
#       "workdir": "C:/Users/you/project",   // optional: defaults to the login home
#       "password": "changeme"
#     }
#   }]
#
# Since 3.0.0 the REMOTE_* environment variables were deleted (the plugin runs
# inside a shared background service that does not inherit your shell, so they
# were never reliable). Nothing here can configure the remote — see AGENTS.md
# and MIGRATION-V3.md.
#
# What this script does: it pins a stable local working directory derived from
# the remote target, so OpenCode sessions do not "disappear" when you launch
# from different folders (OpenCode binds sessions to process.cwd()).
#
# Usage:
#   1. Optionally edit the "User Configuration" block below.
#   2. Run: .\remote-opencode.ps1
#      or: .\remote-opencode.ps1 --ssh "ssh user@192.0.2.10" --workdir C:/Users/x/proj
#
# --ssh / --workdir win over environment variables; unparsed arguments are
# forwarded to opencode unchanged. Both values are used for the session
# directory name only (the workdir may be a Windows or a POSIX remote path).

# ==========================
# === User Configuration ===
# ==========================
# Optional. The remote itself is configured in `opencode.jsonc`; the values
# below only decide the local session directory.
#
# Uncomment and edit to pin a target here instead of using the environment.
# 192.0.2.0/24 is the RFC 5737 documentation range (never a real device) and
# "changeme" is an obvious placeholder. YOU MUST REPLACE THESE VALUES.
#
# $REMOTE_SSH = "ssh -p 48713 user@192.0.2.10"
# $REMOTE_WORKDIR = "C:/Users/x/project"
# $REMOTE_PASSWORD = "changeme"

$REMOTE_SSH = $env:REMOTE_SSH
$REMOTE_WORKDIR = $env:REMOTE_WORKDIR
$REMOTE_PASSWORD = $env:REMOTE_PASSWORD
# ==========================

# Connection pool sizing is a plugin option now (`options.pool` = { command,
# file, stagger }); it is no longer read from the environment.

# Remote workdir -> ONE directory-name-safe token.
#
#   /home/x/proj           -> home_x_proj
#   C:/Users/x/proj        -> C_Users_x_proj
#   C:\Users\x\my proj     -> C_Users_x_my_proj
#   /                      -> ""            (caller falls back to "root")
#
# Rules: backslashes become "/", a leading drive colon is dropped, every run of
# characters outside [A-Za-z0-9._-] collapses to a single "_", and leading /
# trailing "_" are removed.
function Get-WorkdirSlug {
    param([string]$Path)

    if (-not $Path) { return "" }
    $slug = $Path.Replace('\', '/')
    $slug = $slug -replace '^([A-Za-z]):', '$1'
    $slug = $slug -replace '[^A-Za-z0-9._-]+', '_'
    $slug = $slug -replace '^_+', ''
    $slug = $slug -replace '_+$', ''
    return $slug
}

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
    $dirSlug = Get-WorkdirSlug $REMOTE_WORKDIR
    if (-not $dirSlug) { $dirSlug = "root" }
}

$sessionDir = Join-Path $env:USERPROFILE ".opencode/remote-sessions/${hostOnly}_${dirSlug}"

New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
Set-Location $sessionDir

# Legacy exports: kept for scripts that still read them. The plugin itself reads
# no environment at all in 3.x, so these cannot activate remote mode. Empty
# values are left unset on purpose.
if ($REMOTE_SSH) { $env:REMOTE_SSH = $REMOTE_SSH }
if ($REMOTE_WORKDIR) { $env:REMOTE_WORKDIR = $REMOTE_WORKDIR }
if ($REMOTE_PASSWORD) { $env:REMOTE_PASSWORD = $REMOTE_PASSWORD }

Write-Host "[remote-opencode] note: the remote is configured in opencode.jsonc plugin options (see AGENTS.md)."
Write-Host "[remote-opencode] session directory: $sessionDir"

& opencode @opencodeArgs
