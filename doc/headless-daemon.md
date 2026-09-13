# 无头 Bot（Headless）运行机制

> 扩展：`~/.copilot/extensions/copilot-telegram-bridge`  
> 模型：[`models-config.md`](./models-config.md) · 人设：[`system-prompts.md`](./system-prompts.md) · runtime：[`../runtime/README.md`](../runtime/README.md)  

无头主路径是 **LaunchAgent 常驻守护**，**不依赖 GitHub Copilot 桌面 App**。CLI / SDK / bootstrap 钉在扩展目录 `runtime/`（见 [`../runtime/README.md`](../runtime/README.md)）。

```text
launchd gui/$(id -u)  com.copilot-telegram-bridge
  KeepAlive + ThrottleInterval=10
       ▼
headless-daemon.sh run
  TELEGRAM_BRIDGE_MODE=headless-only
       ▼
runtime/<VERSION>/cli/copilot  +  runtime/<VERSION>/pkg/preloads/extension_bootstrap.mjs
  COPILOT_CLI_DIST_DIR=runtime/<VERSION>/pkg   ← CLI 的 JS 运行时也钉在这里
       ▼
extension.mjs
  只起 role=headless 的 bot
```

**硬依赖**：`runtime/` 成对 CLI+SDK · CLI Proxy `:8317` · `config/bots.json` token · `config/access.json`。

⚠️ **CLI 的 JS 运行时 = `runtime/<VERSION>/pkg` 本体**：SEA launcher 认 `COPILOT_CLI_DIST_DIR`，直接 `import <pkg>/index.js`，于是 `resolveBootstrapPath()` 命中的是 `<pkg>/preloads/extension_bootstrap.mjs`（已软化那份）；**全程不读 `~/Library/Caches/copilot/pkg`**（该缓存已删，`COPILOT_AUTO_UPDATE=false` 防止 CLI 自动下载把它重建）。

换版本：`bash scripts/vendor-copilot-runtime.sh [版本]` —— **两阶段**：先跑 `preflight-sdk-diff.sh` 预览（上游 changelog + 6 个关键 API 面 diff），确认后才拉包 + 软化 bootstrap + 写 `VERSION` + **自动 restart 并打 status**；关键面有变化时要求完整输入 `yes`，非 TTY 环境须显式 `--yes`。规程见 [`sdk-upgrade.md`](./sdk-upgrade.md)。见 [`../runtime/README.md`](../runtime/README.md)。PATH 上的 npm/brew `copilot` 不够。

---

## 1. 模式与启动

| 变量 | 守护取值 | 作用 |
| :--- | :--- | :--- |
| `TELEGRAM_BRIDGE_MODE` | `headless-only` | 脚本仍写入；其它值会被忽略 |
| `EXTENSION_PATH` | `…/copilot-telegram-bridge/extension.mjs` | 扩展入口 |
| `COPILOT_SDK_PATH` | `runtime/<ver>/pkg/copilot-sdk` | SDK |
| `COPILOT_CLI_PATH` | `runtime/<ver>/cli/copilot` | CLI（子进程用） |
| `COPILOT_CLI_DIST_DIR` | `runtime/<ver>/pkg` | **CLI 的 JS 运行时**（层1 launcher 直接 import 这里的 index.js）。⚠️ 带上它就不能再传 `--prefer-version`，那个 flag 会让它失效 |
| `COPILOT_AUTO_UPDATE` | `false` | 禁 CLI 自动下载/换版本（= `--no-auto-update`），防止偷偷重建 Caches |
| `SESSION_ID` | `headless-daemon` | **宿主**会话名，不是业务 sticky UUID |

`bots.json` 的 `role` 只认 `headless`。`editor` 启动时跳过。

`headless-daemon.sh run`：对齐 CLI/pkg 版本 → **硬校验**（`pkg/index.js`+`app.js` 在、bootstrap 带 `HEADLESS_BOOTSTRAP_COMPAT_V1`，否则响亮报错而不是静默崩循环）→ 写 `bots/Headless/daemon.pid` → `exec copilot extension_bootstrap.mjs`（stdout/err → `daemon.log`）。

---

## 2. Leader 与 sticky

实现：`lib/headless-leader.mjs` · 文件：`bots/<Name>/headless.leader.json`

