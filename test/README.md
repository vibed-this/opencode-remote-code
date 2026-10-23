# 本地测试装置（假 SSH 服务器）

这套脚本用 `ssh2` 的 `Server` 类在本机起一个**真的 SSH 服务器**，把"远端"映射到
`test/tmp/remote` 目录，从而不需要任何真实远程机器就能端到端验证插件。

## 怎么跑

```powershell
npm run build                              # 单元套件 import dist/，必须先构建
node test/run-tests.mjs                    # 总入口：单元套件 → 两种方言各跑一遍（默认 both）
node test/run-tests.mjs --dialect=posix    # 只跑 POSIX 远端
node test/run-tests.mjs --dialect=windows  # 只跑 Windows 远端
node test/run-tests.mjs --verbose          # 打印每条 SSH/SFTP 请求 + 单元套件的完整输出
node test/run-tests.mjs --skip-plugin      # 不起插件（只跑假服务器一致性检查）
node test/run-tests.mjs --skip-slow        # 跳过 ssh-pool 生命周期套件（它要等约 25s 的定时器）

node test/plugin-smoke-windows.mjs   # 只跑 Windows 端到端插件冒烟（自己起服务、自己关）
node test/spike-windows.mjs          # 只跑 Windows 传输层冒烟（不依赖 dist/）
node test/verify-mock-server.mjs     # 只验证假服务器本身（自己起服务、自己关）
node test/remote-path.mjs            # 只跑远端路径规范化/拼接的单元断言
node test/dialect.mjs                # 只跑方言（命令构造/暂存/引号）的单元断言
node test/glob-matcher.mjs           # 只跑 glob 匹配器的单元断言
node test/remote-walk.mjs            # 只跑远端遍历/读取的单元断言
node test/path-mapper.mjs            # 只跑镜像路径映射的单元断言
node test/ssh-pool-lifecycle.mjs     # 只跑连接池生命周期/泄漏断言
```

- 全部通过时 exit 0，否则 exit 1（`--dialect` 写错也是 1，并打印用法）。
- 所有断言只依赖 stdio，不连任何外部服务。
- 默认账号：`testuser` / `testpass`（可用 `MOCK_SSH_USER` / `MOCK_SSH_PASSWORD` 覆盖）。
- 当前基线（Node v26，2026-10-23 实测）：

  | 命令 | 结果 | 用时 |
  | --- | --- | --- |
  | `node test/run-tests.mjs` | `total: PASS=85 FAIL=1 SKIP=3 (36.9s) dialect=both` → `RESULT: FAIL` | ~37s |
  | `node test/run-tests.mjs --dialect=posix --skip-slow` | `total: PASS=46 FAIL=0 SKIP=1 (3.9s) dialect=posix` → `RESULT: PASS` | ~4s |
  | `node test/run-tests.mjs --dialect=windows --skip-slow` | `total: PASS=45 FAIL=0 SKIP=4 (3.8s) dialect=windows` → `RESULT: PASS` | ~4s |
  | `node test/run-tests.mjs --skip-plugin --skip-slow` | `total: PASS=61 FAIL=0 SKIP=6 (4.1s) dialect=both` → `RESULT: PASS` | ~4s |
  | `node test/plugin-smoke-windows.mjs` | `total: PASS=13 FAIL=0 (1.8s)` | ~2s |
  | `node test/spike-windows.mjs` | `PASS=18 FAIL=0` | ~3s |

  全量（含 slow 池生命周期套件）是 `total: PASS=86 FAIL=0 SKIP=3 (37s) dialect=both`。
  那 3 个 SKIP 是 `verify-mock-server.mjs` 里 POSIX 形状的检查（见
  `POSIX_ONLY_VERIFICATION`），它们在 `--dialect=posix` 下照常 PASS。
- 默认方言是 `posix`；`--dialect=both`（默认）会用同一个假服务器实现**先后**跑两遍
  （posix → windows），每遍之前都把 `test/tmp` 整个清空重建，互不干扰。

## 方言矩阵：`--dialect=posix|windows|both`

远端可以是 POSIX（Linux/macOS）或 Windows（Win32-OpenSSH + PowerShell），所以总入口
按**方言**分组跑，而不再是一种方言跑到底：

