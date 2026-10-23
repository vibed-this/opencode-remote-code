# Remote Code V3 — 跨平台远端（Windows / POSIX）重构设计

> 状态：已实现 (3.0.0)
> 目标版本：3.0.0（破坏性）
> 前置：V2 移植已完成并验证（commit `2abeb30`），当前版本只支持 POSIX 远端。
> 实现与本文的差异见文末附录 **A. 实现偏差记录**（本文是设计意图，代码才是事实）。

---

## 1. 目标与非目标

### 目标

1. **远端可以是 Windows**（OpenSSH for Windows，PowerShell 5.1 起），也可以是 Linux / macOS。
2. 平台差异**只存在于一层抽象**里；`tools/` 目录下不再出现任何平台假设。
3. 远端仍然**零依赖**：不要求远端装 ripgrep / git / 任何运行时。
4. 配置、诊断、测试三条链路对两种平台表现一致（同一套 options、同一套日志、同一套测试骨架）。

### 非目标

- 不支持"老机器"：远端 OpenSSH < 8.0、只能用 `ssh-rsa`(SHA-1) 的服务器不再兼容（见 §12 删除清单）。
- 不做 Windows 远端的 `cmd.exe` 方言：只支持 PowerShell（5.1 / 7+）。
- 不做 LSP、不做远端端口转发、不做交互式 shell（`ssh2` 的 `shell()`）。
- 不追求远端 glob/grep 的极致速度（见 §7.3 预算与加速器）。

---

## 2. 现状：POSIX 耦合点清单

V2 把平台假设散落在 11 个文件里。这是这次重构要清掉的东西（行号为重构前）：

| 类别 | 位置 | 问题 |
| --- | --- | --- |
| 路径模型 | `config.ts:216`、`path-mapper.ts:14,40,78,86,141,156`、`manifest.ts:47,53`、`tools/*.ts`（read/write/edit/patch 各自的 `path.posix.normalize` + `path.posix.join`） | 全部用 `path.posix`；`C:/x` 不是 posix 绝对路径 → 直接抛错休眠 |
| 命令拼接 | `ssh-pool.ts:494` `cd <cwd> && <cmd>` | PowerShell 5.1 不支持 `&&`；`cd` 语义/引号完全不同 |
| 引号 | `shell-quote.ts`（POSIX 单引号转义） | Windows 上无效（cmd 无安全引号，PS 用单引号双写） |
| 远端二进制 | `glob.ts:27,38`（`rg`/`find`/`stat`/`sort`/`cut`）、`grep.ts:64,75`（`rg --json`/`grep -Ern`）、`read.ts:39,49,107,114,151`（`file`/`dd`/`od`/`ls -1pA`） | Windows 上全都没有 |
| 文件系统写操作 | `sync-engine.ts:82` `mkdir -p`、`patch.ts:596` `rm -f`、`ssh-pool.ts:468-480` `mktemp`/`cat >`/`chmod`（sudo askpass） | POSIX 专用命令；`sudoPassword` 本身在 Windows 无意义 |
| 探测 | `index.ts:97` `uname -s`、`index.ts:102` `git -C ... rev-parse`、`remote-system-prompt.ts:36` `cat AGENTS.md` | 全部可改成 SFTP / 方言化 |
| 编码/流 | `ssh-pool.ts:610,613` 一律 `toString("utf-8")`；`bash.ts:44-52` 用 stderr 文本猜退出码（为老 OpenSSH） | 中文 Windows 上原生程序输出是 CP936；PowerShell 错误流会吐 CLIXML |
| 行尾 | `write.ts`/`patch.ts` 写回统一 `\n`（只有 `edit.ts` 有 CRLF 保持） | Windows 文件被改成 LF |
| 其他 | `resolve-git-tool.ts`（死代码）、`test-e2e.ts`/`test-extended.ts`（跑 POSIX 命令的真机脚本） | 删 |

---

## 3. 设计原则（不变量）

1. **规范路径**：内部一律"绝对 + 正斜杠 + 带盘符（Windows）/ 带前导 `/`（POSIX）"，例如 `C:/Users/x/proj/src/a.ts`。反斜杠只在**输入归一化**时出现。
2. **只有 `shell` 工具碰远端 shell**。另外 6 个工具（`glob`/`grep`/`read`/`write`/`edit`/`patch`）只走 SFTP。这是本次重构最重要的简化：平台方言只影响一个工具。
3. **平台差异收口在 `src/platform/`**；`src/tools/` 与 `src/mirror/` 里不允许出现 `path.posix`、`quoteShell`、`cd &&`。
4. **一切远端 IO 经接口**（`RemoteFs` / `RemoteDialect`），测试可以整体换成 mock。
5. **远端不留痕**：不安装任何东西；临时文件（超长脚本暂存）用完即删。

---

## 4. 架构