同一 bot token 只允许一个存活循环，否则会双 poll、空壳狂增。

| 己方 | 对方仍存活 | 结果 |
| :--- | :--- | :--- |
| `daemon` | `daemon` | 不抢 |
| `daemon` | 历史 `app` leader | 可抢（`preferSteal`） |
| 任意 | 对方 pid 已死 | 覆盖 |

写入后双读确认。`refreshHeadlessLeadership` 失败则让位。

| 函数 | 用途 |
| :--- | :--- |
| `resolveHeadlessResumeTarget` | 启动优先 resume：lock → `lastSessionId`，且必须可 resume |
| `resolveHeadlessStickySessionId` | 新建复用 UUID，避免重连狂建空壳 |
| `rememberBotSession` | 写入 `state.json` 的 `lastSessionId` |

**可 resume**：有 `session.db` 或非空 `events.jsonl`。仅 `workspace.yaml` 的空壳不算。业务 sticky 在 `lock.json` / `state.json`，与 `SESSION_ID=headless-daemon` 不是一回事。

断线：循环报错 / session lost → 约 10s 重连；仍持 leader 则 resume/create 再 poll。

---

## 3. 钉死的 runtime

守护 **不读** PATH、也 **不扫** Copilot.app 缓存。

| 角色 | 路径 |
| :--- | :--- |
| 版本针 | `runtime/VERSION` |
| CLI | `runtime/<ver>/cli/copilot` |
| pkg / bootstrap / SDK | `runtime/<ver>/pkg/` |

`status` 的 `align=vendored:<ver>` 为命中。PATH 上的 npm/brew `copilot` **不能**替代这套布局。升级用 `vendor-copilot-runtime.sh` 拉 `@github/copilot-<plat>`，见 [`../runtime/README.md`](../runtime/README.md)。

bootstrap 的 parent-pid 软化**只打 vendored 副本**（`runtime/<ver>/pkg/preloads/extension_bootstrap.mjs`）—— 因为 `COPILOT_CLI_DIST_DIR` 让 CLI 就跑这一份，它才是**生效文件**。`~/Library/Caches/copilot/pkg` 已删除、也不再使用（`run` 启动时若发现它冒出来，会在 `daemon.log` 打 warn 提醒 DIST_DIR 可能没生效）。

> 历史坑（2026-09-13，升级 1.0.83 崩循环 73 次）：CLI 的层1 launcher 默认把**内置 `copilot.tgz` 自解包**到 `~/Library/Caches/copilot/pkg/<plat>/<ver>/` 并 `import` 那里的 `index.js`；层2 `resolveBootstrapPath(argv, __dir)` 又**优先**用该目录的 `preloads/extension_bootstrap.mjs`，argv 传进去的 vendored 路径被丢弃。于是只在 vendored 副本上软化 = 打给永不执行的文件，原版父进程门闩 `process.exit(0)` 静默退出 → KeepAlive 崩循环。修法是 `COPILOT_CLI_DIST_DIR` 把 `__dir` 钉回 vendored pkg。

---

## 4. 会话数据面（摘要）

细节以专文为准，这里只列无头差异：

* 会话：SDK `createSession` / `resumeSession`。
* 模型：`config/models.json`（`catalog` + `modelSets.headless` + cliproxy）。改完 `check-model-config.mjs --live` 再 `restart`。见 [`models-config.md`](./models-config.md)。
* 人设 / MCP / Skills：create、resume、`/session`、`/new`、`/model` 重注入。见 [`system-prompts.md`](./system-prompts.md)。`enableConfigDiscovery` **不开**。
* 权限：默认 allow-all —— RPC `permissions.setMode("allow-all")` + `setApproveAll(true)` 再保险 + handler `approve-once`。
  ⚠️ **1.0.83 起 `setAllowAll` 被整个移除**（不是废弃），替代品 `setMode`，`PermissionMode = "manual"|"assisted"|"allow-all"`，
  官方语义 `allow-all` = tool+path+URL 全自动批准（与旧 `setAllowAll` 同域）；旧版自动回落，无需改配置。
  `deny-all` = `setMode("manual")` + `setApproveAll(false)` + handler `deny-once`，且默认不加载 MCP。
  日志会打 `permissions.setMode(...) ok success/mode=` —— 以**权威 post-mutation mode** 自证生效。
