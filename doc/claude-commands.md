# Claude 子命令（/claude）

> 实现：`lib/claude-commands.mjs`  
> 配置：`config/models.json` → `defaults.claude*`、`modelSets.claude-cli`  
> 无头守护：[`headless-daemon.md`](./headless-daemon.md) · 模型目录：[`models-config.md`](./models-config.md)

Telegram 里的 `/claude` **不是** Copilot 无头会话。它 `spawn("claude", …)` 调本机 **Claude Code CLI**，经 CLI Proxy `:8317` 的 Anthropic `/v1/messages` 出网（不经 OpenCodex）。

```text
Telegram /claude
    ▼
lib/claude-commands.mjs
    ▼
claude -p … --output-format stream-json --bare --strict-mcp-config --model <slug>
    cwd = ~/.agents/workspace
    env ANTHROPIC_BASE_URL = cliproxy :8317
    ▼
~/.claude/projects/…/*.jsonl     会话落盘
/tmp/telegram-bridge/claude/     Bridge 任务状态
```

改完代码或 `models.json` 后：`bash scripts/headless-daemon.sh restart`。

---

## 1. Telegram 用法

```text
/claude              打开菜单
/claude <prompt>     直接新对话执行
```

| 菜单 | 行为 |
| :--- | :--- |
| ✨ 新建对话 | 进入输入态；下一条文字/图开新 session |
| 📂 继续对话 | `~/.claude/history.jsonl` + `projects/**/*.jsonl`，最多 10 条 |
| 🧠 切换模型 | `modelSets.claude-cli`；只影响当前 Bridge 进程，不改 `~/.claude/settings.json` |
| 🗺 计划 | `--permission-mode plan`；批准后同一 session `--resume` 再跑 |
| ⚡️ 思考档 | `--effort`：低 / 中 / 高 / 极高 / 最大 |
| 🛟 备援 | 主模型 429/配额后，Bridge **换模型再 spawn 一次**（不用 Claude 自己的 `--fallback-model`） |
| 📡 实时 | `stream-json` 刷新进度气泡 |
| 📊 进度 | `/tmp/telegram-bridge/claude/tasks.json`（保留最近 50 条） |
| ✋ 停止 | SIGTERM，2s 后 SIGKILL；含 `stuck` 任务 |
| 🚪 退出 | 清输入态 / 模型锁 / 计划 / 思考档 / 备援 |

连续对话时发图会把本机路径写进 prompt。/cancel、/stop、/claude exit 退出输入态。

---

## 2. 开场上下文：裁了啥、留了啥

实测一次闲聊就要 **~2 万 input tokens**，且 cache_read=0。工作区 ~/.agents/workspace 几乎是空的，膨胀来自 Claude Code **默认系统提示 + 工具 Schema + 技能/插件/MCP/CLAUDE.md**，不是仓库文件。

因此 /claude **默认**加两个旗标：

| 旗标 | 配置 | 默认 |
| :--- | :--- | :--- |
| `--bare` | `defaults.claudeBare` | `true` |
| `--strict-mcp-config`（且不传 `--mcp-config`） | `defaults.claudeStrictMcp` | `true` |

恢复全量：把对应项设为 `false`，再 `headless-daemon.sh restart`。

### 2.1 `--bare` 裁掉的

Claude Code 官方说明：跳过 hooks、LSP、plugin 同步、attribution、auto-memory、后台 prefetch、钥匙串读取、**CLAUDE.md 自动发现**。并设 `CLAUDE_CODE_SIMPLE=1`。
工作区 `~/.agents/workspace` 移除 `.git`，从源头阻断 GitStatus 探测。**不再**用 `--system-prompt` 去顶掉默认 `Date`。

对应到开场注入，等于不再自动带上：

