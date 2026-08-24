# Telegram Bridge（Copilot CLI 扩展）

将 **GitHub Copilot CLI / App 会话** 与 **Telegram Bot** 双向桥接：手机发消息 → 本机 agent 执行 → 回复、工具气泡、权限确认与 `ask_user` 回落到 Telegram。

> 本机路径：`~/.copilot/extensions/copilot-telegram-bridge`  
> 远端仓库：`AmazingDraw/copilot-telegram-bridge`

---

## 架构总览

<p align="center">
  <img src="doc/架构图.svg" alt="Copilot Telegram Bridge 架构" width="100%" />
</p>

### Bot 角色

| Registry key | 角色 | 说明 |
| :--- | :--- | :--- |
| `Copilot` | **桌面 / 编辑器** | `joinSession`，挂在当前 App 会话；模型列表 = 桌面会话自带，**不读** `config/models.json` |
| `Headless` | **无头主 bot** | `createSession` / `resumeSession`；BYOK + 用户 MCP；allow-all |
| `SecondaryBot` | **专用无头** | 专用单模型策略；open-group / deny-all |

- 注册表：`config/bots.json`（token 明文、**不进 Git**）
- 每 bot 独立目录：`bots/<Name>/`（lock / state / leader）
- 开关：`bots.json` 各 bot 的 `disabled`（`true` 则跳过；热重载需重启 App 会话 / Headless 守护）
- 角色：`role`（`editor` = joinSession，`headless` = create/resume）优先；缺省时名称 `Copilot`/`Editor` → editor，`Headless` 或带 `profile` → headless，其余仍按启用序第 1 个 = editor
- 专文：[`editor-bot.md`](doc/editor-bot.md) · [`headless-daemon.md`](doc/headless-daemon.md) · [`models-config.md`](doc/models-config.md)

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
config/models.json     # 模型唯一真源：catalog / modelSets / provider / fixctx
../agent-memory/       # 人设真源：AGENTS.md
```

### 装配顺序（每个 Bot 实例）

```
createBotInstance(name, token, isHeadless)
  → 构造 ctx（getter 防闭包 stale）
  → attachRuntime(ctx)     # queue / typing / bubble / processUpdate / poll
  → access + pairing       # 仍在主文件
  → attachHandlers(ctx)    # setupEventHandlers / permission / user_input
  → attachCommands(ctx)    # slash + callback
  → 晚绑定 slash connect / handleConnect
  → start: join（桌面）或 headless leader 循环（无头）
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
- **Lock**：他会话接管时 409 → 优雅释放 typing/bubble/token；桌面 **lock poller / autoConnect** 仅认领 `pid: 0` 占位锁，且走 **O_EXCL claim 门闩** 原子认领
- **无头 leader**：多桌面扩展实例时只允许一个 Headless 建会话
- **Sticky session**：优先 `resume` 可 resume 的 id；仅空壳则安全删壳后 **同 id create**

### 会话运维（Telegram）

| 命令 | 作用 |
| :--- | :--- |
| `/new` | 无头 `createSession` 开新对话（`/start` 仍是别名） |
| `/stop` `/cancel` | `session.abort`，清 typing/bubble |
| `/session` | 最近 **可 resume** 最多 10 条 + ①–⑩ 一键切换 |
| `/clean` | 空壳只显示数量、一键直删；真会话最多 **15** 条点号删（二次确认） |
| `/model` | 模型列表 + hash 按钮（≤64 字节 `callback_data`） |
| `/thinking` | 思考等级：官方模型走 `reasoningEffort`；第三方走模型别名切换 |
| `/mode` | Interactive / Plan / Autopilot（Plan 为**粘性**：批准卡与计划正文分开发） |
| `/status` | 当前模型 / 思考 / 模式 / 会话 / 上下文 / 表格投递 |
| `/rich` | 表格：`on`＝富文本 HTML 表；`off`（**默认**）＝列表 HTML |

**可 resume 判定**（`session-fs.isSessionResumable`）：有 `session.db` 或非空 `events.jsonl`。仅 `workspace.yaml` 的 sdk 空壳不进 `/session` 列表。

### 桌面 Editor Bot（Copilot）

> 完整说明（`joinSession` / lock handoff / 排障）：[`editor-bot.md`](doc/editor-bot.md)

- 挂在 **GitHub Copilot App 当前会话**，`joinSession`，不单独 create
- `/session` 切换 = **lock handoff**（目标须先在 App 中打开）
- 模型列表 = 桌面会话自带；**不**走无头 `config/models.json` 装配
- `TELEGRAM_BRIDGE_MODE=headless-only` 时 daemon **跳过** editor

### Headless BYOK（CLI Proxy 默认上游）

> 完整机制（CLI 缓存 / LaunchAgent / 排障 / MCP）：[`headless-daemon.md`](doc/headless-daemon.md)

**上游**：CLI Proxy，密钥读 `~/.cli-proxy-api/config.yaml` 或 `CLIPROXY_API_KEY`。`baseUrl` 在本机 `http://127.0.0.1:8317/v1` 与 NAS 铜线 `http://169.254.1.2:8317/v1` 之间随时可切（NAS 不稳就切回本机）。看指针、切机用 `switch-cliproxy-backend.sh`，说明见 cli-proxy-api `references/mac-vs-nas-urls.md`。实际模型列表只看 `config/models.json` 的 `modelSets.headless`，会话 id 形如 `cliproxy/<id>`。

**开关与回滚**（`config/models.json`，改完 `headless-daemon.sh restart`）：

