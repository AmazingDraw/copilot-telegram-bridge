# Telegram Bridge（Copilot CLI 扩展）

将 **GitHub Copilot CLI（无头会话）** 与 **Telegram Bot** 双向桥接：手机发消息 → 本机 agent 执行 → 回复、工具气泡、权限确认与 `ask_user` 回落到 Telegram。

> 扩展目录：`~/.copilot/extensions/copilot-telegram-bridge`  
> 源码：本仓库  
> **不挂 Copilot.app / joinSession。** CLI+SDK 钉在 `runtime/`。


---

## 架构总览

<p align="center">
  <img src="doc/架构图.svg" alt="Copilot Telegram Bridge 架构" width="100%" />
</p>

### Bot 角色

| Registry key | 角色 | 说明 |
| :--- | :--- | :--- |
| `Headless` | **无头主 bot** | `createSession` / `resumeSession`；BYOK + 用户 MCP；allow-all |

- 注册表：`config/bots.json`（token 明文、**不进 Git**）
- 每 bot 独立目录：`bots/<Name>/`（lock / state / leader）
- 开关：`bots.json` 各 bot 的 `disabled`（`true` 则跳过；热重载需重启 Headless 守护）
- 角色：只认 `headless`。遗留 `role: editor` 启动时跳过。
- 专文：[`headless-daemon.md`](doc/headless-daemon.md) · [`models-config.md`](doc/models-config.md) · [`system-prompts.md`](doc/system-prompts.md)

### 模块拆分

入口仍是 **`extension.mjs` 单文件加载**；逻辑拆到 `lib/*`，行为意图保持不变。

```
extension.mjs          # 常量、Telegram API 薄封装、access/pairing、
                       # createBotInstance 装配、handleConnect、slash、
                       # headless start 循环 / leader、main
lib/
  json-util.mjs        # loadJsonOrDefault / saveJsonAtomic
  session-fs.mjs       # 会话目录扫描、resumable、空壳、recent、cleanable
  headless-leader.mjs  # 无头单例 leader + sticky session id
  byok-providers.mjs   # BYOK：models.json + shell env；用户 MCP；buildHeadlessSessionConfig
  bot-profile.mjs      # per-bot：role / agentsMd / access / cooldown / model / loadMcp
  markdown-tg.mjs      # chunk / HTML 排版 / 表格与降级（勿随意改语义）
  bot-runtime.mjs      # sendQueue、typing、tool bubble、processUpdate、poll/lock
  bot-handlers.mjs     # session 事件 → TG；permission / ask_user 工厂
  bot-commands.mjs     # /session /clean /model /mode 与 callback
  claude-commands.mjs  # /claude 子菜单 · FIFO；见 doc/claude-commands.md
config/models.json     # 模型唯一真源：catalog / modelSets / provider
memory/                # 人设真源：AGENTS.md（仅本机仓，不开源）
```

### 装配顺序（每个 Bot 实例）

```
createBotInstance(name, token)
  → 构造 ctx（getter 防闭包 stale）
  → attachRuntime(ctx)     # queue / typing / bubble / processUpdate / poll
  → access + pairing       # 仍在主文件
  → attachHandlers(ctx)    # setupEventHandlers / permission / user_input
  → attachCommands(ctx)    # slash + callback
  → 晚绑定 slash connect / handleConnect
  → start: headless leader 循环
```

### 关键路径

| 路径 | 用途 |
| :--- | :--- |
| `config/bots.json` | Bot token 注册表（明文、不进 Git） |
| `bots/<Name>/state.json` | poll `offset`、`lastSessionId` |
| `bots/<Name>/lock.json` | 当前持有会话 + pid（多实例抢占 / handoff） |
| `bots/<Name>/headless.leader.json` | 无头 leader 单例（每 bot 独立） |
| `config/access.json` | 已授权 Telegram user id（热加载） |
| `~/.copilot/session-state/<uuid>/` | 会话磁盘（yaml / db / events / checkpoints） |

---

## 核心能力

### 连接与冲突

- **Long poll** + 启动前 `deleteWebhook`，避免 webhook/409 空转
- **Lock**：`bots/<Name>/lock.json` 记录本进程持有的 session；同 token 第二实例会 409，释放 typing/bubble
- **无头 leader**：同一 bot 只允许一个存活循环建会话
- **Sticky session**：优先 `resume` 可 resume 的 id；仅空壳则安全删壳后 **同 id create**

### 会话运维（Telegram）