```
src/
  index.ts                 插件入口：loadConfig → detect → 组装工具 → 注册 hook
  config.ts                options 解析 + ssh 串解析 + 校验（破坏性重写）
  platform/
    path.ts                RemotePathOps：posix / windows 两套路径语义（§5）
    dialect.ts             RemoteDialect 接口（§6）
    dialect-posix.ts       sh/bash：'...' 单引号 + cd && payload
    dialect-windows.ts     PowerShell：EncodedCommand + 脚本模板（§6.2）
    detect.ts              realpath 探测 + shell 发现（§6.4）
  remote/
    fs.ts                  RemoteFs：基于 SFTP 的 stat/readdir/read/prefix/write/mkdirp/unlink/realpath
    walk.ts                有界递归遍历（glob 与 grep 共用，§7.2）
    glob.ts                pattern → 匹配器（`*`,`?`,`**`,`{a,b}`,`[..]`）
    search.ts              grep：遍历 + 二进制嗅探 + 字节预算
  transport/
    ssh-pool.ts            ssh2 连接池（只剩连接/重连/健康检查，无路径假设）
  mirror/
    path-mapper.ts         namespace 映射（§8）
    manifest.ts            manifest v2（size/mtime）
    sync.ts                按需 pull/push 单文件（stat 命中则跳过）
  tools/                   7 个工具，纯 RemoteFs/Dialect 消费者
  prompt/                  system-prompt.ts + prompts/*.txt
  log.ts                   诊断日志（options.debug 驱动）
```

数据流（读一个文件）：

```
agent → read tool → RemotePathOps.normalize → PathMapper.toLocal
      → RemoteFs.stat (SFTP)         ← 目录? → readdir 渲染列表
      → RemoteFs.readPrefix(8KB)     ← 二进制? → 拒绝
      → Sync.ensureLocal             ← SFTP fastGet（stat 命中则跳过）
      → 本地镜像 fs.readFile → 渲染行号
```

---

## 5. 抽象层 1：RemotePathOps（路径语义）

```ts
export interface RemotePathOps {
  readonly kind: "posix" | "windows"
  /** 规范形式：绝对、`/` 分隔、去尾斜杠、drive 首字母大写、`.`/`..` 折叠 */
  normalize(p: string): string
  isAbsolute(p: string): boolean
  join(base: string, ...rel: string[]): string
  dirname(p: string): string
  basename(p: string): string
  /** 大小写规则由 kind 决定：windows 折叠比较，posix 精确比较 */
  equals(a: string, b: string): boolean
  /** root 是否包含 p（含 root 自身），边界安全 */
  contains(root: string, p: string): boolean
  /** 分段：[ "C:", "Users", "x" ] / [ "home", "x" ]（POSIX 不含前导空段） */
  segments(p: string): string[]
  /** 上线格式（SFTP 线协议）：windows `C:/Users/x` → `/C:/Users/x` */
  toSftp(p: string): string
  /** realpath 返回值 → 规范形式：`/C:/Users/x` → `C:/Users/x` */
  fromSftp(s: string): string
}
```

### 5.1 Windows 语义表

| 场景 | 输入 | 规范形式 | 说明 |
| --- | --- | --- | --- |
| 反斜杠 | `C:\Users\x\a.ts` | `C:/Users/x/a.ts` | 输出给模型的永远是 `/` |
| 小写盘符 | `c:/users/x` | `C:/Users/x` | 盘符统一大写；其余**保留原大小写** |
| 无盘符绝对 | `/Users/x` | 拒绝（配置期报错） | 远端 Windows 上 `/x` 是"当前盘根"，语义不稳定，明确不支持 |
| 盘符相对 | `C:foo` | 拒绝 | 同理 |
| UNC | `//srv/share/a` | `//srv/share/a` | 仅 best-effort，文档标注 |
| 根 | `C:/` | `C:/` | `contains` 单独处理（类似现在 `"/"` 的特判） |
| 比较 | `C:/Users/X` vs root `C:/users/x` | 相等 | 折叠大小写 |
| SFTP | `C:/Users/x` | `/C:/Users/x` | Win32-OpenSSH 的 sftp-server 形态 |

### 5.2 需要小心的两个真实坑

1. **大小写不敏感**：`isWithinWorkspace` 必须折叠比较，否则 `C:/Users/X/...` 会被误判为"工作区外"并反复弹权限。
2. **镜像路径冲突**：本地镜像若在 POSIX 主机上（远程是 Windows），`a.ts` 与 `A.ts` 是两个文件、互不冲突；但若本地也是 Windows，两者会撞同一个本地路径 → 后写覆盖。用 manifest 记录 `local` 名称，冲突时加 `~2` 后缀并在日志里 warn。

---

## 6. 抽象层 2：RemoteDialect（命令执行）

```ts
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
}

export interface ExecOptions {
  cwd?: string
  timeout?: number
}

export interface RemoteDialect {
  readonly id: "posix-sh" | "windows-powershell"
  /** 给人看的名字，写进 system prompt / 工具描述："bash" | "PowerShell 5.1" */
  readonly shellName: string
  /** 脚本 + cwd → 一条 SSH exec 命令串（可能附带清理回调） */
  buildCommand(script: string, opts: ExecOptions): Promise<{
    command: string
    cleanup?: () => Promise<void>
  }>
  /** 远端字节流 → 文本（UTF-8，失败回退 GB18030） */
  decode(buf: Buffer): string
}
```

### 6.1 POSIX 方言（行为不变）

```
script → `cd <quoted cwd> && <script>`      // quoteShell 保持不变，仅此一处使用
```
显式不用 `-lc`：远端默认 shell 已是用户登录 shell，强行 `bash -lc` 反而会改 PATH。