```
--dialect=posix     只跑 posix：假服务器(dialect:"posix") + verify-mock-server + plugin-smoke
--dialect=windows   只跑 windows：假服务器(dialect:"windows", virtualExecPaths:true)
                                  + verify-mock-server + plugin-smoke-windows
--dialect=both      两遍都跑（默认），顺序 posix → windows
（--dialect all 等价于 both，给将来加第三种方言留的别名）
```

| 阶段 | posix 方言 | windows 方言 | 何时跑 |
| --- | --- | --- | --- |
| 单元套件（`remote-path` / `dialect` / `glob-matcher` / `remote-walk` / `path-mapper` / `plugin-entry`） | 与方言无关 | 与方言无关 | 每次，**只跑一遍** |
| `ssh-pool-lifecycle` | 与方言无关 | 与方言无关 | 每次，`--skip-slow` 时跳过（~25s 都是等定时器） |
| `verify-mock-server`（26 项） | 全部执行 | 执行，其中 3 项按 POSIX 写的断言降级为 SKIP | 每个方言一遍 |
| `plugin-smoke`（12 项） | ✅ | — | 每个方言一遍 |
| `plugin-smoke-windows`（13 项） | — | ✅ | 每个方言一遍 |

窗口方言跳过的是哪 3 项，以及为什么（`run-tests.mjs` 里的 `POSIX_ONLY_VERIFICATION`）：

| 检查 | 为什么在 windows 方言下不成立 |
| --- | --- |
| `exec: non-zero exit code is propagated` | 命令是 POSIX 语法 `echo boom >&2; exit 7`，PowerShell 的 `>&2` 不是这个意思（退出码来自解析错误，不是 7） |
| `exec: stderr is separated from stdout` | 同理，`echo err >&2` 是 POSIX 重定向 |
| `sftp: realpath('/') is the virtual root` | windows 方言下 `/` 的规范形态是 `/C:/Users/test/proj`——这正是平台探测要读的东西，不是缺陷 |

它们在 posix 方言下照常硬断言；windows 方言下打印成 `SKIP`（不是 `PASS`，不掩盖结果），
并在汇总里记一行 note。若哪天 `verify-mock-server.mjs` 改了这几条的名字，
`run-tests.mjs` 会打印 `WARN ... is gone` 而不是静默失灵。

输出约定：banner 和最终汇总行都带方言，例如

```
--- windows dialect: plugin smoke test --------------------------
dialect posix: PASS=40 FAIL=0 SKIP=0 (2.7s)
dialect windows: PASS=38 FAIL=1 SKIP=3 (2.6s)

total: PASS=85 FAIL=1 SKIP=3 (36.9s) dialect=both
RESULT: FAIL (1 failing checks)
```

失败行会带方言前缀（`FAIL [windows] 4. shell propagates a native exit code ...`），
所以两种方言同时跑时也能一眼看出是谁红了。

## 文件

| 文件 | 作用 |
| --- | --- |
| `mock-ssh-server.mjs` | 假 SSH 服务器：密码认证、exec、shell（假）、SFTP 子集；导出 `startMockServer({ dialect, virtualExecPaths })` → `{ port, close(), ... }` |
| `run-tests.mjs` | 总入口：清 `test/tmp`、用子进程跑单元套件、按 `--dialect` 各起一次服务跑 `verify-mock-server` + 对应方言的插件冒烟、汇总 PASS/FAIL/SKIP（带方言标记） |
| `verify-mock-server.mjs` | 用 `ssh2` Client 连自己，验证认证 / exec / SFTP / 路径穿越防护（POSIX 形态，windows 方言下 3 项降级 SKIP） |
| `plugin-smoke.mjs` | POSIX 端到端：用假 V2 `ctx` 加载 `dist/index.js`，断言注册出 7 个工具并在假服务器上真跑一次 `shell` |
| `plugin-smoke-windows.mjs` | **Windows 端到端**：同样加载 `dist/index.js`，在 windows 方言下跑 13 项断言（`platform` 留空以走真实探测 + 一条显式 `platform:"windows"`） |
| `spike-windows.mjs` | Windows **传输层**冒烟：手工拼插件 §6.2 的命令（不依赖 `dist/`），验证 PowerShell exec / 暂存 `-File` / `/C:/...` SFTP 路径空间 |
| `remote-path.mjs` | 远端路径单元断言：规范化、`join`、上/下级判断、windows 长路径前缀、大小写折叠 |
| `dialect.mjs` | 方言单元断言：`buildCommand()` 的 `-EncodedCommand`/`-File` 两条路径、base64 载荷、引号、脚本暂存与清理 |
| `glob-matcher.mjs` | glob 匹配器单元断言：`*` / `**` / `?` / 花括号 / 点文件 / 大小写 |
| `remote-walk.mjs` | 远端遍历与读取单元断言：`readPrefix` 截断、目录列表、`realpath` 探测平台、大文件分片 |
| `path-mapper.mjs` | `PathMapper` 单元断言：`workdir: "/"` 边界、尾斜杠、相对路径报错、`toLocal`↔`toRemote` 往返、镜像基目录互不嵌套 |
| `ssh-pool-lifecycle.mjs` | 连接池生命周期：连不上时不泄漏定时器、进程能自然退出、`close()` 幂等、排队者在 close 时被 reject、`replenish()` 有界终止 |