| 命令 | 作用 |
| :--- | :--- |
| `/new` | 无头 `createSession` 开启全新对话（`/start` 仍是别名） |
| `/stop` `/cancel` | `session.abort`，清 typing/bubble |
| `/session` | 最近 **可 resume** 最多 10 条 + ①–⑩ 一键切换 |
| `/clean` | 空壳只显示数量、一键直删；真会话最多 **15** 条点号删（二次确认） |
| `/model` | 模型列表 + hash 按钮（≤64 字节 `callback_data`）；无头切换会 **resume 同会话并重注入人设** |
| `/thinking` | **不在 Bot 菜单**；手打仍可用。官方模型走 `reasoningEffort`；第三方走模型别名切换 |
| `/mode` | Interactive / Plan / Autopilot（Plan 为**粘性**：批准卡与计划正文分开发） |
| `/status` | 当前模型 / 思考 / 模式 / 会话 / 上下文 / 表格投递 |
| `/rich` | 切换表格样式：`on`＝富文本 HTML 表；`off`（**默认**）＝列表 HTML |

**可 resume 判定**（`session-fs.isSessionResumable`）：有 `session.db` 或非空 `events.jsonl`。仅 `workspace.yaml` 的 sdk 空壳不进 `/session` 列表。

### Headless BYOK（CLI Proxy 默认上游）

> 完整机制（CLI 缓存 / LaunchAgent / 排障 / MCP）：[`headless-daemon.md`](doc/headless-daemon.md)

**上游**：CLI Proxy（默认 `http://127.0.0.1:8317/v1`），密钥读 `~/.cli-proxy-api/config.yaml` 或 `CLIPROXY_API_KEY`。`baseUrl` 以运行中的 `config/models.json` / `CLIPROXY_BASE_URL` 为准。模型列表只看 `modelSets.headless`，会话 id 形如 `cliproxy/<id>`。

**开关与回滚**（`config/models.json`，改完 `headless-daemon.sh restart`）：

- **单模型全局开关**：`catalog.<id>.enabled: false`
- **单场景成员关系**：编辑对应 `modelSets.<name>.models`
- **整组上游开关**：provider 级 `enabled: false`，每个 provider 只用 `modelSet` 引用模型组
- **保留的回滚组**（默认全 `enabled: false`）：
  - `opencode` — OpenCode Go 直连（`OPENCODE_API_KEY`）
  - `deepseek` — DeepSeek 官方 API
- **官方模型回退**：`officialFallback`，从 Copilot 目录走

**per-bot 模型锁**（`bots.json`）：推荐只写 `modelSet`；旧 `defaultModel` / `allowedModels` 仍兼容。

**上下文窗口**：规格统一存于 `config/models.json`；无头 create/resume 时写入 SDK。详见 [`models-config.md`](doc/models-config.md)。

### 用户 MCP（无头显式加载）

- 真源：`~/.copilot/mcp-config.json`（或 `models.json` → `paths.mcpConfig`）
- create/resume 写入 `SessionConfig.mcpServers`
- 默认：**Headless 加载**；**deny-all 不加载**（`loadMcp` 可覆盖）

### 无头独立守护（推荐 · 开机自启）

**不依赖 GitHub Copilot 桌面 App。** 进程只靠 `runtime/` 里钉死的 CLI + bootstrap；第三方模型走 CLI Proxy 8317。

换 CLI/SDK 版本：`bash scripts/vendor-copilot-runtime.sh`（npm 平台包，可跟版本号）再 restart。说明见 [`runtime/README.md`](runtime/README.md)。PATH 上的 npm/brew `copilot` 不够。

```bash
# 一次性安装（登录即启 + 崩溃自动拉起）
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh install

bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh status   # leader.mode=daemon · launchd=loaded
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh restart
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh stop      # bootout（关掉 KeepAlive 直至 start）
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh uninstall
```

| 项 | 路径 / 说明 |
| :--- | :--- |
| LaunchAgent | `~/Library/LaunchAgents/com.copilot-telegram-bridge.plist` |
| 源模板 | `scripts/com.copilot-telegram-bridge.plist`（`RunAtLoad` + `KeepAlive`） |
| 环境 | `TELEGRAM_BRIDGE_MODE=headless-only`（脚本已设） |
| 日志 / pid | `bots/Headless/daemon.log` · `daemon.pid` |
| Leader | `bots/<Name>/headless.leader.json` 每 bot 独立 |

登录分层（GitHub 宿主 / cliproxy / Telegram）见 [`doc/headless-daemon.md`](doc/headless-daemon.md)「登录与鉴权」。

### Claude 子命令（/claude）

专文：[`doc/claude-commands.md`](doc/claude-commands.md)（开场裁剪、超时排队、配置项）。

通过 Telegram 控制 **Claude Code CLI**（配置/会话仍在 `~/.claude`，任务 cwd 为 `~/.agents/workspace`）。直连 CLI Proxy `:8317` 的 Anthropic `/v1/messages`。

```bash
/claude                    # 打开子命令菜单
/claude <prompt>           # 直接新对话执行（不走菜单）
```

