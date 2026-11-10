# GOAL：实现 `agys` —— agy 无感多账号切换命令（npm 全局安装）

> 执行者：Claude Code（goal / 自主模式）。
> 从本文件开始，自主完成实现、测试、npm 打包验证和文档，直到“验收标准”全部通过。
> **现在开始执行**：直接创建文件、写代码、跑测试；不要只给计划，不要等待确认。
> **不要向用户提问**。遇到歧义时选择最安全、最不破坏历史的方案，并在 `README.md` 中记录。
> 如果某一步依赖 macOS 真机或第二个真实账号而当前环境无法完成，标记为 `MANUAL`，继续做其余部分，**不要伪造测试结果**。
> **不要运行 `npm publish`**：发布是对外操作，必须由用户明确授权。只保证包是 publish-ready。

---

## 0. 一句话目标

交付一个 Node.js CLI 包 `agys`，支持：

```bash
npm install -g .          # 在当前目录立即全局安装
npm install -g agys       # 发布到 npm registry 后可用
```

安装后提供：

```bash
agys save [NAME]      # 保存当前已登录的 agy 凭据
agys login [NAME]     # 保存当前账号，登录新账号并切换过去
agys                  # 以当前账号启动 agy 对话
agys next             # 自动切换到下一个可用账号，并启动 agy 对话
```

`agys` 是 `agy` 的**透明代理**：除少量明确的 agys 子命令和保留参数外，其余参数、stdio、
工作目录、环境变量和退出码都原样交给 agy；不得改写、重排或吞掉任何 agy 参数。
所有不得不覆盖的参数都在 README 和 `agys help` 中列明。

切换账号后：

- 对话历史、`--continue` / `--conversation` 可用；
- `settings.json`、`installation_id`、缓存、brain、annotations、日志等保持不变；
- 不重新登录、不复制整个配置目录、不改动 agy 二进制；
- 只替换 agy 的 OAuth 凭据。

新增账号时：

- `agys login` 在临时 `HOME` 中发起 agy 官方 OAuth；
- 登录前先用 `captureCurrent()` 把当前账号完整保存进账号库；
- 新账号保存成功后，**安装新 token 并切换过去**；旧账号随时可用 `agys use <name>` 切回；
- 只有在登录失败/超时/中断时才恢复旧 token，当前账号不变；
- 不需要先 `/logout`；登录成功后不允许停留在“已保存但未激活”的新账号上。

---

## 1. 可行性结论（已调研，直接采用）

在本机 WSL + agy **1.5.3** 上实测：

- agy 的登录凭据是单个 JSON 文件：

  ```text
  ~/.gemini/antigravity-cli/antigravity-oauth-token
  ```

- 文件结构（示例，值必须脱敏）：

  ```json
  {
    "token": {
      "access_token": "<redacted>",
      "token_type": "Bearer",
      "refresh_token": "<redacted>",
      "expiry": "2026-11-10T10:20:37.287783741+08:00",
      "expires_in": 3599
    },
    "auth_method": "consumer",
    "id_token_email": "alice@example.com"
  }
  ```

- 对话历史在同一个父目录下，和 token 完全分离：

  ```text
  ~/.gemini/antigravity-cli/conversations/*.db
  ~/.gemini/antigravity-cli/conversation_summaries.db
  ~/.gemini/antigravity-cli/history.jsonl
  ~/.gemini/antigravity-cli/cache/
  ~/.gemini/antigravity-cli/brain/
  ~/.gemini/antigravity-cli/annotations/
  ~/.gemini/antigravity-cli/implicit/
  ~/.gemini/antigravity-cli/presence/
  ~/.gemini/antigravity-cli/settings.json
  ~/.gemini/antigravity-cli/installation_id
  ~/.gemini/antigravity-cli/jetski_state.pbtxt
  ```

- 只替换 `antigravity-oauth-token`，不触碰上述任何文件，即可切换身份并保留本地历史。成熟工具
  `lbjlaq/Antigravity-Manager` 对 agy CLI 也是这么做的（`sync_agy_cli` 只写 token 文件），
  其配额切换 wrapper 在切号后用 `--continue` 恢复会话。
- agy 在启动时读取 token；**已经在运行的 agy 进程不会因为文件变化而切换身份**。
  `agys next` 必须启动新的 agy 进程。
- agy 会周期性刷新 token 并重写该文件。因此 `agys` 在 agy 退出后要把当前 token 同步回对应账号的
  快照；`agys next` 在切换前也要先捕获当前 token，避免丢失刚轮换的 refresh token。
- 已实测：在**隔离的 `HOME`** 下运行 `agy -p "/login"`，agy 会打印 OAuth URL 并等待授权，
  不会读写真实的 `~/.gemini/antigravity-cli/antigravity-oauth-token`。因此 `agys login` 可以在
  不丢失当前账号的情况下，用 agy 官方 OAuth 新登录一个账号，登录完成后把新 token 存入账号库
  并安装为当前账号。macOS 如果使用全局 Keychain，失败时需要快照/回滚（见 §6.4.1）。

### 已测试但**禁止**采用的方案

1. **不要**用 `HOME=<每账号目录>` 启动 agy。
   - 实测可以让 agy 读取隔离目录里的 token，但也会创建一套全新的 `.gemini`，对话历史被割裂。
2. **不要**依赖 `ANTIGRAVITY_GEMINI_DIR` 或 `ANTIGRAVITY_APP_DATA_DIR` 做账号隔离。
   - 实测放入无效 token 后 agy 仍使用全局凭据，不能可靠重定向认证。
3. **不要**为每个账号复制整个 `~/.gemini/antigravity-cli`。
   - 会复制/分叉对话历史，违背“切换后历史不变”。
4. **不要**修改 `conversations/*.db`、`history.jsonl`、`cache/` 里的任何内容来“适配”账号。
5. **不要**改 agy 二进制或注入环境变量来绕过认证。

### 仍需在真机验证的三点

- macOS 上 agy 是否优先使用 Keychain。实现时以 token 文件为准；如果 macOS 上存在 Keychain 条目，
  做**镜像事务**（见 §6.4），并在 `README.md` 标注验证结果。
- macOS 上 `agys login` 的临时 `HOME` 是否能隔离 Keychain；如果不能：登录成功时让 Keychain
  指向新账号，登录失败/取消时才按 §6.4.1 恢复旧值。
- 用账号 A 创建的对话，切到账号 B 后 `agy --conversation <id>` / `agy -c` 是否能被 Google 后端接受。
  本地历史一定会保留；云端 cascade 的跨账号续聊需要两个真实账号实测。若失败，记录错误，
  **不要删除或重写对话库**。Antigravity-Manager 的 `--continue` 切号模式说明通常可行，但不要把它当成保证。

---

## 2. 硬性约束

- 目标平台：**macOS**、**WSL2/Linux**。Windows 原生先不做，但代码不要故意阻止未来扩展。
- 运行时：**Node.js >= 18**，CommonJS；**零运行时依赖**（只用 Node 标准库）。
- npm 包名：`agys`；可执行命令名：`agys`。
- 不引入 `postinstall` / `preinstall` 脚本；安装时不能执行任意代码。
- 不调用 `sudo`，不修改 shell rc，不修改 agy 安装。
- 只允许写：
  - `~/.gemini/antigravity-cli/antigravity-oauth-token`（切换/登录时）
  - `~/.config/agys/` 下的自有状态（`AGYS_HOME` 可覆盖）
  - `~/.config/agys/state/login-*/` 临时 HOME（仅登录期间，结束必须删除）
  - macOS 上已存在的 Keychain 条目（镜像/登录失败回滚）；或 `AGYS_KEYCHAIN_WRITE=1` 时新建