## `test/tmp` 是临时的

`test/tmp/` 每次运行都会被**整个删掉重建**，里面只有测试数据，随时可以手动删除
（`--dialect=both` 时是**每个方言各重建一次**，所以上一遍的远端文件不会影响下一遍）：

```
test/tmp/remote/       "远端"根目录（exec 的 cwd、SFTP 的 / 都指向这里）
test/tmp/local/        客户端侧的临时文件（上传/下载用）
test/tmp/mirror/       插件本地镜像目录（避免污染 ~/.opencode/mirrors）
test/tmp/drive/        （仅 windows 方言）虚拟 /C:/<其它> 的落盘处，例如 /C:/Temp/x
test/tmp/exec-stage/   （仅 windows 方言）exec 时暂存的 oc-*.ps1（跑完即删）
```

`test/tmp/` 和 `test/.hostkey` 已在 `.gitignore` 里。

## 双方言：`dialect: "posix" | "windows"`

`startMockServer()` 默认 `dialect: "posix"`（Linux/macOS 远端，行为与 V2 逐字节一致，
`verify-mock-server.mjs` / `plugin-smoke.mjs` 一行不改就能跑）。传
`startMockServer({ dialect: "windows" })` 时，同一个进程内模拟的是
**Win32-OpenSSH + PowerShell 5.1 的 Windows 远端**——本机就有真的 PowerShell 5.1，
所以 exec 分支是真跑的，不是桩：

```js
import { startMockServer } from "./mock-ssh-server.mjs"

const server = await startMockServer({ dialect: "windows" })
server.projectSftp // "/C:/Users/test/proj"  ← realpath(".") 的返回值
server.rootDir     // <repo>/test/tmp/remote ← 虚拟 /C:/Users/test/proj 落在这里
server.driveDir    // <repo>/test/tmp/drive  ← 其余 /C:/... 落在这里
server.stagingDir  // <repo>/test/tmp/exec-stage ← exec 暂存 oc-*.ps1
server.powershellPath // "powershell.exe"（除非 options.pwsh 且 PATH 上有 pwsh）
```

### exec 有什么不同

| | posix | windows |
| --- | --- | --- |
| 收到的命令 | `<cmd>` 原样 | `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <b64>` 或 `... -File "<path>"` |
| 怎么执行 | `bash.exe -lc "<cmd>"`，cwd 为远端根 | 解析出脚本文本 → 写到 `test/tmp/exec-stage/oc-*.ps1`（UTF-8 with BOM）→ `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <tmp>` |
| 退出码 | 子进程退出码 | 同左（原样作为 SSH channel exit status） |
| stdout/stderr | 原样透传 | 原样透传（字节不动，所以 UTF-8 不会被二次编码） |

解析规则（`parseWindowsCommand()`）：

1. 命中 `-EncodedCommand\s+(\S+)` → base64 解码 → 按 **UTF-16LE** 解码成脚本；
2. 否则命中 `-File\s+"?([^"]+)"?` → 该路径**先过 SFTP 虚拟映射**再读文件
   （UTF-8，去 BOM）。所以插件把 `.ps1` 放在
   `/C:/Users/test/proj/AppData/Local/Temp/` 下就能被读到；
