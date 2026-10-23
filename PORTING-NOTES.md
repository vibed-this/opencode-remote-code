# 移植笔记：OpenCode V1 插件 API → V2 插件 API

本文件记录 `opencode-remote-code` 从 V1（`@opencode-ai/plugin`，`(input, options) => Hooks`）到
V2（`@opencode/plugin@2.1.2`，`Plugin.define({ id, setup })`）的移植结果。契约依据是仓库里的
`MIGRATION-V2.md`。

**结论：`npm run build` 零错误，`dist/` 完整；7 个工具以 V2 原生形态注册；未配置时完全 dormant；
在 `test/` 里的假 SSH 服务器上端到端跑通（setup / 7 工具注册 / shell 走真 SSH exec / write-edit-patch
走真 SFTP / system prompt 注入 / cleanup）。**

---

## 1. 文件改动一览

| 文件 | 改动 |
| --- | --- |
| `src/index.ts` | 重写入口：`Plugin.define({ id, setup })`；`ctx.options` 取配置；工具用 `ctx.tool.transform` 注册；system prompt 用 `ctx.session.hook("context")`；清理函数替代 `session.deleted` 事件 |
| `src/v2-bridge.ts` | **新增**。V2 上下文类型桥 + `createPermissionGateway()`（V1 `ctx.ask` 的替身）+ 工具/返回值的框架无关类型 |
| `src/config.ts` | 配置来源改为 `ctx.options` > env > argv；新增 kebab-case / camelCase 别名与 `describeConfigSources()`；解析逻辑本身未动 |
| `src/tools/bash.ts` | 只改外壳；**工具名 `bash` → `shell`**；stderr 启发式与 `SSH_NOISE_PATTERNS` 原样保留 |
| `src/tools/glob.ts` | 只改外壳（`rg` 优先 + `find` 回退原样保留） |
| `src/tools/grep.ts` | 只改外壳（`rg --json` + `grep -rn` 回退原样保留），`formatGrepResult` 返回值改成 `{content, metadata}` |
| `src/tools/read.ts` | 只改外壳（二进制度三段检测、目录列举、BOM 语义原样保留）；1 处 `ctx.ask` → `permission(...)` |
| `src/tools/write.ts` | 只改外壳（BOM 合并、diff 预览原样保留）；2 处 `ctx.ask` → `permission(...)` |
| `src/tools/edit.ts` | 只改外壳（9 个 replacer、per-file 锁、diff 预览原样保留）；2 处 `ctx.ask` → `permission(...)` |
| `src/tools/patch.ts` | 只改外壳（native/unified 两套解析、move、BOM 原样保留）；**工具名 `apply_patch` → `patch`**；2 处 `ctx.ask` → `permission(...)` |
| `package.json` | `peerDependencies` → `@opencode/plugin ^2.1.2`；`dependencies` 合并成一个键（`diff` + `ssh2`）；`devDependencies` 去掉 `zod`；`exports` 增加 `"."` 入口；版本 `0.1.0` → `0.2.0` |
| `tsconfig.json` | 删除指向 shim 的 `paths`（以及随之无用的 `baseUrl`） |
| `scripts/postbuild.cjs` | 删除 `@opencode-ai/plugin` → shim 的重写逻辑，只保留复制 `prompts/*.txt` |
| `src/types/plugin-shim.ts` | **删除**（整个 `src/types/` 目录） |
| `src/test-e2e.ts`、`src/test-extended.ts` | 跟着改了工厂签名、mock ctx 与 `result.output` → `result.content`（否则 `tsc` 编译不过） |

`ssh-pool.ts`、`sync-engine.ts`、`path-mapper.ts`、`manifest.ts`、`bom.ts`、`diff-utils.ts`、
`shell-quote.ts`、`remote-system-prompt.ts`、`prompts/*` 一行未动。

---

## 2. 入口形态（`src/index.ts`）

