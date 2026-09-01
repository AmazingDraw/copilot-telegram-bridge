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
       ▼
extension.mjs
  只起 role=headless 的 bot
```

**硬依赖**：`runtime/` 成对 CLI+SDK · CLI Proxy `:8317` · `config/bots.json` token · `config/access.json`。

换版本：`bash scripts/vendor-copilot-runtime.sh`（默认 npm 平台包，可跟版本号）再 `headless-daemon.sh restart`。见 [`../runtime/README.md`](../runtime/README.md)。PATH 上的 npm/brew `copilot` 不够。

---

## 1. 模式与启动

| 变量 | 守护取值 | 作用 |
| :--- | :--- | :--- |
| `TELEGRAM_BRIDGE_MODE` | `headless-only` | 脚本仍写入；其它值会被忽略 |
| `EXTENSION_PATH` | `…/copilot-telegram-bridge/extension.mjs` | 扩展入口 |
| `COPILOT_SDK_PATH` | `runtime/<ver>/pkg/copilot-sdk` | SDK |
| `COPILOT_CLI_PATH` | `runtime/<ver>/cli/copilot` | CLI |
| `SESSION_ID` | `headless-daemon` | **宿主**会话名，不是业务 sticky UUID |

`bots.json` 的 `role` 只认 `headless`。`editor` 启动时跳过。

`headless-daemon.sh run`：对齐 CLI/pkg 版本 → 写 `bots/Headless/daemon.pid` → `exec copilot extension_bootstrap.mjs`（stdout/err → `daemon.log`）。

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

bootstrap 的 parent-pid 软化打在 **vendored 副本** 上，不再改 Caches。

---

## 4. 会话数据面（摘要）

细节以专文为准，这里只列无头差异：

* 会话：SDK `createSession` / `resumeSession`。
* 模型：`config/models.json`（`catalog` + `modelSets.headless` + cliproxy）。改完 `check-model-config.mjs --live` 再 `restart`。见 [`models-config.md`](./models-config.md)。
* 人设 / MCP / Skills：create、resume、`/session`、`/new`、`/model` 重注入。见 [`system-prompts.md`](./system-prompts.md)。`enableConfigDiscovery` **不开**。
* 权限：默认 allow-all（`setAllowAll` + `approve-once`）。`deny-all` 拒绝工具且默认不加载 MCP。
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

网关指针以 `cliproxy status` 为准，不要把某一端写成永久默认。

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
VER=$(tr -d '[:space:]' < ~/.copilot/extensions/copilot-telegram-bridge/runtime/VERSION)
~/.copilot/extensions/copilot-telegram-bridge/runtime/${VER}/cli/copilot login
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh restart
```

本机桌面默认浏览器 OAuth；SSH / 无图形加 `--device-code`。

CLI 还会按顺序读：`COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`。认 fine-grained PAT（**Copilot Requests**）、Copilot CLI OAuth、`gh` 的 Copilot OAuth。**不认经典 `ghp_`。** `gh auth status` 里已有 `copilot` scope 时，有时能直接被 CLI 用；仍 401 再跑上面的 `login`。

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
runtime/<ver>/pkg/{preloads,copilot-sdk}
~/.cli-proxy-api/          # :8317，独立 LaunchAgent
```

离线才用 Caches：`bash scripts/vendor-copilot-runtime.sh --from-cache`（不是运行时路径）：

```text
~/Library/Caches/github-copilot-sdk/cli/<ver>/copilot
~/Library/Caches/copilot/pkg/<plat>/<ver>/{preloads,copilot-sdk}
```