- **不得丢失当前账号**：`agys login` 启动 OAuth 前必须先把当前账号完整保存进账号库；
  登录失败/中断必须恢复登录前的真实认证；登录成功后安装新账号并切换过去，旧账号仍可用
  `agys use` 切回。任何情况下不得调用 `/logout`；除成功切换/登录成功外不得删除或覆盖当前 token。
- **透明代理**：代理模式下 `agys` 不得改写、重排、吞掉或重新解释用户传给 agy 的参数；
  保留词和 `--` 逃生通道之外的一切参数原样转发。stdout 归 agy 独占，agys 自身输出只走 stderr。
  保留词清单、`--` 用法和所有无法完全透明的例外必须写入 README 和 `agys help`。
- 任何输出、日志、异常、测试报告都**不得包含** `access_token`、`refresh_token`、`id_token` 原文。
- token 文件权限必须是 `0600`；`~/.config/agys`、`accounts/` 必须是 `0700`。
- 写入必须原子：同目录临时文件 → `fsync` → `rename`；失败时保留原 token。
- 不得在 argv 中传递 token（macOS `security` 的密码参数是已知例外，需在 README 说明）。
- `agys` 自身不发起任何网络请求；只有 agy 会访问 Google。
- **不要自动 `npm publish`**；只做 `npm pack`、临时 prefix 安装和文档。

---

## 3. 命令契约

| 命令 | 行为 |
|---|---|
| `agys` | 不带参数：以当前 token 启动交互式 `agy`。 |
| `agys <agy args...>` | 其余参数原样转发给 `agy`，例如 `agys -c`、`agys -p "hi"`、`agys --model ...`。不解析、不改写。 |
| `agys -- <agy args...>` | 强制转发：去掉第一个 `--`，剩余参数无条件交给 agy（即使看起来像 agys 子命令）。 |
| `agys save [NAME]` | 读取当前 token，保存为账号快照。默认名取 `id_token_email` 的 `@` 前部分并做 slug 化；无邮箱时用 `account-YYYYmmdd-HHMMSS`。 |
| `agys login [NAME]` | 先把当前账号保存进账号库；在隔离的临时 HOME 中运行 `agy -p "/login"` 完成新账号 OAuth；保存新账号并**切换为当前账号**。登录失败时恢复登录前账号。`NAME` 可选。 |
| `agys list` / `agys ls` | 列出账号、邮箱、token 过期时间、当前标记。不输出 token。 |
| `agys current` | 显示当前匹配到的账号名和邮箱；未保存则显示 `unsaved`。 |
| `agys use NAME` / `agys switch NAME` | 切换到指定账号，**不启动** agy。 |
| `agys next [--no-run] [-- AGY_ARGS...]` | 先捕获当前 token，再按轮转顺序切到下一个可用账号；默认立即启动 agy；`--no-run` 只切换；`--` 之后的参数原样转发给 agy（例如 `agys next -- -c`）。 |
| `agys rm NAME` | 删除账号快照；如果删除当前账号则警告并拒绝，除非 `--force`。`--force` 只删本地快照，真实 token 仍生效，命令会明确提示。 |
| `agys doctor` | 环境诊断：Node/npm 版本、agy 路径/版本、token 路径/邮箱/过期、账号数、是否有 agy 在跑、历史目录是否存在、macOS Keychain 与文件是否身份不一致。 |
| `agys help` / `agys --help` | 帮助（同时列出 agys 保留词和透明代理规则）。 |
| `agys version` / `agys --version` | 打印 `agys` 版本（不是 agy 版本）。 |

补充：

- 第一个参数是未知子命令且不以 `-` 开头时，也转发给 agy（例如 `agys models` 等价于 `agy models`）。
- 保留词（`help`、`--help`、`version`、`--version`、`save`、`login`、`list`、`ls`、
  `current`、`use`、`switch`、`next`、`rm`、`doctor`）会遮蔽 agy 的同名参数；
  用 `agys -- <args...>` 绕过。
- `agys next` 的 `--no-run` 只属于 `agys`，不要传给 agy；`next` 的 agy 参数必须放在
  `--` 之后，否则退出 2；`--` 之后再出现 `--no-run` 时原样传给 agy。
  `login` / `use` / `rm` 不接受 agy 参数。
- 退出码：
  - `0` 成功
  - `2` 用法/参数错误
  - `3` 检测到另一个 agy/agys 会话正在运行
  - `4` 没有已保存账号
  - `5` token 缺失、损坏或校验失败
  - `6` 找不到 agy
  - `7` 获取锁失败
  - `130` 被 Ctrl-C 中断
  - `143` 被 SIGTERM 中断
- 代理模式下 agy 的退出码原样返回（包括与上面 2-7 数字相同但含义不同的情况）；
  上面的 agys 错误码只在启动 agy 之前或 agys 自己的子命令中产生。

### 3.1 透明代理契约

`agys` 的职责是代理 agy，不是重新解释 agy 的命令行。契约如下：

1. **参数原样转发**：代理模式用 `spawn(agyBin, args, { stdio: "inherit" })`，`args` 是去掉
   agys 保留部分后的原始数组。禁止 `exec`、`sh -c`、字符串拼接、重新排序、去重或补默认值。
   包含空格、引号、`=`、空字符串的参数必须原样到达 agy。
2. **只解析 argv[0]**：只有第一个参数会按 agys 子命令/保留词精确匹配（不做前缀匹配）；
   其余参数不解析。例外：`agys next` 自己解析 `--no-run` 和第一个 `--`。
3. **保留词**：`help`、`--help`、`version`、`--version`、`save`、`login`、`list`、`ls`、
   `current`、`use`、`switch`、`next`、`rm`、`doctor`。这些会覆盖 agy 的同名参数。
   未列出的参数（包括 `-h`、`--model` 等）一律转发。
4. **逃生通道**：第一个参数是 `--` 时，去掉它，剩余参数无条件转发给 agy，跳过所有子命令
   识别。例如 `agys -- --help` 显示 agy 帮助，`agys -- list` 把 `list` 交给 agy。
   `--` 出现在其它位置时属于 agy，原样转发。
5. **stdio**：始终 `stdio: "inherit"`。代理模式下 agys 不得向 stdout 写任何字节；横幅、
   警告、错误全部写 stderr。非 TTY 时默认不打印切换横幅（`AGYS_QUIET=1` 可强制关闭）。
6. **cwd/env**：保持 `process.cwd()` 和 `process.env` 不变；不注入 `ANTIGRAVITY_*`，
   不改 `HOME`，不设置 `cwd`。
7. **信号**：agy 与 agys 在同一前台进程组，终端产生的 SIGINT 会同时到达两者，wrapper
   不再补发；wrapper 等待 child 退出并把信号映射为 `128+signum`（SIGINT→130、
   SIGTERM→143）。显式发给 agys 的 SIGTERM 转发给 child。SIGHUP / SIGWINCH 等其它终端
   信号由同一进程组自然送达，wrapper 不拦截、不改写。
8. **退出码**：代理模式必须原样返回 agy 的退出码/信号，包括与 agys 自身 2-7 冲突的情况。
   子进程退出后的 `captureCurrent()` 失败只警告，不改变退出码。
9. **文档**：README 和 `agys help` 必须列出上述保留词、`--` 用法、stdout/stderr 契约、
   信号/退出码行为，以及所有无法完全透明的例外。

---

## 4. npm 打包与安装

### 4.1 目录结构