| 裁掉 | 说明 |
| :--- | :--- |
| 用户/项目/本地 `CLAUDE.md` 自动发现 | 目录树不再扫描；**例外**：Bridge 用 `--append-system-prompt` 只追加 `~/.claude/CLAUDE.md` |
| hooks | 启停、工具前后钩子 |
| LSP | 语言服务上下文 |
| plugin 同步与插件工具 | 市场插件、额外 tool schema |
| auto-memory | 自动记忆读写 |
| 后台 prefetch | 预拉变更/上下文 |
| 钥匙串 / OAuth 读凭据 | 认证只走 env 里的 `ANTHROPIC_AUTH_TOKEN`（cliproxy） |
| **GitStatus 状态快照** | 工作区去 `.git` 后源头阻断，不再注入分支名、用户名、提交记录及未跟踪文件 |

本机对话里曾经出现、现已不再默认注入的噪音（2026-09-01 实测）：

- Anthropic 身份/Co-Authored-By 等与 **Gemini / DeepSeek 网关模型** 不匹配的系统规则
- 冷门工具 Schema：`DesignSync`、`NotebookEdit`、`ReportFindings`
- 重叠调度：`Cron*`、`ScheduleWakeup`、`loop` 技能
- 偏重的 `Task*` 全家桶
- 全量 Skills 长描述（即使当前只是问答）
- 每轮重复的静态元数据（如 `total_tokens` 余量）
- Git 快照与未跟踪文件噪音（如 `.DS_Store`）

### 2.2 `--strict-mcp-config` 裁掉的

只接受命令行 `--mcp-config` 里的 MCP。Bridge **不传**该参数 → **不加载** `~/.claude.json` / 项目 `.mcp.json` 里的服务器。

要给 `/claude` 加 MCP：自己准备一份 JSON，再改 spawn（当前没有配置项自动喂 `--mcp-config`）。

### 2.3 仍然留下的

