# 无头 Bot（Headless）运行机制

> 扩展：`~/.copilot/extensions/copilot-telegram-bridge`  
> 对照：[`editor-bot.md`](./editor-bot.md) · 模型：[`models-config.md`](./models-config.md) · 人设：[`system-prompts.md`](./system-prompts.md)

无头主路径是 **LaunchAgent 常驻守护**，不依赖 GitHub Copilot 桌面是否打开。桌面扩展在「没进具体 session」时可能节流；守护脱离该生命周期。

```text
launchd gui/$(id -u)  com.copilot-telegram-bridge
  KeepAlive + ThrottleInterval=10
       ▼
headless-daemon.sh run
  TELEGRAM_BRIDGE_MODE=headless-only
       ▼
copilot <extension_bootstrap.mjs> → extension.mjs
  只起 role=headless 的 bot（可多个：Headless + SecondaryBot）
  每 bot：leader / sticky / poll / create|resume + BYOK
```

**硬依赖**：CLI 缓存二进制 + bootstrap/SDK（§4）· CLI Proxy `:8317`（指针见 `models.json` / `CLIPROXY_BASE_URL`）· `config/bots.json` token · `config/access.json`。

App 内嵌扩展可并行；守护已占 leader 时，App 侧 Headless 应 standby。

---

## 1. 模式与启动

| 变量 | 守护取值 | 作用 |
| :--- | :--- | :--- |
| `TELEGRAM_BRIDGE_MODE` | `headless-only` | 只起无头，跳过 editor |
| `EXTENSION_PATH` | `…/copilot-telegram-bridge/extension.mjs` | 扩展入口 |
| `COPILOT_SDK_PATH` | `~/Library/Caches/copilot/pkg/…/copilot-sdk` | SDK |
| `COPILOT_CLI_PATH` | 缓存里的 `copilot` | CLI |
| `SESSION_ID` | `headless-daemon` | **宿主**会话名，不是业务 sticky UUID |

`all`（桌面默认）= editor + headless 都尝试；`editor-only` 仅 editor。`bots.json` 的 `role` 优先。

`headless-daemon.sh run`：对齐 CLI/pkg 版本 → 写 `bots/Headless/daemon.pid` → `exec copilot extension_bootstrap.mjs`（stdout/err → `daemon.log`）。

---

## 2. Leader 与 sticky

实现：`lib/headless-leader.mjs` · 文件：`bots/<Name>/headless.leader.json`

同一 bot token 只允许一个存活循环，否则会双 poll、空壳狂增。

| 己方 | 对方仍存活 | 结果 |
| :--- | :--- | :--- |
| `daemon` | `app` | 可抢（`preferSteal`） |
| `daemon` | `daemon` | 不抢 |
| `app` | `daemon` | 不抢（standby） |
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

## 3. CLI 缓存

守护 **不读 PATH** 里的 `copilot`，按版本号成对扫缓存：

| 角色 | 路径 |
| :--- | :--- |
| CLI | `~/Library/Caches/github-copilot-sdk/cli/<ver>/copilot` |
| pkg / bootstrap / SDK | `~/Library/Caches/copilot/pkg/darwin-arm64/<ver>/` |

`status` 的 `align=version:<ver>` 为成对命中；`mtime-fallback` 可能 CLI/SDK 错配。npm/brew 单独装的 CLI **不能**替代这套布局。

Copilot `≥1.0.79` 的 bootstrap 在未设 `COPILOT_EXTENSION_PARENT_PID` 时会 `exit(0)`。`run` 对 bootstrap **幂等软化**（改前 `.bak-compat-*`）；桌面更新覆盖后下次 `run` 会重打。

缓存被清：打开一次 Copilot App 解包 → `headless-daemon.sh restart`。无头不依赖桌面**窗口**，但依赖它曾经写入的缓存文件。

---

## 4. 会话数据面（摘要）

细节以专文为准，这里只列无头差异：

* 会话：SDK `createSession` / `resumeSession`，不是桌面 `joinSession`。
* 模型：`config/models.json`（`catalog` + `modelSets.headless` + cliproxy）。改完 `check-model-config.mjs --live` 再 `restart`。见 [`models-config.md`](./models-config.md)。
* 人设 / MCP / Skills：create、resume、`/session`、`/new`、`/model` 重注入。见 [`system-prompts.md`](./system-prompts.md)。`enableConfigDiscovery` **不开**。
* 权限：默认 allow-all（`setAllowAll` + `approve-once`）。`deny-all`（如 SecondaryBot）拒绝工具且默认不加载 MCP。
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
curl -sS -m 8 -o /dev/null -w "nas %{http_code}\n" http://169.254.1.2:8317/v1/models
tail -50 ~/.copilot/extensions/copilot-telegram-bridge/bots/Headless/daemon.log
```

网关指针以 `switch-cliproxy-backend.sh status` 为准，不要把某一端写成永久默认。

---

## 6. 与桌面 Editor

| | Editor | Headless 守护 |
| :--- | :--- | :--- |
| 宿主 | Copilot App 会话内扩展 | launchd → CLI + bootstrap |
| 会话 | 当前桌面 session | create/resume + sticky UUID |
| 模型 | 桌面会话列表 | `modelSets.headless` + 8317 |
| Leader | `app`，让位 daemon | `daemon`，可抢 app |

不要两边同时 poll 同一个 bot。对照表详见 [`editor-bot.md`](./editor-bot.md)。

---

## 7. 故障速查

| 现象 | 优先查 |
| :--- | :--- |
| 开机后无头不回 | `status` / `launchctl print`；是否在登录 gui 会话；`daemon.log` |
| `copilot CLI not found` / bootstrap missing | §3 缓存；打开一次桌面 App |
| 约两条后停、且只有 App 内 headless | 没走守护或 leader 被 app 占 → `install`，确认 `mode=daemon` |
| poll `fetch failed` | 本机网络 / 代理；**勿改 Stash**，先报主人 |
| `setMyName` Rate limited | `state.lastSetMyName` 同名跳过；改 `bots.json` label 才会再调 |
| 401 / 模型列表空 | cli-proxy-api 是否起、key 是否失效 |
| Session not found | sticky 空壳；`/session` 只列可 resume；`/clean` |
| 双 bot 抢答 / 空壳狂增 | 双 leader；`stop` 干净后再单实例 `start` |
| `stop` 后立刻回来 | KeepAlive → 必须用脚本 `stop`（含 bootout） |
| 长轮无工具气泡 ≈3 分钟 | 可 `/stop` |
| `auth_unavailable` | 上游鉴权/配额，引导 `/model`；不是本机登录失效 |
| HTTP2 `INTERNAL_ERROR` | 流断开，重试 |

---

## 8. 路径

```text
~/.copilot/extensions/copilot-telegram-bridge/
  extension.mjs  lib/  scripts/headless-daemon.sh
  config/{bots,access,models}.json
  bots/Headless/{daemon.pid,daemon.log,headless.leader.json,lock.json,state.json}

~/.copilot/mcp-config.json
../agent-memory/{AGENTS,prompt-reverse}.md
~/Library/LaunchAgents/com.copilot-telegram-bridge.plist
~/Library/Caches/github-copilot-sdk/cli/<ver>/copilot
~/Library/Caches/copilot/pkg/darwin-arm64/<ver>/{preloads,copilot-sdk}
~/.cli-proxy-api/          # :8317，独立 LaunchAgent
```