| 菜单项 | callback | 说明 |
| :--- | :--- | :--- |
| ✨ 新建对话 | `claude:new` | 新对话输入态 |
| 📂 继续对话 | `claude:resume` | 历史会话（history.jsonl + projects） |
| 🧠 切换模型 | `claude:model` | 列表来自 `config/models.json` → `modelSets.claude-cli` |
| 🗺 计划 | `claude:plan` | `--permission-mode plan`；结束后「✅ 按计划执行」 |
| ⚡️ 思考档 | `claude:effort` | `--effort`：低/中/高/极高/最大（💎） |
| 🛟 备援模型 | `claude:fallback` | 主模型 429/配额耗尽后由 Bridge 换模型再跑一次（不走 Claude `--fallback-model`） |
| 📡 实时 | `claude:stream` | `stream-json` 刷新进度 |
| 📊 查看进度 | `claude:progress` | 最近任务状态 |
| ✋ 停止任务 | `claude:stop` | 停止运行中任务 |
| 🚪 退出桥接 | `claude:exit` | 清模型/计划/思考档/备援 |

**模型增删**：只改 `config/models.json` 的 `modelSets.claude-cli` 与 `catalog`。Haiku / Small-Fast：`defaults.claudeHaikuModel`、`claudeSmallFastModel`。改完 `bash scripts/headless-daemon.sh restart`。

**计划模式**：与 `--dangerously-skip-permissions` 互斥。规划轮只读；批准后同一 session `--resume` 再执行。

### 排版与出站

- **调用约定（红线）**：外层 `chunkMessage` → **逐块** `sendFormattedMessage`；勿在内部再切块、勿改三路语义
  1. **表格**：`/rich on` → HTML table；**默认 off** → 列表 HTML
  2. **HTML 安全子集**：`markdownToTelegramHtmlSafe`
  3. **纯文本**：无 markup 时原样发送
- **Send queue**：串行 + `SEND_PACE_MS`；429 按 `retry_after` 回队
- **Typing**：4s 一轮 `sendChatAction`（**旁路** queue）；slash / turn_end / idle 必须 `stopTyping`
- **Tool bubble**：可编辑的临时状态消息，turn 结束延迟删除

### 权限与 ask_user

| 通道 | 行为 |
| :--- | :--- |
| `onPermissionRequest` | Telegram 批准/拒绝按钮 → resolve Promise |
| `onUserInputRequest` | **只挂** Promise / 超时 / 选项解析，**不发**题面 |
| `user_input.requested` | **唯一**发题面 + ①② 键盘 |
| 按钮 `ask:choice:…` | RPC `handlePendingUserInput` + 解冻 `awaitingInput` |
| 纯文本 freeform | 同上；pending 期间任意文本优先当答复（含 slash，原设计） |

> Reload 后旧卡片 `reqId` 会「已过期」——用新一轮 ask。

---

## 安装与配置

已作为 **用户扩展** 落在 `~/.copilot/extensions/copilot-telegram-bridge/`。无头值班直接改 `config/bots.json` 后 `headless-daemon.sh restart`。

全新机器 **不必先装 Copilot.app**。把本仓库放到上述目录（或软链过去），再：

1. `bash scripts/vendor-copilot-runtime.sh`（npm 拉 CLI+pkg 进 `runtime/`）
2. `runtime/<ver>/cli/copilot login`（会创建 `~/.copilot/` 里的凭证；会话盘在 `~/.copilot/session-state/`）
3. 起 CLI Proxy `:8317`，写 `config/bots.json`，`headless-daemon.sh install`

没有「以前装过 Copilot 留下的缓存」也能跑。缺的是 GitHub Copilot 身份 + cliproxy + Bot token，不是桌面 App。

### 注册 Bot

1. @BotFather 创建 bot，复制 token  
2. 写入 `config/bots.json`（或在 Copilot CLI 会话里 `/telegram setup` / `/telegram connect`）  
3. Telegram 发消息 → 终端看 6 位配对码 → 回发配对（5 分钟内）

### 卸载

```text
/telegram disconnect
# 可选：移除扩展目录（会丢掉本地 access/bots，注意备份）
```

---

## 安全

| 文件 | 注意 |
| :--- | :--- |
| `config/bots.json` | **明文 token**；权限宜 `600`；已在 `.gitignore` |
| `config/access.json` | 授权用户列表；勿提交 |
| `bots/*/lock.json` / `state.json` | 本地运行态；勿提交 |

Token 泄漏：BotFather `/revoke` → 本地 `setup` 重写。

---

## 开发与同步

```bash
# 语法检查
node --check extension.mjs
node --check lib/*.mjs
```

热更：`bash scripts/headless-daemon.sh restart`。换 CLI/SDK：`bash scripts/vendor-copilot-runtime.sh` 后再 restart。

**同步方向**：本机扩展 → `sync-copilot-extensions.sh`（私有仓）→ `scripts/sync-to-open-source.sh`（开源镜像）。不要直接改开源目录。

---

## License

MIT。本机先改 `AmazingDraw/copilot-telegram-bridge`，再 `sync-to-open-source.sh` 推镜像。