```ts
export default Plugin.define({
  id: "remote-code",
  async setup(ctx) {
    const config = loadConfig(ctx.options)   // 未配置 → return（dormant）
    ...
    const permission = createPermissionGateway(ctx.permission)
    const tools = [ /* 7 个普通对象 */ ]

    const toolRegistration = await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool)   // 回调同步，execute 返回 Promise
    })

    const hookRegistration = await ctx.session.hook("context", async (event) => { ... })

    return async () => {           // 替代 V1 的 session.deleted
      await hookRegistration.dispose()
      await toolRegistration.dispose()
      await manifest.save()
      await sshPool.close()
    }
  },
})
```

- `setup` 里保留 V1 的全部初始化顺序：`PathMapper` → `ManifestManager.load()` → `createSSHPool` →
  `SyncEngine` → 清空并重建本地镜像 → 重置 manifest → 探测 `uname -s` 与 git。
- 不再订阅事件（契约第 6 节建议），`manifest.save()` + `sshPool.close()` 移到清理函数。

## 3. 工具注册与 7 个 JSON Schema

V2 的 `Tool.Info.input` 接受 `JsonSchema.JsonSchema`（effect 里就是 `{[x: string]: unknown}`），
所以**不需要 zod，也不需要 effect Schema**，手写 JSON Schema 即可。

| V1 名 | V2 名 |
| --- | --- |
| `bash` | `shell` |
| `apply_patch` | `patch` |
| `read` / `write` / `edit` / `glob` / `grep` | 同名 |

`execute` 的返回值统一从 `{ title, output }` 改成 `{ content, metadata }`；`title` 没有对应字段，
一律塞进 `metadata.title` 保留信息（例如 `metadata.title = remotePath`）。

### 3.1 `shell`（原 `bash`）

```json
{
  "type": "object",
  "properties": {
    "command":     { "type": "string", "description": "The bash command to execute" },
    "description": { "type": "string", "description": "A short description of what the command does" },
    "timeout":     { "type": "number", "description": "Timeout in milliseconds (optional)" },
    "workdir":     { "type": "string", "description": "Working directory on the remote machine (optional)" }
  },
  "required": ["command", "description"],
  "additionalProperties": false
}
```

返回 `{ content: stdout(+stderr 段), metadata: { title, exit, description, stderr } }`。

### 3.2 `read`

```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string", "description": "The absolute path to the file or directory to read" },
    "offset":   { "type": "number", "description": "The line number to start reading from (1-indexed)" },
    "limit":    { "type": "number", "description": "The maximum number of lines to read (defaults to 2000)" }
  },
  "required": ["filePath"],
  "additionalProperties": false
}
```

返回 `{ content: "<path>…</path>\n<type>file|directory</type>…", metadata: { title, preview, truncated } }`。

### 3.3 `write`

```json
{
  "type": "object",
  "properties": {
    "content":  { "type": "string", "description": "The content to write to the file" },
    "filePath": { "type": "string", "description": "The absolute path to the file to write (must be absolute)" }
  },
  "required": ["content", "filePath"],
  "additionalProperties": false
}
```

返回 `{ content: "Wrote file successfully.", metadata: { title, filepath, exists } }`。

### 3.4 `edit`

```json
{
  "type": "object",
  "properties": {
    "filePath":   { "type": "string",  "description": "The absolute path to the file to modify" },
    "oldString":  { "type": "string",  "description": "The text to replace" },
    "newString":  { "type": "string",  "description": "The text to replace it with (must be different from oldString)" },
    "replaceAll": { "type": "boolean", "description": "Replace all occurrences of oldString (default false)" }
  },
  "required": ["filePath", "oldString", "newString"],
  "additionalProperties": false
}
```

返回 `{ content: "Edit applied successfully.", metadata: { title, filepath, additions, deletions } }`。

### 3.5 `patch`（原 `apply_patch`）

```json
{
  "type": "object",
  "properties": {
    "patchText": { "type": "string", "description": "The full patch text that describes all changes to be made" }
  },
  "required": ["patchText"],
  "additionalProperties": false
}
```

返回 `{ content: "Success. Updated the following files:\n…", metadata: { title, files } }`。

### 3.6 `glob`

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "The glob pattern to match files against" },
    "path":    { "type": "string", "description": "The directory to search in. Omit to use the default directory." }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```

### 3.7 `grep`

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "The regex pattern to search for in file contents" },
    "path":    { "type": "string", "description": "The directory to search in. Defaults to the current working directory." },
    "include": { "type": "string", "description": "File pattern to include in the search (e.g. '*.js', '*.{ts,tsx}')" }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```

