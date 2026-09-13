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
│    • AGENTS.md / 自定义人设                             │
└────────────────────────────────────────────────────────┘
```

* **Headless 主 Bot**：保留第 1 层里的**改码与工具骨架**，裁掉 CLI 身份/语气；第 3 层人设挂在全部 section **之后**。
* **可选专用 Bot**：`systemMessageMode: "replace"` 时只留第 3 层。

---

## 2. 三种 `SystemMessageConfig` 模式

| 模式 (`mode`) | 说明 | Bridge 用途 |
| :--- | :--- | :--- |
| **`"append"`** | 完整 SDK 底模 + 末尾追加 | 显式 `systemMessageMode: "append"` 时 |
| **`"customize"`** | 按 section 增删改，可选末尾 `content` | **Headless 默认** |
| **`"replace"`** | 清空 SDK 底模，全部由调用方提供 | 专用 Bot 可设 |

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

专用 Bot 继续 `replace`，不要用这套裁剪。

### 3.1 段名漂移是**静默**的（1.0.83 实测）+ 护栏

SDK 对**未知 section** 的处理是：「content-bearing 覆盖会被追加到 additional instructions，
而 **`remove` 是 silent no-op**」（`SystemMessageCustomizeConfig.sections` 官方注释）。
⇒ 将来 SDK 给某段改名，我们的裁剪会**悄悄失效**（CLI 身份/语气渗回来跟人设打架），**不报任何错**。

因此加了一道自检（`lib/byok-providers.mjs`）：

* `EXPECTED_SDK_SECTIONS` = 本文 §3 这 12 段，作为基线快照
* `extension.mjs` 把 SDK **运行时导出**的 `SYSTEM_MESSAGE_SECTIONS` 交给
  `setKnownSystemMessageSections()`，与「本方裁剪的 6 段」双向交叉校验
* 对齐 → 只报一次 `护栏 ok`；漂移 → **每次都响亮告警**，分别指出
  「本方裁剪但 SDK 已无」（`remove` 会静默失效）与「SDK 新增未评估」（该不该裁）
* 取不到该导出（老 SDK / 独立脚本无 SEA resolver）→ 护栏自动关闭并明说，**绝不因此崩桥**

> **复核记录（2026-09-13，对照 vendored SDK `1.0.83`）**：12 段全部仍存在；6 条裁剪全部命中；
> `SectionOverrideAction`（remove/replace/append/prepend/preserve）与 `SessionConfig.systemMessage`
> （定义在 `SessionConfigBase`）形状未变；§4 注入时机表在代码里仍成立（`/model` 走 resume，裸 `switchTo` 仅无 session 兜底）；
> 实测日志与本文一致。**结论：注入链路全部有效，无一条因升级失效。**

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
  "Specialized": {
    "role": "headless",
    "agentsMd": "memory/AGENTS.md",
    "permissionMode": "deny-all",
    "loadMcp": false,
    "loadSkills": false,
    "systemMessageMode": "replace"
  }
}
```

* **`agentsMd`**：该 Bot 提示词文件（相对 bridge 根或绝对路径）。
* **`systemMessageMode`**：`"replace"` \| `"customize"` \| `"append"`。未写时 Headless 默认 `"customize"`。
* **`loadSkills` / `loadMcp`**：`deny-all` 默认 false。

实现：`lib/bot-profile.mjs`、`lib/byok-providers.mjs` 的 `buildHeadlessSystemMessage` / `HEADLESS_CUSTOMIZE_SECTIONS`。

---

## 6. 范例

### Headless 主 Bot

* `systemMessageMode`: `"customize"`（上表裁剪 + 末尾 AGENTS.md）
* `loadSkills` / `loadMcp`: `true`
* `agentsMd`: `memory/AGENTS.md`

### 专用 Bot（可选）

* `systemMessageMode`: `"replace"`
* `loadSkills` / `loadMcp`: `false`
* `permissionMode`: `"deny-all"`

---

## 7. 日志

```text
telegram-bridge: systemMessage 护栏已启用（SDK 目录 12 段，与本方裁剪交叉校验）
telegram-bridge: systemMessage section 护栏 ok：SDK 12 段 / 本方裁剪 6 段全部命中
telegram-bridge: systemMessage mode=customize sections=preamble:remove,tone:remove,guidelines:remove,custom_instructions:remove,last_instructions:remove,safety:replace agents=3240c
telegram-bridge: [Headless] headless model rehydrate → cliproxy/xxx session=<uuid> agents=3240c
```

段名漂移时（升级后必看这几行）：

```text
telegram-bridge: ⚠️ systemMessage section 漂移 —— 本方裁剪但 SDK 已无: [guidelines]（remove 会**静默失效**，CLI 底模会渗进来）; SDK 新增未评估: [brand_new_section]（判断是否该裁）
```

权限姿态（§5 `permissionMode` 的落地证据，`setMode` 返回**权威** post-mutation mode）：

```text
telegram-bridge: [Headless] permissions.setMode(allow-all) ok success=true mode=allow-all
```
