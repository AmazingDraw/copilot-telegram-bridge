# Copilot 自定义模型上下文窗口配置

> 适用范围：GitHub Copilot **桌面 App** 自定义 Provider，以及 **Telegram Headless Bridge** 无头 BYOK。  
> 更新：2026-07-16

---

## 0. 一句话结论

| 路径 | 配置真源 | 本次改 `data.db` 是否生效 |
| :--- | :--- | :--- |
| **桌面 App 会话**（模型选择器里的 cliproxy / opencode go） | `~/.copilot/data.db` → `provider_models` | ✅ **生效** |
| **Editor Telegram bot**（join 桌面会话） | 跟随**当前桌面会话**模型列表 | ✅ **间接生效**（同桌面） |
| **Headless Telegram bot**（独立 create/resume） | `telegram-bridge/config/models.json` + `lib/byok-providers.mjs` | ❌ **不读 data.db**，要单独改 |

**官方 GitHub 模型**（非自定义）不能手填 128K→任意值，只能走产品侧的 `contextTier: default | long_context`。

---

## 1. 背景：为什么自定义模型常显示 128K

1. 自定义 / BYOK 模型 id 若不在 Copilot 内置能力表里，运行时会给**默认窗口**（常见 **128000**）。  
2. 自动压缩（compaction）大约在上下文 **~80%** 触发。  
3. UI 右上角显示的是会话的 `max_context_window_tokens` / 输入上限，**不等于**上游模型营销页的裸数字；系统 prompt、tools、MCP 还会先占一截。  
4. **桌面**与**无头**是两套配置面，互不自动同步。

---

## 2. 桌面 App：自定义模型（`data.db`）

### 2.1 路径与表

| 项 | 值 |
| :--- | :--- |
| 库 | `~/.copilot/data.db` |
| Provider 表 | `model_providers` |
| 模型表 | `provider_models` |

当前本机相关表字段（节选）：

```text
model_providers(
  id, name, base_url, wire_api, type, auth_kind, headers_json, settings_json, ...
)

provider_models(
  id, provider_id, model_id, wire_model, display_name,
  max_prompt_tokens,   -- 关键：控制会话上下文上限（UI 右上角）
  max_output_tokens,   -- 最大输出
  wire_api_override, ...
)
```

> 历史文档里可能写过 `byok_providers` / `byok_models`；**当前 App 版本实际表名是 `model_providers` / `provider_models`。**

### 2.2 当前本机 Provider

| name | id（示例） | base_url | 用途 |
| :--- | :--- | :--- | :--- |
| `cliproxy` | `60728917-…` | `http://127.0.0.1:8317/v1` | Grok / DeepSeek 等经 cli-proxy |
| `opencode go` | `a3e6682a-…` | `https://opencode.ai/zen/go/v1` | MiMo 等 |
| `opencode zen` | `29d9fad5-…` | `https://opencode.ai/zen/v1` | 备用 |

会话选择模型 id 形态：`{provider_id}/{model_id}`，例如：

```text
60728917-5872-4378-bf67-ceab27ee1753/grok-4.5
a3e6682a-c75a-4bf3-82ae-793bdaa9da73/mimo-v2.5
```

### 2.3 官方规格 → 建议写入值（2026-07）

| model_id | 官方 context | `max_prompt_tokens` | `max_output_tokens`（建议） |
| :--- | ---: | ---: | ---: |
| `grok-4.5` | **500K**（xAI docs） | `500000` | `32000` |
| `gemini-3.5-flash-low` | **1M**（Gemini 3.5 Flash） | `1000000` | `65536` |
| `deepseek-v4-flash` | **1M** | `1000000` | `32000` |
| `deepseek-v4-flash-low/high/max` | **1M** | `1000000` | `32000` |
| `deepseek-v4-pro` | **1M** | `1000000` | `32000` |
| `deepseek-v4-pro-low/high/max` | **1M** | `1000000` | `32000` |
| `mimo-v2.5` | **1M** | `1000000` | `32000` |
| `mimo-v2.5-pro` | **1M** | `1000000` | `32000` |

