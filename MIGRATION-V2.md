# 移植契约：OpenCode V1 插件 API → V2 插件 API

> **历史文档（仅描述 V1 → V2 的 API 契约，对应 2.x）**
> 3.0.0 之后仓库已重构为跨平台版本（POSIX + Windows、`glob`/`grep` 走纯 SFTP、配置只走插件
> `options`）。本文里的 `REMOTE_*` 环境变量、`pullAll`/`pushAll`、`src/tools/bash.ts`、
> `src/test-e2e.ts` 等描述**已不适用于当前代码**：升级请看 [`MIGRATION-V3.md`](MIGRATION-V3.md)，
> 当前行为见 [`AGENTS.md`](AGENTS.md)。文中 V2 的插件 API 契约（`Plugin.define({ id, setup })`、
> `ctx.tool.transform`、`ctx.permission.assert`、`{ content, metadata }` 返回形态）依然成立。

本文件由主 agent 实测得出，是移植的唯一依据。**不要凭记忆猜测 API**，有疑问就按本文或去查
`node_modules/@opencode/plugin/dist/**/*.d.ts`。

## 0. 环境事实（已实测）

- 本机 OpenCode 版本：`v2.1.0`
- V2 插件包：`@opencode/plugin@2.1.2`（已作为 devDependency 安装在本仓库）
- V1 插件包：`@opencode-ai/plugin@1.19.3`
- **V1 插件在 V2 上无法运行**。实测报错：
  ```
  PluginModule.LoadError: Plugin must export a default definition with an id and an
  effect or setup function. (cause: SchemaError(Missing key at ["default"]["effect"]
  / Missing key at ["default"]["setup"]))
  ```
  所以 `{ id, server }` 和 `(input, options) => Hooks` 两种 V1 形态都必须换掉。

## 1. 入口形态

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "remote-code",          // 稳定 ID，插件 storage 也按它隔离
  async setup(ctx) {
    // 初始化
    return () => { /* 清理：关 SSH 池、存 manifest */ }
  },
})
```

- `setup` 返回的函数在插件卸载时执行，替代 V1 的 `dispose`。
- `ctx` 同时是 client + 扩展 API。

## 2. 上下文映射

| V1 | V2 |
|---|---|
| `input.directory` | `ctx.location.directory` |
| `input.project` | `ctx.location.project` |
| `input.client` | `ctx.session` / `ctx.tool` / `ctx.permission` 等 |
| `options` 第二参数 | `ctx.options` |
| 返回 `{ dispose }` | `setup` 返回清理函数 |
| 返回 `{ event }` | `ctx.event.subscribe({ signal })` |
| 返回 `{ tool }` map | `ctx.tool.transform(editor => editor.add(...))` |
| `$` (Bun shell) | 自己用 node 的 child_process |

## 3. 工具注册（关键）

`ctx.tool.transform` 的回调**必须同步**；`execute` 返回 Promise 即可（Promise 插件适配器会包成 Effect）。

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: "shell",
    description: "Execute commands in a bash shell on the remote machine.",
    input: {                                  // 注意：JSON Schema，不是 zod
      type: "object",
      properties: {
        command: { type: "string", description: "..." },
        timeout: { type: "number", description: "..." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      // input 是已按 schema 解码的值
      return { content: "文本给模型看", metadata: { ... } }
    },
  })
})
```

### 3.1 工具返回值形态

```ts
interface Result {
  readonly output?: any              // 结构化值（可选）
  readonly content?: string | ReadonlyArray<Content>   // 模型可见内容
  readonly metadata?: Record<string, any>
}
type Content = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }
```

旧代码返回的 `{ title, output: "字符串" }` 要改成 `{ content: "字符串", metadata }`。
`title` 在 V2 没有对应字段，丢掉即可（或塞进 `metadata.title`）。

### 3.2 V2 内置工具名（已实测 `ctx.tool.list()`）

```
patch, edit, glob, grep, read, shell, write, question, skill, subagent,
webfetch, websearch, todo, opencode_*
```

