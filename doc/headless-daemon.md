# 无头 Bot（Headless）运行机制

> 对应扩展：`~/.copilot/extensions/telegram-bridge`  
> 相关变更：CHANGELOG §24（独立守护）· §25（LaunchAgent 开机自启）  
> 读者：运维 / 排障；与桌面 editor bot（`Copilot`）对照：[`editor-bot.md`](./editor-bot.md)。

---

## 1. 要解决什么问题

| 场景 | 旧行为 | 新行为 |
| :--- | :--- | :--- |
| 桌面 App **没打开** | 挂在 App 扩展进程上 → 无进程则无头挂 | **独立守护**只靠本机 CLI + bootstrap |
| 桌面 App 开着但 **没进具体 session** | 宿主可能节流扩展，约 **两条后无响应** | 守护 **脱离** App 会话生命周期，不吃节流 |
| 机器重启 / 进程崩溃 | 需手动再 `start` | **LaunchAgent** `RunAtLoad` + `KeepAlive` 自动拉起 |

**结论**：无头对话（Telegram Headless bot）的主路径是 **本机常驻守护**，不再依赖「先打开 GitHub Copilot 桌面并点进某个 session」。

---

## 2. 总览架构

```text
┌─────────────────────────────────────────────────────────────┐
│  macOS 登录会话  gui/$(id -u)                               │
│                                                             │
│  launchd  LaunchAgent                                       │
│  com.copilot-telegram-bridge                             │
│       │  RunAtLoad + KeepAlive + ThrottleInterval=10        │
│       ▼                                                     │
│  bash …/scripts/headless-daemon.sh run                      │
│       │  解析 CLI 缓存 + bootstrap                          │
│       │  TELEGRAM_BRIDGE_MODE=headless-only                 │
│       ▼                                                     │
│  copilot <extension_bootstrap.mjs>                          │
│       │  COPILOT_SDK_PATH / EXTENSION_PATH                  │
│       ▼                                                     │
│  extension.mjs                                              │
│       │  headless-only：启动所有 role=headless 的 bot       │
│       │  （跳过 editor；如 Headless + PromptReverse）       │
│       ├─ 每 bot 独立 leader / sticky / poll                 │
│       ├─ create/resume + BYOK（models.json）                │
│       ├─ 用户 MCP 显式注入（mcp-config.json；可 per-bot 关） │
│       └─ OpenCode 直连 + cliproxy(grok) :8317               │
└─────────────────────────────────────────────────────────────┘

可选并行（不负责无头主路径）：
  GitHub Copilot.app 内嵌扩展  →  mode=all 时双 bot；
  若守护已占 leader，App 侧 Headless  standby。
```

**依赖链（缺一不可）**

1. **CLI 缓存二进制** + **bootstrap / copilot-sdk**（见 §5）  
2. **cli-proxy-api** 本机 `http://127.0.0.1:8317`（通常另有 LaunchAgent）  
3. **config/bots.json** 中 Headless 的 token + **config/access.json** 授权用户  
4. 本扩展目录与 `scripts/headless-daemon.sh` / plist 模板

---

## 3. 进程与模式

### 3.1 环境变量

| 变量 | 守护侧取值 | 作用 |
| :--- | :--- | :--- |
| `TELEGRAM_BRIDGE_MODE` | `headless-only` | 只起无头 bot，**跳过** editor bot |
| `EXTENSION_PATH` | `…/telegram-bridge/extension.mjs` | bootstrap 加载的扩展入口 |
| `COPILOT_SDK_PATH` | `…/Caches/copilot/pkg/…/copilot-sdk` | SDK 模块路径 |
| `COPILOT_CLI_PATH` | 缓存中的 `copilot` 可执行文件 | 记录/兼容 |
| `SESSION_ID` | `headless-daemon` | 扩展宿主会话标识（非业务 sticky id） |

代码侧模式枚举（`extension.mjs`）：

| `TELEGRAM_BRIDGE_MODE` | 行为 |
| :--- | :--- |
| `all`（默认） | 桌面扩展：editor + headless 都尝试启动 |
| `headless-only` | **仅** headless（独立守护） |
| `editor-only` / `app-editor` | 仅 editor（预留） |

角色划分：`bots.json` 的 **`role` 优先**（`editor` \| `headless`）；未写时启用序 **第 1 个 = editor**，其后 = headless。`headless-only` 下可同时跑 **多个无头 bot**（如 Headless + PromptReverse），各有独立 session/leader。

