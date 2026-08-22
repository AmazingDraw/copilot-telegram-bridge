# 桌面 / 编辑器 Bot（Editor · Copilot）

> 对应扩展：`~/.copilot/extensions/copilot-telegram-bridge`  
> 默认 registry key：`Copilot`（`config/bots.json`）  
> Telegram：`@YourCopilotBot`（以 BotFather 为准；`label` 可改显示名）  
> 对照文档：无头守护见 [`headless-daemon.md`](./headless-daemon.md)；总览见 [`README.md`](./README.md)

---

## 1. 要解决什么问题

| 场景 | 行为 |
| :--- | :--- |
| 人在 **GitHub Copilot 桌面 App** 里写代码 | 手机 Telegram 继续同一会话：发指令、收回复、批权限、答 ask |
| 多会话切换 | `/session` 通过 **lock handoff** 把桥接让给「已打开」的目标会话进程 |
| 与无头并存 | 桌面跟 App 窗口生命周期；无头独立守护。**同一会话勿双开** |

**结论**：Editor Bot **不自己 `createSession`**，而是 `joinSession` 挂上**当前 App 正在跑的会话**。App 关窗 / 会话未打开 → 该会话上的桥接进程不在，handoff 会失败（见 §6）。

---

## 2. 与 Headless 对照

| 维度 | Editor（`Copilot`） | Headless（`Headless`） |
| :--- | :--- | :--- |
| 进程宿主 | Copilot App 扩展进程（跟桌面 session） | `headless-daemon.sh` + LaunchAgent |
| 会话获得 | `joinSession({ onPermissionRequest, onUserInputRequest })` | `createSession` / `resumeSession` + BYOK |
| 模型来源 | **桌面当前会话已有模型**（官方白名单 + 会话里已配置的 BYOK） | `config/models.json` BYOK + 官方目录模型（如 `grok-4.5`） |
| Leader | 无（按 lock 抢占） | `headless.leader.json` 单例 |
| `/session` 切换 | **lock handoff**（目标进程需在线认领） | 本进程 `resumeSession` |
| `TELEGRAM_BRIDGE_MODE` | 默认 `all` 时启用；`headless-only` 下 **跳过** | `headless-only` 只跑它；`editor-only` 跳过它 |
| 权限 | `bots.json` → `permissionMode`（Copilot 现为 **`allow-all`**：自动放行工具/扩展提权，不再弹 TG 批准卡；改回 `ask` 可恢复逐条确认） | 默认 allow-all |

Registry 中 **启用** bot 按顺序：第 1 个 = editor，其后 = headless（与历史 `isFirst` 一致）。

---

## 3. 启动与连接流程

```text
GitHub Copilot App 打开某个 workspace/session
        │
        ▼
extension.mjs  (TELEGRAM_BRIDGE_MODE=all 默认)
        │  启用 bots：Copilot → isHeadless=false
        │           Headless → 若 mode=all 也会起，但无头主路径建议 daemon
        ▼
createBotInstance("Copilot", token, false)
        │
        ├─ attachRuntime / Handlers / Commands
        ▼
start:
  joinSession({ permission + user_input handlers })
  registerSlashCommand  →  /telegram setup|connect|…
  autoConnectWithRetry(name, sessionId)   # 认 lock 后 handleConnect
  startLockPoller(name, sessionId)        # 5s：发现 handoff 锁则接管 poll
```

### 3.1 `handleConnect`（两边共用骨架）

1. 读 `config/bots.json`，校验 token（`getMe`）  
2. 写 `bots/Copilot/lock.json`（sessionId + pid）  
3. 装事件、`setMyCommands`、可选 `setMyName`  
4. 启动 **long poll** `getUpdates`（先 `deleteWebhook`）  
5. 已授权 chat：**不再**发「session connected/ended」TG 通知（多进程重连会刷屏；状态只写 CLI `session.log`）；无授权则走配对

### 3.2 自动连接