- **`bash` → `shell`**
- **`apply_patch` → `patch`**
- `read` / `write` / `edit` / `glob` / `grep` 同名

用 `editor.add({ name: "shell", ... })` 覆盖同名的内置工具**是可行的**，已实测：覆盖后
`ctx.tool.list()` 里 `shell` 的 description 变成插件提供的值。

## 4. 权限申请

V1（原代码里 7 处 `ctx.ask`）：

```ts
await ctx.ask({ permission: "edit", patterns: [p], always: [p], metadata: { diff } })
```

V2：

```ts
await ctx.permission.assert({
  sessionID: context.sessionID,          // 必填
  action: "edit",                        // V1 的 permission 值
  resources: [p],                        // V1 的 patterns
  save: [p],                             // V1 的 always
  metadata: { diff },                    // 可选
  source: { type: "tool", messageID: context.messageID, id: context.id },  // 可选
})
```

V2 的 action 命名：`read` / `edit` / `shell` / `subagent` / `glob` / `grep` / `webfetch` /
`websearch` / `skill` / `question` / `external_directory`。原代码用的 `read`、`edit` 直接沿用。

注意：V2 默认 `external_directory` 是 **allow**（V1 是 ask）。如果想让工作区外的路径弹窗，
需要在文档里提示用户加配置，或者插件自己用 action `external_directory` 显式 assert。
本次移植保持原语义：工作区外才 assert，不额外改行为。

## 5. system prompt 注入

V1：

```ts
"experimental.chat.system.transform": async (input, output) => { output.system.push("...") }
```

V2：

```ts
await ctx.session.hook("context", (event) => {
  // event.system: Array<SystemPart>
  // SystemPart = { type: "text"; text: string; cache?; metadata? }
  event.system.push({ type: "text", text: "..." })
})
```

要点：

- `event.system` 是**对象数组**，不是字符串数组。原代码 `output.system.findIndex(s => s.includes(...))`
  必须改成 `s.text.includes(...)`。
- 原代码是**整体替换** system（只保留 title generator）。V2 里就地改：`event.system.length = 0`
  然后 `push(...)`，等价。
- hook 返回同步即可；`ctx.session.hook` 本身是 await 的。

## 6. 事件

V1：`event: async ({ event }) => { if (event.type === "session.deleted") ... }`

V2：`ctx.event.subscribe({ signal })` 返回 `AsyncIterable<OpenCodeEvent>`。

```ts
const controller = new AbortController()
void (async () => {
  for await (const event of ctx.event.subscribe({ signal: controller.signal })) { ... }
})()
return () => controller.abort()
```

**注意**：V2 的事件 type 字符串与 V1 不保证一致（本 agent 未能在 v2 schema 里确认
`session.deleted` 是否存在）。原代码在 `session.deleted` 里只做两件事：`manifest.save()` +
`sshPool.close()`。这两个都可以放进 `setup` 返回的清理函数，因此**建议直接删掉事件订阅**，
不要赌事件名。

## 7. 配置来源（重要，会改变用户使用方式）

原实现：`loadConfig()` 读 `process.env.REMOTE_SSH` 等 + `process.argv` 的 `--remote*`。

实测问题：**V2 插件跑在后台共享服务里，shell 里 export 的环境变量传不进去**。
实测 `opencode api ...`（走后台服务）时 `process.env.REMOTE_SSH === null`；
只有 `opencode run --standalone`（私有服务）才拿得到。

因此移植后：**以 `ctx.options` 为主**，环境变量和 argv 作为兼容回退。

```jsonc
// opencode.jsonc
{
  "plugins": [
    {
      "package": "/abs/path/to/dist-or-package",
      "options": {
        "ssh": "ssh -p 22 user@host",
        "workdir": "/home/project",
        "password": "***",
        "sudoPassword": "***",
        "mirror": "~/.opencode/mirrors"
      }
    }
  ]
}
```

兼容别名：`ssh` / `workdir` / `password` / `sudoPassword` / `mirror`，
同时接受 kebab-case（`sudo-password`）、env（`REMOTE_SSH` / `REMOTE_WORKDIR` /
`REMOTE_PASSWORD` / `REMOTE_SUDO_PASSWORD` / `REMOTE_MIRROR`）和旧的 `--remote-*` argv。

