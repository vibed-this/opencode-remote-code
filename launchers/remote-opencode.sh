#!/usr/bin/env bash
# Launcher for OpenCode with the Remote Code plugin (OpenCode V2).
#
# IMPORTANT (V2): the real remote configuration lives in `opencode.jsonc`, under
# the plugin's `options`:
#
#   "plugins": [{
#     "package": "/absolute/path/to/opencode-remote-code",
#     "options": {
#       "ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa user@192.0.2.10",
#       "workdir": "/home/project",
#       "password": "changeme"
#     }
#   }]
#
# V2 plugins run inside a shared BACKGROUND service that does not inherit your
# shell environment, so exporting REMOTE_* here is normally not enough to
# activate remote mode. Only `opencode run --standalone` (a private service
# process) inherits these variables. See PORTING-NOTES.md for a working config.
#
# What this script still does: it pins a stable local working directory derived
# from the remote target, so OpenCode sessions do not "disappear" when you
# launch from different folders (OpenCode binds sessions to process.cwd()).
#
# Usage:
#   ./remote-opencode.sh
#   ./remote-opencode.sh --ssh "ssh user@192.0.2.10" --workdir /home/project
#   REMOTE_SSH="ssh user@192.0.2.10" REMOTE_WORKDIR=/home/project ./remote-opencode.sh
#
# --ssh / --workdir win over environment variables; unparsed arguments are
# forwarded to opencode unchanged.

set -e

# ==========================
# === User Configuration ===
# ==========================
# Optional. Prefer the `opencode.jsonc` plugin options for the actual remote
# target; the values below only affect the local session directory name and the
# legacy REMOTE_* exports.
#
# Uncomment and edit to pin a target here instead of using the environment:
#   192.0.2.0/24 is the RFC 5737 documentation range (never a real device),
#   and "changeme" is an obvious placeholder. YOU MUST REPLACE THESE VALUES.
#
# REMOTE_SSH="ssh -oHostKeyAlgorithms=+ssh-rsa user@192.0.2.10"
# REMOTE_WORKDIR="/home/project"
# REMOTE_PASSWORD="changeme"
# REMOTE_SUDO_PASSWORD="changeme"
REMOTE_SSH="${REMOTE_SSH:-}"
REMOTE_WORKDIR="${REMOTE_WORKDIR:-}"
REMOTE_PASSWORD="${REMOTE_PASSWORD:-}"
REMOTE_SUDO_PASSWORD="${REMOTE_SUDO_PASSWORD:-}"
# ==========================

# SSH connection pool tuning (environment only, uncomment in your shell).
# These are still read from process.env, so they inherit the same V2 caveat as
# the REMOTE_* variables above (reliable only with `opencode run --standalone`).
# REMOTE_POOL_COMMAND_SIZE=3
# REMOTE_POOL_FILE_SIZE=2
# REMOTE_POOL_STAGGER_MS=0

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

# Derive a stable local session directory from remote config.
# Format: ~/.opencode/remote-sessions/<host>_<remote_dir_slug>
# Missing values are not an error: we still launch, with a placeholder name.
HOST_ONLY=$(printf '%s\n' "$REMOTE_SSH" | grep -oE '[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+' | head -n1 | cut -d'@' -f2 || true)
[ -n "$HOST_ONLY" ] || HOST_ONLY="unknown"

if [ -n "$REMOTE_WORKDIR" ]; then
  DIR_SLUG=$(printf '%s\n' "$REMOTE_WORKDIR" | sed 's/^\///;s/\//_/g')
  [ -n "$DIR_SLUG" ] || DIR_SLUG="root"
else
  DIR_SLUG="no-workdir"
fi

SESSION_DIR="$HOME/.opencode/remote-sessions/${HOST_ONLY}_${DIR_SLUG}"

mkdir -p "$SESSION_DIR"
cd "$SESSION_DIR"

# Exported for compatibility only: these reach the plugin only under
# `opencode run --standalone`. Empty values are left unset on purpose so that
# a placeholder cannot accidentally activate remote mode.
if [ -n "$REMOTE_SSH" ]; then export REMOTE_SSH; fi
if [ -n "$REMOTE_WORKDIR" ]; then export REMOTE_WORKDIR; fi
if [ -n "$REMOTE_PASSWORD" ]; then export REMOTE_PASSWORD; fi
if [ -n "$REMOTE_SUDO_PASSWORD" ]; then export REMOTE_SUDO_PASSWORD; fi

echo "[remote-opencode] note: remote config lives in opencode.jsonc plugin options (see PORTING-NOTES.md)." >&2
echo "[remote-opencode] REMOTE_* exports only take effect with 'opencode run --standalone'." >&2

exec opencode "${OPENCODE_ARGS[@]}"
