# Codex 子命令（/codex）

> 实现：`lib/codex-commands.mjs`  
> 配置：`config/models.json` → `defaults.codex*`、`paths.codex*`  
> Claude 对照：[`claude-commands.md`](./claude-commands.md) · 无头人设：[`system-prompts.md`](./system-prompts.md)

Telegram 里的 `/codex` **不是** Copilot 无头会话。它 `spawn("codex", ["exec", …])` 调本机 **Codex CLI**，cwd 为 `~/.agents/workspace`，配置/会话仍在 `~/.codex`。

```text
Telegram /codex
    ▼
lib/codex-commands.mjs
    ▼
codex exec [resume <sid>] <prompt> -o done.txt --skip-git-repo-check
     + Telegram 瘦身旗标（见 §2）
    cwd = ~/.agents/workspace
    ▼
~/.codex/sessions/…jsonl
/tmp/telegram-bridge/codex/     Bridge 任务状态
```

改完代码或 `models.json` 后：`bash scripts/headless-daemon.sh restart`。

桌面 ChatGPT/Codex App 开着时 CLI 会抢会话。菜单有「🖥 关闭桌面」。

---

## 1. Telegram 用法

```text
/codex              打开菜单
/codex <prompt>     直接新对话执行
```

| 菜单 | 行为 |
| :--- | :--- |
| 💬 新建对话 | 进入输入态 |
| 📂 继续对话 | `~/.codex/sessions` 历史 |
| 🎛 切换模型 | `~/.codex/opencodex-catalog.json`；只锁当前 Bridge 进程，不写 `config.toml` |
| 📊 进度 | `/tmp/telegram-bridge/codex/tasks.json`（最近 50 条） |
| 🖥 关闭桌面 | 杀掉 ChatGPT 桌面，避免和 CLI 互锁 |
| ✋ 停止 | SIGTERM，5s 后 SIGKILL；结束后仍 drain 剩余队列 |
| 🗑 取消排队 | 丢掉未跑的指令 |
| ⚡️ 打断 | 停掉当前，丢掉更早排队，立刻跑最新一条 |
| 🚪 退出 | 清输入态 / 模型锁 |

连续对话默认 **排队**（当前任务不受影响，等于追加）。`claude -p` / `codex exec` 都不读 stdin，**不能**把字塞进正在生成的那一轮。

发图走 `codex exec -i <path>`。

---

## 2. 开场上下文：裁了啥、留了啥

`~/.codex/config.toml` 是给 **桌面 Codex** 用的全量：一堆插件（Chrome / Calendar / Slack / 文档 / Computer Use…）、`memories`、MCP `node_repl`。CLI 若原样加载，Telegram 一轮会非常肥、也容易和桌面抢资源。

因此 `/codex` **默认** `defaults.codexSlim: true`：

| 关掉 | 说明 |
| :--- | :--- |
| `--disable memories` + `features.memories=false` | 不跑记忆子系统 |
| `--ignore-rules` | 不加载 execpolicy `.rules` |
| 桌面插件 | visualize / calendar / slack / documents / pdf / spreadsheets / presentations / template-creator / chrome / computer-use / record-and-replay / browser / codex-app-tools |
| MCP | `node_repl`、`computer-use`、`cua_repl` |

| 留下 | 说明 |
| :--- | :--- |
| `~/.codex/config.toml` 其余项 | 模型、`openai_base_url`（opencodex :10100）、sandbox 等 |
| **`~/.codex/AGENTS.md`** | CLI **没有**跳过开关，人设仍会注入（见 §3） |
| 工作目录 | `paths.codexAgentsDir`，默认 `~/.agents/workspace` |
| 会话 | `~/.codex/sessions`；`exec resume <uuid>` |
| 你在 Telegram 里打的 prompt | 不再追加「任务完成后…」之类后缀 |
| `--skip-git-repo-check` | workspace 可以不是 git 根 |

恢复全量插件：`defaults.codexSlim: false`，再 restart。

超时：5 分钟无输出警告；**无输出**超过 10 分钟才杀（不是按开场墙钟）。卡住的任务算占用，不会并行再开一场。

---

## 3. 人设会不会和 Copilot 重复？

**同一次任务里不会叠两份。** 三条 Telegram 通道读的是三份文件，互不扫描：

| 通道 | 进程 | 人设文件 | 同一次 spawn 会不会再读另一份 |
| :--- | :--- | :--- | :--- |
| 无头主 Bot（普通聊天，不是 /codex） | Copilot SDK | `memory/AGENTS.md`（`paths.agentsMd`） | 否。SDK 不读 `~/.codex/AGENTS.md` |
| `/codex` | `codex exec` | `~/.codex/AGENTS.md` | 否。不读 Copilot 的 `memory/AGENTS.md`，工作区也没有 `AGENTS.md` |
| `/claude` | `claude --bare` | **无**（`--bare` 跳过 CLAUDE.md 自动发现；`~/.claude` 也没有 AGENTS.md） | 否 |

两份人设 **内容同源**（都是「小白」模板，章节结构一样），但 **不是同一文件**，长度也不等（Copilot ~2.3k 字 / Codex ~2.5k 字）。Codex 那份多了「禁止直接改代码、必须先出 3 方案」和按端同步脚本；Copilot 那份多了 kimi-webbridge / Tavily 等技能路由。

所以：

- 在 Telegram **普通说话**（无头 Copilot）：只有 Copilot 那份。
- 发 `/codex`：只有 Codex 那份。不会 Copilot+Codex 人设各灌一次。
- 你感觉「重复」，是两端各维护一份很像的副本，不是 Bridge 把两份都塞进同一轮。

改人设时按端改、按端同步（Codex 文件自己写明了不要动其它端的 AGENTS）。不要把两份合成一份再让两边同时读。

---

## 4. `config/models.json` 相关键

```json
"defaults": {
  "codexWaitTimeoutMs": 3600000,
  "codexSlim": true
},
"paths": {
  "codexAgentsDir": "${HOME}/.agents/workspace",
  "codexSessionDir": "${HOME}/.codex/sessions",
  "codexStateDir": "/tmp/telegram-bridge/codex"
}
```

| 键 | 作用 |
| :--- | :--- |
| `codexSlim` | `false` = 加载桌面那套插件/MCP/memories |
| `codexWaitTimeoutMs` | 连续对话没人打字多久退出 |

模型列表不在 `models.json`，在 `~/.codex/opencodex-catalog.json`（排除 `~/.opencodex/config.json` 的 `disabledModels`）。

---

## 5. 路径速查

| 内容 | 路径 |
| :--- | :--- |
| 实现 | `lib/codex-commands.mjs` |
| 工作区 | `~/.agents/workspace` |
| Codex 人设 | `~/.codex/AGENTS.md` |
| Copilot 人设（无头 Bot） | `copilot-telegram-bridge/memory/AGENTS.md` |
| Codex 配置 | `~/.codex/config.toml` |
| 会话 | `~/.codex/sessions/` |
| Bridge 任务 | `/tmp/telegram-bridge/codex/tasks.json` |