### 4.1 MCP 与 Skills（按 bot 分开 · MCP 必须两层）

**MCP 为什么要两层**：`loadMcp:false` 只挡住了「会话层注入」，而运行时（CLI）会**自己读 `~/.copilot/mcp-config.json`** 并起进程
—— 实测反推 bot 的 `tavily-mcp` 照样在跑（守护下两个 child 各挂一个）。所以：

| 层 | 落点 | 语义 |
| :--- | :--- | :--- |
| ① 会话级 | `SessionConfig.disabledMcpServers` | 创建/**冷**恢复时**不启动、不鉴权** |
| ② 进程级 | `RuntimeConnection.forStdio({ args })` → `--disable-mcp-server <name>` | 进程**根本没机会起**（比①更早） |

两层共用**同一名单真源** `resolveDisabledMcpServers()`：`loadMcp:false` ⇒ `mcp-config.json` 里**全部** server ＋ 内置
`github-mcp-server` ＋ bots.json 显式 `disabledMcpServers`；`loadMcp:true` ⇒ 只禁显式名单。
⇒ **新增 MCP server 无需改代码**（名单自动推导）。
⚠️ **resident resume 不能停已经在跑的 server** ⇒ 改完必须**冷重启**（`headless-daemon.sh restart`）。
✅ 验证：`pgrep -f tavily-mcp | wc -l`（应为 2 = 只剩 Headless 那份）；日志 `[<bot>] runtime MCP args=…` 与 `headless MCP hard-disabled → …`。

**bots.json 开关**（两 bot 都**显式写死**，不依赖画像默认）：`loadMcp` / `loadSkills` / `disabledMcpServers` / `clientMode` / `permissionMode`。

**`clientMode: "empty"`**（官方 client 模式；SDK 明示多用户服务应用它）：可选特性默认全关 + 工具过滤 **deny-wins**。两条硬要求（SDK 会 throw）：
① `baseDirectory`（下传为 `COPILOT_HOME`，传 `~/.copilot` 保持 sticky 会话位置不变）；② 每会话显式 `availableTools`
（Headless `["builtin:*","mcp:*","custom:*"]`；反推 bot `[]` = 无工具 ⇒ 比 deny-all 更硬）。
副作用：SDK 会注入 `COPILOT_DISABLE_KEYTAR=1`（关 keychain），且 `coauthorEnabled` 默认翻成 false（已显式设回 true）。

**Skills（已对齐官方旋钮，退役自建黑名单）**：`enableSkills` + `skillDirectories` + `includedBuiltinSkills: []`
（empty 下**省略即不加载任何运行时内置技能**）+ `enableConfigDiscovery: false`（收掉自动发现层）。
会话打开时打**技能面自证**（读回**实际**可用技能，日志说真话才算数）：

```text
telegram-bridge: [Headless] skills 自证：可用 22/22 → <技能名…>       # 只列我们自己目录里的，内建技能一个不剩
telegram-bridge: [专用 bot] skills 自证：可用 0/0（无）
```

### 4.2 会话心跳与官方模型面（2026-09-13 起的现状）

* **心跳位置**：`runHeartbeat()` 在**收完消息之后**跑（每 60s 节流）。原先它排在 `getUpdates()` **之前**，慢/挂时最多阻塞 8s
  —— 代码注释原话就是"半天没响应，过一会儿一下全回来"；全量统计 `heartbeat timeout` 发生过 **1382 次**。
* **心跳不再查云端**：删掉了 `model.list()`，只走 `banishBlockedSessionModel`（内部先 `getCurrent()`，仅当前模型是官方时才动作）。
  `isOfficialModelBlocked` 是**纯 id/名单判断**，不依赖云端目录 ⇒ 掉这条调用零损失。
* **超时** `HEARTBEAT_TIMEOUT_MS` 8s → **6s**（心跳只剩本地 RPC，6s 富余）。
* **官方模型面**由 `config/models.json → display.officialModels.enabled` 控制（当前 `false`：跳过两处 `listModels()`，
  启动诊断改用**本地** `model.getCurrent()`，错误体经 `compactError()` 压成一行）；`auth.login=false` 时它自动视为关闭。
* **自证**：`session model current: cliproxy/…（官方模型面已关闭，跳过云端 model.list）` ＋ `auth: isAuthenticated=…`。

* 锁：`bots/<Name>/lock.json`；他会话持锁则 auto-connect 停手。

---

## 5. LaunchAgent

| 项 | 值 |
| :--- | :--- |
| Label | `com.copilot-telegram-bridge` |
| 安装路径 | `~/Library/LaunchAgents/com.copilot-telegram-bridge.plist` |
| 模板 | `scripts/com.copilot-telegram-bridge.plist` |
| 域 | `gui/$(id -u)`（登出即停） |
| 日志 | `bots/Headless/daemon.log` |

```bash
EXT=~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh
bash "$EXT" install     # plist + bootstrap + kickstart
bash "$EXT" uninstall   # bootout + 删 plist + 杀进程
bash "$EXT" start       # 已装走 launchd；未装 nohup（无开机自启）
bash "$EXT" stop        # 先 bootout，否则 KeepAlive 立刻拉回
bash "$EXT" restart
bash "$EXT" status
```

```bash
bash "$EXT" status
# 期望：running · launchd=loaded · leader "mode":"daemon"

launchctl print "gui/$(id -u)/com.copilot-telegram-bridge" | head
curl -sS -m 5 -o /dev/null -w "mac %{http_code}\n" http://127.0.0.1:8317/v1/models
curl -sS -m 8 -o /dev/null -w "nas %{http_code}\n" http://127.0.0.1:8317/v1/models
tail -50 ~/.copilot/extensions/copilot-telegram-bridge/bots/Headless/daemon.log
```

网关指针以 `switch-cliproxy-backend.sh status` 为准，不要把某一端写成永久默认。

---

## 6. 登录与鉴权

无头 **不需要 Copilot.app**，但宿主仍是闭源 Copilot CLI。GitHub 身份、cliproxy key、Telegram token 是三套凭证，失效时先对层再动手。

| 层 | 失效长什么样 | 怎么办 |
| :--- | :--- | :--- |
| **GitHub Copilot 宿主** | 守护起不来、`client.start` / `listModels` 失败、官方模型 401 | 用 **vendored** 二进制重登（见下），再 `headless-daemon.sh restart` |
| **cliproxy 上游** | Telegram 报 `auth_unavailable`、换模型才好 | **不是** GitHub 登录。查 `:8317` 是否起、key / 渠道 |
| **Telegram 配对** | Bot 不理、要 6 位码 | 再发一条回配对码；或从 `config/access.json` 去掉该 user |

日常 BYOK 走 cliproxy 时，中间那层更常见。`auth_unavailable` 按上游配额处理，不当本机 Copilot 掉线。

重登宿主（必须和守护同一份 CLI，不要用 brew / PATH 上的 `copilot`）：

```bash
cd ~/.copilot/extensions/copilot-telegram-bridge
VER=$(tr -d '[:space:]' < runtime/VERSION)
# ⚠️ 必须带 COPILOT_CLI_DIST_DIR，否则 CLI 会自解包重建 ~/Library/Caches/copilot/pkg（该缓存已删）
COPILOT_CLI_DIST_DIR="$PWD/runtime/$VER/pkg" COPILOT_AUTO_UPDATE=false \
  "runtime/$VER/cli/copilot" login
bash scripts/headless-daemon.sh restart
```

本机桌面默认浏览器 OAuth；SSH / 无图形加 `--device-code`。

CLI 还会按顺序读：`COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`。认 fine-grained PAT（**Copilot Requests**）、Copilot CLI OAuth、`gh` 的 Copilot OAuth。**不认经典 `ghp_`。** `gh auth status` 里已有 `copilot` scope 时，有时能直接被 CLI 用；仍 401 再跑上面的 `login`。

**想直接不登录**：`config/models.json → auth.login: false`（已设）—— 启动清身份 env + SDK 传 `--no-auto-login`，
官方模型面自动视为关闭；会话/技能/权限/BYOK 全不受影响，日志会打 `auth: isAuthenticated=false` 自证。详见 [`models-config.md`](./models-config.md) §1.1。

**无身份也能跑（2026-09-13 隔离实测）**：清空所有 token 类 env ＋ `COPILOT_HOME` 指向临时目录 ＋ PATH 去掉 `gh`
（SDK 报 `isAuthenticated:false` / `Not authenticated`）时，链路**依然完整**：`start ok` → `createSession ok` →
BYOK（cliproxy）回合**正常返回内容**。失效的只有**官方模型面**（`listModels` 报 Not authenticated）——
而它已被 `models.json → display.officialModels.enabled=false` 屏蔽（跳过调用、不再刷 401）。
⇒ 日常 BYOK **不依赖 GitHub 身份**；但没必要删凭证（保留更稳），只是**别指望官方模型**（已实测 401：该 PAT 缺 `Copilot Requests`）。

> 副作用提醒：`CopilotClient({ mode: "empty" })` 会让 SDK 给 runtime 注入 `COPILOT_DISABLE_KEYTAR=1`（keychain 被关），
> 于是身份来源只剩 env token 与 `gh` CLI —— 这也是上表"宿主 401"排查时**优先查 env token** 的原因。

Telegram token 在 `config/bots.json`（明文、勿提交）。废了去 BotFather `/revoke` 再写回并 restart。

---

## 7. 故障速查

| 现象 | 优先查 |
| :--- | :--- |
| 开机后无头不回 | `status` / `launchctl print`；是否在登录 gui 会话；`daemon.log` |
| `copilot CLI not found` / bootstrap missing | `runtime/VERSION` 与 `runtime/<ver>/` 是否成对；补 `vendor-copilot-runtime.sh` |
| 约两条后停 | 没走守护或 leader 被占 → `install`，确认 `mode=daemon` |
| poll `fetch failed` | 本机网络 / 代理；**勿改 Stash**，先报主人 |
| `setMyName` Rate limited | `state.lastSetMyName` 同名跳过；改 `bots.json` label 才会再调 |
| 401 / 模型列表空 | cli-proxy-api 是否起、key 是否失效 |
| Session not found | sticky 空壳；`/session` 只列可 resume；`/clean` |
| 双 bot 抢答 / 空壳狂增 | 双 leader；`stop` 干净后再单实例 `start` |
| `stop` 后立刻回来 | KeepAlive → 必须用脚本 `stop`（含 bootout） |
| 长轮无工具气泡 ≈3 分钟 | 可 `/stop` |
| `auth_unavailable` | 上游鉴权/配额，引导 `/model`；不是本机登录失效 |
| 宿主起不来 / 官方模型 401 | 第 6 节 GitHub Copilot 重登；勿与 cliproxy key 混用 |
| 不回消息、`daemon.log` 只有 2 行 `resolveBootstrapPath` 就断 | 生效 bootstrap 是原版（父进程门闩 `exit(0)`）：查 `status` 的 `dist=` 是否指向 `runtime/<ver>/pkg`；`~/Library/Caches/copilot/pkg` 是否被重建 |
| `vendored pkg incomplete` / `bootstrap parent-pid compat missing` | 启动前硬校验拦下（宁响亮报错不静默崩循环）→ 重跑 `vendor-copilot-runtime.sh` |
| `daemon.log` 出现 `warn: …/Caches/copilot/pkg 存在` | DIST_DIR 没生效或有别的进程用了它 → 核对 `status` 的 `dist=`、进程 env 里的 `COPILOT_CLI_DIST_DIR` |
| `daemon.log` 出现 `⚠️ systemMessage section 漂移` | 新 SDK 改了段名 → 裁剪会**静默失效**（CLI 底模渗进人设）。按 [`system-prompts.md`](./system-prompts.md) §3.1 对齐基线后重启 |
| 升级前 `preflight` 报 `⑥ pattern miss` / vendor 拒绝升级 | bootstrap 父进程门闩写法变了 —— **升了会静默崩循环**。对齐 `scripts/patch-bootstrap-compat.py` 后再升，见 [`sdk-upgrade.md`](./sdk-upgrade.md) |
| 权限姿态可疑 / `setMode 与 setAllowAll 都不存在` | SDK 权限 API 又变了 → 查 vendored `copilot-sdk/generated/session-events.d.ts` 的 `PermissionMode`，在 `lib/bot-handlers.mjs` 补检测分支；日志的 `success=/mode=` 是权威证据 |
| **"bot 卡了"先看哪层** | ① `poll error (retry in 5000ms): fetch failed` / `timeout` / `502` → **Telegram 出网**（退避 5s→10s→20s，退避期间消息收不进来，最常见；**勿改 Stash**，先报主人）② `session heartbeat failed` → 心跳（现已挪到收消息之后，设计上不再挡）③ 回合内工具被拒/弹窗 → **macOS 本地文件访问（TCC）**，只影响处理、不影响收消息 ④ `401` → 官方模型面（不影响日常 BYOK） |
| 本地文件访问被拒（TCC） | 系统设置 → 隐私与安全性 → 文件与文件夹 给对应进程授权；它只影响**回合内工具调用**，不影响消息接收 |
| HTTP2 `INTERNAL_ERROR` | 流断开，重试 |

---

## 8. 路径

```text
~/.copilot/extensions/copilot-telegram-bridge/
  extension.mjs  lib/  scripts/headless-daemon.sh
  config/{bots,access,models}.json
  bots/Headless/{daemon.pid,daemon.log,headless.leader.json,lock.json,state.json}

~/.copilot/mcp-config.json
memory/AGENTS.md
~/Library/LaunchAgents/com.copilot-telegram-bridge.plist
runtime/<ver>/cli/copilot
runtime/<ver>/pkg/          # CLI 的 JS 运行时本体（COPILOT_CLI_DIST_DIR 指这里）
~/.cli-proxy-api/          # :8317，独立 LaunchAgent
```

### 8.1 日志策略（2026-09-13 起）

* **每条带时间戳**：格式 `[MM-DD HH:MM:SS]`（本地时区）。
  * 桥侧：`lib/log-stamp.mjs` 必须是 **extension.mjs 的第一个 import**（side-effect 模块），
    这样其它模块的**顶层代码**也带前缀；launchd 只是把 stdout/stderr 落盘，桥侧不自己写文件。
  * 脚本侧：`headless-daemon.sh` 的 `log()`（含 bootstrap 软化输出）。
  * 例外：`[extension-fork]` / `[extension-bootstrap]` / `[extension-resolver]` 这 6 行由 SEA bootstrap 在
    **加载 extension.mjs 之前**打出，没有前缀（属正常，不是漏）。
* **按大小轮转**：`run_daemon` 启动时调 `rotate_log_if_needed` —— 默认**超过 8MB 就只保留最近约 2MB**
  （丢首行避免半行），并写一条 `日志轮转（原 N 字节 → …）` 说明。
  阈值可覆盖：`LOG_ROTATE_MAX_BYTES` / `LOG_ROTATE_KEEP_BYTES`；函数也可传参自测
  `rotate_log_if_needed <file> <max> <keep>`。
* **速查当前异常**（不用数行号了）：

  ```bash
  cd ~/.copilot/extensions/copilot-telegram-bridge
  LAST=$(grep -n "run pid=" bots/Headless/daemon.log | tail -1 | cut -d: -f1)
  awk -v n=$LAST 'NR>n' bots/Headless/daemon.log | grep -nE "401|heartbeat failed|is not a function|漂移|warn:"
  ```

**没有 Caches 依赖**：`~/Library/Caches/copilot/pkg` 已删除 —— CLI 不再自解包、不再读它（`COPILOT_CLI_DIST_DIR` + `COPILOT_AUTO_UPDATE=false`）。
只有跑 `vendor-copilot-runtime.sh --from-cache`（离线备选）时才会去读本机 App 留下的缓存，那是**一次性取源**，不是运行时路径：

```text
~/Library/Caches/github-copilot-sdk/cli/<ver>/copilot      # --from-cache 的 CLI 来源，未删
~/Library/Caches/copilot/pkg/<plat>/<ver>/                 # 已删除（2026-09-13）
```

> 手动跑 `cli/copilot login` 时若不带 `COPILOT_CLI_DIST_DIR`，CLI 会自解包重建 `~/Library/Caches/copilot/pkg`（守护下一次启动会在日志里 warn）。介意就带上：
> `COPILOT_CLI_DIST_DIR="$PWD/runtime/$(cat runtime/VERSION)/pkg" runtime/$(cat runtime/VERSION)/cli/copilot login`