- App 会话起来后：`autoConnectWithRetry` 最多每 10s 试一次，直到 `connected` 或 **他会话活锁**占坑则停。  
- 他会话持锁时：新会话可 **接管**（旧侧遇 Telegram 409 / lock poller 会放）。

---

## 4. Lock 与会话切换（桌面特有）

### 4.1 文件

`bots/Copilot/lock.json` 示例字段：

- `sessionId` — 当前应持有 Telegram 桥的会话  
- `pid` — 持有进程；**handoff 请求时写 `pid: 0`** 表示「待认领」

认领侧还会临时使用 **claim 门闩文件** `lock.json.claim`（O_EXCL 原子创建），
用于防止多扩展实例（SDK 新版下同会话可挂多个 server 进程）同时认领
`pid: 0` 占位锁导致的重复切换通知。

### 4.2 `/session` 数字切换（Editor）

```text
当前桥进程 A（session-A）收到切换到 session-B
  → writeLock(bot, session-B, pid=0)
  → 8s 超时：若仍是 session-B 且 pid=0 → 回滚 lock 到 A，TG 提示「目标离线」
  → 若 App 里 session-B 进程在线：其 lock poller / autoConnect 发现锁指向自己
       → 原子认领（O_EXCL claim 门闩）→ handleConnect / 接管 poll
       → 广播「会话切换成功」→ 手机继续聊 B
```

**要点**：目标会话必须先在 **GitHub Copilot App 历史里打开**（扩展进程活着）。无头则不需要开窗，那是另一条路径。

### 4.3 Lock poller

- 每 **5s** 检查 lock 是否仍指向本 `sessionId`  
- 仅当 lock 是 `pid: 0` 占位锁且 sessionId 匹配时才认领（活进程持有的锁不抢）
- 认领走 **O_EXCL claim 门闩**：同时刻只有一个实例能进入「判锁→写锁」临界区，
  从根上杜绝多实例重复认领 / 重复广播
- 认领成功后、广播前再次校验锁归属；连接失败（token 失效/网络异常）不广播
- 被他会话接管 → 停 poll、清 typing/bubble，避免双 poll 409
- autoConnect 遇到 `pid: 0` 占位锁时同样走原子认领并广播（补上切换通知）

---

## 5. 命令与能力（Telegram）

与无头菜单一致（`setMyCommands`）：

| 命令 | 桌面侧说明 |
| :--- | :--- |
| `/start` | 状态 / 重连说明 |
| `/stop` | `session.abort`，清 typing、bubble |
| `/session` | 最近可 resume；切换 = **handoff** |
| `/model` | 对 **当前 join 的会话** `model.list()`（官方白名单 + 桌面 BYOK） |
| `/thinking` | 思考等级（`setReasoningEffort`；档位按 `model.list().supportedReasoningEfforts`） |
| `/mode` | Interactive / Plan / Autopilot |
| `/rename` | 改会话名（写 `workspace.yaml` 等） |
| `/clean` | 空壳数量 + 一键直删；真会话最多 **15** 条点号删（二次确认，不显示 id） |
| `/fixctx` | 修复 Copilot 桌面模型上下文 |
| `/status` | 当前模型 / 模式 / 会话 / 表格投递方式 |
| `/rich` | 表格富文本开/关（**默认关**＝列表 HTML；开＝`sendRichMessage` 表） |
| `/reboot` | **仅 Editor 菜单**：重启无头 daemon（🧿） |

菜单与无头一致，Editor **多** `/reboot`。桌面侧 **没有** 独立 BYOK 装配：模型列表 = 该会话 `model.list()`（含 App 已配置的 BYOK，id 形如 `{providerUUID}/{model_id}`）。无头专属的 OpenCode/cliproxy 配置 **不自动** 注入 editor 会话。

CLI / 会话 slash（扩展侧）：

```text
/telegram setup <Name>
/telegram connect <Name>
/telegram disconnect
/telegram status
/telegram remove <Name>
```