3. 都不命中 → 整条命令当裸 PowerShell 命令行（所以健康检查
   `exec("echo __SSH_HEALTH_CHECK__")` 照常工作）。

> 为什么不走 `-Command "<脚本>"`：引号地狱。落到临时文件后，脚本内容不经过任何
> 命令行解析（和插件自己对超长脚本的做法一致）。

**exec 看的是真实文件系统**：PowerShell 没法 chroot，脚本里的路径由真 PS 解析。
所以 `C:/Users/test/proj` 在 exec 里并不存在——exec 的 workdir 请用
`server.rootDir`（它就是虚拟项目根指向的真实目录）。若确实需要脚本里直接写虚拟
路径（例如给插件跑 windows 方言的端到端冒烟测试），传
`startMockServer({ dialect: "windows", virtualExecPaths: true })`：mock 会在**暂存
副本**里把 `C:/Users/test/proj` / `/C:/Users/test/proj` 改写成 `server.rootDir`。
默认关闭（= 原样执行解码出的脚本）。`-File` 的路径不用改写，它本来就走虚拟映射。

> **为什么非要 `virtualExecPaths`**：插件发来的脚本文本里写的是**虚拟**路径
> （`Set-Location -LiteralPath 'C:/Users/test/proj'`、暂存目录
> `C:/Users/test/proj/AppData/Local/Temp/oc-xxxx.ps1`），而 `powershell.exe` 只能
> 在**真实**文件系统上执行——exec 通道无法被 chroot（SFTP 可以，exec 不行）。
> 所以只能在"喂给真的 powershell.exe 之前"，在 mock 自己那份暂存副本里做一次字符串
> 改写；插件上传的原始文件一个字节都不动。`run-tests.mjs --dialect=windows` 会自动
> 把它打开（`virtualExecPaths: dialect === "windows"`），单跑
> `node test/plugin-smoke-windows.mjs` 时脚本自己在 `startMockServer()` 里传。

**PowerShell 5.1 的一个坑（不是 mock 的 bug）**：§6.2 模板末尾有 `exit`，而裸
`Get-Location` 的输出要过 format 引擎，会被 `exit` 吞掉（实测只剩一个空行，连同
同一批里的字符串输出一起丢）。所以断言/示例请用 `(Get-Location).Path` 或
`$PWD.Path`；`Get-ChildItem`、`Get-ChildItem -Name`、`Get-Item` 这类不受影响。

### SFTP 路径空间（windows 方言）

虚拟路径是 Win32-OpenSSH 的形态：前导 `/` + 盘符，例如
`/C:/Users/test/proj/src/a.ts`。映射表：

| 虚拟路径（客户端看到的） | 真实落盘 | 说明 |
| --- | --- | --- |
| `/C:/Users/test/proj` 及其下所有路径 | `test/tmp/remote/...` | 插件的 `workdir`（项目根） |
| `/C:/Users/test/proj/AppData/Local/Temp` | `test/tmp/remote/AppData/Local/Temp` | 起服务时就建好；插件在这里暂存 `.ps1` |
| `C:/Users/test/proj/...`（无前导 `/`） | 同上 | 自动补前导 `/` |
| `.` / `/` / 空串 | `/C:/Users/test/proj` | `REALPATH` 的返回值（设计稿 §6.4 用它探测平台） |
| `foo/bar`（不带盘符） | `test/tmp/remote/foo/bar` | 按"项目相对路径"处理 |
| `/C:/<其它>`（如 `/C:/Temp/x`） | `test/tmp/drive/C/Temp/x` | 父目录按需创建，`stat` 给出可信答案而不是垃圾 |
| `/D:/<其它>` | `test/tmp/drive/D/<其它>` | 同上 |
| `..` 弹出盘符之后（如 `/C:/..`）、`C:foo`、分段里出现 `: * ? " < > \|` | 拒绝 | `PERMISSION_DENIED`，与 POSIX 分支同一套策略；拦截记录在 `server.stats.blockedPaths` |

细节：

