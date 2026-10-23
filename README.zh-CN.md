# 🌐 Remote Code

[English](README.md)

> **3.0.0 是破坏性版本。** 相对 2.x 有两处变化：
>
> 1. 远程可以是 **Windows**（OpenSSH for Windows + PowerShell 5.1/7），也可以是 **Linux / macOS**。
>    所有平台知识都收口在 `src/platform/`，7 个工具里不再出现任何平台假设。
> 2. **全部配置搬进插件的 `options`**（`opencode.jsonc`）。`REMOTE_*` 环境变量、`--remote*` 参数
>    和 `sudoPassword` 已删除——V2 的插件跑在后台共享服务里，继承不到你 shell 的环境变量。
>
> 从 2.x 升级请看 **[MIGRATION-V3.md](MIGRATION-V3.md)**（十分钟清单，英文）。
> 行为参考：**[AGENTS.md](AGENTS.md)**（英文）。设计稿：**[DESIGN-V3.md](DESIGN-V3.md)**。
> 历史文档：**[MIGRATION-V2.md](MIGRATION-V2.md)**（V1→V2 API 契约）、
> **[PORTING-NOTES.md](PORTING-NOTES.md)**（V1→V2 逐文件移植记录）。
>
> Fork 自 [zz6zz666/opencode-remote-code](https://github.com/zz6zz666/opencode-remote-code)。

一款 OpenCode 插件，让 AI Agent 能够通过 SSH 直接操控远程机器——**远程端零依赖**，仅需 SSH 守护
进程即可。无需在远程安装任何 agent、运行时或依赖。

对 AI 而言一切感知与本地无异：它调用的仍然是 `shell`、`glob`、`grep`、`read`、`write`、`edit`
和 `patch`（这些都是 OpenCode V2 的原生工具名），而每次调用都落在远端机器上。

---

## 💡 为什么需要 Remote Code？

我是一名模拟 IC 工程师。日常工作依赖 **Cadence IC6.1.7 设计套件**，它运行在一台古老的
**CentOS 6 虚拟机**上。CentOS 6 的 glibc 版本无法安装任何现代化 agent 工具，Node.js、
Python 3.11+ 甚至大多数现代 CLI 工具都无法运行。

我需要在本地 Windows 主机上使用 OpenCode 来操控这台虚拟机——自动化设计流程、批量修改原理图参数、
运行仿真脚本。**Remote Code** 让这一切成为可能：AI 以为自己在直接操作本地文件，实际上每个命令都在
那台古老的虚拟机上执行。

![pic](pic.png)

**无需触碰虚拟机上的任何一个文件，只需 SSH 服务在运行。**

| 场景 | 痛点 | Remote Code 的解法 |
| :--- | :--- | :--- |
| 老旧虚拟机（CentOS 6、RHEL 5） | 无法安装现代 agent | 仅需 SSH |
| 生产服务器 | 合规严格，禁止随意安装软件 | 远程不留任何痕迹 |
| 嵌入式 / 边缘设备 | 资源受限，无包管理器 | 所有智能逻辑在本地运行 |
| **远程 Windows 主机** | 装不了 agent，但 Windows 自带 OpenSSH | POSIX 与 Windows 目标统一入口 |
| 容器 / 临时环境 | 不想反复配置 | 即连即用，退出无残留 |

自 3.0.0 起，同一个插件也能驱动 **Windows** 目标：远端只需要 OpenSSH for Windows 和
PowerShell（Windows 10+ 自带 5.1），别的一概不需要。

---

## 🔌 独立 MCP Server

当前仓库是 **OpenCode 插件版**：
<https://github.com/zz6zz666/opencode-remote-code>

同一 GitHub 账号下也会有独立 MCP server 版本：
<https://github.com/zz6zz666/mcp-remote-code>

两个项目有相同的零侵入 SSH 动机，但面向不同工作流：

- **OpenCode 插件版**：深度绑定 OpenCode。它覆盖原生工具，把远端机器完全伪装成 agent
  workspace。运行时环境完全在远端，本地目录不会自然进入 agent 的普通视野。
- **MCP server 版**：向任意 MCP 客户端暴露带命名空间的 `remote_*` 工具。本地和远端工作可以并存，
  agent 可以在本地维护设计笔记或查找表，同时在 SSH 目标上执行远端命令、编辑、patch、pull、push
  和仿真任务。

---

## 📋 前置要求

- **OpenCode V2**（本分支面向 `@opencode/plugin` ^2.1.2）
- **Node.js ≥ 20**（Bun 亦可）——用于构建插件
- 远程机器上运行的 **SSH 服务**（**唯一的远程依赖**）
  - POSIX 远端：任意 `sh`/`bash` 登录 shell
  - Windows 远端：**OpenSSH for Windows** + PowerShell 5.1 或 7
- 服务端 OpenSSH **≥ 8.0**（旧服务器不再支持：插件直接信任 SSH 通道的退出码，不再从 stderr 猜）

> **注意**：本插件内部使用纯 Node.js 的 `ssh2` 库。你**不需要**在本地安装 `ssh`、`sshpass` 或
> `rsync`；远端也不需要 `rg`、`git`、`node`、`python`——`glob`/`grep` 是用 JavaScript 走
> SFTP 实现的。

---

## 🚀 快速开始

```bash
# 1. 取源码并构建（插件带运行时依赖，必须构建）
git clone https://github.com/zz6zz666/opencode-remote-code.git
cd opencode-remote-code
npm install
npm run build            # tsc + scripts/postbuild.cjs（把 src/prompts 拷进 dist/prompts）
```

```jsonc
// 2. 在 opencode.jsonc 里加插件——这是唯一配置远程模式的地方。
//    Linux / macOS 远端：
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-remote-code",
      "options": {
        "ssh": "ssh -p 22 user@192.0.2.10",
        "workdir": "/home/project",   // 可选，缺省 = 登录 home
        "password": "changeme"        // 或 "key": "~/.ssh/id_ed25519"
      }
    }
  ]
}
```

```jsonc
//    Windows 远端（OpenSSH for Windows）：
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
      "options": {
        "ssh": "ssh -p 48713 zhouxiaokang@frp-use.com",
        "workdir": "C:/Users/zhouxiaokang/proj",   // 必须带盘符
        "password": "***"
      }
    }
  ]
}
```

```bash
# 3. 重启 OpenCode（或后台服务），然后照常使用
opencode run "列出工作目录里的文件，并读一下 README"
```

就这样——远端不用装任何东西，不留任何状态。可选项：通过启动脚本运行，让会话始终绑定在稳定的本地
目录（见[会话持久化](#-会话持久化启动脚本)）。

`workdir` 在两种平台上都可以省略：插件用一次 SFTP `realpath(".")` 拿到登录 home。相对路径
（`proj`、`src/app`）和 `~` 都会按该 home 解析。

---

## 🔧 安装细节

### OpenCode V2 如何解析本地插件目录

这是"安装后毫无反应"最常见的原因：

1. **`package.json` 的 `main` / `exports` 被忽略。** 对本地路径，V2 只探测 `<dir>/server.js` 和
   `<dir>/index.js`。没有根目录 `index.js` 时条目会被丢弃，**连一行日志都没有**。因此本仓库自带
   一个提交进版本库的根 `index.js` 壳（`export * from "./dist/index.js"`）。
2. **路径必须是绝对路径，且位于 V2 真正会探测的盘符上。** Windows 上，如果插件目录与项目/配置不在
   同一个盘，同样会被静默忽略（实测：同一份拷贝放 `C:\…` 能加载，放 `D:\…` 从不尝试；指向 `D:` 的
   `C:` 联接点也不行，因为它会被 realpath）。请把真实拷贝放在你运行 OpenCode 的同一个盘上。
3. **只有条目是对象时 `plugins[].options` 才会传到插件**（`{ "package": …, "options": { … } }`）。
   `.opencode/plugins/` 下自动发现的插件拿到的是 `options: {}`——在 3.x 里这等于**休眠**，因为
   options 是唯一的配置来源。
4. **加载是懒的。** `opencode api …` / `opencode debug config` **不会**加载插件；真正加载的是
   `opencode run`（或 TUI）。打开 `"debug": true` 看 `~/.opencode/remote-code-debug.log`，或运行
   `opencode run --standalone --print-logs` 搜 `msg="loading plugin"`。

`opencode plugin add` 只接受 npm/Git 规格，本地 checkout 必须手写进 `plugins`。

### 拷贝安装（稳定，跨盘可用）

只要 checkout 与 OpenCode 同盘，直接引用源码路径即可。要更稳定的安装，把构建产物拷到全局配置旁边，
并在那里装运行时依赖：

```powershell
$dst = "$env:USERPROFILE\.config\opencode\remote-code"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item <repo>\index.js,<repo>\package.json -Destination $dst
Copy-Item <repo>\dist -Destination $dst -Recurse
Copy-Item <repo>\launchers -Destination $dst -Recurse
cd $dst; npm install --omit=dev   # ssh2 + diff（@opencode/plugin 由宿主提供）
```

然后把 `plugins[].package` 指向 `$dst`。**不要**把拷贝放到 `~/.config/opencode/plugins/`——那个目录
会被自动发现，插件会被加载两次（其中一次没有 options，即休眠）。

POSIX 主机把 `Copy-Item` 换成 `cp -r`，其余相同。

---

## 🎯 配置

远程模式由插件的 **`options`** 激活，别无他物：不读环境变量，不读 argv。既没有 `ssh` 也没有
`host` 时插件完全**休眠**——不建 SSH 连接、不注册工具、不写文件，OpenCode 完全按本地模式运行。

配置**有错**时（ssh 串解析失败、结构化字段相互冲突、ssh2 无法模拟的 SSH 特性），插件会向 stderr
打印一行 `[remote-code] …` 然后保持休眠。它永远不会把 OpenCode 弄崩。

### `ssh` 串

`ssh` 就是一条你会在终端里敲的命令字符串。它是被**解析**的，从不被执行——真正连接的是 `ssh2`；
凡是 ssh2 无法模拟的选项都会**报错**，而不是被静默忽略。

```jsonc
"ssh": "ssh -p 2222 -i C:/Users/me/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new me@host"
```

| 支持的写法 | 说明 |
| :--- | :--- |
| `ssh`、`ssh.exe`、`/usr/bin/ssh`、`C:\…\ssh.exe` | 程序名被丢弃 |
| `user@host`、`host`、`user@[::1]` | 位置参数目标 |
| `-p 2222`、`-p2222`、`--port 2222`、`--port=2222` | 端口（默认 22） |
| `-i ~/.ssh/id_ed25519`、`-i/path/key`、`--identity <path>` | 私钥文件；`~` 在本地展开 |
| `-l user`、`-luser` | 用户名 |
| `-o Key=Value`、`-oKey=Value` | 白名单：`StrictHostKeyChecking`、`UserKnownHostsFile`、`ConnectTimeout`、`ServerAliveInterval`、`ServerAliveCountMax`、`HostKeyAlgorithms`、`IdentitiesOnly` |
| `ssh://user@host:2222` | URL 形式（URL 里的密码会被拒绝，URL 里的路径会被忽略并告警） |
| `'…'` / `"…"` | 带空格的路径加引号；引号外反斜杠是字面量，所以 `C:\Users\me\id_rsa` 可用 |

故意忽略：无害开关（`-4 -6 -A -a -C -f -K -k -N -n -q -s -T -V -v -X -x -Y -y`）与 `-F <config>`
（ssh2 不读 `ssh_config`——请把需要的内容翻译成白名单 `-o`）。未知 `-o` 键只告警一次然后丢弃。

**硬报错**（错误信息里直接给出替代做法）：

| 拒绝项 | 请改用 |
| :--- | :--- |
| `-J`、`-ProxyJump`、`-o ProxyJump=…` | 另开窗口 `ssh -N -L 2222:<目标host>:22 <跳板user>@<跳板host>`，然后 `host: "127.0.0.1"`、`port: 2222` |
| `-o ProxyCommand=…` | 在插件外把代理起来，把 `host`/`port` 指向本地端点 |
| `-L`、`-R`、`-D`、`-o LocalForward` / `RemoteForward` / `DynamicForward` | 自己另开终端做端口转发；插件不需要 |
| `-t`、`-tt`、`-o RequestTTY` | 每条远端命令都在无 pty 下运行，交互式 shell 只会挂住；请用真实终端 |

结构化写法（与字符串二选一）：

```jsonc
{ "host": "192.0.2.10", "port": 22, "user": "me",
  "key": "C:/Users/me/.ssh/id_ed25519", "password": "***" }
```

两种写法同时存在且在 host / port / user / 私钥上**不一致**时，`loadConfig()` 直接抛错，而不是替你
挑一个。

### 配置项参考

别名由 `src/config.ts` 的 `OPTION_KEYS` 解析（camelCase 为准，kebab-case 亦可）。

| 含义 | 配置键 | 默认值 |
| :--- | :--- | :--- |
| SSH 命令串 | `ssh`、`sshCommand`、`ssh-command` | —（与 `host` 二选一必填） |
| 主机 | `host` | 与 `ssh` 二选一必填 |
| 端口 | `port` | `22` |
| 用户 | `user` | 本地 OS 用户名 |
| 私钥 | `key`、`identityFile`、`identity`、`keyFile`、`key-file`、`identity-file` | 无 → ssh-agent / 密码 |
| 密码 | `password` | 无 |
| 远端工作目录 | `workdir`、`remoteWorkdir`、`remote-workdir`、`remote_workdir` | 登录 home（SFTP `realpath(".")`） |
| 平台 | `platform` | `"auto"`（`auto` \| `windows` \| `posix`） |
| Shell | `shell` | `"auto"` → 找到则 `pwsh.exe`，否则 `powershell.exe`（Windows）；`bash`（POSIX） |
| 本地镜像根 | `mirror`、`mirrorRoot`、`mirror-root` | `~/.opencode/mirrors` |
| 调试日志 | `debug` | `false` → `~/.opencode/remote-code-debug.log` |
| ignore 名单 | `ignore` | **追加**到内置名单（不会替换） |
| 工具限额 | `limits` | 见下表 |
| `shell` 默认超时 | `timeout` | `120000` ms |
| 连接池 | `pool` | `{ "command": 3, "file": 4, "stagger": 0 }` |
| 激活作用域 | `activateIn`、`activate-in` | `[]` = 永远激活；否则为一个本地目录或目录数组（见下文「本地与远端共用一份配置」） |

`limits` 键与默认值（`src/limits.ts`；数字也可写成字符串）：

| 键 | 默认值 | 作用域 |
| :--- | :--- | :--- |
| `globResults` | `100` | `glob` 结果上限 |
| `searchMatches` | `100` | `grep` 命中上限 |
| `searchBytes` | `67108864`（64 MiB） | `grep` 实际读取总量 |
| `searchFileSize` | `2097152`（2 MiB） | `grep` 单文件跳过阈值 |
| `searchMillis` | `45000` | `grep` 墙钟时间 + `glob`/`grep` 的遍历预算 |
| `walkDepth` | `12` | `glob` + `grep` 遍历深度 |
| `walkEntries` | `20000` | `glob` + `grep` 访问的目录项数 |
| `shellTimeout` | `120000` | `shell`（被 `timeout` 覆盖） |

内置 ignore 名单（20 项，按任意深度的目录**名**匹配）：`node_modules`、`.git`、`.hg`、`.svn`、
`dist`、`build`、`out`、`target`、`.venv`、`venv`、`vendor`、`__pycache__`、`.next`、`.cache`、
`.turbo`，以及卷根噪音 `$RECYCLE.BIN`、`System Volume Information`、`Windows.old`、
`.pnpm-store`、`.Trash`。仅在远端为 Windows 时大小写不敏感。后五项存在的原因：远端工作区经常
就是登录 home（甚至整个盘），这些目录里塞着上万条无关条目，会把遍历预算烧在无关的树上。

已删除的键仍会得到一次明确提示：`sudoPassword` → `console.warn`（插件从不提权）；
`jump` / `proxyJump` / `proxyCommand` → 硬报错。

### 本地与远端共用一份配置（`activateIn`）

七个工具都是**按名覆盖内置工具**，所以插件一旦活跃，这个会话就**完全没有本地文件访问能力**
——不存在第二个指向你自己磁盘的 `read`。对专用远端配置这没问题，但正因如此，一份全局
`opencode.jsonc` 会很难受：远端一开，本地项目的原生工具就没了。

`activateIn` 把「是否激活」收敛到**本地目录作用域**，于是一份配置能两头兼顾：

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/WIN11/.config/opencode/remote-code",
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

- 会话目录在其前缀之内 → 七个远端工具照常注册。
- 之外 → `setup()` 打一行日志就返回：插件**休眠**，模型看到的就是 OpenCode 原生本地工具。
- 接受单个字符串或数组，展开 `~`，忽略尾部分隔符。
- 匹配是**边界安全**的（`…/remote-sessions-archive` **不**算在 `…/remote-sessions` 之内），
  且仅在 Windows 上大小写不敏感。
- 拿不到会话目录时一律判为**外部**——猜错会静默剥掉会话的本地工具。
- 缺省/空数组 = 永远激活（3.0.0 的行为）。

它与启动脚本天然咬合：脚本按「主机 + 远端目录」固定一个本地会话目录
（`~/.opencode/remote-sessions/<host>_<workdir-slug>/`），于是**一份**配置就能做到「启动脚本
起的会话里是远端工具，其它目录全是原生本地工具」。故意**不**提供 `coexist: true`（注册但不
覆盖）模式：两套同名工具会让模型随机挑一个，然后在错的机器上执行。

### Windows 远端与 `workdir`

远端平台由**一次 SFTP `realpath(".")`** 判定：`/C:/Users/x` → `windows`，`/home/x` → `posix`。
探测无法判断时（被 chroot 的 SFTP 服务、容器）用 `"platform": "windows"` / `"posix"` 钉死。

`workdir` 在探测**之后**才校验，因为两种平台的形状规则不同：

| 输入 | POSIX 远端 | Windows 远端 |
| :--- | :--- | :--- |
| 省略 | 登录 home | 登录 home |
| `/Users/x/proj` | 可用 | **报错**——无盘符绝对路径 |
| `C:/Users/x/proj` | 报错——不是绝对路径 | 可用 |
| `c:/users/x/proj` | — | 可用 → `C:/users/x/proj`（盘符转大写，其余保留原大小写） |
| `C:foo` | — | **报错**——盘符相对路径 |
| `proj`、`src/app`、`~`、`~/proj` | 按登录 home 解析 | 按登录 home 解析 |

Windows 的拒绝信息特意写得明确：

```
workdir "/Users/me/proj" is not an absolute Windows path: a drive letter is required
(e.g. "C:/Users/me/project"). Drive-relative ("C:foo") and drive-less ("/Users/x") forms
are not supported because their meaning depends on the shell's current drive.
```

---

## 🖥️ 平台支持

| | Linux / macOS | Windows（OpenSSH for Windows） |
| :--- | :--- | :--- |
| 探测 | `realpath(".")` → `/home/x` | `realpath(".")` → `/C:/Users/x` |
| Shell（仅 `shell` 工具） | `bash`，`cd '<cwd>' && <script>` | `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(UTF-16LE)>` |
| Shell 发现 | 不变（沿用登录 shell） | `where.exe pwsh` → PowerShell 7，否则 PowerShell 5.1（底线） |
| 其余所有工具 | SFTP | SFTP（线上形态 `/C:/…`） |
| 远端要求 | `sshd` + POSIX shell | `sshd`（Win32-OpenSSH）+ PowerShell 5.1/7 |

方言不只是形式：它决定工具描述（`Execute commands in <shellName> on the remote machine.`）和
system prompt 里的提示段，从而让模型在 Windows 上不再写 `ls -la`、`cat`、`cd x && y`。输出先按
UTF-8 解码，出现替换字符时整段回退 `gb18030`（中文 Windows 输出 CP936），并清洗 PowerShell 的
CLIXML 错误序列化。超长脚本（base64 > 6000 字符）会经 SFTP 暂存为 `%TEMP%/oc-<hex8>.ps1` 并在用
完后删除。

---

## ⚙️ 工作原理

### 一条不变量，三层结构

> **只有 `shell` 碰远端 shell。`glob`、`grep`、`read`、`write`、`edit`、`patch` 全走纯 SFTP。**

正是这条规则让"支持两种平台"变得付得起：

| 层 | 文件 | 职责 |
| :--- | :--- | :--- |
| **Platform** | `src/platform/*` | `RemotePathOps`（POSIX / Windows 路径语义）、`RemoteDialect`（脚本 → 一条 exec 命令、字节→文本解码、提示段）、平台/shell/home 探测 |
| **Remote** | `src/remote/*` | 基于 SFTP 的 `RemoteFs`、有界树遍历、ripgrep 风味 glob 匹配器、grep 引擎 |
| **Mirror** | `src/mirror/*` | 远端↔本地 namespace 映射、manifest v2、按文件 pull/push |

规范远端路径永远是"绝对 + `/` 分隔 + Windows 带盘符"（`C:/Users/x/proj/src/a.ts`）。反斜杠只在
**输入归一化**时出现，随即被消掉。

### 本地镜像

只镜像 AI 真正触碰过的文件，目录按目标派生：

```
~/.opencode/mirrors/<slug>-<hash6>/<drive-or-root>/<远端分段…>

POSIX    /home/zxk/proj/src/a.ts
      →  ~/.opencode/mirrors/zxk-frp-oil-com-4c1f2a/root/home/zxk/proj/src/a.ts
Windows  C:/Users/zhouxiaokang/proj/src/a.ts
      →  ~/.opencode/mirrors/zhouxiaokang-frp-use-com-9a3d1b/C/Users/zhouxiaokang/proj/src/a.ts
```

`slug` 是 `user@host` 转小写、非字母数字串折叠成 `-`；`hash6` 是 `sha256("user@host:port")` 的前
六位十六进制，因此同主机的不同端口（或不同用户）永不共用 namespace。字面量 `root`（POSIX）与
`unc`（UNC 路径）让工作区内、外路径共用同一套规则。

### 同步引擎（manifest v2，按文件）

`read`、`write`、`edit`、`patch` 在本地镜像上操作，并且**一次只同步一个文件**——V2 时代的
`pullAll()` / `pushAll()` 全量扫描已删除：

```
ensureLocal(remote)   stat → 是目录？建本地目录
                      → 不存在？建一个空的本地文件
                      → manifest 的 size+mtime 命中且本地副本存在？跳过
                      → 否则：SFTP readFile → 写本地 → 登记

commit(remote)        读本地 → SFTP mkdirp(父目录) → writeFile → stat → 登记 → 存盘
```

`manifest.json`（version 2）位于 namespace 内部，为每个远端路径记录 `{ local, size, mtime }`，
其中 size/mtime 是**上一次成功传输时远端**的值。manifest 丢失或格式不符只会多传一次。每次启动都会
清空整个 namespace（正确性优先于缓存）。

### SSH 连接

`ssh2` 连接池，无任何外部二进制：

- **命令池**（`pool.command`，默认 3）：`shell` 执行，外加一次性的 `where.exe pwsh` 探测。
- **文件池**（`pool.file`，默认 4）：所有 SFTP 会话。取 4 而非 2 的原因：`walk()` 会并发发
  8 个 `readdir`，在隧穿链路上（单次往返 0.3–0.8 s）2 条连接几乎把并发全部串行化了。
- **`pool.stagger`**（默认 0 ms）：为不喜欢连接突发的服务器拉开握手间隔。

`"debug": true` 追加写入 `~/.opencode/remote-code-debug.log`；绝不记录敏感信息
（只有 `auth=password|key|agent`，从不记密码或私钥路径）。

---

## 📊 工具行为矩阵

7 个工具全部是**按名字覆盖 OpenCode V2 内置工具**的插件工具（`shell` / `patch` / `read` /
`write` / `edit` / `glob` / `grep`——V1 的 `bash` / `apply_patch` 在 V2 中不存在）。

| 工具 | 通道 | 行为 | 限额 |
| :--- | :--- | :--- | :--- |
| `shell` | SSH exec（方言） | `workdir` 缺省为工作区根；超时被报成独立的失败（`Command timed out after <n>ms`），与非零退出区分；退出码为准 | `timeout`（默认 120 s） |
| `glob` | SFTP 遍历 | `*`、`?`、`**`、`**/`、`{a,b}`、`[abc]`/`[!abc]`；不含 `/` 的模式匹配**文件名**；反斜杠视为分隔符；结果按 mtime 降序 | 深度 12 / 20 000 项 / 100 条 |
| `grep` | SFTP 读取 | JavaScript `RegExp` 方言；开头 `(?i)` / `(?m)` / `(?s)` 提升为 flag；`include` 是对遍历相对路径的 glob；结果按遍历顺序、按文件分组，格式 `Line <n>: <text>` | 100 命中 / 64 MiB / 单文件 2 MiB / 45 s |
| `read` | SFTP + 镜像 | `stat` → 是目录？`readdir` 列表（目录带 `/`，符号链接带 `@`）→ 不存在？同目录"你是指"→ 二进制闸门（前 8 KiB 的 NUL + 扩展名黑名单）→ `ensureLocal` → 读**本地**副本，保证与 `write`/`edit` 看到的一致 | 2000 行 / 50 KB 输出 / 每行 2000 字符 |
| `write` | 镜像 + 单文件推送 | 保留文件自身行尾（新文件用 `\n`），保留 BOM，权限请求里带 unified diff 预览 | — |
| `edit` | 镜像 + 单文件推送 | 完整的 OpenCode 原生替换器集合，按文件加锁，保留 CRLF | — |
| `patch` | 镜像 + 单文件推送 | 原生 `*** Begin Patch` **或** unified diff；按 LF 解析、按各目标自身行尾写回；"move to" 走真正的 SFTP rename | — |

截断从不静默：任何预算触发都会附加一句提示，让模型缩小 pattern 或路径；`glob` 只在遍历真正跑完时
才输出 "No files found"。

---

## 🧭 会话持久化：启动脚本

OpenCode 的会话与**本地工作目录**（`process.cwd()`）绑定。从不同本地文件夹启动，远程会话看起来就
"消失"了。

`launchers/remote-opencode.{sh,ps1,bat}` 会根据 **host + 远端 workdir** 派生一个**稳定的本地会话
目录**，然后在那里启动 `opencode`：

```
~/.opencode/remote-sessions/<host>_<workdir-slug>/
```

启动脚本**不配置远端**——那是 `opencode.jsonc` 与插件 `options` 的事。它们接受
`--ssh "<ssh 命令>"` / `--workdir "<远端路径>"`（旧的 `REMOTE_SSH` / `REMOTE_WORKDIR` 环境变量名
同样可用），这些值**只**用于给目录命名。无法识别的参数原样转发给 `opencode`，`--` 之后的一切也全部
转发。缺值时不算错误：用 `unknown` / `no-workdir` 占位并照常启动。

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

workdir slug 既要能吃 Windows 路径也要能吃 POSIX 路径（这正是 3.0.0 里启动脚本改动的原因）：

| 输入 | slug |
| :--- | :--- |
| `/home/x/proj` | `home_x_proj` |
| `C:/Users/x/proj` | `C_Users_x_proj` |
| `C:\Users\x\my proj` | `C_Users_x_my_proj` |
| `D:/a//b///c` | `D_a_b_c` |
| `/` 或空 | `root` |

规则：反斜杠 → `/`；去掉开头的盘符冒号；`[A-Za-z0-9._-]` 之外的连续字符折叠成单个 `_`；去掉首尾
`_`。`/`（或 slug 后为空的 workdir）会变成 `root`；完全**没有** workdir 时用占位名 `no-workdir`。

---

## 🔒 安全边界

- **路径安全**：`PathMapper.toLocal()` 在解析出的本地路径逃出镜像 namespace 时直接抛错；相对路径与
  含 NUL 的远端路径被拒绝；`toRemote()` 拒绝 namespace 根。Windows 主机上超过 250 字符的本地镜像
  路径会加 `\\?\` 前缀。
- **工作区边界**：`RemotePathOps.contains()` 边界安全，且在 Windows 上折叠大小写，因此
  `C:/Users/X/…` 不会被误判为"工作区外"。工作区外路径统一走 OpenCode 自己的权限确认
  （`src/v2-bridge.ts` 封装 V2 的 `ctx.permission.assert`）。
- **命令安全**：`shell` 的脚本作为**数据**交给方言——POSIX 下只插值被引号包住的 `cwd`，Windows 下
  整个脚本只走 base64。
- **权限边界**：远端操作权限与 SSH 用户一致，插件从不提权（这也是 `sudoPassword` 被删的原因）。
- **日志不含机密**：`debug` 日志只记 `auth=password|key|agent`，从不记密码或私钥路径。

---

## ⚠️ 局限性

| 局限 | 影响 | 缓解 |
| :--- | :--- | :--- |
| 无远程 LSP | 远程文件没有语言服务器诊断（插件工具拿不到 OpenCode 的 LSP 服务） | 对主要用途可接受；将来可做 LSP-over-SSH |
| 大文件首次访问 | 第一次 `read`/`edit` 大文件要付一次 SFTP 传输 | 远端 `size`+`mtime` 未变时跳过（manifest v2） |
| SFTP 遍历速度 | 超大仓库上 `glob`/`grep` 比 `rg` 慢（设计如此：单一语义、远端零依赖） | 预算 + 明确的截断提示；缩小路径或 pattern |
| 混编 CP936/UTF-8 | 同一流里既有 UTF-8 原生命令又有 GBK 原生程序时无法完美复原 | 整段回退；提示词引导用 PS 原生命令 |
| 并发会话 | 同一远端目录的两个会话共用镜像 namespace，跨会话后写覆盖 | 会话内按文件加锁；建议一个目标一个会话 |
| `patch` 删除 hunk | 删除 hunk 会写成空文件而不是 unlink | 已知缺口（`SyncEngine.remove()` 已存在）；目前可用 `shell` 删除 |
| UNC 路径 | 接受并在 `unc` token 下镜像，但未在真实 SMB 后端 OpenSSH 上实测 | 按 best-effort 对待 |
| 旧 SSH 服务器 | OpenSSH < 8.0、仅支持 `ssh-rsa`/SHA-1 主机键的服务器不再支持 | 升级服务端，或前面套一层现代隧道 |

---

## 🧪 测试

```bash
npm run build
node test/run-tests.mjs          # 等价于 npm test
```

一条命令离线跑完全部：先把单元套件作为子进程跑一遍，然后对每个方言起一个进程内 mock SSH 服务器
（`ssh2.Server`，密码认证 + 真 SFTP），跑 mock 一致性检查与插件冒烟测试。最后打印
`total: PASS=… FAIL=… SKIP=…`，有任何失败则退出码非零。

| 参数 | 作用 |
| :--- | :--- |
| `--dialect=posix\|windows\|both` | 跑哪种远端方言（默认 `both`） |
| `--skip-slow` | 跳过 `test/ssh-pool-lifecycle.mjs`（约 25 s 的连接计时器） |
| `--skip-plugin` | 不加载 `dist/index.js`（只跑单元 + mock 服务器检查） |
| `--verbose` | 打印每条 SSH/SFTP 请求与子套件的完整输出 |

开发机是 Windows 且装有真实的 PowerShell 5.1，所以 `windows` 方言会把插件生成的
`-EncodedCommand` 交给真正的 `powershell.exe` 执行，而 SFTP 用 `/C:/…` 形态操作真实目录——方言、
路径映射、解码、退出码都在本地被真实覆盖。每个套件也可单独运行（`node test/<suite>.mjs`）；
mock 的路径映射与已知限制见 [`test/README.md`](test/README.md)。

---

## 📄 许可

MIT