### 3.2 启动命令实质

`headless-daemon.sh run`：

1. 解析最新 CLI / pkg 路径（失败则 `exit 1`）  
2. 写 `bots/Headless/daemon.pid`（`$$`，`exec` 后 pid 不变，便于 launchd）  
3. `export` 上表变量  
4. `exec copilot extension_bootstrap.mjs`（进程替换；stdout/err 由 launchd 写入 `daemon.log`）

---

## 4. Leader 单例与 sticky session

实现：`lib/headless-leader.mjs`  
状态文件：`bots/Headless/headless.leader.json`

### 4.1 为什么需要 leader

同一 bot token 上只允许 **一个** 存活进程跑无头循环，否则：

- 多 `getUpdates` / 多 `createSession` → 空壳会话爆炸  
- 消息抢答、锁文件互相踢

### 4.2 抢锁规则

`tryAcquireHeadlessLeadership(botName, { mode, preferSteal })`：

| 己方 | 对方仍存活 | 结果 |
| :--- | :--- | :--- |
| `daemon` | `app` | **可抢**（`preferSteal`）→ App 侧 refresh 失败后让位 |
| `daemon` | `daemon` | **不抢** |
| `app` | `daemon` | **不抢**（standby） |
| 任意 | 对方 pid 已死 | 覆盖为己 |

写入后 **双读确认** + 短 spin，降低双写竞态。

`refreshHeadlessLeadership`：周期续命；若文件已是别人存活 pid → 返回 false → 本进程让位。  
`releaseHeadlessLeadership`：仅当 `pid === process.pid` 时删 leader 文件。

### 4.3 Sticky / resume

| 函数 | 用途 |
| :--- | :--- |
| `resolveHeadlessResumeTarget` | 启动优先 **resume**：lock → `lastSessionId`，且必须 **可 resume** |
| `resolveHeadlessStickySessionId` | 新建时 **复用 UUID**（目录在即可），避免重连狂建空壳 |
| `rememberBotSession` | 成功 create/resume 后写入 `state.json` 的 `lastSessionId` |

**可 resume**：`session-fs.isSessionResumable` —— 有 `session.db` 或非空 `events.jsonl`（仅有 `workspace.yaml` 的空壳不算）。

业务上常见 sticky：`bots/Headless/state.json` / lock 中的 UUID（长期会话），与 launchd 的 `SESSION_ID=headless-daemon` **不是一回事**。

---

## 5. CLI 缓存依赖（与「单独装 CLI」的关系）

守护 **不读 PATH** 里的 `copilot`，硬编码扫缓存：

| 角色 | 路径模式 |
| :--- | :--- |
| CLI 二进制 | `~/Library/Caches/github-copilot-sdk/cli/<版本>/copilot` |
| 扩展宿主包 | `~/Library/Caches/copilot/pkg/darwin-arm64/<版本>/` |
| bootstrap | `…/preloads/extension_bootstrap.mjs` |
| SDK | `…/copilot-sdk/` |

**版本对齐（≥ 本机守护自愈）**：按 CLI 目录名与 pkg **同版本号成对**选取（例：`cli/1.0.79-5` ↔ `pkg/…/1.0.79-5`）。不再各自只按 mtime 挑「最新」，避免桌面更新后 CLI/SDK 错配。

**bootstrap 父进程门闩**：Copilot `≥1.0.79` 的 `extension_bootstrap.mjs` 在未设置 `COPILOT_EXTENSION_PARENT_PID` 时会 `exit(0)`。无头以 `copilot <bootstrap.mjs>` 启动时常不带该 env → launchd 崩循环。`run` 每次启动会对 aligned + latest bootstrap **幂等软化**（有合法 parent 仍守护；未设置则继续跑；改前写 `.bak-compat-*`）。桌面再更新覆盖文件后，下次 `run` / sdk-watch 重启会自动重打。

`status` 输出 `align=version:<ver>` 表示成对命中；`mtime-fallback` 表示无成对版本、已降级（可能错配）。

**单独 npm / brew 装 Copilot CLI 默认不能替代这套缓存**，因为还缺同布局的 **bootstrap + copilot-sdk**。  
要「无 Cache」需改脚本并固定安装前缀——**当前未做**。