`glob` / `grep` 都返回 `{ content, metadata: { title, count|matches, truncated } }`。

## 4. 权限：`ctx.ask` → `ctx.permission.assert`（7 处）

`src/v2-bridge.ts` 提供 `createPermissionGateway(ctx.permission)`，返回

```ts
(identity, { action, resources, save, metadata }) => Promise<void>
```

内部映射：`sessionID ← identity.sessionID`、`permission → action`、`patterns → resources`、
`always → save`，并补上 `source: { type: "tool", messageID, id }`。`identity` 就是 `execute` 的
第二个参数（V2 `ToolContext` 的子集，结构兼容）。

| 位置 | action | 触发条件 | metadata |
| --- | --- | --- | --- |
| `read.ts` | `read` | 路径在工作区外 | `{}` |
| `write.ts` #1 | `edit` | 路径在工作区外 | `{}` |
| `write.ts` #2 | `edit` | 每次写入前 | `{ diff }`（unified diff 预览） |
| `edit.ts` #1 | `edit` | 路径在工作区外 | `{}` |
| `edit.ts` #2 | `edit` | 每次编辑前 | `{ diff }` |
| `patch.ts`（native） | `edit` | 补丁目标在工作区外 | `{ diff: patchText.slice(0,2000) }` |
| `patch.ts`（unified） | `edit` | 同上 | 同上 |

`save`（V1 的 `always`）与 `metadata` 只在有值时通过条件展开加入对象——V2 的 `AssertInput` 把
这两个键声明为 `optionalKey`，显式传 `undefined` 与「不传」不等价，稳妥起见一律省略。

## 5. system prompt 注入

V1 的 `experimental.chat.system.transform` → V2 的 `ctx.session.hook("context", cb)`：

- `event.system` 是 `SystemPart[]`（`{ type: "text", text }`），旧代码的 `s.includes(...)`
  改成 `part.text.includes(...)`。
- 逻辑与 V1 等价：找到 title generator 就地保留，`event.system.length = 0` 后
  `push(titleGenerator, ...remoteSystem.map(t => ({ type: "text", text: t })))`；找不到就整体替换。
- `buildRemoteSystemPrompt()` 的入参 `originalSystem: string[]` 仍然成立（传 `event.system.map(p => p.text)`），
  所以该模块无需改动。
- modelID 取自 `event.model.id`（V1 是 `input.model?.api?.id ?? input.model?.id`）。

## 6. 配置项最终形态

**优先级：`ctx.options` > 环境变量 > 旧 `--remote*` argv**（V2 插件跑在后台共享服务里，shell 里
`export` 的变量传不进去，所以 `ctx.options` 必须优先，且必须能独立激活远程模式）。

| 含义 | `ctx.options` 键（别名都接受） | env | argv |
| --- | --- | --- | --- |
| SSH 命令串 | `ssh` / `sshCommand` / `ssh-command` | `REMOTE_SSH` | `--remote` / `--remote-ssh` |
| 远端工作目录 | `workdir` / `remoteWorkdir` / `remote-workdir` / `remote_workdir` | `REMOTE_WORKDIR` | `--remote-workdir` |
| SSH 密码 | `password` / `sshPassword` / `ssh-password` | `REMOTE_PASSWORD` | `--remote-password` |
| sudo 密码 | `sudoPassword` / `sudo-password` / `sudo_password` | `REMOTE_SUDO_PASSWORD` | `--remote-sudo-password` |
| 本地镜像根 | `mirror` / `mirrorRoot` / `mirror-root` | `REMOTE_MIRROR` | `--remote-mirror` |

连接池调节仍然只认环境变量（未改）：`REMOTE_POOL_COMMAND_SIZE`、`REMOTE_POOL_FILE_SIZE`、
`REMOTE_POOL_STAGGER_MS`。

`ssh` 缺失 → `setup` 直接 return（dormant，不连 SSH、不注册工具、不写任何文件）。`ssh` 存在但
`workdir` 缺失 → `console.error` 一行说明原因后同样 return（见第 8 节取舍）。