```text
agys/
├── package.json
├── package-lock.json        # npm install --package-lock-only 生成
├── bin/
│   └── agys.js              # #!/usr/bin/env node，chmod 755
├── lib/
│   └── agys.js              # 全部逻辑，CommonJS，导出 main 和可测试函数
├── test/
│   └── agys.test.js         # node:test
├── README.md
├── LICENSE                  # MIT
└── .gitignore               # node_modules/, *.tgz
```

### 4.2 package.json 必须包含

```json
{
  "name": "agys",
  "version": "0.1.0",
  "description": "Seamless multi-account switcher for the Antigravity CLI (agy)",
  "bin": { "agys": "bin/agys.js" },
  "main": "lib/agys.js",
  "files": ["bin/", "lib/", "README.md", "LICENSE"],
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test",
    "pack:check": "npm pack --dry-run"
  },
  "keywords": ["antigravity", "agy", "account", "switcher", "cli"],
  "license": "MIT"
}
```

- 不要加 `postinstall`。
- `files` 只包含运行所需文件；不要把 `test/`、`.env`、token、抓包文件打进 tarball。
- `bin/agys.js` 第一行必须是 `#!/usr/bin/env node`，文件模式 755。
- `lib/agys.js` 末尾导出 `{ main, ... }`，并只在 `require.main === module` 时执行 `main`；
  这样测试可以直接 `require` 内部函数。

### 4.3 安装方式

本地开发目录：

```bash
cd agys
npm install -g .
agys help
```

从 npm registry（仅在发布后可用）：

```bash
npm install -g agys
```

发布前检查（不实际发布）：

```bash
npm pack --dry-run
npm pack
npm install -g ./agys-0.1.0.tgz --prefix "$(mktemp -d)"
```

- `npm install -g .` 必须无需 sudo（在用户可写的 npm prefix 下）。
- 如果用户 npm prefix 需要提权，README 给出替代方案：
  `npm install -g --prefix "$HOME/.local" .`，并提示把 `$HOME/.local/bin` 加入 PATH。
- `npm uninstall -g agys` 必须可用。
- 发布前用 `npm view agys version` 确认名称仍可用；如果已被占用，改用 `@scope/agys`，
  但可执行命令仍叫 `agys`，并同步更新 README。
- README 必须写明：
  - `npm install -g .` 立即可用；
  - `npm install -g agys` 需要包已发布到 registry；
  - 发布命令是 `npm publish --access public`，但不要让 goal 自动执行。

---

## 5. 状态目录

默认：

```text
~/.config/agys/
├── config.json                 # {"version":1,"order":["work","personal"],"last":"work"}
├── accounts/
│   ├── work/
│   │   ├── token.json          # 0600，保存时的原始 token 字节或规范化 JSON
│   │   └── meta.json           # 0600，邮箱、auth_method、保存/更新时间、expiry 展示值
│   └── personal/
│       ├── token.json
│       └── meta.json
├── state/
│   ├── previous-token.json     # 0600，切换前备份，供人工恢复
│   ├── switch.lock             # 切号/登录独占锁
│   ├── state.lock              # 账号库读写锁
│   ├── runs/
│   │   └── <pid>.json          # 正在运行的 agys/agy 会话标记
│   └── login-<pid>-<ts>/       # 0700，agys login 的临时 HOME；结束必须删除
│       └── home/.gemini/antigravity-cli/
```

环境变量：

| 变量 | 作用 |
|---|---|
| `AGYS_HOME` | 覆盖 `~/.config/agys`，测试必须使用 |
| `AGYS_AGY_TOKEN` | 覆盖 token 路径，测试必须使用 |
| `AGYS_AGY_BIN` | 覆盖 agy 路径，测试必须使用 |
| `AGYS_SKIP_RUNNING_CHECK=1` | 仅测试用，跳过 `ps` 扫描（锁和 run marker 仍然生效） |
| `AGYS_KEYCHAIN_SERVICE` / `AGYS_KEYCHAIN_ACCOUNT` | macOS Keychain 条目名覆盖 |
| `AGYS_KEYCHAIN_WRITE=1` | 允许在 Keychain 条目不存在时创建 |
| `AGYS_LOGIN_TIMEOUT` | `agys login` 等待新 token 的毫秒数，默认 `300000`（5 分钟） |
| `AGYS_LOGIN_PROMPT` | `agys login` 传给 agy 的 print prompt，默认 `/login`；仅用于 agy 升级后的兼容性覆盖 |
| `AGYS_REAL_AGY=1` | 允许执行真实环境 smoke test |
| `AGYS_QUIET=1` | 不打印切换横幅 |
| `AGYS_DEBUG=1` | 打印脱敏调试信息 |

目录创建后显式 `chmod 0700`；文件写入后显式 `chmod 0600`，不要依赖 umask。

---

## 6. 实现细节

### 6.1 读取 token

优先级：

1. `AGYS_AGY_TOKEN`（测试用）
2. `~/.gemini/antigravity-cli/antigravity-oauth-token`
3. macOS 可选：`security find-generic-password -s gemini -a antigravity -w`
   - 输出可能是原始 JSON、带引号的 JSON 字符串、或 base64 编码的 JSON；三种都要尝试解析。
   - 如果 Keychain 条目不存在（`security` 返回非 0），静默回退，不报错。

如果文件与 Keychain 都读到合法 token 但内容不同：

- 先比较 `id_token_email`：
  - **邮箱不同**：这是身份不一致。`readToken()` 以文件为准（与 §1 的结论一致）并标记
    `divergent`；`agys current` 打印警告；`agys doctor` 报错并退出 5；`agys use` /
    `agys next` / `agys login` 在切换前打印警告，且在 macOS 上必须同时写文件与 Keychain，
    安装目标后消除分歧。
  - 邮箱相同：属于同一账号的凭据漂移，不算错误。
- 同一账号时比较 `token.expiry`（按 ISO 时间解析；解析失败则视为旧），取 expiration 更晚的；
  无法比较则优先文件；`agys doctor` 打印警告。

读取后必须：

- 解析 JSON，确认 `token` 是 object；
- 确认 `token.access_token`、`token.refresh_token` 是非空字符串；
- 提取 `id_token_email`（可能缺失）；如果缺失但存在 `id_token` JWT，解码 payload 取 `email`；
- 保留原始字节 `raw`，切换时优先写回原始字节，避免不必要的字段/格式变化。

如果文件存在但不是合法 JSON：先短暂重试（3 次，间隔 50ms），因为 agy 可能正在重写；
重试后仍失败才报错退出 5，**不要覆盖**它。

### 6.2 写入 token（原子）

```text
writeToken(rawBytes):
  target = realpath(tokenPath)（不存在则用原路径）
  tmp = 同目录临时文件
  open(tmp, "wx", 0600)
  write(rawBytes); fsync(fd); close(fd)
  chmod(tmp, 0600)
  rename(tmp, target)
  chmod(target, 0600)
  fsync(dir)  # 尽力而为
```

- 如果目标路径是 symlink，先 `realpath`，写真实文件；不要替换 symlink 本身。
- 写入前再次校验 JSON；校验失败直接退出 5，原文件不变。
- 写入失败时删除临时文件，保留原 token。
- `writeToken` 不做备份；切换前的备份由 `installAccount` 统一负责（见 §6.5），避免在
  macOS Keychain 已被登录流程改写时把新账号误当成旧账号备份。

### 6.3 账号模型

`meta.json` 示例：

```json
{
  "name": "work",
  "email": "alice@example.com",
  "auth_method": "consumer",
  "saved_at": "2026-11-10T10:00:00+08:00",
  "updated_at": "2026-11-10T10:00:00+08:00",
  "expiry": "2026-11-10T10:20:37.287783741+08:00"
}
```

