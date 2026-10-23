# 本地测试装置（假 SSH 服务器）

这套脚本用 `ssh2` 的 `Server` 类在本机起一个**真的 SSH 服务器**，把"远端"映射到
`test/tmp/remote` 目录，从而不需要任何真实远程机器就能端到端验证插件。

## 怎么跑

```powershell
npm run build                        # 单元套件 import dist/，必须先构建
node test/run-tests.mjs              # 总入口：清 tmp → 跑单元套件 → 起服务 → 跑全部断言
node test/run-tests.mjs --verbose    # 打印每条 SSH/SFTP 请求
node test/run-tests.mjs --skip-plugin
node test/run-tests.mjs --skip-slow  # 跳过 ssh-pool 生命周期套件（它要等约 25s 的定时器）
node test/verify-mock-server.mjs     # 只验证假服务器本身（自己起服务、自己关）
node test/path-mapper.mjs            # 只跑镜像路径映射的单元断言
node test/ssh-pool-lifecycle.mjs     # 只跑连接池生命周期/泄漏断言
```

- 全部通过时 exit 0，否则 exit 1。
- 所有断言只依赖 stdio，不连任何外部服务。
- 默认账号：`testuser` / `testpass`（可用 `MOCK_SSH_USER` / `MOCK_SSH_PASSWORD` 覆盖）。
- 当前基线：`total: PASS=42 FAIL=0 SKIP=0`（约 35s）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `mock-ssh-server.mjs` | 假 SSH 服务器：密码认证、exec、shell（假）、SFTP 子集；导出 `startMockServer()` → `{ port, close() }` |
| `verify-mock-server.mjs` | 用 `ssh2` Client 连自己，验证认证 / exec / SFTP / 路径穿越防护 |
| `plugin-smoke.mjs` | 用假 V2 `ctx` 加载 `dist/index.js`，断言注册出 7 个工具 |
| `path-mapper.mjs` | `PathMapper` 单元断言：`workdir: "/"` 边界、尾斜杠、相对路径报错、`toLocal`↔`toRemote` 往返、镜像基目录互不嵌套 |
| `ssh-pool-lifecycle.mjs` | 连接池生命周期：连不上时不泄漏定时器、进程能自然退出、`close()` 幂等、排队者在 close 时被 reject、`replenish()` 有界终止 |
| `run-tests.mjs` | 总入口：清理 `test/tmp`、用子进程跑上面两个单元套件、起服务跑 `verify-mock-server` + `plugin-smoke`、汇总 PASS/FAIL/SKIP |

## `test/tmp` 是临时的

`test/tmp/` 每次运行都会被**整个删掉重建**，里面只有测试数据，随时可以手动删除：

```
test/tmp/remote/   "远端"根目录（exec 的 cwd、SFTP 的 / 都指向这里）
test/tmp/local/    客户端侧的临时文件（上传/下载用）
test/tmp/mirror/   插件本地镜像目录（避免污染 ~/.opencode/mirrors）
```

`test/tmp/` 和 `test/.hostkey` 已在 `.gitignore` 里。

## 假服务器已知限制

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

## 插件冒烟测试的 SKIP 规则

插件现在已经是 V2 形态（`Plugin.define({ id, setup })`）。SKIP 只是给"还没 `npm run build`"
这种情况留的兜底：`dist/index.js` 不存在、导入失败、或默认导出不是 V2 形态（是函数，或
`{ id, server }`）时，冒烟测试打印 **SKIP** 并说明原因，**不会**让整套测试失败。
正常构建后它一定会做真断言：注册 `shell read write edit patch glob grep` 七个工具且都有
`execute`，然后额外用 `shell` 工具跑一次 `echo plugin-smoke-ok`（走假 SSH 的 exec 通道，
软失败），最后调用 `setup` 返回的清理函数。

假 `ctx` 里 `tool.transform` / `session.hook` 都返回 `{ dispose }`（V2 的 `Registration`），
`options.mirror` 指向 `test/tmp/mirror`，所以插件不会写用户目录下的
`~/.opencode/mirrors`。