| 留下 | 说明 |
| :--- | :--- |
| Claude Code 内置核心工具 | `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、Web 搜索/抓取等 CLI 默认工具 |
| `--dangerously-skip-permissions` | 非计划模式；Telegram 远程不能点本机权限窗 |
| 工作目录 | `paths.claudeWorkDir`，默认 `~/.agents/workspace`（`spawn` 的 `cwd`） |
| 本端人设 | `~/.claude/CLAUDE.md`；`--bare` 不会自动发现，Bridge 用 `--append-system-prompt` 追加。人设只改这个文件，不同步仓库 |
| 会话落盘 | `~/.claude/projects/…`；`--resume <uuid>` 续聊 |
| 你在 Telegram 里打的 prompt | `-p` |
| 模型 / 思考档 / 计划 | `--model`、`--effort`、`--permission-mode plan` |
| cliproxy 上游 | `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` |
| Haiku / Small-Fast 别名 | `ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_SMALL_FAST_MODEL` |
| `stream-json` + `--verbose` | 实时进度（可在菜单关掉实时，仍是 stream-json） |

`--bare` **不会**清空已经 `--resume` 的旧 jsonl。旧会话里的工具结果、长文还在。要瘦上下文：菜单里 **新建对话**，不要续昨晚那条。

技能若要用，须在对话里显式 `/skill-name`（bare 下不再预注入技能目录）。

---

## 3. 超时、卡住、排队

| 项 | 值 | 行为 |
| :--- | :--- | :--- |
| 卡住警告 | 5 分钟无 stdout/stderr | Telegram 提示「可能卡住」；子进程 **还活着** |
| 杀掉 | **无输出** 超过 10 分钟 | SIGTERM，必要时 SIGKILL（按无输出，不按开场墙钟） |
| 输入等待 | `defaults.claudeWaitTimeoutMs`（默认 1 小时） | 没人说话则退出连续对话桥接 |
| 新消息 | 已有 `running`/`stuck` 或活着的 child | **默认排队**（当前任务不受影响，等于追加） |

历史上的坑（已修）：

1. `stuck` 不算占用 → 用户再发「好了吗」会 **并行** 再拉一个 `claude --resume` 抢同一 session。
2. `tasks.json` 没写 `taskId`，停止按钮 `Map.get(undefined)`，**杀不掉** 子进程，最后 `exit=null`。
3. 10 分钟按 **开始时间** 杀，长任务即使用流还在写也会被干掉。现改成按 **最后一次输出**。
4. 连续对话默认 **排队**（当前继续跑，新消息等于追加到结束后）。
5. 子菜单 / 排队提示提供三键：**停止**（杀掉当前，结束后仍会 drain 剩余队列）、**取消排队**、**打断**（杀掉当前，丢掉更早的排队，立刻跑最新一条）。
6. `claude -p` 的 stdin 是关掉的，**不能**在生成中途把字塞进同一轮。要追加信息：直接发消息排队即可。

任务记录：`/tmp/telegram-bridge/claude/tasks.json`。

---

## 4. `config/models.json` 相关键

```json
"defaults": {
  "claudeWaitTimeoutMs": 3600000,
  "claudeDefaultModel": "gemini-flash",
  "claudeFallbackModel": "deepseek-v4-flash",
  "claudeDefaultEffort": "",
  "claudeModelSet": "claude-cli",
  "claudeModelPrefix": "",
  "claudeHaikuModel": "cursor-auto",
  "claudeSmallFastModel": "cursor-auto",
  "claudeBare": true,
  "claudeStrictMcp": true
},
"paths": {
  "claudeWorkDir": "${HOME}/.agents/workspace",
  "claudeSessionDir": "${HOME}/.claude",
  "claudeStateDir": "/tmp/telegram-bridge/claude"
}
```

| 键 | 作用 |
| :--- | :--- |
| `claudeBare` | `false` = 不要 `--bare`（全量 CLAUDE.md / hooks / 插件 / 记忆） |
| `claudeStrictMcp` | `false` = 允许 Claude 读用户/项目 MCP 配置 |
| `claudeModelSet` | 菜单模型列表；增删只改这组和 `catalog` |
| `claudeFallbackModel` | 应与主模型 **不同**；相同则备援等于没开 |
| `claudeWaitTimeoutMs` | 连续对话没人打字多久退出 |

环境变量（spawn 时写入，不写进 git）：

- `ANTHROPIC_BASE_URL` ← cliproxy（去 `/v1` 后缀）
- `ANTHROPIC_AUTH_TOKEN` ← `CLIPROXY_API_KEY` 或 cliproxy yaml
- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- `CLAUDE_CODE_MAX_RETRIES=1`

stderr 里 `[claude-code:unrecognized_model]` 表示该 slug 不在 Claude Code 内置表，但网关发现仍可能跑。模型列表以 `modelSets.claude-cli` 为准。

---

## 5. 路径速查

| 内容 | 路径 |
| :--- | :--- |
| 实现 | `lib/claude-commands.mjs` |
| 工作区 | `~/.agents/workspace` |
| Claude 配置/会话 | `~/.claude/` |
| Bridge 任务 | `/tmp/telegram-bridge/claude/tasks.json` |
| 守护日志 | `bots/Headless/daemon.log` |

`/claude` 与 Copilot 无头 Bot **不共享** `SessionConfig.systemMessage`。无头人设裁剪见 [`system-prompts.md`](./system-prompts.md)，不要和这份混为一谈。


---

## 6. 2026-09-02 流畅性补丁

- 去掉 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=829800`（几乎等于禁止压缩上下文）。
- **开场 GitStatus**：`~/.agents/workspace` 移除 `.git` 与 `.DS_Store`（保留 `skills` 软链），从源头阻断分支名、用户名、提交记录及未跟踪文件快照。默认 `Date` 不再用 `--system-prompt` 覆盖。
- **人设**：`lib/claude-commands.mjs` 用 `--append-system-prompt` 追加 `~/.claude/CLAUDE.md`（`--bare` 不会自动加载）。
- `/codex` 默认同款排队/停止/打断；Telegram 启动关闭 memories、桌面插件、Computer Use / Chrome / Calendar 等 MCP（`defaults.codexSlim`，可 `false` 恢复全量）。
- `~/.codex/AGENTS.md` 人设仍会加载（CLI 没有跳过开关）；不要用 Telegram 任务去改这份记忆。`/claude` 人设只读 `~/.claude/CLAUDE.md`。