- 大小写按 Windows 语义折叠（`/c:/users/test/PROJ/x` 命中同一个文件），但
  `/C:/Users/test/projx/x` **不会**被误判进项目（按分段比较，不是字符串前缀）。
- 项目区内的写操作保持正常 SFTP 语义（父目录不存在 → `NO_SUCH_FILE`），
  只有"驱动器沙箱"区才按需建父目录。
- SFTP 的所有 handler（`REALPATH OPEN READ WRITE CLOSE FSTAT STAT LSTAT SETSTAT
  FSETSTAT OPENDIR READDIR CLOSEDIR MKDIR RMDIR REMOVE RENAME READLINK` 和
  `posix-rename@openssh.com`）在两种方言下共用同一份实现，差别只在映射层
  （`createPathMap(rootDir, { dialect })` → `createPosixPathMap` /
  `createWindowsPathMap`）。
- `close()` 会清掉本次 exec 暂存的 `.ps1`，不留垃圾。

### Windows 传输的冒烟测试

```powershell
node test/spike-windows.mjs
```

不需要 `dist/`、不需要 `src/`（不依赖插件代码），几秒跑完。它自己起一个
`dialect: "windows"` 服务器，用 `ssh2` 手工拼出插件 §6.2 那条命令
（`-EncodedCommand <base64(UTF-16LE(script))>`），逐条断言：

1. `(Get-Location).Path` 是 workdir，`Write-Output "spike-ok"` 到 stdout；
2. `Get-ChildItem -Name` 列出预先创建的文件；
3. `Write-Error "boom"` → stderr 有 `boom`、**无 `#< CLIXML`**、不回显源码、exit 1；
4. `cmd /c exit 7` → exit 7（`$LASTEXITCODE` 传播）；
5. `中文.txt` 的 stdout 是合法 UTF-8（无 U+FFFD、无乱码）；
6. 裸命令行 `echo __SSH_HEALTH_CHECK__`（健康检查）仍然工作；
7. base64 > 6000 字符的脚本 → SFTP 暂存 + `-File` 执行（含暂存目录可写）；
8. `realpath(".") === "/C:/Users/test/proj"`；
9–13. `stat` / `readdir` / `writeFile`+读回 / `mkdir` / `unlink`；
14–16. 其余 `/C:/...` 落到驱动器沙箱、越界穿越被拒、盘符大小写折叠；
17. `-File` 的四种引号/路径形态都能跑；
18. `virtualExecPaths: true` 时脚本里可以直接写虚拟路径。

全过打印 `RESULT: PASS`（exit 0），否则逐条列出失败原因并 exit 1。

### Windows 端到端插件冒烟：`plugin-smoke-windows.mjs`

`spike-windows.mjs` 证明的是**传输层**（手拼命令）；这一支证明的是**产品**：

```
dist/index.js  →  假 V2 ctx  →  setup(ctx)
               →  驱动真正注册出来的工具（shell / read / write / edit / glob / grep）
               →  打到假服务器的 windows 方言上
```

```powershell
node test/plugin-smoke-windows.mjs            # 自己起服务（dialect=windows, virtualExecPaths）
node test/run-tests.mjs --dialect=windows     # 走总入口（复用总入口起的那个服务）
```

用的是**真实 V3 选项名**（`src/config.ts` 的 `OPTION_KEYS`）：

```js
{
  ssh: `ssh -p ${port} ${user}@127.0.0.1`,
  workdir: "C:/Users/test/proj",
  password,
  mirror: "<repo>/test/tmp/mirror",
  debug: true,          // 日志写 ~/.opencode/remote-code-debug.log（真实用户目录，任务要求）
}
```

`platform` **故意不传**：先让 `realpath(".")` 探测跑一遍（返回 `/C:/Users/test/proj`
→ 判定 windows）。第 12 条再单独验证显式 `platform: "windows"` 也一样能起。

13 条断言（编号与输出里的 `1.` `2.` … 一致）：