缓存常见消失原因：手动/第三方清 Caches、重置桌面包、版本目录被清掉未重下。  
**恢复**：打开一次 GitHub Copilot App 完成解包 → `headless-daemon.sh restart`。

> 无头 **不依赖桌面窗口**，但 **依赖桌面/SDK 曾经写入的缓存文件**。

---

## 6. 会话与 BYOK 数据面

1. Headless 用 SDK **createSession / resumeSession**（非桌面 editor 会话直连）  
2. 模型 **多源 BYOK**（真源 **`config/models.json`**，密钥不进文件）：  
   - **OpenCodex 10100**（`apiKeyFromFile: ~/.opencodex/admin-api-token`，默认启用）→ `deepseek-v4-*`、`mimo-v2.5(-pro)`、`gemini-3.6-flash-high`、`claude-sonnet-4-6`、`cursor-grok-4.5-{high,medium,low}`、`composer-2.5` 共 10 个第三方模型，**模型 id 不变**  
   - **OpenCode Go**（`OPENCODE_API_KEY`，整组 `enabled: false` 作回滚开关）→ `deepseek-v4-*`、`mimo-v2.5(-pro)`  
   - **本地 CLI Proxy 8317**（整组 `enabled: false` 作回滚开关）→ `gemini-*`、`cursor-grok-*`、`composer-*`  
   - **DeepSeek 官方**（默认 `enabled: false`）→ `deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro`  
   - **模型级开关**：`models.json` 中每个模型条目可显式 `"enabled": false` 单独下线；provider 级 `enabled: false` 整组关闭  
3. 默认：`defaultModel`（现 `deepseek-v4-flash`）→ 会话 id `opencodex/<id>`  
4. Key/URL：`loadShellEnvForByok()` 读 bash 的 `DEEPSEEK_*` / `OPENCODE_*` / `COPILOT_*` / `CLIPROXY_*`；`paths.cliproxyConfig` 可用 `${HOME}`；`paths.agentsMd` 默认 `../agent-memory/AGENTS.md`（与 join 共用；也可用 `${EXTENSIONS}` / `${BRIDGE_ROOT}`）  
5. 改模型：只编辑 `config/models.json` 后 `bash scripts/headless-daemon.sh restart`（或 env `HEADLESS_MODELS_CONFIG`）  
6. **上下文窗口**：在 `models.json` 里为每个模型写 `maxPromptTokens` / `maxContextWindowTokens` / `maxOutputTokens`（SDK 自定义模型默认 128K）。**不读**桌面 `~/.copilot/data.db`。详见 [`custom-models-context.md`](./custom-models-context.md)。  
7. **用户 MCP**：create/resume 显式加载 `paths.mcpConfig`（默认 `~/.copilot/mcp-config.json`）→ `SessionConfig.mcpServers`。详见 §14。  
8. **per-bot 模型/MCP**：`bots.json` 可写 `defaultModel` / `allowedModels` / `loadMcp` / `mcpServerNames`（见 [`prompt-reverse-bot.md`](./prompt-reverse-bot.md)）。  

**锁文件**：`bots/<Name>/lock.json` —— 标记该 bot 当前占用 session；他会话持锁时 auto-connect 会停手，避免双连。

**断线**：headless 循环报错 / session lost → 约 **10s** 重连；仍持 leader 则 resume/create 再进 poll。

---

## 7. Telegram 入站 / 出站（与 editor 共用 runtime）

同属 `lib/bot-runtime.mjs` + `lib/bot-handlers.mjs`：

| 能力 | 要点 |
| :--- | :--- |
| Long poll | `getUpdates`；启动前清 webhook 防 409 |
| 授权 | `config/access.json`；未授权走配对码 |
| 发送队列 | 串行 + pace；429 按 `retry_after` 回队 |
| Typing | `sendChatAction` **旁路** queue；turn_end / slash / idle 必须停 |
| Tool bubble | 临时状态消息；turn 结束延迟删除（以实现代码为准） |
| 权限 / ask_user | **默认无头**（`permissionMode` 缺省 / allow-all）：`setAllowAll` + handler `approve-once`。**deny-all**（如 PromptReverse）：`setAllowAll(false)` + handler `deny-once`。**Editor**：`bots.json` 可设 `allow-all`（现默认已开）或 `ask`（TG 批准卡）。`ask_user` 用 freeform/按钮解冻 awaitingInput |
| 准入 | 默认 **allowlist**（`access.json` 配对）；**open-group** 等见 bot profile |

