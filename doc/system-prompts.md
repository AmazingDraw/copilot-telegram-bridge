# Copilot SDK 系统提示词注入与定制指南

本文档全面介绍 **GitHub Copilot SDK**（`1.0.80+`）底层系统提示词的组成架构、控制机制，以及在 **Telegram Bridge** 中如何按 Bot 角色进行精细化裁剪与纯净替换。

---

## 1. 提示词三层架构

在无头会话（`createSession` / `resumeSession`）启动时，最终送入大模型的系统提示词由以下三层叠加组成：

```text
┌────────────────────────────────────────────────────────┐
│ 1. SDK 原生系统底模 (1.5k~2k tokens)                    │
│    • identity ("You are GitHub Copilot CLI...")        │
│    • code_change_rules (代码 diff/编辑规则)            │
│    • tool_efficiency / guidelines / safety 等         │
├────────────────────────────────────────────────────────┤
│ 2. 运行时元数据 (2k~3k tokens)                          │
│    • Skills 元数据 (33+ 个 skill 的详细功能与使用指导)   │
│    • 用户 MCP 工具定义 (Tavily, Notion 等工具 schema)   │
├────────────────────────────────────────────────────────┤
│ 3. 用户/业务指令 (1k~4k tokens)                         │
│    • AGENTS.md / prompt-reverse.md / 自定义人设与规则   │
└────────────────────────────────────────────────────────┘
```

* **通用开发场景（Headless 主 Bot）**：需要保留全部 3 层，以提供完整的代码生成、终端运维与技能编排能力。
* **垂直专用场景（如 SecondaryBot 看图反推 Bot）**：仅需第 3 层，第 1 层和第 2 层为完全多余的 Token 负担与干扰。

---

## 2. SDK 原生提示词模式 (`SystemMessageConfig`)

Copilot SDK 原生提供了三种系统提示词注入模式：

| 模式 (`mode`) | 说明 | 适用场景 |
| :--- | :--- | :--- |
| **`"append"`** *(默认)* | 保留 SDK 基础底模，在所有系统规则末尾追加用户内容。 | 最基础的常规扩展。 |
| **`"customize"`** | 保持 SDK 基础框架，但允许对具体的 Section 执行针对性增删改（如删除 `identity` 或重写 `safety`）。 | 主力开发 Bot（如 `Headless`），既保留代码能力又精简安全规则。 |
| **`"replace"`** | **彻底清空** SDK 所有内置提示词，100% 完全由调用方提供系统指令，0 冗余 CLI 提示词。 | 垂直专用 Bot（如 `SecondaryBot` 提示词反推、翻译 Bot 等）。 |

---

## 3. SDK 内置 11 个 Sections 清单

在 `"customize"` 模式下，SDK 将系统提示词拆分为 11 个独立的命名区块（`SystemMessageSection`）：

| Section 名称 | 核心内容与作用 | 典型裁剪建议 |
| :--- | :--- | :--- |
| **`identity`** | 身份设定（`You are the GitHub Copilot CLI, a terminal assistant built by GitHub...`） | 垂直专用角色建议 `remove` |
| **`preamble`** | 基础序言与全局引导 | 极简模式建议 `remove` |
| **`code_change_rules`** | 代码修改与 Diff 格式规范（apply_patch 规则等） | 纯问答/反推场景建议 `remove` |
| **`tool_efficiency`** | 命令行执行效率与批处理原则 | 不调命令行工具的 Bot 建议 `remove` |
| **`guidelines`** | 终端操作与输出风格指引 | 纯问答/反推场景建议 `remove` |
| **`safety`** | 危险命令防护（rm -rf 等破坏性操作限制） | 默认较冗长，Bridge 已用 `HEADLESS_SAFETY_SLIM` 进行 `replace` |
| **`tool_instructions`** | 内置工具的调用指令 | 默认保留（若无工具可精简） |
| **`environment_context`** | 运行时环境信息（系统、Shell 等） | 默认保留 |
| **`custom_instructions`** | 用户自定义附加指令 | 挂载用户 Prompt |
| **`runtime_instructions`** | 运行时内部控制指令 | 默认保留 |
| **`last_instructions`** | 末尾强制约束 | 默认保留 |

### Section 覆盖动作 (`SectionOverrideAction`)
* **`"remove"`**：彻底剔除该区块，不注入对应的 token。
* **`"replace"`**：使用自定义文本完全替换该区块。
* **`"append"`** / **`"prepend"`**：在该区块原内容前后追加内容。
* **`"preserve"`**：保留原样（常用于从全局组移除中豁免）。

---

## 4. Bridge 层的控制与生效链路

Bridge 在 `lib/bot-profile.mjs` 与 `lib/byok-providers.mjs` 中对提示词注入提供了多层自动化与配置化控制：

### 4.1 `config/bots.json` 配置字段

```json
{
  "SecondaryBot": {
    "token": "...",
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

* **`agentsMd`**：指定该 Bot 专属的提示词文件路径（相对 bridge 根目录或绝对路径）。
* **`systemMessageMode`**：`"replace"` \| `"customize"` \| `"append"`。
  * `profile === "prompt-reverse"` 时默认自动推导为 `"replace"`。
  * 其他角色默认 `"customize"`。
* **`loadSkills`**：`true` \| `false`。
  * `profile === "prompt-reverse"` 或 `permissionMode === "deny-all"` 时默认自动推导为 `false`。
  * 其他常规角色默认 `true`（加载 `~/.agents/skills` 下所有技能）。
* **`loadMcp`**：`true` \| `false`。控制是否注入 `mcp-config.json` 中的 MCP 服务器。

---

## 5. 典型配置范例

### 范例 1：全能编码助手（Headless 主 Bot）
需要完整的编程规则、技能库与工具支持：

* `systemMessageMode`: `"customize"`（自动应用精简版 `safety`）
* `loadSkills`: `true`（注入 33 个技能元数据）
* `loadMcp`: `true`（加载 Tavily、Notion 等工具）
* `agentsMd`: 读全局 `AGENTS.md`

### 范例 2：纯净垂直/视觉反推 Bot（SecondaryBot）
只需要专注看图反推生图提示词，追求极速与零干扰：

* `systemMessageMode`: `"replace"`（100% 仅注入 `prompt-reverse.md`）
* `loadSkills`: `false`（0 技能注入）
* `loadMcp`: `false`（0 MCP 注入）
* `permissionMode`: `"deny-all"`（物理级锁定任何工具调用）

---

## 6. 排障与日志审计

在 LaunchAgent 运行日志中可直接核对每个 Bot 的提示词与技能加载状态：

```text
# SecondaryBot 极简模式实测日志：
telegram-bridge: headless skills skipped (loadSkills=false)
telegram-bridge: systemMessage mode=replace (len=2283c)
telegram-bridge: [SecondaryBot] skills_loaded count=0

# Headless 完整模式实测日志：
telegram-bridge: headless skills enableSkills=true dir=~/.agents/skills
telegram-bridge: [Headless] loaded AGENTS.md instructions (3240 chars, global)
telegram-bridge: [Headless] skills_loaded count=33 sample=codex,ams-investing,...
```