- `name` 只允许 `[A-Za-z0-9._-]+`，拒绝 `..`、`/`、空字符串、以 `.` 或 `-` 开头
  （避免与子命令 flag 混淆）。
- 默认名：邮箱 `@` 前部分，转小写，非允许字符转 `-`；冲突时追加 `-2`、`-3`。
- 保存时先按邮箱匹配：同一邮箱总是更新已有账号（即使传了不同的 `NAME`，并打印实际账号名）；
  邮箱是新的时才使用 `NAME`。
- 同名但不同邮箱：自动追加 `-2`、`-3`，打印实际使用的名字；绝不覆盖已有账号。
  `save` 和 `login` 采用同一规则。MVP 不实现 `--force` 覆盖。
- `rm` 必须从 `config.order` 移除该名字；`list` / `doctor` 发现 `accounts/` 下有未登记账号时
  追加到 `order` 并警告。
- 当前账号识别：
  1. 先按 `id_token_email` 匹配；
  2. 同邮箱有多个时，按 `refresh_token` 精确匹配；
  3. 仍不唯一时取 `updated_at` 最新的一个；
  4. 无匹配则 `unsaved`。

### 6.4 macOS Keychain（镜像事务，不是主路径）

- 常量：`KEYCHAIN_SERVICE=gemini`，`KEYCHAIN_ACCOUNT=antigravity`（可覆盖）。
- `readKeychain()`：`security find-generic-password -s <service> -a <account> -w`。
- `writeKeychain(raw)`：
  - 仅当条目已存在，或 `AGYS_KEYCHAIN_WRITE=1` 时更新；
  - 保留原有编码：原值是 base64 就写 base64，否则写原始 JSON；
  - `security add-generic-password -U -s ... -a ... -w <value>`；
  - 条目存在（或 `AGYS_KEYCHAIN_WRITE=1`）时，Keychain 写入属于切换事务，不再只是警告：
    先写 Keychain，成功后再原子写文件；Keychain 写失败则退出 5、当前账号不变；
    文件写失败则把 Keychain 回滚到切换前的值，回滚失败退出 5 并明确报告两边可能不一致；
  - 校验两边一致时比较解析后的 `id_token_email` + `refresh_token`/`expiry`，
    不要比较原始编码字节（Keychain 可能是 base64）；
  - 条目不存在且未设置 `AGYS_KEYCHAIN_WRITE=1` 时跳过 Keychain，不报错。
- Linux 不实现 Secret Service；WSL2 已确认走文件。
- 如果 macOS 上文件不存在但 Keychain 有值：`agys save` 应能从 Keychain 读取并保存；
  `agys use` 写文件；如果 Keychain 条目存在，按上面的切换事务同时写 Keychain。
- README 说明：`security` 的 `-w` 会让密码短暂出现在进程参数中，这是 macOS 工具的限制；
  不要在多人共享机器上运行。

### 6.4.1 新增账号登录：`agys login`（保存当前账号并切换）

目标：先把当前账号 A 完整保存进账号库；用 agy 官方 OAuth 登录账号 B；把 B 存入账号库并
**安装为当前账号**。旧账号 A 随时可以用 `agys use a` 切回；不调用 `/logout`，不丢 A 的 token。

**语义说明（重要）**：切换不是登出。A 的 token 在登录开始前已经写入账号库；真实 token
文件被 B 覆盖后，A 仍可完整恢复。因此“不得丢失当前账号”的硬约束体现为：

1. 登录前必须成功保存 A；
2. 登录失败/中断必须恢复 A；
3. 登录成功后停留在 B，而不是回到 A。

**已实测依据**：在隔离的 `HOME` 下运行 `agy -p "/login"`，agy 会打印 OAuth URL 并等待授权，
不会读写真实验证文件。隔离 HOME 必须保留：真实 HOME 里已有 A 的有效 token，`agy /login`
可能认为“已登录”而不发起新 OAuth；隔离 HOME 保证 agy 从空状态开始。
`-p` 让 agy 执行完 slash command 后退出；如果它没有退出，wrapper 在检测到新 token 后主动结束它。

#### 流程

```text
acquireSwitchLock()
  assertNoRuns()                      # 登录期间不允许其他 agy 运行，避免刷新/安装互相覆盖
  withStateLock():
    current = captureCurrent()        # A 必须先安全进库；有 token 但保存失败 → 退出 5
  realBefore = snapshotRealAuth()     # 真实 token 文件 + macOS Keychain（仅用于失败回滚）
  tempHome = state/login-<pid>-<ts>/home (0700)
    mkdir tempHome/.gemini/antigravity-cli (0700)
    copy real installation_id -> tempHome/.gemini/antigravity-cli/installation_id
    # 不复制 conversations/history/cache/token
  child = spawn(agy, ["-p", AGYS_LOGIN_PROMPT || "/login"], {
    env: {...process.env, HOME: tempHome},
    stdio: "inherit",
  })
  poll:
    - tempHome/.gemini/antigravity-cli/antigravity-oauth-token
    - macOS Keychain（如果它相对 realBefore 发生了变化）
    每 500ms，直到 AGYS_LOGIN_TIMEOUT（默认 300000ms）
  一旦拿到合法新 token:
    - 等 child 退出最多 3s；否则 SIGTERM，再 2s 后 SIGKILL
    - child 退出后重新读取一次新 token（agy 可能在退出前轮换）
    - withStateLock():
        save/update account B
        installAccount(B, current?.raw)  # 与 use 相同的原子写入 + Keychain 镜像 + config.last
    - 校验真实文件与 Keychain 都等于 B（installAccount 内部已做）
    - 删除 tempHome
  releaseSwitchLock()
```

失败路径（OAuth 拒绝、超时、child 未产生 token、安装失败、Ctrl-C / SIGTERM）：

```text
if 真实认证相对 realBefore 被改写:
    writeBackRealAuth(realBefore)     # 文件 + 已存在的 macOS Keychain
    再次校验；仍不一致 → 退出 5，打印 `agys use <A>` 恢复命令；
    若 installAccount 已开始写入，保留 state/previous-token.json
清理 tempHome
当前账号仍是 A（首次使用时仍为空）
退出 5（Ctrl-C → 130，SIGTERM → 143）
```

#### 保存新账号

- `email = newToken.id_token_email`。
- 保存前先按 `id_token_email` 匹配账号库：
  - 匹配到已有账号 → 更新该账号快照（re-authenticated），不新建，并切换/停留在该账号；
  - 邮箱是新的 → 有 `NAME` 且未占用就用 `NAME`；已被其他邮箱占用则用 `NAME-2`、`NAME-3`
    （绝不覆盖），并打印实际名字；无 `NAME` 按邮箱默认名。
- 插入到 `config.order` 中当前账号之后（首次使用则追加），`config.last = B`。
- 保存完成后打印（全部走 stderr）：
  ```text
  agys: saved new account personal <bob@example.com>
  agys: now using personal <bob@example.com>
  ```

#### 关键安全规则

- 登录前必须 `captureCurrent()`；如果当前 token 存在但损坏，退出 5，先让用户修复/保存，
  不要冒险登录导致当前账号丢失。
- 当前账号 A 的账号库写入必须成功后才能启动 OAuth：不允许“先登录再保存 A”。
- 成功判据：新 token 已保存为 B，且已安装到真实位置（token 文件 + 已存在的 Keychain 条目），
  `agys current` 显示 B。安装失败时 A 必须仍是当前账号（真实位置未被成功替换），退出 5。