### 6.2 Windows 方言（PowerShell，已在本机实测）

命令形态：

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(UTF-16LE(script))>
```

脚本模板（本机 PS 5.1 实测通过：stdout 干净、stderr 无 CLIXML、退出码正确传播）：

```powershell
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$OutputEncoding=[Text.Encoding]::UTF8
$global:LASTEXITCODE=0
try {
  Set-Location -LiteralPath 'C:/Users/x/proj'
  <payload>
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
```

为什么是这个形状（都是实测结论，不是猜的）：

| 决策 | 理由 |
| --- | --- |
| `-EncodedCommand` 而不是 `-Command "<拼字符串>"` | 命令体经 cmd.exe / SSH 层都不需要引号转义，彻底绕开 Windows 命令行引号地狱 |
| 自己 `Set-Location` 而不是 `cd x && cmd` | PS 5.1 无 `&&`；且 `Set-Location` 失败要能报错 |
| `$ErrorActionPreference='Stop'` + `try/catch` + `[Console]::Error.WriteLine` | 直接把错误写真实 stderr，**避免 PowerShell 的 CLIXML 序列化**（实测：未捕获的 `Write-Error` 会让 stderr 变成 `#< CLIXML <Objs…> ` 一大坨，还回显源码行） |
| `$ProgressPreference='SilentlyContinue'` | 首启动的 "Preparing modules for first use" 进度记录同样会污染 stderr |
| 末尾显式 `exit` | 实测：`powershell -Command "cmd /c exit 3"` → 进程退出码 **1**；加上 `exit $LASTEXITCODE` 才得到 3 |
| `[Console]::OutputEncoding=UTF8` | 否则 `Get-ChildItem` 中文名输出为 CP936，客户端按 UTF-8 解就是乱码 |

**超长脚本**：`EncodedCommand` 会放大 2.67 倍（UTF-16 + base64），而 Windows 的 `exec` 最终经 `cmd.exe /c`，命令行上限约 8191 字符。因此：

```
base64 长度 <= 6000  →  -EncodedCommand（一次往返）
否则                 →  SFTP 写 %TEMP%/oc-<rand>.ps1（UTF-8 with BOM）
                        →  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>
                        →  结束后 SFTP unlink（cleanup 回调）
```

### 6.3 输出解码

```ts
decode(buf) {
  const utf8 = new TextDecoder("utf-8").decode(buf)          // 非 fatal
  if (!utf8.includes("\uFFFD")) return utf8
  try { return new TextDecoder("gb18030").decode(buf) } catch { return utf8 }
}
```
只做整段回退（不做逐行），因为中文 Windows 上一次 `ipconfig`/`ping` 的输出是整段 CP936。混合编码（PS 输出 UTF-8 + 原生程序输出 GBK）无法完美还原，文档标注为已知限制；缓解办法是让模型优先用 PS 原生命令。

### 6.4 平台探测（`platform/detect.ts`）

1. `options.platform` 显式给了 `windows` / `posix` → 直接用，不探测。
2. 否则 **一次 SFTP `realpath(".")`**：
   - 结果形如 `/C:/Users/zhouxiaokang` → `windows`，并且**这就是默认 workdir**（`options.workdir` 缺省时用）
   - 结果形如 `/home/x`、`/Users/x` → `posix`
3. Windows 下探测 PowerShell：`Get-Command pwsh -ErrorAction SilentlyContinue`（一条 exec，缓存）；有则用 `pwsh.exe`（PS7，UTF-8 更省心），否则 `powershell.exe`（PS 5.1，Windows 10+ 必有）。
4. POSIX 下不探测 shell（保持现状）。

> 探测用 SFTP 而不是 `uname`/`ver`：SFTP 一定存在（我们本来就要用），且 `realpath` 一次往返同时解决"是不是 Windows"和"默认 workdir 是什么"。

---

## 7. 抽象层 3：RemoteFs（SFTP）与工具重写

### 7.1 RemoteFs

```ts
export interface RemoteFs {
  realpath(p: string): Promise<string>
  stat(p: string): Promise<Stat | null>                 // null = 不存在
  readdir(p: string): Promise<Dirent[]>                 // { name, dir, size, mtime, symlink }
  readPrefix(p: string, bytes: number): Promise<Buffer> // 二进制嗅探 / AGENTS.md
  readFile(p: string): Promise<Buffer>                  // 小文件（预算内）
  writeFile(p: string, data: Buffer): Promise<void>
  mkdirp(p: string): Promise<void>
  unlink(p: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}
```
所有入参是**规范路径**，内部统一 `ops.toSftp()`。

### 7.2 有界遍历 `walk.ts`（glob / grep 共用）

```ts
walk(remoteFs, root, {
  maxDepth = 12,
  maxEntries = 20_000,
  ignore = ["node_modules", ".git", "dist", "build", "target", ".venv", "venv", "vendor", "__pycache__", ".next"],
  concurrency = 8,
  onFile(relPath, dirent) => boolean | void,   // 返回 false 提前结束
}): Promise<{ truncated: boolean }>
```
- 8 路并发 `readdir`（SFTP 通道是复用的，但每个请求要往返；并发能显著提速）。
- 命中 `maxEntries` 或时间预算 → `truncated=true`，工具输出里明确告诉模型"结果被截断，请缩小 path/pattern"。

### 7.3 工具逐个重写

| 工具 | V2 做法 | V3 做法 | 平台无关性 |
| --- | --- | --- | --- |
| `shell` | `cd <cwd> && <cmd>` | `dialect.buildCommand(script, {cwd, timeout})`；描述里写明是 bash 还是 PowerShell | 仅此处用方言 |
| `glob` | `rg --files` / `find+stat+sort` | `walk` + `remote/glob.ts` 匹配器，按 mtime 降序，上限 100 | 纯 SFTP |
| `grep` | `rg --json` / `grep -Ern` | `walk` + `RemoteFs.readFile` + JS `RegExp`，逐行匹配 | 纯 SFTP |
| `read`（文件） | `file` + `dd\|od` 探测二进制 | 扩展名黑名单 + `readPrefix(8KB)` 含 NUL → 二进制 | 纯 SFTP |
| `read`（目录） | `ls -1pA` | `readdir`，目录名后加 `/`，符号链接加 `@` | 纯 SFTP |
| `read`（不存在） | `ls` 父目录猜相近名 | `readdir(parent)` 猜相近名 | 纯 SFTP |
| `write` | mirror + `pullAll`/`pushAll` | mirror + 单文件 pull/push | 纯 SFTP |
| `edit` | 同上（已有 CRLF 保持） | 同上 + 行尾策略统一（见下） | 纯 SFTP |
| `patch` | 同上 + `rm -f` 做 move | 同上 + `RemoteFs.unlink` + `rename` | 纯 SFTP |

**行尾统一**：`write` / `edit` / `patch` 都先 `detectLineEnding(text)`，写回时还原；`patch` 的 hunks 解析继续先把 CRLF 归一成 LF，应用后按原文行尾写回。这修掉"Windows 文件被改成 LF"的老问题。

**grep 的索引/预算**：

```
maxMatches = 100        // 与 V2 一致
maxBytes   = 64 MiB     // 累计读取
maxFileSize= 2 MiB      // 单文件超过就跳过（日志记一笔）
maxMillis  = 20_000
```
超预算返回部分结果 + 明确提示。

### 7.4 `grep` 的正则方言

V2 远端用 rg（Rust regex）/grep（POSIX BRE/ERE），V3 用 JS `RegExp`（同一套在两种平台上跑）。差异点：`\p{...}`、lookbehind（JS 支持）、`(?i)` 内联标志（JS 不支持，需要在 `new RegExp(p, "i")` 层面处理）。设计上：把 `(?i)`/`(?-i)` 前缀提升成 flag，其余非法模式给出清晰错误。

> 备选（未采纳，见 §14 Q3）：保留 `rg` 加速分支。否决理由：两套实现 = 两倍 bug 面，且 Windows 上 rg 不一定存在，等于 Windows 永远走慢路径却要维护两套语义。

---

## 8. Mirror & Sync v2

### 8.1 布局（不再是 slug 拼接）

```
<mirrorRoot>/<hostSlug>-<hash6>/<drive>/<remote path segments...>
```
- POSIX 远端：`<mirrorRoot>/zxk@frp-oil.com-4c1f/root/Users/zxk/proj/src/a.ts`
- Windows 远端：`<mirrorRoot>/zhouxiaokang@frp-use.com-9a3d/C/Users/zhouxiaokang/proj/src/a.ts`

好处：**工作区外路径与工作区内路径同一套规则**，`toRemote` 不再需要 V2 那个 `outsidePaths` 记忆表（V2 因为"外部路径去掉前导 `/`"和"内部相对路径"撞在一起，才不得不记一张表）。V2 的 `PathMapper.outsidePaths` 直接删掉。

每次 `setup()` 清空**整个 namespace**（`<mirrorRoot>/<hostSlug>-<hash6>/`），行为和 V2 的"每次清 mirrorBase"一致，但更彻底。

### 8.2 manifest v2

```jsonc
{
  "version": 2,
  "remoteRoot": "C:/Users/zhouxiaokang/proj",
  "files": {
    "C:/Users/zhouxiaokang/proj/src/a.ts": { "local": "C/Users/zhouxiaokang/proj/src/a.ts", "size": 1234, "mtime": 1729550000123 }
  }
}
```

### 8.3 按需同步（V2 的 `pullAll`/`pushAll` 是 O(n) 全量，删掉）

```ts
ensureLocal(remotePath)   // remote stat → 与 manifest 比对 size+mtime → 命中则跳过 fastGet
commit(remotePath)        // mkdirp(remote parent) → fastPut → 更新 manifest
```
现有 `edit` 的 per-file 锁保留；`sync.ts` 内部再加一个 per-path mutex（SFTP 通道共享）。

---

## 9. 配置（破坏性重写）

### 9.1 新 options

```jsonc
{
  "package": "C:/Users/WIN11/.config/opencode/remote-code",
  "options": {
    "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
    "password": "***",
    "workdir": "C:/Users/zhouxiaokang/proj",   // 可选：缺省=登录 home
    "platform": "auto",                        // auto | windows | posix
    "shell": "auto",                           // auto | pwsh | powershell | bash | sh
    "mirror": "C:/Users/WIN11/.opencode/mirrors",
    "debug": true,                             // 取代 REMOTE_CODE_DEBUG（后台服务拿不到 env）
    "timeout": 120000,
    "ignore": ["node_modules", ".git"],
    "limits": { "globResults": 100, "grepMatches": 100, "grepBytes": 67108864, "walkDepth": 12 }
  }
}
```

结构化写法（替代方案，`ssh` 串能表达的都优先用串）：

```jsonc
{ "host": "frp-use.com", "port": 48713, "user": "zhouxiaokang", "key": "C:/Users/WIN11/.ssh/id_rsa", "password": "***" }
```

### 9.2 破坏性变更表

| V2 | V3 | 处理 |
| --- | --- | --- |
| `REMOTE_SSH` / `REMOTE_WORKDIR` / `REMOTE_PASSWORD` / `REMOTE_MIRROR` env | 删除 | 后台服务本就看不到 env，留着只制造迷惑 |
| `--remote*` argv | 删除 | 同上 |
| `sudoPassword` | 删除 | 只对 POSIX 有意义，且插件从不提权 |
| `workdir` 必填 | 可选（默认登录 home） | Windows 下没人愿意手抄 `C:/Users/...` |
| `workdir` 必须 POSIX 绝对 | 按平台校验 | 核心修复 |
| `REMOTE_CODE_DEBUG=1` | `options.debug` | env 在后台服务不可见 |
| `REMOTE_POOL_*` env | `options.pool = { command, file, stagger }` | 同上 |
| 镜像布局 slug | namespace + drive | 旧镜像残留无害，可手工删 |
| `SSHPool.exec(cmd, {cwd})` | `exec(script, opts)` 由 dialect 编码 | 内部 API |

### 9.3 ssh 串解析

保留（用户友好），但明确**拒绝**无法模拟的选项而不是静默忽略：

- 支持：`-p`、`-i`、`-o Key=Value`（白名单映射，见下）、`user@host`、`ssh://` 形式
- 白名单 `-o`：`StrictHostKeyChecking`、`UserKnownHostsFile`、`ConnectTimeout`、`ServerAliveInterval`、`ServerAliveCountMax`、`HostKeyAlgorithms`
- **报错**：`-J` / `ProxyCommand` / `ProxyJump` / `-L` / `-R`（ssh2 不支持，要用户改用别的方式），错误信息直接说明
- 未知 `-o`：`console.warn` 一次，继续

---

## 10. 工具行为与提示词

- `shell` 描述动态生成：`Execute commands in {shellName} on the remote machine.`，input schema 里 `workdir` 描述同步改。
- system prompt `<env>` 块：
  ```
  Working directory: C:/Users/zhouxiaokang/proj
  Platform: windows
  Shell: PowerShell 5.1 (use PowerShell syntax; path separators may be / )
  Is directory a git repo: yes
  ```
- Windows 下追加一小段"方言提示"（避免模型写 `ls -la` / `cd x && y` / `cat`）：
  ```
  The remote shell is PowerShell. Prefer native cmdlets (Get-ChildItem, Get-Content,
  Select-String, Test-Path); `&&` is unavailable; use `;` to chain. Quote paths with
  single quotes. Paths may use forward slashes.
  ```
- `AGENTS.md` 读取：`RemoteFs.readPrefix` / `readFile`（`<workdir>/AGENTS.md`），不再 `cat`。
- git 探测：`RemoteFs.stat(<workdir>/.git)`，不再 `git rev-parse`。

---

## 11. 测试策略

### 11.1 mock SSH server 加 `dialect: "windows"`

本机就是 Windows，`powershell.exe` 5.1 真实存在 → **可以在本机真实端到端验证 Windows 分支**：

| 层 | posix 模式（现状） | windows 模式（新增） |
| --- | --- | --- |
| exec | `bash.exe -lc "<cmd>"` | `powershell.exe -NoLogo -NoProfile -NonInteractive <args>`（原样把 decode 后的命令交给真 PS） |
| SFTP 虚拟根 | `/tmp/...` ← 真实 `test/tmp/remote` | `/C:/Users/test/proj` ← 真实 `test/tmp/remote` |
| realpath('.') | 返回虚拟 POSIX 路径 | 返回 `/C:/Users/test/proj` |

这样方言、路径映射、编码、退出码、SFTP 路径形态都在本机被真实覆盖，只有"Win32-OpenSSH 的 sftp-server 是否接受 `/C:/x`"等少数点需要真机（§15 S1）。

### 11.2 新增/保留的套件

| 套件 | 覆盖 |
| --- | --- |
| `test/remote-path.mjs`（新，双参数化） | posix + windows 两套 normalize/isAbsolute/contains/segments/toSftp；大小写、盘符根、UNC、`..` 逃逸 |
| `test/dialect.mjs`（新） | PS 模板生成、base64/UTF-16LE、超长脚本走 `-File` 分派、GB18030 回退解码、退出码语义 |
| `test/glob-matcher.mjs`（新） | `*`/`?`/`**`/`{a,b}`/`[..]`、大小写、路径相对化 |
| `test/path-mapper.mjs`（改写） | namespace 布局、往返一致性、工作区边界、长路径 |
| `test/ssh-pool-lifecycle.mjs`（保留） | 连接池状态机 |
| `test/plugin-entry.mjs`（保留） | V2 目录解析（`index.js` shim） |
| `test/verify-mock-server.mjs`（重写） | 两种方言各跑一遍：exec 退出码/编码、SFTP 读写/mkdirp/unlink、目录列表 |
| `test/plugin-smoke.mjs`（扩展） | 两种方言各注册 7 个工具并各执行一次 |
| 删除 | `src/test-e2e.ts`、`src/test-extended.ts`（POSIX 真机脚本，被上表取代） |

`run-tests.mjs` 改成方言矩阵：`--dialect=posix|windows|both`，默认 `both`。

### 11.3 验收标准

1. `npm run build` 零错误。
2. `node test/run-tests.mjs` 两种方言全绿（预估 ~60s）。
3. 真实会话（`opencode run --standalone --print-logs`）在 `win` 远端上：`shell` 能跑 `Get-Location`、`glob` 能列出文件、`read` 能读 CRLF 文件、`write` 能把改动落回远端。
4. 休眠路径不变：无 `ssh` 时零副作用。

---

## 12. 删除清单（"不需要兼容旧机器"落地）

| 删除项 | 位置 | 理由 |
| --- | --- | --- |
| `ssh-rsa`(SHA-1) host key 放宽、`HostKeyAlgorithms=+ssh-rsa` 处理 | `ssh-pool.ts:657-687` | 老 OpenSSH 5.3 才需要 |
| stderr 文本猜退出码 | `bash.ts:41-52` | 老 OpenSSH 不传退出码的 workaround |
| `sudoPassword` + askpass 全套 | `config.ts`、`ssh-pool.ts:460-487,496-501,537-541` | POSIX-only，且从不提权 |
| `glob` 的 `find+stat+sort+cut` 回退 | `glob.ts:36-41` | 换成 SFTP 遍历 |
| `grep` 的 `grep -Ern` 回退 | `grep.ts:71-80` | 同上 |
| `read` 的 `file`/`dd`/`od`/`ls` | `read.ts:38-56,106-116,151` | 同上 |
| `mkdir -p` / `rm -f` 远端写操作 | `sync-engine.ts:82`、`patch.ts:596` | 换 SFTP |
| `resolve-git-tool.ts` | 整文件 | 死代码 |
| env/argv 配置回退 | `config.ts:51-131` | 见 §9.2 |
| `test-e2e.ts` / `test-extended.ts` | 整文件 | 见 §11.2 |
| `PathMapper.outsidePaths` | `path-mapper.ts:36,101-107,127-132` | namespace 布局后不再需要 |

---

## 13. 实施阶段

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| **P0 spike（0.5d）** | 用 mock 的 windows 方言打通 poke 脚本：验证 `-EncodedCommand` 经 ssh2.exec 的引号/长度、退出码、CLIXML、GBK 解码；同时摸真实的 Win32-OpenSSH 行为（§15 S1，需要 `win` 的密码） | `test/spike-windows.mjs` 打印出干净的 stdout/stderr/exit |
| **P1 platform 层（1d）** | `platform/path.ts` + `dialect{,-posix,-windows}.ts` + `detect.ts` + 对应单测 | `remote-path.mjs`、`dialect.mjs` 全绿 |
| **P2 remote 层 + 工具（1.5d）** | `remote/{fs,walk,glob,search}.ts`，重写 `glob`/`grep`/`read`，去掉 `quoteShell` 依赖 | mock 双方言下 7 个工具可用 |
| **P3 mirror/sync v2（0.5d）** | namespace 布局、manifest v2、按需 pull/push、长路径、行尾统一 | `path-mapper.mjs` 全绿；写/编辑/补丁往返正确 |
| **P4 收尾（0.5d）** | system prompt 方言块、文档重写（AGENTS.md/README）、删清单执行、CI 脚本 | 双方言全量测试 + 真机 `win` 会话验证 |

预计 4 天（不含真机联调的等待时间）。

---

## 14. 待确认（需要你拍板）

- **Q1** "不需要兼容旧机器"是否按 §12 理解（砍 ssh-rsa/老 OpenSSH、砍 env/argv、砍 sudoPassword）？
- **Q2** Windows 远端只支持 PowerShell（不提供 cmd 方言）——可以吗？
- **Q3** `glob`/`grep` 一律走 SFTP（统一语义，大树慢）vs 保留 rg 加速分支（快，双实现双语义）？设计默认前者。
- **Q4** `launchers/` 是否一起改（Windows 远端目录名 slug 需要支持盘符与反斜杠）？

---

## 15. 风险与 spike 项

| 编号 | 风险 | 影响 | 应对 |
| --- | --- | --- | --- |
| S1 | Win32-OpenSSH 未实测：`realpath('.')` 返回值、`/C:/x` 形态 SFTP 是否接受、exec 命令长度上限、`-EncodedCommand` 是否被 `cmd.exe` 二次转义 | 高（阻塞 Windows 分支） | P0 spike，需 `frp-use.com:48713` 密码；不通过则退化为 `C:/x` 直传 SFTP |
| S2 | 中文 Windows 原生命令输出 CP936 | 中（乱码） | 整段 GB18030 回退；提示词引导优先 PS 原生命令 |
| S3 | SFTP 遍历在大仓库上慢 | 中 | 有界遍历 + ignore 表 + 预算 + 明确截断提示；§14 Q3 决定是否上加速器 |
| S4 | 大小写不敏感导致镜像冲突 | 低 | manifest 记录 local 名，冲突加 `~N` 后缀并 warn |
| S5 | 本地镜像长路径 > 260 | 低 | 本地为 Windows 时加 `\\?\` 前缀 |
| S6 | PS 5.1 单引号/花括号/here-string 转义 | 中 | 命令体只经 base64，不做字符串拼接；`shell` 工具里用户脚本原样嵌入模板（唯一嵌入点是 cwd，用 `'...'` 双写单引号） |
| S7 | 每次 `setup()` 清整个 namespace | 低 | 与 V2 一致（正确性优先）；后续可做增量清理 |

---

## 附录 A. 实现偏差记录（3.0.0 落地时与本文不一致之处）

本节只记录**代码事实与本文设计不一致**的地方。判断依据是 3.0.0 的代码，不是本文；如果两者冲突，
以代码为准。未被列出的部分（三层结构、`shell` 之外全走 SFTP、manifest v2、按需同步、namespace 思路、
休眠路径、`workdir` 按平台校验等）均按设计实现。

| # | 位置 | 本文写法 | 实际实现 | 说明 |
| --- | --- | --- | --- | --- |
| A1 | §6.2 模板 / 决策表"末尾显式 `exit`" | 模板最后一行 `exit 0` | **没有** `exit 0`：成功路径自然退出 | 实测 PS 5.1 上 `exit 0` 会丢掉尚未 flush 的输出（`Get-Location` 重定向到 stdout 时一个字都不打印）。`if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` 保留，退出码传播不受影响。见 `src/platform/dialect-windows.ts:19-60` |
| A2 | §6.4 第 3 步 | `Get-Command pwsh -ErrorAction SilentlyContinue` | `where.exe pwsh`（一次 exec，缓存结果） | 探测走的是"远端默认 shell 的一条命令"，`where.exe` 在 cmd 与 PS 下都成立；必须写 `.exe`，因为 PowerShell 里裸 `where` 是 `Where-Object` 的别名。见 `src/platform/detect.ts:100-101` |
| A3 | §6.3 `decode` | UTF-8 有替换字符就整段换 gb18030 | UTF-8 / gb18030 **比较替换字符数量取更少者**，然后 `stripClixml()`（去 `#< CLIXML <Objs…`、反转义 `_x000D__x000A_`） | 模板只是"主要防线"，`decode` 做防御式兜底（用户脚本改 `$ErrorActionPreference`、非 `shell` 通道的文本等）。见 `src/platform/dialect-windows.ts:170-182` |
| A4 | §5.1 语义表 | `c:/users/x` → `C:/Users/x` | `c:/users/x` → `C:/users/x`（**只**把盘符字母转大写，其余保留原大小写） | 设计表格第三列是笔误；真正的规则由表格第四列"其余保留原大小写"和风险 S4（大小写不敏感冲突）共同决定。见 `src/platform/path.ts:139` |
| A5 | §9.3 白名单 / 硬报错 | 6 个 `-o`；报错项 `-J`/`ProxyCommand`/`ProxyJump`/`-L`/`-R` | 7 个 `-o`（多 `IdentitiesOnly`）；另外 `-o LocalForward`/`RemoteForward`/`DynamicForward`/`RequestTTY` 也硬报错；`-l` 支持，`-F` 告警后忽略 | `IdentitiesOnly` 是 ssh2 真正能映射的键；转发与 pty 在 ssh2 里无法模拟，故把设计里只列在 `-L`/`-R` 上的规则推广到 `-o` 等价写法。见 `src/config.ts:105-125` |
| A6 | §7.3 grep 预算 / §9.1 `limits` | `maxMatches` / `maxBytes` / `maxFileSize` / `maxMillis`；`limits` 里只有 4 个键 | 配置键是 `searchMatches` / `searchBytes` / `searchFileSize` / `searchMillis`，另有 `walkEntries`、`shellTimeout`、`globResults`、`walkDepth`，共 **8** 个键 | 键名统一成"工具名前缀"，并把 `glob` 的预算和 `shell` 超时也纳入同一张表。见 `src/limits.ts` |
| A7 | §7.2 walk 默认 ignore | 9 项硬编码默认 | 实际生效的是 `limits.DEFAULT_IGNORE` 的 **15** 项（`glob`/`grep` 都传 `ctx.ignore`；`walk.ts` 自己的默认表只在调用方没传时兜底） | 用户 `options.ignore` 是**追加**，永不替换内置表。Windows 下大小写不敏感由调用方按 `ops.kind` 决定。见 `src/limits.ts:43-59,77-85`、`src/tools/glob.ts:62`、`src/tools/grep.ts:85` |
| A8 | §5 接口 / §6 接口 | `RemotePathOps` 9 个方法，无 `rootOf`；`buildCommand` 直接返回 `{ command, cleanup? }` | `RemotePathOps` 多了 `rootOf(p)`；`RemoteDialect` 多了 `promptHint()`，`buildCommand` 的返回值被命名为 `StagedScript` | `rootOf` 供 `contains` 与 `\\?\` 长路径前缀复用；`promptHint()` 就是 §10 那段方言提示（写在方言里，而不是 `system-prompt.ts` 里 if 平台）。见 `src/platform/path.ts:44`、`src/platform/dialect.ts:25-46` |
| A9 | §4 目录树 | `transport/ssh-pool.ts`、`prompt/system-prompt.ts` | `src/ssh-pool.ts`、`src/system-prompt.ts`（没有 `transport/`、`prompt/` 目录；`src/prompts/` 只放 `.txt` 片段和 `index.ts`）；另有 `src/limits.ts`、`src/log.ts`、`src/tools/context.ts`、`src/tools/text.ts`、`src/v2-bridge.ts` | 多一层目录只会多一层 import 路径，没有独立职责；`v2-bridge.ts` 是 V1→V2 权限/上下文桥，设计稿成稿时还没有它 |
| A10 | §9.3 / §6 默认用户 | 未明说（V2 语义是 `root`） | 未写 `user@` 时用本地 OS 用户名（`os.userInfo().username`），与 OpenSSH 自身默认一致 | 见 `src/config.ts:230-236,775`；`os.userInfo()` 抛错的精简环境里再退到 `root` |
| A11 | §9.2 表"`REMOTE_CODE_DEBUG=1` → `options.debug`（删除 env）" | env 完全删除 | `options.debug` 优先，但 `process.env.REMOTE_CODE_DEBUG === "1"` 仍作为 best-effort 兜底保留 | 保留是因为本地 `opencode run --standalone` 开发时方便；后台服务里通常看不到（这也正是迁到 `options` 的原因）。见 `src/config.ts:813-818` |
| A12 | §8.1 布局示例 | `<hostSlug>-<hash6>`，示例 `zxk@frp-oil.com-4c1f/root/Users/…` | slug 里 `@` 也折叠成 `-`（`zxk-frp-oil-com`），hash 是 **6** 位十六进制（示例写成 4 位）；UNC 路径多一层 `unc` token（`…/unc/srv/share/a.ts`） | 示例里的 `@`/4 位 hash/`root/Users` 都是示意，实际串见 AGENTS.md 与 `src/mirror/path-mapper.ts:83-94,294-302`；`unc` token 是新增的第三种 root 形态（§5.1 只写了 "best-effort"） |
| A13 | §11.2 / §11.3 | `run-tests.mjs --dialect=posix\|windows\|both`，两方言各跑一遍全部套件 | 参数与默认值 `both` 已实现，但矩阵落在 runner 层：每个方言起一个 mock 服务，跑 `verify-mock-server` + 各自的 smoke（posix → `plugin-smoke.mjs`，windows → `plugin-smoke-windows.mjs`）；单元套件仍只跑一遍（`remote-path.mjs` 内部自己参数化两种方言） | windows 方言下 `verify-mock-server` 有 3 条 POSIX 形态检查（POSIX 重定向、`realpath("/")`）记为 SKIP，列入 `POSIX_ONLY_VERIFICATION`；`test/spike-windows.mjs` 不参与矩阵，只能单独运行 |
| A14 | §7.3 表"`patch` … `RemoteFs.unlink` + `rename`" | 删除走 unlink | `move to` 是真 rename；但 `*** Delete File` 仍然**写空文件**（`apply: () => ""`） | `SyncEngine.remove()` 已实现却未被 `patch` 调用；这是已知行为变更（AGENTS.md "Open Questions" 第 3 条），不是文档笔误 |
| A15 | §5.2 风险 S4 | 大小写冲突用 `~2`/`~3` 后缀并 warn | 已实现：碰撞键大小写折叠，冲突时给 basename 追加 `~2`、`~3`…，并记住正反映射 | 实测点见 `test/path-mapper.mjs`；实现见 `src/mirror/path-mapper.ts:190-231` |

### A.1 为什么模板里没有 `exit 0`（最重要的一条）

打开任何一份 PS 5.1 的资料都建议"脚本末尾显式 `exit`"，但在这里它是**有害**的：`exit` 会先拆宿主
再让 format engine flush，于是 `Get-Location` 这类输出在 stdout 被重定向（我们正是重定向）时整段
消失，模型看到的是一条空输出。正确的形状是：

```powershell
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }   # 只在失败时显式退出
                                                  # 成功时让进程自然结束 = 0，输出不丢
```

同一条实测还带来一个示例写法：脚本里要打印当前目录请用 `(Get-Location).Path`，不要用裸
`Get-Location`。

### A.2 为什么探测用 `where.exe pwsh`

§6.4 的 `Get-Command pwsh` 只有在"探测命令本身由 PowerShell 执行"时才对，而探测发生在方言与 shell
都还没确定的时刻：命令经由远端默认 shell（可能是 cmd，也可能是 sh）发出。`where.exe pwsh` 在
cmd 与 PowerShell 下语义一致（在 PowerShell 里必须带 `.exe`，裸 `where` 是 `Where-Object` 别名），
在 POSIX 上则根本不发这条命令。