**未配置时必须保持 dormant**：`setup` 里配置为空就 return，不要连 SSH，不要注册任何工具，
让 OpenCode 保持本地模式。这一点是硬要求。

## 7.1 本地插件「目录形式」的加载规则（实测 v2.1.0，踩坑记录）

把 `package` 写成仓库/目录路径时，V2 的 `PluginModule` 只探测 `<dir>/server.js` 与
`<dir>/index.js` 两个入口，**完全忽略 `package.json` 的 `main` / `exports`**。入口不在目录根时：
一行日志都没有（连 `failed to load plugin` 都不打），插件静默失效。

实测过程（同一台机器，同一份代码）：

| 变体 | 结果 |
|---|---|
| 目录只含 `package.json` + `dist/`（`main: dist/index.js`） | 静默跳过，无任何日志 |
| 目录含根 `index.js`（`export * from "./dist/index.js"`） | `msg="loading plugin"` + 正常加载 |
| 同上但目录在 `D:`（配置/项目在 `C:`） | 静默跳过（junction 指到 `D:` 同样被跳过，估计被 realpath） |
| 同上但在 `C:` | 正常加载 |
| `package` 直接写成 `.../dist/index.js`（文件形式） | 本次未复现成功场景，按目录+根 `index.js` 落地 |

结论（已固化到仓库）：

- 仓库根必须有 `index.js`（本仓库已有，`test/plugin-entry.mjs` 覆盖）。
- Windows 上安装目录必须和 OpenCode 项目在**同一盘符**；不能靠 junction / 符号链接跨盘。
- `opencode plugin add` 只吃 npm/git spec，本地目录只能手写进 `plugins`。
- 插件加载是**懒触发**的：`opencode api ...`、`opencode debug config` 都不会加载插件，
  必须跑一次真实会话（`opencode run --standalone --print-logs` 最方便观察）。

## 8. package.json 需要修的地方

1. 上游 `dependencies` 键**写了两遍**，第二个覆盖第一个，导致 `diff` 丢失、`npm run build` 直接失败
   （`TS2307: Cannot find module 'diff'`）。必须合并成一个。
2. `peerDependencies`: `"@opencode-ai/plugin": ">=1.15.0"` → `"@opencode/plugin": "^2.1.2"`。
3. 因为工具用**纯 JSON Schema**（不用 effect Schema），所以**不需要** `effect` 依赖。
4. `main` / `exports` 指向 `dist/index.js` 不变；`exports` 里 `./server` 这个入口名是 V1 遗留，
   V2 用默认导出即可，可以保留也可以删。
5. `tsconfig.json` 里的 `paths` 把 `@opencode-ai/plugin` 指到本地 shim，要删掉；
   `src/types/plugin-shim.ts` 整个删除。
6. `scripts/postbuild.cjs` 里把 `@opencode-ai/plugin` 改写成本地 shim 的逻辑**必须删掉**，
   否则 `dist` 里的工具会 import 一个已删除的文件。

## 9. 不要动的东西

以下模块和 SSH/v2 API 无关，逻辑保持原样：

`ssh-pool.ts`（除配置入参）、`sync-engine.ts`、`path-mapper.ts`、`manifest.ts`、`bom.ts`、
`diff-utils.ts`、`shell-quote.ts`、`remote-system-prompt.ts`、`tools/*.ts` 的内部实现。

特别保留这些已处理过的老机器兼容逻辑，别"优化"掉：
- `bash.ts` 里 CentOS 6 / OpenSSH 5.3 退出码不可靠的 stderr 启发式判定
- SSH 噪声过滤 `SSH_NOISE_PATTERNS`（含 post-quantum 警告那几条）
- `glob`/`grep` 的 `rg` 优先 + `find`/`grep` 回退
- `read` 的二进制度检测（扩展名 → `file -b` → `dd`+`od` 空字节）
- BOM 保留语义