- 失败时必须校验真实认证等于 `realBefore`；被改写则写回并再次校验；仍失败则退出 5，
  打印 `agys use <A>` 恢复命令；若 installAccount 已开始写入，保留 `state/previous-token.json`。
- 首次使用（没有任何当前 token）不是特例：保存 B 后走同一条 `installAccount(B, null)` 路径。
- **绝不调用 `/logout`**，绝不删除真实 token 作为登录手段。
- 临时 `HOME` 必须 0700；其中 token 文件 0600；结束后整个目录删除。
  删除失败时先截断 token 文件再删，并打印路径警告。
- 每次 `agys login` / `agys doctor` 启动时清理超过 24 小时的 `state/login-*` 残留目录；
  更年轻的残留只报告，避免误删另一个正在进行的登录。
- 登录期间持有 `switch.lock`，所以 `agys next` / `agys use` / 另一个 `agys login` 会退出 3。
- `assertNoRuns()` 意味着**正在运行的 agy 进程要先退出**。这不是登出：账号已保存在账号库
  和真实 token 文件里；这样做是为了避免运行中的 agy 刷新 token 与 `agys login` 的安装逻辑
  互相覆盖。
- Ctrl-C / SIGTERM：走失败路径；退出 130/143。
- OAuth 被拒绝、超时、child 未产生 token：走失败路径；退出 5。
- `AGYS_LOGIN_PROMPT` 默认 `/login`。如果未来 agy 改了 slash command，用户可覆盖为
  `agy -p "hi"` 之类的触发方式；README 说明这会消耗一次模型请求。
- agy 的 print mode 自身大约只等 60 秒 OAuth；`AGYS_LOGIN_TIMEOUT` 是 wrapper 的总超时，
  不会延长 agy 内部窗口。README 提示用户先准备好浏览器/账号再执行 `agys login`。

#### macOS 特别注意

- 临时 `HOME` 可能无法隔离全局 Keychain。`snapshotRealAuth()` 必须同时读取 Keychain。
- 登录成功：如果 Keychain 已被新账号覆盖，这正是目标状态；`installAccount(B, current?.raw)`
  会把 B 镜像进 Keychain（已是 B 则 no-op）。不要恢复 A。
- 登录失败：如果 Keychain 相对 `realBefore` 被改写，必须写回 A。
- 如果登录后没有发现新 token，且 Keychain 与 `realBefore` 相同，说明 agy 可能复用了当前账号，
  没有真正发起新登录：报错 5，提示用户检查 `security find-generic-password -s gemini -a antigravity`
  或先在 macOS 上手工验证隔离 HOME 是否生效；不要假装成功。
- README 明确标注 macOS `agys login` 的验证状态（已验证/未验证）。

### 6.5 切换流程

`captureCurrent()`：

```text
raw = readToken()
if not raw: return null
data = parse(raw)
email = data.id_token_email
name = findExistingName(email, data)
if not name:
    name = uniqueName(email)
    order.push(name)
write accounts/<name>/token.json 和 meta.json
return { name, raw }
```

`installAccount(name, previousRaw)` 是 `use` / `next` / `login` 共用的唯一安装路径：

```text
installAccount(name, previousRaw):
  validate target account token
  if previousRaw: write previousRaw -> state/previous-token.json (0600)
  macOS: if Keychain entry exists, write target token to Keychain first
  write target token atomically to real token path
  config.last = name
  macOS: verify file and Keychain both equal target
```

- `previousRaw` 必须由调用方显式传入：`use` / `next` 传 `captureCurrent()` 读到的当前原始
  字节；`login` 传 `current?.raw`。这样当前 token 损坏时也不会被账号库里的旧快照覆盖备份。
- 如果没有当前 token，传 `null`，不写 `previous-token.json`。

`agys use NAME`：

```text
acquireSwitchLock()
  assertNoRuns()
  withStateLock():
    current = captureCurrent()          # 先保存当前 token，防止 refresh token 丢失
    installAccount(NAME, current?.raw)  # 目标损坏 → 退出 5，当前账号不变
releaseSwitchLock()
print("agys: now using NAME <email>")   # stderr
```

`agys next`：

```text
acquireSwitchLock()
  assertNoRuns()
  withStateLock():
    current = captureCurrent()
    if not accounts: exit 4
    start = current?.name or config.last
    candidates = start 在 order 中 ? 从 start 之后轮转全部账号 : order 全量
    for name of candidates:
      try validate target token
      if valid: next = name; break
      else: warn("skipping NAME: token corrupt")
    if no valid target: exit 5
    installAccount(next, current?.raw)
  # 保持 switch lock，直到新 agy 进程启动并注册 run marker
  spawnAgy(args, { lockHeld: true })
releaseSwitchLock()
await child exit
```

- `start` 的取法：优先当前账号；没有当前 token 时用 `config.last`；两者都没有、或 `start`
  不在 `order` 中时，从 `order` 全量开始。这样用户 `/logout` 后仍能接着上次的轮转继续。
- `captureCurrent()` 在当前 token 损坏时的行为：`save` / `login` 退出 5；
  `use` / `next` 警告并把原始字节备份到 `state/previous-token.json`，返回 `null` 后继续。
- `next` 会跳过校验失败的账号并在 stderr 警告；全部账号都不可用才退出 5。
  `use NAME` 仍然对损坏目标直接退出 5，因为用户明确指定了它。
- `agys save` 只做 `captureCurrent()`，然后打印保存结果。
- `agys next` / `agys use` 前的 `captureCurrent()` 是必须的：agy 可能刚刷新过 token。
- 如果当前 token 对应一个从未保存的新账号，`captureCurrent()` 会自动保存它，再切换；
  这样不会丢掉用户刚手动登录的账号。

### 6.6 启动 agy 与退出后同步

`agys` / `agys next` 启动：

```js
const child = spawn(agyBin, args, {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});
```

- 不要用 `exec` 或 `sh -c` 拼接参数，避免注入；argv 数组原样传入。
- 等待 child 的 `spawn` 事件后再认为启动成功；`error` 事件（如 ENOENT）要清理 run marker、
  释放 switch lock，并以 6 退出。
- 不要改 `HOME`、`ANTIGRAVITY_*`、`cwd`；环境变量原样继承。
- 继承 stdio，保证交互式 TUI 正常；代理模式下 agys 不向 stdout 写任何字节。
- 信号：agy 与 agys 在同一前台进程组，终端产生的 SIGINT 会同时到达两者，wrapper 不再补发；
  只安装 handler 阻止 Node 默认立即退出，等待 child 结束后按 `128+signum` 退出
  （SIGINT → 130，SIGTERM → 143）。显式发给 agys 的 SIGTERM 转发给 child。
- 子进程退出后的 `captureCurrent()` 失败只警告，不改变退出码。
- 子进程退出后：
  - 读取当前 token；
  - 如果能匹配到账号（邮箱/refresh_token），更新该账号的 `token.json`、`meta.json`；
  - 如果匹配不到，自动保存为新账号；
  - 如果 token 不存在（用户 `/logout`），跳过，不报错；
  - 捕获失败只警告，不影响 agy 的退出码。
- `agys` 运行期间注册 `state/runs/<pid>.json`；退出时删除。
- `agys next` 在切换和启动期间持有 `switch.lock`；启动后释放。

### 6.7 并发保护（Node 无第三方依赖）

不用 `fcntl`；用原子文件操作实现锁。

**switch lock**：

```text
acquireSwitchLock():
  try fs.openSync(state/switch.lock, "wx", 0600)
  if EEXIST:
    read JSON {pid, started_at}
    if pid is alive or age < 5 min: exit 3
    unlink stale lock; retry once
  write {pid: process.pid, started_at: ISO}
```