| # | 断言 | 关键点 |
| --- | --- | --- |
| 1 | `setup(ctx)` 完成并返回 cleanup | 90s 上限，失败就直接停 |
| 2 | 七个工具全部注册且都有 `execute` | `shell read write edit patch glob grep` |
| 3 | `shell` 真跑 PowerShell 并打印 workdir | `(Get-Location).Path` == `test/tmp/remote`（虚拟路径背后那个真目录）；stderr 里不许出现 `#< CLIXML` |
| 4 | **`cmd /c exit 3` → 抛 `exit code 3`** | 退出码端到端回归守卫（曾经真红过：`execOnClient` 把 `close` 挂在 `stream.stderr` 上），见下文 |
| 5 | >300 行脚本走暂存 `-File` 分支且成功后不留垃圾 | 断言 base64 载荷 > 6000 强制走暂存；输出 ≥300 行、首尾行齐全；`AppData/Local/Temp` 下 `oc-*.ps1` 必须为 0 |
| 6 | `write` 落盘 | `C:/Users/test/proj/src/e2e.ts` 的字节与传入内容逐字节相同 |
| 7 | `read` 行号 + CRLF 规则 | `<path>` 是远端绝对路径；逐行 `N: line`；CRLF/LF 双胞胎行数一致且 `\r` 保留；覆盖写回后仍是 CRLF |
| 8 | `edit` 生效并落到远端 | 内容替换成功 + 磁盘上旧串消失 |
| 9 | `glob "*.ts"` | 返回绝对 `C:/...` 路径、命中 `src/e2e.ts`、不误报 `.md` |
| 10 | `grep` | 报 `C:/...` 绝对路径 + `Line 1:`（1-based） |
| 11 | `read` 目录 + 拼写提示 | 子目录带尾斜杠（`src/`）、有 `AppData/`；读不存在的 `src/e2e` 抛 `Did you mean` 并提示 `e2e.ts` |
| 12 | 显式 `platform: "windows"` 同样可用 | 第二套 `setup()`（跳过探测）也注册七个工具且 `shell` 的 workdir 正确；放在 13 之前，因为清理后再连就 ECONNREFUSED 了 |
| 13 | `cleanup()` 正常返回且不留 socket | 轮询 `process.getActiveResourcesInfo()` 里 `TCPSocketWrap` 必须归零（连接池没关就会吊住进程） |

- 120s `unref()` 看门狗：卡住时打印 `TIMEOUT` 并 exit 1（不再无声挂死）。
- 输出格式与总入口一致：每条 `PASS` / `FAIL` 一行，末尾
  `total: PASS=12 FAIL=1 (1.8s)` + `RESULT: PASS|FAIL`。
- 该套件自己造的测试数据（`src/`、`crlf-fixture.txt`、`lf-fixture.txt`）在退出前删掉，
  `test/tmp` 本身留给总入口管。

## 回归守卫：exit code 必须在 ssh-pool 里活下来（已修复）

`plugin-smoke-windows.mjs` 第 4 条断言（`cmd /c exit 3` 必须让 `shell` 抛 `exit code 3`）
是一条**回归守卫**，它曾抓到重构中的一个真实 bug：

`src/ssh-pool.ts` 的 `execOnClient()` 曾把 `close` / `error` 处理器接到 **`stream.stderr`** 上，
因为链式写法在 `.stderr.on("data", …)` 之后还在继续：

```js
stream.on("data", …)
      .stderr.on("data", …)
      .on("close", (code) => …)   // ← 挂在 stderr 上，不是 channel
```

`stderr` 的 `close` 事件不携带退出码，于是 `code ?? 0` 恒为 `0`——**所有远端命令都报成功**。
实测（同一个 mock 服务器、同一条命令）：`stream.on("close")` → `3`，链式写法 → `undefined`。

修法：把 `close` / `error` 接在 **channel**（`stream`）上。现状是 4 条 handler 各自独立挂载，
`src/ssh-pool.ts` 里有一行注释说明为什么不能合并成链式写法。**别为了让套件好看而弱化这条断言。**

## 假服务器已知限制（默认 `posix` 方言）

- **只支持密码认证**：`none` / `publickey` / `keyboard-interactive` 一律被拒（这是刻意的，
  密码认证正是要测的点）。host key 是首次运行生成的 ed25519，缓存在 `test/.hostkey`。