Slash：`/session` `/clean` `/model` `/mode` `/status` `/rich` `/stop` 等与 README 一致；**restricted** bot 菜单可缩到仅 `/start` `/stop`。无头侧 `/session` 切换的是 **该 bot sticky 会话**。`/rich` **默认关**（表格→列表）；`on` 才走富文本表。

---

## 8. LaunchAgent 与运维命令

### 8.1 单元

| 项 | 值 |
| :--- | :--- |
| Label | `com.copilot-telegram-bridge` |
| 安装路径 | `~/Library/LaunchAgents/com.copilot-telegram-bridge.plist` |
| 源模板 | `scripts/com.copilot-telegram-bridge.plist` |
| 域 | `gui/$(id -u)`（**登录会话内**；登出停，再登录起） |
| 程序 | `/bin/bash` + `…/headless-daemon.sh` + `run` |
| 策略 | `RunAtLoad=true` · `KeepAlive=true` · `ThrottleInterval=10` |
| 日志 | `bots/Headless/daemon.log`（stdout/stderr 同文件） |

### 8.2 脚本子命令

```bash
EXT=~/.copilot/extensions/telegram-bridge/scripts/headless-daemon.sh

bash "$EXT" install     # 装 plist + bootstrap + kickstart
bash "$EXT" uninstall   # bootout + 删 plist + 杀进程
bash "$EXT" start       # 已装 → launchd；未装 → nohup 临时代跑
bash "$EXT" stop        # 先 bootout（否则 KeepAlive 立刻拉回）再杀
bash "$EXT" restart
bash "$EXT" status      # pid / bin / launchd / leader JSON
bash "$EXT" run         # 前台 exec（仅 launchd 或调试用）
```

| 操作 | 注意 |
| :--- | :--- |
| `stop` | **必须**先 `bootout`，否则 KeepAlive 秒级 respawn |
| `install` | 会先停掉无 launchd 的手动 nohup，防双 leader |
| `start`（未 install） | 仅 nohup，**无**开机自启；日志由脚本重定向 |

### 8.3 健康检查清单

```bash
# 1) 守护
bash ~/.copilot/extensions/telegram-bridge/scripts/headless-daemon.sh status
# 期望：running · launchd=loaded · leader 含 "mode":"daemon"

# 2) launchd
launchctl print "gui/$(id -u)/com.copilot-telegram-bridge" | head

# 3) 网关
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8317/v1/models

# 4) 日志尾
tail -50 ~/.copilot/extensions/telegram-bridge/bots/Headless/daemon.log
# 期望：acquired headless leadership mode=daemon · session resumed/created · 无连续 poll error
```

---

## 9. 与桌面 Bot 的边界

| | 桌面 editor（如 `Copilot`） | 无头守护（`Headless`） |
| :--- | :--- | :--- |
| 宿主 | Copilot App / 会话内扩展 | launchd → CLI + bootstrap |
| 模式 | 默认 `all` | 强制 `headless-only` |
| 会话 | 当前桌面 session | create/resume + sticky UUID |
| 模型 | 桌面会话模型列表 | OpenCode 四模型 + cliproxy grok |
| 节流风险 | 未进 session 时可能卡 | **无此路径** |
| Leader | mode=`app`，让位 daemon | mode=`daemon`，可抢 app |

两边 **不要** 同时抢同一 bot 的 poll：守护占 leader 时，App 内 Headless 应 standby。

---

## 10. 故障速查

| 现象 | 优先查 |
| :--- | :--- |
| 开机后无头不回 | `status` / `launchctl print`；是否登录 gui 会话；`daemon.log` |
| `error: copilot CLI not found` | §5 缓存是否被清；打开一次桌面 App |
| `extension_bootstrap` / sdk missing | 同上 pkg 目录 |
| 约两条后停、且 **只有** App 内 headless | 未走守护或 leader 被 app 占用 → `install` + 确认 `mode=daemon` |
| poll `fetch failed` | 本机网络 / 代理；**勿擅自改 Stash**，先报主人 |
| `setMyName` Rate limited | 已用 `state.lastSetMyName` 同名跳过 + 429 缓存；改 `config/bots.json` label 后才会再调 |
| 401 / 模型列表空 | cli-proxy-api 是否起、key 是否失效 |
| Session not found | sticky 空壳；`/session` 只列可 resume；必要时 `/clean` |
| 双 bot 抢答 / 空壳狂增 | 双 leader 或双守护；`stop` 干净后单实例 `start` |
| `stop` 后进程立刻回来 | 正常 KeepAlive → 用脚本 `stop`（含 bootout）或 `uninstall` |