**state lock**：同样的 `wx` 逻辑，用于账号库短临界区。
**加锁顺序**：`switch.lock` → `state.lock`；`save` / post-run capture 只拿 `state.lock`。
持锁代码必须 `try/finally` 释放；未捕获异常也要释放，进程被 SIGKILL 时靠 stale lock 清理。

**run marker**：

```text
registerRun(pid, account):
  mkdir state/runs (0700)
  write state/runs/<pid>.json {pid, started_at, account} with flag "wx"

unregisterRun(pid): unlink file
assertNoRuns():
  for each state/runs/*.json:
    if pid alive -> collect
    else unlink stale
  scan ps for agy (unless AGYS_SKIP_RUNNING_CHECK=1)
  if any -> exit 3 with PID list
```

**启动 agy 时的竞态处理**：

1. 先检查 `switch.lock`；如果存在且有效，退出 3。
2. 注册自己的 run marker。
3. 再检查一次 `switch.lock`；如果出现，删除 marker 并退出 3。
4. 启动 agy。
5. 退出时删除 marker 并捕获 token。

`agys next` 持有 `switch.lock` 时调用 `spawnAgy`，传入 `lockHeld: true`，跳过第 1/3 步；
启动后释放锁。这样新会话不会在切号中途启动。

**检测手动启动的 agy**：

- Linux/macOS：`ps -axo user=,pid=,comm=,args=`；
- 只匹配当前用户（`os.userInfo().username` 或 `process.getuid()` 对应用户）的进程；
- 匹配 `comm` 的 basename 为 `agy`，或 args 第一个 token 的 basename 为 `agy`；
- 排除当前进程及其祖先；
- 找到则 `agys next` / `agys use` 打印 PID 列表并退出 3；
- `AGYS_SKIP_RUNNING_CHECK=1` 只跳过这一步，run marker 仍然生效。

原因：agy 运行中刷新 token 会写同一个文件；如果在它运行期间切换，它可能把旧账号 token 写回，
覆盖新账号。拒绝并发切换是最安全的 MVP 行为。

### 6.8 错误处理

- 所有面向用户的错误写到 stderr，前缀 `agys: `。代理模式下 stdout 只属于 agy。
- 永远不要打印 token 原文；错误里只显示邮箱、路径、JSON 字段名。
- `agys list` 的过期时间只做展示，不阻止切换；agy 会用 refresh_token 自动刷新。
- `agys save` 在没有当前 token 时退出 5，并提示先运行 agy 登录。
- 如果目标账号 token 损坏：`agys use` 退出 5，保持当前账号不变；
  `agys next` 跳过并警告，继续找下一个可用账号，全部不可用才退出 5。
- 如果**当前** token 损坏：
  - `agys save` / `agys login` 退出 5；
  - `agys next` / `agys use` 可以警告并继续切到目标账号，但必须先把当前原始字节备份到
    `state/previous-token.json`，避免用户被困在坏 token 上；
  - 目标账号也必须校验通过，否则按上一条处理。
- macOS Keychain 条目存在时，Keychain 写入失败属于切换失败：退出 5，当前账号不变；
  不允许出现“文件已切、Keychain 仍是旧账号”却报告成功的情况。
- `agys rm --force` 删除当前账号时，只删除本地快照，不删除真实 token；打印提示，
  `agys current` 之后显示 `unsaved`。
- 如果 `agy` 不存在：退出 6，提示 `AGYS_AGY_BIN` 或安装 agy。

---

## 7. 测试计划

使用 Node 内置 `node:test` 和 `node:assert/strict`，不依赖 Jest/Vitest。
所有测试在临时目录中运行，使用合成 token 和 fake agy，
**绝不能读写真实 `~/.gemini` 或真实 `~/.config/agys`**。

### 7.1 测试夹具

- `AGYS_HOME=<tmp>/agys`
- `AGYS_AGY_TOKEN=<tmp>/home/.gemini/antigravity-cli/antigravity-oauth-token`
- `AGYS_AGY_BIN=<tmp>/bin/agy`（shell 脚本，记录 argv 到 `AGYS_TEST_ARGS_FILE`，退出码由 `AGYS_TEST_EXIT` 控制）
  - 当参数包含 `-p /login` 且设置了 `AGYS_TEST_LOGIN_TOKEN` 时，fake 把该 JSON 写到
    `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`，然后退出 0；
  - 这用于测试 `agys login` 的隔离 HOME、保存与切换逻辑，不需要真实 OAuth。
- `AGYS_SKIP_RUNNING_CHECK=1`
- 在 `<tmp>/home/.gemini/antigravity-cli/` 放：
  - `conversations/aaa.db`（内容 `history-a`）
  - `history.jsonl`
  - `settings.json`
  - `installation_id`
  - `cache/last_conversations.json`
- 合成 token 函数：

  ```js
  function token(email, refresh, access = "access", expiry = "2026-11-10T10:20:37+08:00") {
    return {
      token: {
        access_token: access,
        token_type: "Bearer",
        refresh_token: refresh,
        expiry,
        expires_in: 3599,
      },
      auth_method: "consumer",
      id_token_email: email,
    };
  }
  ```

### 7.2 必测用例

1. `agys save` 保存当前 token，默认名来自邮箱；`agys list` 显示邮箱和当前标记。
2. 同一邮箱再次 `agys save` 更新而不是新建。
3. 同名不同邮箱：自动保存为 `NAME-2` 并打印实际名字，原账号不变。
4. 非法名字 `../evil`、`a/b`、空字符串被拒绝，不创建目录。
5. 保存 A、B 后，`agys next --no-run` 从 A 切到 B；再执行切回 A（round-robin）。
6. 当前 token 是未保存的 C 时，`agys next --no-run` 先自动保存 C，再切到下一个。
7. `agys use B` 后 token 文件内容等于 B 的快照，权限 0600。
8. 切换前后，`conversations/`、`history.jsonl`、`settings.json`、`installation_id`、
   `cache/` 的哈希完全不变。
9. `agys` 调用 fake agy，参数原样转发，退出码透传。覆盖：多个参数、含空格/引号/`=` 的参数、
   重复参数、未知子命令、未知 dash 参数。
10. `agys -- <args...>` 去掉第一个 `--` 后无条件转发，即使第一个参数是 agys 保留词；
    `--` 出现在后续位置时原样转发。
11. 代理模式下 agys 不向 stdout 写字节；fake agy 的 stdout 与直接运行时一致；
    切换横幅只出现在 stderr。
12. `agys next` 在切换后调用 fake agy；`--no-run` 不调用；`next` 的 agy 参数必须放在 `--`
    之后，未加 `--` 的多余参数退出 2。
13. `agys save` / `agys list` / `agys current` 的 stdout/stderr 不包含合成 token 的
    `access_token` / `refresh_token` 字符串。