- **单模型全局开关**：`catalog.<id>.enabled: false`
- **单场景成员关系**：编辑对应 `modelSets.<name>.models`
- **整组上游开关**：provider 级 `enabled: false`，每个 provider 只用 `modelSet` 引用模型组
- **保留的回滚组**（默认全 `enabled: false`）：
  - `opencodex` — OpenCodex 10100（`apiKeyFromFile`）
  - `opencode` — OpenCode Go 直连（`OPENCODE_API_KEY`）
  - `deepseek` — DeepSeek 官方 API
- **官方模型回退**：`officialFallback`，从 Copilot 目录走

**per-bot 模型锁**（`bots.json`）：推荐只写 `modelSet`；旧 `defaultModel` / `allowedModels` 仍兼容。

**上下文窗口**：规格统一存于 `config/models.json`；无头直接读取，桌面 `data.db` 与 OpenCodex 配置由 `/fixctx` 应用。详见 [`custom-models-context.md`](doc/custom-models-context.md)。

### 用户 MCP（无头显式加载）

- 真源：`~/.copilot/mcp-config.json`（或 `models.json` → `paths.mcpConfig`）
- create/resume 写入 `SessionConfig.mcpServers`
- 默认：**Headless 加载**；**deny-all 不加载**（`loadMcp` 可覆盖）

### 无头独立守护（推荐 · 开机自启）

**不依赖 GitHub Copilot 桌面版是否打开。** 进程只靠本地 CLI + bootstrap；第三方模型直接走 CLI Proxy 8317。

桌面 App **未进入具体 session** 时，挂在 App 树下的 Headless 可能被宿主节流（约两条后停）。独立守护脱离会话生命周期，并由 **LaunchAgent KeepAlive** 保活。

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

### Codex 子命令（/codex）

通过 Telegram 控制 **Codex CLI**（本地 `~/.codex`），支持新对话、续对话、进度、模型切换与异常智能诊断。

```bash
/codex                    # 打开子命令菜单
/codex <prompt>           # 直接新对话执行（不走菜单）
```

| 菜单项 | callback | 说明 |
| :--- | :--- | :--- |
| 💬 新建对话 | `codex:new` | 进入新对话输入态，直接执行 |
| 🎛 切换模型 | `codex:model` | 列出可用模型（3 列）；**仅当前对话生效**，退出模式恢复默认 |
| 📂 继续对话 | `codex:resume` | 历史会话列表（智能意图标题、按实际时间排序、去重、序号 ①-⑩ 视觉等宽对齐） |
| 📊 查看进度 | `codex:progress` | 最近 10 条任务状态（含错误原因）；存储自动裁剪至 50 条 |
| 🖥 关闭桌面 | `codex:desktop` | 检测/关闭 ChatGPT 桌面端（CLI 需桌面关闭才能正常响应） |
| 🚪 退出桥接 | `codex:exit` | 退出连续对话，恢复默认模型 |

**关键设计**：

- **智能错误诊断与中断保护**：自动清洗 `stderr` 提取真实报错（429 限流 / 401 凭据 / 50x 网关 / 上下文超限 / 桌面端锁冲突 / OOM exit=137 等）并附带排查建议；模型意外中断时**保留已生成正文**并追加中断说明，告别模糊报错
- **桌面端检测**：新建/续接对话前检测 ChatGPT 桌面端是否运行，开着 → 提示先关闭（附「🖥 关闭桌面」按钮）；`codex:desktop` 内置实现 kill 桌面进程（不等外部脚本）
- **指令排队**：同一会话有 running 任务时，新指令**入队不丢弃**，任务结束后自动执行下一条（FIFO）；排队提示附「✋ 停止任务 / 🗑 取消排队」按钮
- **停止/取消**：`codex:stop` 对运行中任务 SIGTERM（5s 兜底 SIGKILL）标记 cancelled；`codex:cancelqueued` 清空排队指令
- **模型切换**：`ctx.codexModel` 存于运行时（不写 `~/.codex/config.toml`），发任务时注入 `codex exec -m <model>`；模型列表来自 `~/.codex/opencodex-catalog.json`，**排除 `~/.opencodex/config.json` 的 `disabledModels`**
- **发图**：Codex 模式下直接发图片/文档 → `handleFileAttachment` 下载落盘 → `codex exec -i <path>`；无 caption 用默认提示词「请分析这张图片。」
- **防卡后缀**：prompt 不再追加「任务完成后…」提示词（会污染历史标题）
- **会话去重**：历史列表按 `session_meta.payload.session_id`（纯 UUID）去重；`codex exec resume` 必须用纯 UUID，文件名带时间戳前缀会被当新会话
- **进度存储**：`/tmp/cu-card/codex/tasks.json`，任务完成自动裁剪至最新 50 条

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

已作为 **用户扩展** 落在 `~/.copilot/extensions/copilot-telegram-bridge/`。

### 注册 Bot

1. @BotFather 创建 bot，复制 token
2. CLI / 会话内：

```text
/telegram setup <Name>     # 如 Copilot / Headless；名允许 [A-Za-z0-9_-]
# 粘贴 token
/telegram connect <Name>
```

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

热更：宿主支持时 `extensions_reload`，或重启承载会话 / App。

### 改动纪律（近期踩坑）

1. **排版路径**未复现问题前不要改
2. **ask_user 双发**只动 handler 停发，勿加 assistant 延迟去重
3. **slash 必须** `stopTyping` + `dismissBubble`，否则 `bubbleActive` 会续命 60s debounce
4. **`getRecentSessions` 只列 resumable**；切换前再校验
5. **poll 心跳**节流（60s + 8s 超时），勿每轮堵 `model.list()`
6. 隐藏回归：`lib` 用到的 `basename` 等必须在本模块 `import`

---

## License

MIT。维护与同步以 `AmazingDraw/copilot-telegram-bridge` 为准。