---

## 6. 日常使用清单

1. 打开 GitHub Copilot App → 进入要桥接的 **具体 session**（仅停在首页可能节流扩展）。  
2. 确认 `config/bots.json` 里 `Copilot` 有 token、`"disabled": false`（或未设 `disabled`）。要停用 join bot 时设 `"disabled": true`，并给 Headless 写 `"role": "headless"`。  
3. 首次：Telegram 任意消息 → 终端配对码 → 回发完成 `config/access.json`。  
4. 手机对 `@YourCopilotBot` 发消息，应进当前桌面会话。  
5. 换会话：先在 App 打开目标会话 → TG `/session` 点编号。

### 不该指望的

| 误区 | 实际 |
| :--- | :--- |
| App 全关还能用 Copilot Bot | 不行；请用 **Headless** + daemon |
| `/session` 切到从未打开的桌面会话 | handoff 8s 失败，提示先打开 |
| 与 Headless 同时挂同一 sessionId | 禁止；无头会拒绝占用，双开易卡死 |

---

## 7. 配置与路径

| 路径 | 用途 |
| :--- | :--- |
| `config/bots.json` | token / label / username（**600**，gitignore） |
| `config/access.json` | 授权 Telegram user id |
| `bots/Copilot/state.json` | poll offset 等 |
| `bots/Copilot/lock.json` | 会话持有 + handoff |
| `~/.copilot/session-state/<uuid>/` | 会话磁盘（与 App 共用） |

敏感路径已迁入 `config/`；根目录旧 `access.json` / `bots.json` 启动时 **一次性 migrate**。

环境变量（与 editor 相关）：

| 变量 | 含义 |
| :--- | :--- |
| `TELEGRAM_BRIDGE_MODE` | `all`（默认）/ `headless-only` / `editor-only` |
| （无头 daemon 脚本） | 强制 `headless-only`，**不会**起 Copilot editor 实例 |

---

## 8. 排障

| 现象 | 排查 |
| :--- | :--- |
| TG 完全无响应 | App 是否开着目标 session？扩展是否加载？`lock.json` 是否他 pid？ |
| `getMe` 401 | token 失效 → BotFather revoke → `/telegram remove` + `setup` |
| 409 Conflict | 双实例 poll 同一 bot；看 lock，留一个 leader |
| 切换失败「离线」 | App 历史打开目标会话后再 `/session` |
| 配对码不出现 | 看 **承载扩展的 CLI/App 终端日志**，不是 daemon.log |
| 权限按钮过期 | reload 后旧 `reqId` 失效，重新触发一轮 permission/ask |

日志位置（桌面）：随 **App / CLI 扩展宿主** stdout/stderr，**不是** `bots/Headless/daemon.log`。

---

## 9. 与无头守护的协作建议

| 用法 | 推荐 |
| :--- | :--- |
| 日常手机遥控、不关 Mac | **Headless** + LaunchAgent |
| 坐在电脑前写代码、TG 同步当前窗 | **Copilot** editor bot |
| 同时跑 | 可以；**不同 session**，且 mode 下 daemon 跳过 editor |

```bash
# 无头常驻（不碰 editor）
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh status

# 桌面：打开 App 会话即可；改扩展后
# App 内 extensions_reload 或重进 session
```

---

## 10. 开发注意

1. **行为红线**：排版仍走 `chunkMessage` → `sendFormattedMessage`；勿在 editor 路径旁路。  
2. **joinSession** 参数变更要测 permission + ask_user 双通道。  
3. **handoff** 超时 8s、poller 5s 与无头 resume 语义不同，改 `/session` 时分支勿混。  
4. 文档路径以 `doc/` 为准（非 `docs/`）。

变更记录：`changelog/`（按日）。总册与 BYOK/会话运维见  
[`changelog/2026-07-14_headless-byok-session-and-ops.md`](../changelog/2026-07-14_headless-byok-session-and-ops.md)。