14. 损坏 token（`{`）时 `agys save` 退出 5，原 token 文件字节不变。
15. 目标账号 token 损坏时 `agys use` 退出 5，当前 token 不变。
16. `agys next` 遇到损坏的目标时跳过并警告；两个账号都损坏时退出 5，当前 token 不变。
17. `agys next` 在只有一个账号时切回自己并正常启动。
18. `agys doctor` 在夹具环境中退出 0，输出 agy 路径、token 邮箱、账号数，不含 token。
19. macOS Keychain 解析函数用 fake `security` 输出测试三种格式：raw JSON、quoted JSON、base64 JSON。
20. macOS 文件与 Keychain 邮箱不同时，`agys doctor` 报错退出 5；同邮箱漂移只警告。
21. `agys --help` / `agys help` 列出所有命令、保留词和 `--` 逃生通道。
22. 文件权限：`~/.config/agys` 0700，`accounts/*` 0700，`token.json` / `meta.json` / `config.json` 0600。
23. 存在一个存活的 `state/runs/<pid>.json` 时，`agys next --no-run` 退出 3，token 不变。
24. 存在一个死 PID 的 `switch.lock` 时，`agys next --no-run` 能清理并继续。
25. `agys login` 使用 fake agy：fake 检测到 `-p /login` 时，把 `AGYS_TEST_LOGIN_TOKEN`
    写到 `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`，然后退出 0。
    执行 `agys login new` 后：
    - 新账号出现在 `agys list`；
    - `agys current` 变成新账号（登录并切换）；
    - 旧账号快照仍完整，`agys use <old>` 能切回；
    - 真实 token 文件等于新账号 token；
    - `state/login-*` 临时目录已删除；
    - agys 自身不向 stdout 写内容（fake agy 无 stdout 时整条命令 stdout 为空）；
      提示信息只在 stderr，且不含 token。
26. `agys login` 新账号与当前邮箱相同：更新当前账号快照并保持当前，不新增重复账号；
    真实 token 等于新 token。
27. `agys login` fake agy 退出但没有写 token：退出 5，当前 token 不变，临时目录已删除。
28. `agys login NAME` 的 NAME 已被另一个邮箱占用：新账号保存为 `NAME-2`，旧账号不被覆盖，
    并切换到 `NAME-2`。
29. `agys login` 超时：fake agy 睡眠且不写 token，`AGYS_LOGIN_TIMEOUT=500`，退出 5，
    child 被结束，当前 token 不变，临时目录已删除。
30. 当前 token 未保存时执行 `agys login`：先自动保存当前账号 A，再保存并切换到 B；
    两者都在 `list` 中，A 可用 `use` 切回。
31. macOS Keychain 单测：登录成功时安装 B 到文件与 Keychain；登录失败时恢复 A；
    恢复失败时退出 5 且不删除 `state/previous-token.json`。
32. 没有当前 token（首次使用）时执行 `agys login`：新账号保存后安装为当前账号；
    走与有当前账号时相同的 `installAccount` 路径。
33. `agys next` 在没有当前 token 时从 `config.last` 的下一个开始轮转。
34. 代理模式退出码：fake agy 退出 2/5/7 时 agys 原样返回，不映射成 agys 错误。

### 7.3 npm 打包测试

```bash
npm test
npm pack --dry-run
npm pack
TMP=$(mktemp -d)
npm install -g --prefix "$TMP" .
"$TMP/bin/agys" help
"$TMP/bin/agys" version
```

验收：

- tarball 只包含 `package.json`、`bin/`、`lib/`、`README.md`、`LICENSE`；
- 不包含 `test/`、token、抓包、`.env`；
- 临时 prefix 安装后 `agys help` 可执行；
- `npm uninstall -g --prefix "$TMP" agys` 可清理。

### 7.4 真实环境 smoke test（可选，`AGYS_REAL_AGY=1` 才执行）

在 WSL 中，**不切换账号、不启动对话**：

```bash
agys doctor
agys save
agys list
agys current
agys --version     # 必须是 agys 版本，不启动 agy
agys -- --version  # 若 agy 支持，显示 agy 版本；不发起模型请求
```

然后验证：

- `agys save` 前后 `sha256sum ~/.gemini/antigravity-cli/antigravity-oauth-token` 不变；
- `agys save` 不修改 `conversations/`、`history.jsonl`；
- 代理转发 smoke：`agys <agy 的无副作用参数>` 与直接运行 agy 的 stdout/退出码一致；
  不确定时不要用会发起模型请求的参数。

不要在没有第二个账号的情况下执行真实 `agys next` 并启动 agy。
`agys login` 涉及真实 Google OAuth，默认不要在无人值守的 goal 中执行；只在用户在场、
有第二个账号和浏览器/可粘贴授权码时手工验证。

### 7.5 手工验收（写入 README 的 MANUAL 清单）

- macOS：`npm install -g .`、`agys doctor`、`agys save`、两个账号 `agys next`、`agy -c` 历史仍在；
  检查 Keychain 条目是否存在、切换后文件与 Keychain 是否都指向目标账号。
- 登录新账号并切换（不丢失旧账号）：
  1. 当前已登录账号 A，`agys save a`；
  2. `agys login b`，完成浏览器 OAuth（或粘贴授权码）；
  3. 命令结束后 `agys current` 必须是 `b`，`agys list` 必须同时有 `a` 和 `b`；
  4. `agys use a` 能切回 A，`agys use b` 能再切回 B；
  5. 检查 `~/.config/agys/state/` 下没有残留 `login-*` 目录。
- 双账号跨账号续聊：
  1. 账号 A 下创建一个带唯一暗号的对话（例如 `ORANGE`）；
  2. `agys save a`；
  3. 登录账号 B，`agys save b`；
  4. `agys use a`，`agy -c -p "暗号是什么？"` 应回答 `ORANGE`；
  5. `agys use b`，再次 `agy -c -p "暗号是什么？"`，记录是否成功；
  6. 如果失败，记录完整错误；本地历史仍在，不要修改数据库。

---

## 8. 交付物

在本目录创建：

```text
package.json
package-lock.json
bin/agys.js
lib/agys.js
test/agys.test.js
README.md
LICENSE
.gitignore
```

可选：

```text
test/fixtures/fake-agy.sh       # 由测试动态生成也可以
```

`README.md` 必须包含：

- 安装：
  - `npm install -g .`（本地立即可用）
  - `npm install -g agys`（发布后可用）
  - 权限不足时的 `--prefix "$HOME/.local"` 方案
- 使用示例：`agys save` / `agys login` / `agys` / `agys next`
- 原理：只替换 token，不碰历史
- **透明代理契约**（必须单独一节）：
  - 代理模式下参数原样转发，stdout 只属于 agy，agys 输出只走 stderr
  - 保留词完整清单：`help`、`--help`、`version`、`--version`、`save`、`login`、
    `list`、`ls`、`current`、`use`、`switch`、`next`、`rm`、`doctor`；
    未列出的参数（包括 `-h`、`--model`）一律原样转发
  - `agys -- <agy args...>` 逃生通道；`--` 出现在其它位置时的行为
  - `agys next` 的 `--no-run` 和 `--` 规则；`login` / `use` / `rm` 不接受 agy 参数
  - 退出码：代理模式原样透传；agys 自己的 2-7 只在启动前/子命令产生
  - 信号：同进程组，不重复发送 SIGINT；SIGTERM 转发；130/143 映射；
    SIGHUP/SIGWINCH 等自然送达，不拦截
  - cwd/env 不变，不注入 `ANTIGRAVITY_*`，不覆盖 `HOME`（`login` 的临时 HOME 仅用于 OAuth child）
  - agy 必须是 PATH 中的可执行文件；shell alias/function 不会被继承，必要时用 `AGYS_AGY_BIN`
- `agys login` 的工作方式：
  - 先把当前账号保存进账号库
  - 在 `~/.config/agys/state/login-*` 创建临时 `HOME`
  - 用 `agy -p "/login"` 发起官方 OAuth
  - 新 token 保存到账号库后安装为当前账号并删除临时目录
  - 登录完成后直接 `agys` / `agys -c` 继续工作
  - 登录失败/超时才恢复旧账号；成功后 `agys use <旧账号>` 可切回
