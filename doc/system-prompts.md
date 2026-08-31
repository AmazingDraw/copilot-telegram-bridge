# Copilot SDK 系统提示词注入与定制指南

本文档说明 **GitHub Copilot SDK**（`1.0.80+`）系统提示词的组成、`customize` 裁剪，以及 Telegram Bridge 无头会话的注入时机。

---

## 1. 提示词三层架构

无头会话（`createSession` / `resumeSession`）启动时，最终送入大模型的系统提示词由以下三层叠加：

```text
┌────────────────────────────────────────────────────────┐
│ 1. SDK 原生系统底模 (1.5k~2k tokens)                    │
│    • identity 组 / preamble / tone / code_change_rules │
│    • tool_efficiency / guidelines / safety 等          │
├────────────────────────────────────────────────────────┤
│ 2. 运行时元数据 (2k~3k tokens)                          │
│    • Skills 元数据                                      │
│    • 用户 MCP 工具定义                                  │
├────────────────────────────────────────────────────────┤
│ 3. 用户/业务指令 (1k~4k tokens)                         │
│    • AGENTS.md / prompt-reverse.md / 自定义人设         │
└────────────────────────────────────────────────────────┘
```

* **Headless 主 Bot**：保留第 1 层里的**改码与工具骨架**，裁掉 CLI 身份/语气；第 3 层人设挂在全部 section **之后**。
* **垂直专用 Bot（SecondaryBot）**：`replace` 只留第 3 层。

---

## 2. 三种 `SystemMessageConfig` 模式

| 模式 (`mode`) | 说明 | Bridge 用途 |
| :--- | :--- | :--- |
| **`"append"`** | 完整 SDK 底模 + 末尾追加 | 显式 `systemMessageMode: "append"` 时 |
| **`"customize"`** | 按 section 增删改，可选末尾 `content` | **Headless 默认** |
| **`"replace"`** | 清空 SDK 底模，全部由调用方提供 | `profile=prompt-reverse` 默认 |

---

## 3. SDK 内置 section（12 个，含组）

`SystemMessageSection`（vendored SDK `runtime/<ver>/pkg/copilot-sdk` 的 `types.d.ts`）实际是 **12** 个，不是 11。其中 **`identity` 是组**，不是单独一段正文：`remove identity` 会连带拆掉组内 sibling（`tone`、`tool_efficiency` 等），除非对组员标 `"preserve"`。

| Section | 作用 | Headless customize 取舍 |
| :--- | :--- | :--- |
| **`identity`** | **组**：preamble + tone + tool_efficiency 等 | **不动**（禁止整组 remove） |
| **`preamble`** | CLI 身份（You are GitHub Copilot CLI…） | **remove**（让位给人设） |
| **`tone`** | CLI 简洁/输出格式 | **remove**（与 Telegram 人设排版打架） |
| **`tool_efficiency`** | 并行工具、批处理 | **保留** |
| **`environment_context`** | CWD / OS / git / 工具列表 | **保留** |
| **`code_change_rules`** | Diff / apply_patch / 测试风格 | **保留** |
| **`guidelines`** | 终端行为建议 | **remove**（冗余且易盖人设） |
| **`safety`** | 危险操作与保密 | **replace** → `HEADLESS_SAFETY_SLIM` |
| **`tool_instructions`** | 各内置工具用法 | **保留** |
| **`custom_instructions`** | 仓库/组织指令（SDK 发现） | **remove**（人设只走 content，避免叠一层） |
| **`runtime_instructions`** | 运行时通知、mode、排除策略 | **保留** |
| **`last_instructions`** | 收尾：并行调用、把任务做完 | **remove**（与 tool_efficiency / 人设重复） |

人设放在 customize 的顶层 **`content`**（全部保留 section 之后）。不写 `organizationCustomInstructions`。

垂直 Bot 继续 `replace`，不要用这套裁剪。

---

## 4. Bridge 注入时机

无头只在 **打开/重建会话配置** 时写入 `SessionConfig.systemMessage`，普通打字不注。

| 时机 | API | 注入 |
| :--- | :--- | :--- |
| 守护拉起 / 断线重连 | `resumeSession` 或 `createSession` | ✅ |
| `/session` 切历史 | 本进程 `resumeSession` | ✅（重读盘上最新人设） |
| `/new` | `createSession` | ✅ |
| **`/model` 换模型** | 同 `sessionId` 再 `resumeSession`（不是裸 `switchTo`） | ✅ |
| 普通消息 / `/stop` | `send` / `abort` | ❌ |

`/model` 若只 `rpc.model.switchTo`，系统提示词不会重建。无头因此改为 resume 当前会话，并把目标模型写进 `SessionConfig.model`。

---

## 5. `bots.json` 字段

```json
{
  "SecondaryBot": {
    "role": "headless",
    "profile": "prompt-reverse",
    "agentsMd": "../agent-memory/prompt-reverse.md",
    "permissionMode": "deny-all",
    "loadMcp": false,
    "loadSkills": false,
    "systemMessageMode": "replace"
  }
}
```

* **`agentsMd`**：该 Bot 提示词文件（相对 bridge 根或绝对路径）。
* **`systemMessageMode`**：`"replace"` \| `"customize"` \| `"append"`。
  * `profile === "prompt-reverse"` → 默认 `"replace"`。
  * 其他 → 默认 `"customize"`。
* **`loadSkills` / `loadMcp`**：prompt-reverse 与 deny-all 默认 false。

实现：`lib/bot-profile.mjs`、`lib/byok-providers.mjs` 的 `buildHeadlessSystemMessage` / `HEADLESS_CUSTOMIZE_SECTIONS`。

---

## 6. 范例

### Headless 主 Bot

* `systemMessageMode`: `"customize"`（上表裁剪 + 末尾 AGENTS.md）
* `loadSkills` / `loadMcp`: `true`
* `agentsMd`: 全局 `AGENTS.md`

### SecondaryBot（看图反推）

* `systemMessageMode`: `"replace"`
* `loadSkills` / `loadMcp`: `false`
* `permissionMode`: `"deny-all"`

---

## 7. 日志

```text
telegram-bridge: systemMessage mode=customize sections=preamble:remove,tone:remove,guidelines:remove,custom_instructions:remove,last_instructions:remove,safety:replace agents=3240c
telegram-bridge: [Headless] headless model rehydrate → cliproxy/xxx session=<uuid> agents=3240c

telegram-bridge: systemMessage mode=replace (len=2283c)
telegram-bridge: [SecondaryBot] skills_loaded count=0
```