> DeepSeek `*-low/high/max` 必须经 **cliproxy**（`payload.override` 注入 `reasoning.effort`）。桌面直连 `api.deepseek.com` 的 provider **无法**按模型 id 改思考强度。

说明：

- 桌面表**没有**单独的 `max_context_window` 列；实测 UI 上限跟 **`max_prompt_tokens`** 对齐。  
- `max_output_tokens` 只限制输出，不影响“500K/1M”总窗口展示。  
- 填得比上游真实能力大 → 可能在代理/API 侧截断或报错。

### 2.4 修改方法

**A. App UI（推荐，若有入口）**  
Settings → Models / Providers → 点开对应模型 → 填 Max prompt / Max output。

**B. SQLite（等价，已验证有效）**

```bash
# 查看
sqlite3 ~/.copilot/data.db \
  "SELECT model_id, max_prompt_tokens, max_output_tokens FROM provider_models ORDER BY model_id;"

# 单模型
sqlite3 ~/.copilot/data.db <<'SQL'
UPDATE provider_models
SET max_prompt_tokens = 500000,
    max_output_tokens = 32000,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_id = 'grok-4.5';
SQL

# 批量 1M（DeepSeek / MiMo）
sqlite3 ~/.copilot/data.db <<'SQL'
UPDATE provider_models
SET max_prompt_tokens = 1000000,
    max_output_tokens = 32000,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_id IN (
  'deepseek-v4-flash','deepseek-v4-pro','mimo-v2.5','mimo-v2.5-pro'
);
SQL
```

**生效条件**

1. **新开 session**（旧会话的 `context_input_token_limit` 已缓存，不会自动变）。  
2. 必要时完全退出并重启 GitHub Copilot App。  
3. 模型选择器选的是该自定义模型（不是官方同名模型）。

### 2.5 校验

```bash
# 模型表
sqlite3 ~/.copilot/data.db \
  "SELECT model_id, max_prompt_tokens, max_output_tokens FROM provider_models;"

# 最近会话实际上限（应看到 500000 / 1000000）
sqlite3 ~/.copilot/data.db \
  "SELECT id, model, context_input_token_limit, context_current_tokens
   FROM sessions ORDER BY updated_at DESC LIMIT 10;"
```

App Context 面板右上角应显示 **500K / 1M**，而不是 128K。

---

## 3. Telegram Bridge：两条线

### 3.1 Editor bot（`Copilot`）

- 行为：`joinSession` 接到**已打开的桌面会话**。  
- 模型列表 = 该桌面会话自带模型（官方 + 桌面已配 BYOK）。  
- **不**使用 `config/models.json` 的十模型装配。
- 因此：改 `data.db` 后，桌面会话用上大窗口 → Editor bot 跟同一会话也用大窗口。

### 3.2 Headless bot（`Headless`）

- 行为：独立 `createSession` / `resumeSession`，**不依赖**桌面是否打开。  
- 真源：  
  - `~/.copilot/extensions/telegram-bridge/config/models.json`  
  - 装配逻辑：`lib/byok-providers.mjs` → `buildHeadlessSessionConfig()`  
- **不读取** `~/.copilot/data.db` 的 `provider_models`。  
- 改完 json 后必须：

```bash
bash ~/.copilot/extensions/telegram-bridge/scripts/headless-daemon.sh restart
```

（或 env `HEADLESS_MODELS_CONFIG` 指向另一份配置文件后重启。）

### 3.3 无头 models.json 结构

路径：`~/.copilot/extensions/telegram-bridge/config/models.json`