---

## 11. 关键路径速查

```text
扩展根
  ~/.copilot/extensions/telegram-bridge/
    extension.mjs
    lib/headless-leader.mjs
    lib/bot-runtime.mjs
    lib/bot-handlers.mjs
    scripts/headless-daemon.sh
    scripts/com.copilot-telegram-bridge.plist
    config/bots.json             # token（敏感）
    config/access.json           # 授权用户
    config/models.json           # BYOK 模型清单 + paths.mcpConfig
    # 人设：../agent-memory/{AGENTS,prompt-reverse}.md
    bots/Headless/               # 进程级 daemon.pid / daemon.log + 该 bot 态
      daemon.pid
      daemon.log
      headless.leader.json
      lock.json
      state.json
    bots/PromptReverse/          # 其他无头 bot 同结构（无 daemon.pid）

用户级
  ~/.copilot/mcp-config.json     # 用户 MCP 真源（显式注入 session）

系统
  ~/Library/LaunchAgents/com.copilot-telegram-bridge.plist

CLI 缓存
  ~/Library/Caches/github-copilot-sdk/cli/<ver>/copilot
  ~/Library/Caches/copilot/pkg/darwin-arm64/<ver>/preloads/extension_bootstrap.mjs
  ~/Library/Caches/copilot/pkg/darwin-arm64/<ver>/copilot-sdk/

网关
  ~/.cli-proxy-api/              # :8317，独立 LaunchAgent
```

---

## 12. 相关文档

- 总览与日常命令：`README.md`（「无头独立守护」小节）
- 专用反推 bot：[`prompt-reverse-bot.md`](./prompt-reverse-bot.md)
- 演进记录：`changelog/2026-07-14_headless-byok-session-and-ops.md` §24 / §25；MCP：`changelog/2026-07-17_headless-explicit-mcp.md`
- 网关运维：本机 cli-proxy-api 技能 / LaunchAgent（非本仓库）

---

## 13. 无头工具权限（按 profile）

### 13.1 默认 allow-all（Headless）

对齐桌面 **Run tools without asking**：

1. create/resume/switch 后：`setAllowAll(true)` + `setApproveAll(true)`
2. Handler：`{ kind: "approve-once" }`，不向 TG 弹授权卡
3. 仅 `isHeadless` 且非 deny-all；editor 仍交互授权

日志：`setAllowAll(true) ok` / `auto-approved permission kind=`。

### 13.2 deny-all（如 PromptReverse）

1. `setAllowAll(false)` + `setApproveAll(false)`
2. Handler：`{ kind: "deny-once" }`
3. 默认 **不加载 MCP**（§14）；菜单/命令受限

日志：`permissions.setAllowAll(false) deny-all`。

---

## 14. 用户 MCP（显式加载）

无头 **create/resume** 从用户 MCP 配置读 `mcpServers`，写入 `SessionConfig.mcpServers`（**不**依赖 SDK `enableConfigDiscovery`）。

| 项 | 说明 |
| :--- | :--- |
| 真源 | `~/.copilot/mcp-config.json`；可改 `models.json` → `paths.mcpConfig`（`${HOME}` 可展开） |
| 默认加载 | **是**（普通 Headless） |
| 默认跳过 | `permissionMode: deny-all` 或 `profile: prompt-reverse` |
| 覆盖 | `bots.json`：`"loadMcp": true\|false`；`"mcpServerNames": ["tavily"]` 只加载部分 |
| create/resume | 均走 `buildHeadlessSessionConfig({ loadMcp, mcpServerNames })` |
| 日志 | `loaded user MCP servers (N) from …: a, b` 或 `MCP load skipped (loadMcp=false)`；boot 行带 `mcp=on\|off` |

实现：`lib/byok-providers.mjs` → `loadUserMcpServers` / `normalizeMcpServerConfig`。

**验收**：Headless 对话中真实调用 tavily/notion/dayone 工具；PromptReverse 不应起 MCP 子进程。

---

*文档与实现对齐日期：2026-07-17。代码以仓库为准；运维改脚本后请同步改本节。*