### 可直接使用的 `opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  "plugins": [
    {
      // 指向构建产物所在的包目录（含 package.json + dist/）
      "package": "D:/zxk-2/opencode-remote-code",
      "options": {
        // 远端只要跑着 sshd，不需要装任何东西
        "ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa -i ~/.ssh/id_rsa root@192.168.184.133",
        // 远端工作目录（AI 看到的绝对路径根）
        "workdir": "/home/project",

        // 以下都可省略
        "password": "***",          // 用密码认证时填（等价 REMOTE_PASSWORD）
        "sudoPassword": "***",      // 需要 sudo 时填，插件会在远端建临时 askpass（等价 REMOTE_SUDO_PASSWORD）
        "mirror": "~/.opencode/mirrors"  // 本地镜像根，默认就是 ~/.opencode/mirrors
      }
    }
  ]
}
```

老机器（CentOS 6 / OpenSSH 5.3）示例：`"ssh": "ssh -oHostKeyAlgorithms=+ssh-rsa -oStrictHostKeyChecking=no root@192.168.184.133"`
——`-o` 选项由插件解析后传给 `ssh2`（`buildAlgorithms()` 会补 `ssh-rsa`），`StrictHostKeyChecking=no`
会关掉 host key 校验。

## 7. 验收实测

```
$ npm run build
> tsc                 # 零错误
> node scripts/postbuild.cjs
[postbuild] Copied prompt …（14 个 .txt）

$ node -e "import('./dist/index.js').then(m=>console.log(Object.keys(m.default)))"
[ 'id', 'setup' ]

$ Get-ChildItem -Recurse dist -File | Select-String -Pattern "@opencode-ai|plugin-shim"
（无匹配）

