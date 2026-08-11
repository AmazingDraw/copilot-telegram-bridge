# PromptReverse（提示词反推 Bot）

专用无头 Bot：`@YourPromptReverseBot`，只做**提示词反推**，可进群、群员可用。

## 配置

| 项 | 值 |
| :--- | :--- |
| Registry | `config/bots.json` → `PromptReverse` |
| Agents | `../agent-memory/prompt-reverse.md`（相对 bridge；真源 `extensions/agent-memory/prompt-reverse.md`） |
| accessMode | `open-group`（群内全员；需 @ 提及） |
| permissionMode | `deny-all`（拒绝工具/写盘） |
| cooldownSec | `60`（按 userId） |
| denyPrivate | `true`（私聊拒绝对话） |
| allowedChats | `[]` = 任意群；可填 chat id 锁群 |
| 菜单 | 仅 `/start` `/stop` |
| 默认模型 | **仅** `cliproxy/cursor-grok-4.5-low`（`defaultModel` + `allowedModels`） |
| loadMcp | **false**（默认不注入用户 MCP） |
| agents 注入 | create **与** resume 均读 `agentsMd`（`systemMessage`） |

Token 仅存本地 `bots.json`（权限 600），勿提交公开仓库。  
改 agents / 模型锁 / MCP 开关后：`headless-daemon.sh restart`。

## 进群前（BotFather）

1. `/setprivacy` → **Disable**（否则群消息收不全）
2. 把 `@YourPromptReverseBot` 拉进群（建议可发消息；不必管理员）

## 用法

推荐（群内）：

1. **@ 提及 + 发图**：`@YourPromptReverseBot` 与图片同条（caption 可写补充说明），或先 @ 再发图带 caption
2. **纯图无字**：也可触发（反推专用放行）
3. **纯文字**：`@YourPromptReverseBot` + 描述文字

- 冷却：同一用户约 **60s** 一次
- 模型固定 **cursor-grok-4.5-low**（cliproxy / 8317），无 `/model` 切换
- 越权请求：agents 文案拒绝；工具权限硬 deny

## 运维

与 Headless 共用 `headless-only` daemon：

```bash
bash ~/.copilot/extensions/telegram-bridge/scripts/headless-daemon.sh restart
bash ~/.copilot/extensions/telegram-bridge/scripts/headless-daemon.sh status
```

日志：`bots/Headless/daemon.log`（进程级）；各 bot 状态：`bots/PromptReverse/`。

## 锁群示例

```json
"allowedChats": [-1001234567890]
```

改后 restart daemon。

## MCP

默认 **不加载** 用户 MCP（deny-all）。若强行 `"loadMcp": true` 也会被权限 handler deny。