```json
{
  "defaultModel": "deepseek-v4-flash",
  "display": {
    "officialModels": { "enabled": true, "allowIds": [] },
    "nameDedup": "suffix-provider",
    "unknownBareId": "hide"
  },
  "preferredOrder": [
    "deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2.5", "mimo-v2.5-pro",
    "gemini-3.6-flash-high", "claude-sonnet-4-6",
    "cursor-grok-4.5-high", "cursor-grok-4.5-medium", "cursor-grok-4.5-low",
    "composer-2.5"
  ],
  "officialFallback": "mai-code-1-flash",
  "paths": {
    "cliproxyConfig": "${HOME}/.cli-proxy-api/config.yaml",
    "agentsMd": "../agent-memory/AGENTS.md",
    "sessionState": "${HOME}/.copilot/session-state",
    "mcpConfig": "${HOME}/.copilot/mcp-config.json"
  },
  "providers": [
    {
      "id": "opencodex",
      "enabled": true,
      "baseUrl": "http://127.0.0.1:10100/v1",
      "apiKeyFromFile": "${HOME}/.opencodex/admin-api-token",
      "models": [
        { "id": "deepseek-v4-flash", "maxPromptTokens": 1000000, "maxContextWindowTokens": 1000000, "maxOutputTokens": 32000 }
      ]
    }
  ]
}
```

> 当前启用 provider：**opencodex（10100）**，10 个第三方模型全走它。opencode / cliproxy / deepseek 直连均为 `enabled: false` 回滚组。
> `display.officialModels.allowIds` 为空 → `/model` 不显示官方模型（精确 ID 白名单）。

兼容：

- 旧写法 `"models": ["grok-4.5"]` 仍可用，但**不声明窗口时 SDK 常回落 128K**。  
- 推荐新写法：对象带 `maxPromptTokens` / `maxContextWindowTokens` / `maxOutputTokens`。

装配时写入 SDK `ProviderModelConfig` 字段：

| json 字段 | SDK 字段 | 作用 |
| :--- | :--- | :--- |
| `maxPromptTokens` | `maxPromptTokens` | 触发 compaction 的 prompt 预算 |
| `maxContextWindowTokens` | `maxContextWindowTokens` | 总上下文窗口 |
| `maxOutputTokens` | `maxOutputTokens` | 最大输出 |

密钥仍不进 json：走 shell env / `~/.cli-proxy-api/config.yaml`。

### 3.4 无头默认模型路由（本机）

| 会话 id 形态 | 上游 | 模型 |
| :--- | :--- | :--- |
| `opencodex/deepseek-v4-flash` 等 | OpenCodex `127.0.0.1:10100` | DeepSeek / MiMo / Gemini / Claude / Cursor-Grok / Composer（共 10 个） |
| `opencodex/cursor-grok-4.5-*` | OpenCodex `127.0.0.1:10100` | Cursor Grok 4.5 High/Medium/Low |
| 默认 | `defaultModel` | 现为 `deepseek-v4-flash` |

---


### 3.4 per-bot 模型锁（bots.json）

全局默认仍看 `models.json` 的 `defaultModel` / 白名单。

个别无头 bot 可在 `config/bots.json` 覆盖：

```json
"defaultModel": "deepseek-v4-flash",
"allowedModels": ["deepseek-v4-flash"]
```

- 只影响该 bot 的 `buildHeadlessSessionConfig` 过滤与默认选择  
- 不改变其他 bot 的 `/model` 列表装配  
- 例：PromptReverse 仅 `opencodex/cursor-grok-4.5-low`；Headless 仍十模型

改后 `headless-daemon.sh restart`。

## 4. 两套配置对照（必看）

```text
┌─────────────────────┐     ┌──────────────────────────────┐
│  GitHub Copilot App │     │  Telegram Headless Daemon    │
│  UI 模型选择器       │     │  createSession BYOK          │
└─────────┬───────────┘     └──────────────┬───────────────┘
          │                                │
          ▼                                ▼
 ~/.copilot/data.db                 config/models.json
 model_providers /                  + byok-providers.mjs
 provider_models
 max_prompt_tokens                  maxPromptTokens /
                                    maxContextWindowTokens
          │                                │
          └────────────┬───────────────────┘
                       ▼
              上游 API（OpenCode / cliproxy:8317 / xAI…）
```