- **exec 不是真远端 shell**：命令交给
  `C:\Program Files\Git\usr\bin\bash.exe -lc "<cmd>"`，cwd 固定为 `test/tmp/remote`。
  因此命令里的**绝对 POSIX 路径不会映射**到远端根目录（`cd /` 会跑到 Git 安装根，`/etc/passwd`
  是 Git 自带的），只有 cwd 和相对路径落在远端根内。SFTP 才做完整的 POSIX → Windows 路径映射。
- **`rg.exe` 不存在**：Git for Windows 没带 ripgrep，所以插件的 `glob`/`grep` 会走
  `find`/`grep` 回退分支——这正是想要的覆盖，但也意味着 `rg` 快路径没被测到。
- **SFTP 是子集**：实现 `REALPATH OPEN READ WRITE CLOSE FSTAT STAT LSTAT SETSTAT FSETSTAT
  MKDIR RMDIR REMOVE RENAME OPENDIR READDIR CLOSEDIR READLINK` 和
  `posix-rename@openssh.com` 扩展；`fastGet`/`fastPut` 可用（含多分片并发写）。
  没有实现硬链接、符号链接创建、文件锁、`statvfs`、扩展属性。
- **权限/属主是假的**：`uid`/`gid` 恒为 0，`mode` 只按"目录 0755 / 文件 0644"生成，
  `chmod` 在 Windows 上基本是空操作。所以**权限相关断言（EACCES）测不出来**。
- **大小写不敏感**：底层是 NTFS，`/Foo.txt` 和 `/foo.txt` 是同一个文件；真实 Linux 远端不是。
- **路径穿越防护**：`..` 越界、盘符（`C:`）、`* ? " < > |` 等一律拒绝（`PERMISSION_DENIED`），
  并且不会跟随符号链接。拦截次数在 `server.stats.pathViolations` 里。
- **shell 通道是假的**：能接受 channel，但只回显 `echo`/`pwd`，不执行命令（插件不用它）。
- 端口用 `0` 由系统分配，只监听 `127.0.0.1`，不需要管理员权限。

### `dialect: "windows"` 的额外限制

- **exec 用的是真实 PowerShell + 真实文件系统**（见上文）：脚本里的虚拟路径不会
  被解释，除非显式开 `virtualExecPaths`。
- **只模拟 PowerShell 方言**，没有 `cmd.exe` 方言（与设计稿 §1 一致）；`pwsh`（PS 7）
  只在 `options.pwsh` 为真且 PATH 上确有 `pwsh` 时才用，否则一律 `powershell.exe` 5.1。
- **属性/权限、大小写、符号链接**等表现与 posix 方言相同（uid/gid 恒为 0、
  mode 是假的、底层 NTFS 大小写不敏感）。
- **`/C:/...` 之外的形态**（UNC `//srv/share/x`）按"项目相对路径"处理，属于最小
  可行支持，别拿它做断言。
- 暂存目录 `test/tmp/exec-stage` 与沙箱 `test/tmp/drive` 都在 `test/tmp` 里，
  随整套测试一起被清理。

## 插件冒烟测试的 SKIP 规则

插件现在已经是 V2 形态（`Plugin.define({ id, setup })`）。SKIP 只是给"还没 `npm run build`"
这种情况留的兜底：`dist/index.js` 不存在、导入失败、或默认导出不是 V2 形态（是函数，或
`{ id, server }`）时，POSIX 那一支（`plugin-smoke.mjs`）打印 **SKIP** 并说明原因，
**不会**让整套测试失败。正常构建后它一定会做真断言：注册 `shell read write edit patch
glob grep` 七个工具且都有 `execute`，然后额外用 `shell` 工具跑一次 `echo plugin-smoke-ok`
（走假 SSH 的 exec 通道，软失败），最后调用 `setup` 返回的清理函数。

Windows 那一支（`plugin-smoke-windows.mjs`）**不软跳过**：它是端到端证明，`dist/` 缺失
就是硬失败（并提示先 `npm run build`）。总入口的 `--skip-plugin` 对两种方言都生效，
此时打印 `SKIP ... (--skip-plugin)` 并在汇总里留一行 note。

假 `ctx` 里 `tool.transform` / `session.hook` 都返回 `{ dispose }`（V2 的 `Registration`），
`options.mirror` 指向 `test/tmp/mirror`，所以插件不会写用户目录下的
`~/.opencode/mirrors`。