$ node test/run-tests.mjs          # 假 SSH 服务器 + V2 冒烟
mock server: PASS=39 FAIL=0 SKIP=0
[plugin] PASS setup(ctx) completes
[plugin] PASS tool.transform registers tools
[plugin] PASS tool "shell" / "read" / "write" / "edit" / "patch" / "glob" / "grep" registered
[plugin] PASS tool shell executes over the mock server
[plugin] PASS cleanup() runs
RESULT: PASS
```

另外用临时脚本（已删除）补测了三点：

1. **dormant**：`setup({ options: {} })` 返回 `undefined`，只读取了 `ctx.options`，
   `ctx.tool` / `ctx.session` / `ctx.permission` 一次都没被访问（用 getter 埋点验证）。
2. **system prompt**：普通请求 → 本地 prompt 被替换为远端 prompt（含 `Working directory` / `Platform`，
   保留 skills 段）；纯 title 请求 → 数组原样不动；title + 其他 → 保留 title generator 并替换其余。
3. **工具端到端**（对假 SSH 服务器）：`write` → `edit` → `patch` 都落到「远端」磁盘，
   返回值键为 `content, metadata`；5 次 `permission.assert` 的 `action` 全为 `edit`，
   `source` 为 `{ type: "tool", messageID, id }`。

## 8. 取舍与坑

1. **未配置时不写日志**。V1 的 `logDebug` 会往 `~/.opencode/remote-code-debug.log` 追加，这算副作用，
   所以改成默认关闭：只有 `REMOTE_CODE_DEBUG=1` 或配置成功（远程模式激活）后才写。
   dormant 分支完全不落盘。
2. **配置错误不抛异常**。`ssh` 有、`workdir` 没有这种半配置，`console.error` 一行后 return，
   避免把宿主的插件加载搞崩；但**已配置且连不上 SSH 时是 `setup` reject**（故意不静默退回本地模式——
   否则 AI 会以为在操作远端、实际改本地文件）。
3. **~~已知遗留：ssh-pool 健康检查无限重试~~（已修复）**。原实现里 `ConnectionPool` 构造函数
   无条件 `startHealthCheck()`，`init()` 失败后 30s interval 仍在；`replenish()` 的
   `while` 循环失败后固定 sleep 5s、永不退出。现在改为 `status: connecting|ready|failed|closed`
   状态机：健康检查只在 `init()` 成功后启动；`replenish()` 单轮最多 3 次尝试、退避 5s→10s→20s、
   只打「首次失败」和「放弃」两条日志；`createSSHPool()` 启动失败会关闭已建好的池再 rethrow；
   `close()` 幂等，并且会 reject 排队中的 `acquire()`（原来是直接丢队列，工具调用会永久挂起）。
   回归测试：`test/ssh-pool-lifecycle.mjs`。
4. **title 请求跳过注入**。`event.system` 只有 title generator 一个 part 时直接 return，
   避免每次生成标题都额外跑一次 SSH（`buildRemoteSystemPrompt` 会 `cat` 远端 AGENTS.md）。
   有 title generator 但也有其他 part 时，按 V1 语义替换其余部分。
5. **`exports` 增加 `"."`**。原 `package.json` 只有 `"./server"`，而 V2 是按包名 `import` 插件包的，
   只有子路径导出会解析失败；`main` 在有 `exports` 时不生效。保留 `"./server"` 兼容旧写法。
6. **~~`workdir: "/"` 的边界 bug~~（已修复）**：`isWithinWorkspace()` 原来用
   `normalized.startsWith(remoteRoot + "/")`，当 `remoteRoot === "/"` 时拼出 `"//"`，
   于是所有路径都被判定为「工作区外」，每读写一个文件都多弹一次权限。
   现在统一走 `isInsideRoot()`：根目录显式判断，非根用 `=== root || startsWith(root + "/")`。
   顺带修掉三个同源性缺陷：`remoteWorkdir` 尾斜杠（`/home/proj/`）会让 `startsWith` 恒假；
   构造函数改为归一化一次（`posix.normalize` + 去尾斜杠）并校验必须绝对，
   相对路径直接抛错而不是静默算出错误镜像；`slugify("/")` 原返回空串，会让 `mirrorBase`
   少一级、成为其它 workdir 镜像基目录的前缀，而 `index.ts` 每次启动 `rm -rf mirrorBase`——
   现在空 slug 回落为 `"root"`。另外 `toRemote(toLocal(p))` 在「外部路径」上原本不精确
   （`/home/proj` 下 `/etc/passwd` 与 `proj/etc/passwd` 共用镜像路径），用一张只做记账的
   `outsidePaths` Map 修好。回归测试：`test/path-mapper.mjs`。
7. **`zod` 已从 devDependencies 移除**：工具 schema 是纯 JSON Schema，`tool.schema` 不再存在；
   同理不需要 `effect` 依赖（`AssertInput` 只做类型引用）。
8. **测试脚本一并改签名**。`src/test-e2e.ts` / `src/test-extended.ts` 在 `tsconfig` 的 `include` 里，
   不改就编译不过；已把 mock ctx 换成 V2 identity + 一个记录型 `PermissionGateway`，
   `result.output` 改成 `result.content`。这两个套件仍需要真实 SSH 目标才能跑。
9. **假 SSH 服务器的覆盖盲区**：`test/` 里的 mock 的 `exec` 不把绝对 POSIX 路径映射到远端根
   （见 `test/README.md`），所以 `read`（远端 `file -b` / `dd` 判类型）、`glob`/`grep`
   （`cd <dir> && rg`）无法在该装置上端到端验证，只验证了注册与外壳；`write`/`edit`/`patch`
   走 SFTP，已完整验证。
10. **~~文档遗留~~（已修复）**：`AGENTS.md` 与三个 launcher 原先仍把「仅环境变量激活」写成唯一方式。
    现在 `AGENTS.md` 已按 V2 重写（`shell`/`patch`、`Plugin.define({id, setup})`、
    `ctx.permission.assert`、`ctx.session.hook("context")`、`opencode.jsonc` 的
    `plugins[].options` 优先），并顺手修正了上游的事实错误（`pullAll`/`pushAll` 写的是 rsync、
    实际是 SFTP `fastGet`/`fastPut`；本 fork 没有 `dist/tui.jsx`）。launcher 保留「按远端目标
    钉一个稳定的本地会话目录」这个核心用途，但会明确提示真正的远端配置在 `opencode.jsonc` 里，
    `REMOTE_*` 导出只在 `opencode run --standalone` 下生效。两个 README 保持上游正文不动，
    只在顶部加 V2 警示块指向本文件与 `MIGRATION-V2.md`。