| 你想改谁 | 改哪里 | 重启什么 |
| :--- | :--- | :--- |
| 桌面 App 上下文 UI | `data.db` / App Providers UI | 新 session；必要时重启 App |
| Headless 无头上下文 | `config/models.json` | `headless-daemon.sh restart` |
| Editor 跟桌面的 bot | 同桌面会话 | 桌面侧生效即可 |
| cli-proxy 路由 / key | `~/.cli-proxy-api/config.yaml` | 重启 cliproxy 服务 |

---

## 5. 自动压缩与 Buffer（两端共通）

- 约 **80%** 上下文占用 → 后台 compaction。  
- Context 面板常见分段：System prompt / System tools / MCP tools / Messages / Free / Buffer。  
- 窗口从 128K 提到 500K/1M 后，tools+MCP 仍占固定大头；**真正对话历史占比仍可能很小**。  
- 减 MCP、新开任务会话，比盲目拉大窗口更有效时也不少见。

官方模型 long context：

- `contextTier`: `default` | `long_context`  
- 部分 Claude 等支持 1M 档，需在模型选择里显式选 long context；**不是**改 `data.db` 自定义表。

---

## 6. 排障清单

| 现象 | 排查 |
| :--- | :--- |
| 桌面仍显示 128K | 是否**新开 session**？`provider_models.max_prompt_tokens` 是否非 NULL？选的是否自定义 `provider_id/model`？ |
| 无头仍像 128K | `models.json` 是否带 token 字段？是否 **restart headless**？日志是否出现 `headless BYOK config ...`？ |
| 改了 data.db 无头不变 | **正常**——无头不读该库。 |
| 改了 models.json 桌面不变 | **正常**——桌面读 data.db。 |
| 上游 400 / 截断 | 本地上限 > 上游真实能力；回调小或查代理限流。 |
| App 升级丢配置 | 查 `data.db` 是否被重置；重新 UPDATE / 从备份恢复。 |

日志：

```bash
# 无头
tail -80 ~/.copilot/extensions/telegram-bridge/bots/Headless/daemon.log

# cliproxy 是否活着
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8317/v1/models
```

---

## 7. 相关路径速查

| 用途 | 路径 |
| :--- | :--- |
| 桌面配置库 | `~/.copilot/data.db` |
| 无头模型清单 | `~/.copilot/extensions/telegram-bridge/config/models.json` |
| 无头 BYOK 代码 | `~/.copilot/extensions/telegram-bridge/lib/byok-providers.mjs` |
| 无头守护脚本 | `~/.copilot/extensions/telegram-bridge/scripts/headless-daemon.sh` |
| cliproxy 配置 | `~/.cli-proxy-api/config.yaml` |
| 本文 | `~/.copilot/extensions/telegram-bridge/doc/custom-models-context.md` |
| 无头架构 | `doc/headless-daemon.md` |
| Bridge 总览 | `doc/README.md` |

---

## 8. 变更记录

| 日期 | 内容 |
| :--- | :--- |
| 2026-07-16 | 桌面 `provider_models`：grok 500K；DeepSeek/MiMo 1M。无头 `models.json` 改为对象写法并传入 SDK token 字段；`byok-providers.mjs` 支持解析。本文档初版。 |
| 2026-07-18 | 桌面+无头补齐 `gemini-3.5-flash-low`（1M / 65K output）。 |
| 2026-08-01 | DeepSeek 思考强度：cliproxy 别名 `deepseek-v4-{flash,pro}-{low,high,max}` + `payload.override` 注入；桌面挂到 cliproxy provider；无头 `/thinking` 切模型后缀。 |
| 2026-08-11 | 模型规则 JSON 化：`/model` 显示抽到 `models.json` 的 `display` 块（精确官方白名单 / nameDedup / unknownBareId）；主路径按 provider/model `enabled` 过滤；去掉隐藏 grok 与 Sonnet 5 硬编码。默认 provider 改为 **opencodex(10100)**，10 个模型；`officialFallback` 改为免费 **mai-code-1-flash**；未配置模型上下文兜底 **200K**（`/fixctx` 硬编码表独立维护）。 |
