@echo off
setlocal EnableExtensions
REM Launcher for OpenCode with the Remote Code plugin (Windows CMD, plugin 3.x, OpenCode V2).
REM
REM The remote target is configured ONLY by the plugin "options" in
REM opencode.jsonc:
REM
REM   "plugins": [{
REM     "package": "C:/Users/you/.config/opencode/remote-code",
REM     "options": {
REM       "ssh": "ssh -p 48713 you@192.0.2.10",
REM       "workdir": "C:/Users/you/project",   // optional: defaults to the login home
REM       "password": "changeme"
REM     }
REM   }]
REM
REM Since 3.0.0 the REMOTE_* environment variables were deleted (the plugin runs
REM inside a shared background service that does not inherit your shell, so they
REM were never reliable). Nothing here can configure the remote -- see AGENTS.md
REM and MIGRATION-V3.md.
REM
REM What this script does: it pins a stable local working directory derived from
REM the remote target, so OpenCode sessions do not "disappear" when you launch
REM from different folders (OpenCode binds sessions to process.cwd()).
REM
REM Usage:
REM   remote-opencode.bat
REM   remote-opencode.bat --ssh "ssh user@192.0.2.10" --workdir C:/Users/x/proj
REM
REM --ssh / --workdir win over environment variables; unparsed arguments are
REM forwarded to opencode unchanged. Both values are used for the session
REM directory name only (the workdir may be a Windows or a POSIX remote path).

chcp 65001 >nul

REM ==========================
REM === User Configuration ===
REM ==========================
REM Optional. The remote itself is configured in opencode.jsonc; the values
REM below only decide the local session directory.
REM
REM Uncomment and edit to pin a target here instead of using the environment.
REM 192.0.2.0/24 is the RFC 5737 documentation range (never a real device) and
REM "changeme" is an obvious placeholder. YOU MUST REPLACE THESE VALUES.
REM
REM set "REMOTE_SSH=ssh -p 48713 user@192.0.2.10"
REM set "REMOTE_WORKDIR=C:/Users/x/project"
REM set "REMOTE_PASSWORD=changeme"
REM ==========================

REM Connection pool sizing is a plugin option now ("options.pool" = { command,
REM file, stagger }); it is no longer read from the environment.

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

REM Remote workdir -> ONE directory-name-safe token.
REM   /home/x/proj        -> home_x_proj
REM   C:/Users/x/proj     -> C_Users_x_proj
REM   C:\Users\x\my proj  -> C_Users_x_my_proj
REM Rules: backslashes become "/", a leading drive colon is dropped, common
REM unsafe characters become "_", runs of "_" collapse to one, and leading /
REM trailing "_" are removed. An empty result falls back to "root".
set "DIR_SLUG=%REMOTE_WORKDIR%"
set "DIR_SLUG=%DIR_SLUG:\=/%"
if "%DIR_SLUG:~1,1%"==":" set "DIR_SLUG=%DIR_SLUG:~0,1%%DIR_SLUG:~2%"
set "DIR_SLUG=%DIR_SLUG:/=_%"
set "DIR_SLUG=%DIR_SLUG: =_%"
set "DIR_SLUG=%DIR_SLUG::=_%"
set "DIR_SLUG=%DIR_SLUG:@=_%"
set "DIR_SLUG=%DIR_SLUG:+=_%"
set "DIR_SLUG=%DIR_SLUG:&=_%"
set "DIR_SLUG=%DIR_SLUG:(=_%"
set "DIR_SLUG=%DIR_SLUG:)=_%"
set "DIR_SLUG=%DIR_SLUG:[=_%"
set "DIR_SLUG=%DIR_SLUG:]=_%"
set "DIR_SLUG=%DIR_SLUG:{=_%"
set "DIR_SLUG=%DIR_SLUG:}=_%"
set "DIR_SLUG=%DIR_SLUG:;=_%"
set "DIR_SLUG=%DIR_SLUG:,=_%"
set "DIR_SLUG=%DIR_SLUG:!=_%"
set "DIR_SLUG=%DIR_SLUG:'=_%"
set "DIR_SLUG=%DIR_SLUG:`=_%"

:slug_collapse
if not defined DIR_SLUG goto slug_empty
set "SLUG_TMP=%DIR_SLUG:__=_%"
if "%SLUG_TMP%"=="%DIR_SLUG%" goto slug_trim_lead
set "DIR_SLUG=%SLUG_TMP%"
goto slug_collapse

:slug_trim_lead
if not defined DIR_SLUG goto slug_empty
if not "%DIR_SLUG:~0,1%"=="_" goto slug_trim_tail
set "DIR_SLUG=%DIR_SLUG:~1%"
goto slug_trim_lead

:slug_trim_tail
if not defined DIR_SLUG goto slug_empty
if not "%DIR_SLUG:~-1%"=="_" goto have_slug
set "DIR_SLUG=%DIR_SLUG:~0,-1%"
goto slug_trim_tail

:slug_empty
set "DIR_SLUG=root"
goto have_slug

:no_workdir
set "DIR_SLUG=no-workdir"

:have_slug
set "SESSION_DIR=%USERPROFILE%\.opencode\remote-sessions\%HOST_ONLY%_%DIR_SLUG%"

if not exist "%SESSION_DIR%" mkdir "%SESSION_DIR%"
cd /d "%SESSION_DIR%"

REM REMOTE_* are exported for compatibility only: the plugin reads no
REM environment at all in 3.x, so they cannot activate remote mode. Undefined
REM ones are simply left unset. (Variables set with "set" are already part of
REM the child environment.)

echo [remote-opencode] note: the remote is configured in opencode.jsonc plugin options (see AGENTS.md).
echo [remote-opencode] session directory: %SESSION_DIR%

opencode %OPENCODE_ARGS%
endlocal
