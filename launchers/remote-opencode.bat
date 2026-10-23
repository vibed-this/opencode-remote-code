@echo off
setlocal EnableExtensions
REM Launcher for OpenCode with the Remote Code plugin (Windows CMD, OpenCode V2).
REM
REM IMPORTANT (V2): the real remote configuration lives in opencode.jsonc, under
REM the plugin's "options":
REM
REM   "plugins": [{
REM     "package": "D:/path/to/opencode-remote-code",
REM     "options": {
REM       "ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa user@192.0.2.10",
REM       "workdir": "/home/project",
REM       "password": "changeme"
REM     }
REM   }]
REM
REM V2 plugins run inside a shared BACKGROUND service that does not inherit your
REM shell environment, so setting REMOTE_* here is normally not enough to
REM activate remote mode. Only "opencode run --standalone" (a private service
REM process) inherits these variables. See PORTING-NOTES.md for a working config.
REM
REM What this script still does: it pins a stable local working directory
REM derived from the remote target, so OpenCode sessions do not "disappear" when
REM you launch from different folders (OpenCode binds sessions to process.cwd()).
REM
REM Usage:
REM   remote-opencode.bat
REM   remote-opencode.bat --ssh "ssh user@192.0.2.10" --workdir /home/project
REM
REM --ssh / --workdir win over environment variables; unparsed arguments are
REM forwarded to opencode unchanged.

chcp 65001 >nul

REM ==========================
REM === User Configuration ===
REM ==========================
REM Optional. Prefer the opencode.jsonc plugin options for the actual remote
REM target; the values below only affect the local session directory name and
REM the legacy REMOTE_* exports.
REM
REM Uncomment and edit to pin a target here instead of using the environment.
REM 192.0.2.0/24 is the RFC 5737 documentation range (never a real device) and
REM "changeme" is an obvious placeholder. YOU MUST REPLACE THESE VALUES.
REM
REM set "REMOTE_SSH=ssh -oHostKeyAlgorithms=+ssh-rsa user@192.0.2.10"
REM set "REMOTE_WORKDIR=/home/project"
REM set "REMOTE_PASSWORD=changeme"
REM set "REMOTE_SUDO_PASSWORD=changeme"
REM ==========================

REM SSH connection pool tuning (environment only, uncomment in your shell).
REM These are still read from process.env, so they inherit the same V2 caveat as
REM the REMOTE_* variables above (reliable only with "opencode run --standalone").
REM set "REMOTE_POOL_COMMAND_SIZE=3"
REM set "REMOTE_POOL_FILE_SIZE=2"
REM set "REMOTE_POOL_STAGGER_MS=0"

REM Optional CLI arguments: --ssh ^<command^> / --workdir ^<path^>.
REM Anything else (including everything after "--") is forwarded to opencode.
set "OPENCODE_ARGS="
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--ssh" goto set_ssh
if /i "%~1"=="--workdir" goto set_workdir
if "%~1"=="--" goto forward_rest
set "OPENCODE_ARGS=%OPENCODE_ARGS% %1"
shift
goto parse_args

:forward_rest
shift
:forward_loop
if "%~1"=="" goto args_done
set "OPENCODE_ARGS=%OPENCODE_ARGS% %1"
shift
goto forward_loop

:set_ssh
set "REMOTE_SSH=%~2"
shift
shift
goto parse_args

:set_workdir
set "REMOTE_WORKDIR=%~2"
shift
shift
goto parse_args

:args_done

REM Derive a stable local session directory from remote config.
REM Format: %USERPROFILE%\.opencode\remote-sessions\<host>_<remote_dir_slug>
REM Missing values are not an error: we still launch, with a placeholder name.
set "HOST_ONLY="
if defined REMOTE_SSH for /f "tokens=2 delims=@" %%a in ("%REMOTE_SSH%") do set "HOST_ONLY=%%a"
REM Keep only the first whitespace/colon delimited piece (drops trailing flags or :port)
if defined HOST_ONLY for /f "tokens=1 delims=: " %%a in ("%HOST_ONLY%") do set "HOST_ONLY=%%a"
if not defined HOST_ONLY set "HOST_ONLY=unknown"

if not defined REMOTE_WORKDIR goto no_workdir
set "DIR_SLUG=%REMOTE_WORKDIR:/=_%"
set "DIR_SLUG=%DIR_SLUG:~1%"
if not defined DIR_SLUG set "DIR_SLUG=root"
goto have_slug

:no_workdir
set "DIR_SLUG=no-workdir"

:have_slug
set "SESSION_DIR=%USERPROFILE%\.opencode\remote-sessions\%HOST_ONLY%_%DIR_SLUG%"

if not exist "%SESSION_DIR%" mkdir "%SESSION_DIR%"
cd /d "%SESSION_DIR%"

REM REMOTE_* are exported for compatibility only: they reach the plugin only
REM under "opencode run --standalone". Undefined ones are simply left unset so
REM that a placeholder cannot accidentally activate remote mode. (Variables set
REM with "set" are already part of the child environment.)

echo [remote-opencode] note: remote config lives in opencode.jsonc plugin options (see PORTING-NOTES.md).
echo [remote-opencode] REMOTE_* exports only take effect with "opencode run --standalone".

opencode %OPENCODE_ARGS%
endlocal
