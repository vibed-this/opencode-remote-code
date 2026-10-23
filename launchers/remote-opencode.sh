#!/usr/bin/env bash
# Launcher for OpenCode with the Remote Code plugin (plugin 3.x, OpenCode V2).
#
# The remote target is configured ONLY by the plugin `options` in
# `opencode.jsonc`:
#
#   "plugins": [{
#     "package": "/absolute/path/to/opencode-remote-code",
#     "options": {
#       "ssh": "ssh -p 22 user@192.0.2.10",
#       "workdir": "/home/project",          // optional: defaults to the login home
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
#   ./remote-opencode.sh
#   ./remote-opencode.sh --ssh "ssh user@192.0.2.10" --workdir /home/project
#   REMOTE_SSH="ssh user@192.0.2.10" REMOTE_WORKDIR=/home/project ./remote-opencode.sh
#
# --ssh / --workdir win over environment variables; unparsed arguments are
# forwarded to opencode unchanged. Both values are used for the session
# directory name only (the workdir may be a POSIX or a Windows remote path).

set -e

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
# REMOTE_SSH="ssh -p 22 user@192.0.2.10"
# REMOTE_WORKDIR="/home/project"
# REMOTE_PASSWORD="changeme"
REMOTE_SSH="${REMOTE_SSH:-}"
REMOTE_WORKDIR="${REMOTE_WORKDIR:-}"
REMOTE_PASSWORD="${REMOTE_PASSWORD:-}"
# ==========================

# Connection pool sizing is a plugin option now (`options.pool` = { command,
# file, stagger }); it is no longer read from the environment.

# Optional CLI arguments: --ssh <command> / --workdir <path>.
# Anything else is forwarded to opencode.
OPENCODE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh)
      REMOTE_SSH="$2"
      shift 2
      ;;
    --workdir)
      REMOTE_WORKDIR="$2"
      shift 2
      ;;
    --)
      shift
      OPENCODE_ARGS+=("$@")
      break
      ;;
    *)
      OPENCODE_ARGS+=("$1")
      shift
      ;;
  esac
done

# Remote workdir -> ONE directory-name-safe token.
#
#   /home/x/proj           -> home_x_proj
#   C:/Users/x/proj        -> C_Users_x_proj
#   C:\Users\x\my proj     -> C_Users_x_my_proj
#   /                      -> root
#
# Rules: backslashes become "/", a leading drive colon is dropped, every run of
# characters outside [A-Za-z0-9._-] collapses to a single "_", and leading /
# trailing "_" are removed. An empty result is never used as a directory name
# (the caller falls back to a placeholder).
slugify_workdir() {
  printf '%s' "$1" \
    | tr '\\' '/' \
    | sed -e 's#^\([A-Za-z]\):#\1#' \
    | sed -e 's#[^A-Za-z0-9._-][^A-Za-z0-9._-]*#_#g' \
    | sed -e 's#^_*##' -e 's#_*$##'
}

# Derive a stable local session directory from remote config.
# Format: ~/.opencode/remote-sessions/<host>_<remote_dir_slug>
# Missing values are not an error: we still launch, with a placeholder name.
HOST_ONLY=$(printf '%s\n' "$REMOTE_SSH" | grep -oE '[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+' | head -n1 | cut -d'@' -f2 || true)
[ -n "$HOST_ONLY" ] || HOST_ONLY="unknown"

if [ -n "$REMOTE_WORKDIR" ]; then
  DIR_SLUG=$(slugify_workdir "$REMOTE_WORKDIR")
  [ -n "$DIR_SLUG" ] || DIR_SLUG="root"
else
  DIR_SLUG="no-workdir"
fi

SESSION_DIR="$HOME/.opencode/remote-sessions/${HOST_ONLY}_${DIR_SLUG}"

mkdir -p "$SESSION_DIR"
cd "$SESSION_DIR"

# Legacy exports: kept for scripts that still read them. The plugin itself reads
# no environment at all in 3.x, so these cannot activate remote mode. Empty
# values are left unset on purpose.
if [ -n "$REMOTE_SSH" ]; then export REMOTE_SSH; fi
if [ -n "$REMOTE_WORKDIR" ]; then export REMOTE_WORKDIR; fi
if [ -n "$REMOTE_PASSWORD" ]; then export REMOTE_PASSWORD; fi

echo "[remote-opencode] note: the remote is configured in opencode.jsonc plugin options (see AGENTS.md)." >&2
echo "[remote-opencode] session directory: $SESSION_DIR" >&2

exec opencode "${OPENCODE_ARGS[@]}"