- 安全与限制：
  - 运行中的 agy 不会切号；`agys login` / `agys next` 要求先退出正在运行的 agy
  - 跨账号云端续聊需双账号实测
  - 同一设备/IP/installation_id 多账号可被关联，不是防封工具
  - macOS Keychain 的验证状态，以及 `agys login` 在 macOS 上是否真正隔离 Keychain
- 故障排查：
  - `command not found` → PATH
  - `EACCES` → npm prefix
  - token 不存在 → 先登录 agy
  - `agys next` 退出 3 → 先退出正在运行的 agy
- 卸载：`npm uninstall -g agys`

`LICENSE` 使用 MIT，版权人写 `agys contributors`，不要写个人隐私信息。

---

## 9. 验收标准（Definition of Done）

全部满足才算完成：

- [ ] `npm test` 全部通过（Node >=18）。
- [ ] `node bin/agys.js help` 和 `node bin/agys.js version` 正常。
- [ ] `npm pack --dry-run` 的 tarball 只包含运行所需文件，不含 `test/`、token、抓包、`.env`。
- [ ] `npm install -g --prefix "$(mktemp -d)" .` 后，临时 prefix 下的 `agys help` 可执行。
- [ ] 合成账号测试中，`agys save` / `agys list` / `agys use` / `agys next --no-run` 全部符合 §3。
- [ ] `agys login` 使用 fake agy 测试通过：新账号保存并成为当前账号，旧账号快照完整且可用
      `agys use` 切回；`installAccount` 后真实 token 等于新账号；临时 `login-*` 目录删除。
- [ ] `agys login` 的失败路径（无新 token、超时）均恢复/保持当前账号不变，且退出码正确；
      名字冲突按 `NAME-2` 保存，不覆盖旧账号。
- [ ] 切换前后历史夹具哈希完全一致（§7.2 第 8 条）。
- [ ] 所有输出不含 token 原文；所有敏感文件 0600，目录 0700。
- [ ] `agys` 启动 fake agy 时参数与退出码透传。
- [ ] 透明代理测试通过：参数（含空格/引号/`=`/重复项）原样转发；`agys --` 跳过保留词；
      代理模式 stdout 无 agys 输出；agy 退出码 2/5/7 原样透传。
- [ ] `agys next` 在检测到运行中的 agy 或存活 run marker 时退出 3，不覆盖 token。
- [ ] `agys doctor` 在无账号、无 agy、token 损坏等情况下给出可操作错误，不崩溃。
- [ ] `README.md` 明确写出：
  - 只替换 token，不碰历史；
  - `agys login` 先保存当前账号，登录新账号并切换；失败时恢复旧账号；
  - 透明代理契约：保留词、`--`、stdout/stderr、退出码、信号、cwd/env；
  - 运行中的 agy 不会切号；
  - 同一设备/IP/installation_id 多账号可被关联，这不是防封工具；
  - 跨账号云端续聊需双账号实测；
  - macOS Keychain 的验证状态；
  - `npm install -g .` 与 `npm install -g agys` 的区别。
- [ ] 没有执行 `npm publish`；最终报告如实列出：已运行的测试、未运行/手工的测试、已知限制。

---

## 10. 执行顺序

1. **Discovery**：确认 `node --version`、`npm --version`、`agy --version`、token 路径、
   `conversations/` 是否存在；不要打印 token 内容。
2. **npm 骨架**：`package.json`、`bin/agys.js`、`lib/agys.js`、`LICENSE`、`.gitignore`；
   先让 `node bin/agys.js help` 可运行。
3. **账号库**：路径、JSON 读写、原子写、权限、`save` / `list` / `current` / `use` / `rm`。
4. **登录**：`login`、隔离 HOME、`agy -p "/login"`、保存当前账号、安装新账号、失败回滚、
   临时目录清理。
5. **切换**：`next`、round-robin、跳过损坏账号、自动捕获当前账号、`--no-run`。
6. **运行**：透明代理（argv/stdio/退出码/信号）、退出后同步、switch/state/runs 锁协议。
7. **测试**：先写夹具和 §7.2 全部用例，再修实现。
8. **npm 验证**：`npm test`、`npm pack --dry-run`、临时 prefix 安装、`agys help`。
9. **文档**：`README.md` 写清安装、使用、限制、故障排查。
10. **Smoke**：`agys doctor`、`agys save`、`agys list`；真实 `agys next` / `agys login` 只在有两个账号且用户明确允许时做。
11. **最终报告**：按 §11 输出。

每完成一个阶段，运行一次测试；不要把所有测试留到最后。

---

## 11. 最终报告格式

完成后，用以下格式汇报（中文）：

```markdown
## 完成情况
- npm 包名/版本：
- 实现文件：
- 测试命令与结果：
- npm pack 内容：
- 临时 prefix 安装结果：
- 真实环境 smoke：
- `agys login` fake 测试结果（是否切换为新账号、旧账号是否可切回）：
- 透明代理测试结果（argv/stdio/退出码）：
- 未执行/需要手工验证：

## 核心设计
- token 路径与写入策略：
- 历史保护策略：
- 透明代理策略（参数、stdio、退出码、信号）：
- `agys login` 保存-登录-切换与失败恢复策略：
- 并发保护：
- macOS Keychain 处理：

## 已知限制
- 运行中 agy 不切号：
- `agys login` 需要浏览器/授权码：
- 跨账号云端续聊：
- 账号关联风险：

## 使用示例
agys save work
agys login personal
agys list
agys next
```

如果任何测试失败，不要声称完成；给出失败命令、退出码和关键 stderr（脱敏后）。

---

## 12. 备注：为什么不是“复制整个配置目录”

用户的核心要求是“切换账号后其他没有变化，比如对话历史”。agy 的历史是本地 SQLite + JSONL，
和 token 文件分离。复制整个配置目录会得到两套历史，后续 `--continue` 会看到不同的列表。
因此本方案只替换 token，所有历史文件保持在原位、原 inode、原权限。

agy 自己可能会把当前账号的云端对话摘要同步到对话列表（日志里可见 `ListConversations` /
`Cloud summaries` 相关行为）。`agys` 不会改动 `conversations/*.db`、`history.jsonl` 等本地历史，
但“列表里是否出现新账号的云端摘要”由 agy 决定；如果要求列表也严格按账号隔离，只能采用
“每账号独立 home/config”的方案，而那会分叉本地历史，和本目标冲突。

`agys login` 是唯一一个“临时使用独立 HOME”的功能：它只借这个 HOME 完成新账号 OAuth，
不读取当前历史，也不把新账号的登录状态留在真实配置里。登录前当前账号已保存进账号库；
登录成功后新 token 进入账号库并安装为当前账号，临时 HOME 删除。macOS 上如果 Keychain
是全局的，成功时让 Keychain 也指向新账号，失败时才按 §6.4.1 恢复旧值。

`agys` 对 agy 是透明代理：除了 §3.1 列出的保留词和 `--` 逃生通道，参数、stdio、cwd、env、
信号和退出码都按 agy 直连处理。任何不得不覆盖的行为都必须出现在 README 的代理契约里，
不能让用户在看 `agys help` 之外还要猜。

同一台机器、同一个 `installation_id`、同一个出口 IP 下轮换多个账号，账号之间仍然可能被关联；
`agys` 解决的是本地使用便利性和配额切换，不是反检测/防封工具。

---

## 13. 完成信号

当且仅当 §9 的验收标准全部通过（或只剩无法在当前环境执行的 `MANUAL` 项，且已在最终报告中如实列出）时，
在最终报告的最后一行输出：

```text
<!-- GOAL_COMPLETE -->
```

如果当前使用的 `goal` 命令要求不同的完成标记，以该命令的要求为准；不要在没有完成时输出标记。