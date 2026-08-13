# 模型管理手册（无头 BYOK）

> 目标读者：任何 AI / 人 —— 看完就能**一次改对**模型，不出错。
> 改完唯一必做：`bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh restart`

---

## 0. 30 秒速查

| 想干什么 | 改哪里 | 怎么改 |
| :--- | :--- | :--- |
| **关掉某个模型** | `config/models.json` → 对应 provider → `models[]` → 该模型条目 | `"enabled": true` 改成 `"enabled": false` |
| **加回被关的模型** | 同上 | `"enabled": false` → `"enabled": true` |
| **整组切换上游** | provider 级 `enabled` | 把想用的 provider `enabled: true`，其他 `enabled: false` |
| **改默认模型** | 顶层 `defaultModel` | 填模型 id（不带 provider 前缀） |
| **改上下文窗口** | 模型条目里 | 改 `maxPromptTokens` / `maxContextWindowTokens` / `maxOutputTokens` |
| **加一个新模型** | 对应 provider 的 `models[]` | 追加 `{ "id": "...", "enabled": true, ... }` 对象 |
| **删一个模型** | 对应 provider 的 `models[]` | 直接删整个对象条目 |

**每改一次都要重启**：

```bash
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh restart
```

---

## 1. 核心概念（先看这个，少走弯路）

### 1.1 三层结构

`config/models.json` 里就三层东西：

```
models.json
├── 顶层字段（defaultModel / preferredOrder / officialFallback / paths）
└── providers[]                    ← 上游提供方（哪些 baseUrl + 哪些 apiKey）
    └── models[]                   ← 这个上游下挂着哪些模型
```

- **Provider** = 一个上游服务（OpenCodex / OpenCode / cliproxy / DeepSeek 官方）。
- **Model** = 单个模型条目，必须挂在某个 provider 下。
- **同一个模型 id 可以出现在多个 provider 下**，互不影响；但同一时刻**只应有一个 provider 启用**，否则会让同一个 id 出现两份。

### 1.2 开关的两层粒度

| 粒度 | 字段位置 | 效果 |
| :--- | :--- | :--- |
| **Provider 级** | `providers[].enabled` | 整组上下线，一键回滚用 |
| **Model 级** | `providers[].models[].enabled` | 单个模型上下线 |

**缺省规则**：`enabled` 不写 = `true`。显式 `false` 才关闭。

### 1.3 生效时机

- `models.json` 是**启动时读一次**（缓存在 `_cache`）。
- 改完必须 `headless-daemon.sh restart`，否则不生效。
- join bot（桌面 Copilot）**完全不读**这个文件，随便改不会影响桌面。

---

## 2. 当前 providers 速查

文件：`~/.copilot/extensions/copilot-telegram-bridge/config/models.json`

| Provider id | baseUrl | 默认 enabled | 用途 | 模型数量 |
| :--- | :--- | :--- | :--- | :--- |
| `opencodex` | `http://127.0.0.1:10100/v1` | ✅ `true` | **当前默认第三方上游** | 10 |
| `opencode` | `https://opencode.ai/zen/go/v1` | ❌ `false` | 回滚用（原 mimo+DeepSeek） | 4 |
| `cliproxy` | `http://127.0.0.1:8317/v1` | ❌ `false` | 回滚用（原 gemini/claude/cursor-grok/composer） | 6 |
| `deepseek` | `https://api.deepseek.com/v1` | ❌ `false` | 紧急回退 DeepSeek 官方 API | 2 |

**红线**：同一时刻只应有 **一个** 第三方 provider `enabled: true`，否则会话模型 id 冲突。

---

## 3. 常见操作（Step-by-step）

### 3.1 关掉一个模型（最常用）

例：关掉 `cursor-grok-4.5-low`。

**Step 1**：用编辑器打开

```bash
code ~/.copilot/extensions/copilot-telegram-bridge/config/models.json
# 或 vim ~/.copilot/extensions/copilot-telegram-bridge/config/models.json
```

**Step 2**：定位到该模型。它在 `providers[0]`（id=`opencodex`）的 `models[]` 里：

```json
{
  "id": "cursor-grok-4.5-low",
  "enabled": true,
  "maxPromptTokens": 256000,
  ...
}
```

**Step 3**：把 `"enabled": true` 改成 `"enabled": false`：

```json
{
  "id": "cursor-grok-4.5-low",
  "enabled": false,
  ...
}
```

**Step 4**：重启

```bash
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh restart
```

**Step 5**：验证

```bash
tail -20 ~/.copilot/extensions/copilot-telegram-bridge/bots/Headless/daemon.log | grep cursor-grok
# 应该看不到 opencodex/cursor-grok-4.5-low
```

或在 Telegram 里 `/model` 看按钮列表，应该没有 `cursor-grok-4.5-low`。

---

### 3.2 整组切换上游（一键回滚）

场景：OpenCodex 挂了，想回到原 cliproxy 8317。

**Step 1**：编辑 `models.json`，把两段 `enabled` 互换：

```json
{ "id": "opencodex", "enabled": false, ... }   ← 原来是 true
...
{ "id": "cliproxy",  "enabled": true,  ... }   ← 原来是 false
```

**Step 2**：重启 daemon。

**Step 3**：日志应看到 `providers=cliproxy`，且模型 id 变成 `cliproxy/<id>`。

---

### 3.3 改默认模型

顶层：

```json
"defaultModel": "deepseek-v4-flash",
```

改成你想要的模型 id（**不带 `opencodex/` 前缀**），例：

```json
"defaultModel": "mimo-v2.5",
```

重启。日志里应看到 `model=opencodex/mimo-v2.5`。

**优先级**：`bots.json` 里 per-bot 的 `defaultModel` > 顶层 `defaultModel` > `preferredOrder` 第一个可用 > `officialFallback`。

---

### 3.4 调整上下文窗口

模型条目里这三个字段（可选）：

```json
{
  "id": "deepseek-v4-flash",
  "enabled": true,
  "maxPromptTokens": 1000000,
  "maxContextWindowTokens": 1000000,
  "maxOutputTokens": 32000
}
```

- `maxPromptTokens`：单次 prompt 最多 token
- `maxContextWindowTokens`：上下文窗口总容量（不写则 = `maxPromptTokens`）
- `maxOutputTokens`：单次回答最多 token

**单位是 token，不是字符**。1 万汉字 ≈ 1.5 万 token。

改完重启。

**未配置模型的默认窗口**：模型若**不在 `models.json` 的 providers 里配置**（或该条目没写上下文窗口），`/status` 显示的上下文默认 **200K**。

- 已配置模型（写了 `maxContextWindowTokens` / `maxPromptTokens`）→ 用配置值。
- 未配置模型 → `/status` 显示默认 200K。
- **实际修复上下文**走 **`/fixctx`**：同时更新 Copilot 桌面 `data.db`、OpenCodex `modelContextWindows`，并重启 OpenCodex 同步 catalog。

> **⚠️ `/fixctx` 硬编码表同步（唯一例外）**
> 新增一个模型并想用 `/fixctx` 修复桌面与 OpenCodex 上下文时，除了改 `models.json`，**还要**在
> `scripts/fix-model-tokens.sh` 的 `MODELS=()` 表里加一行
> `"<model_id>|<Copilot prompt>|<Copilot output>|<OpenCodex context>|<显示名>"`。
> Copilot 与 OpenCodex 可写不同窗口值（如十进制 1M 与 1048576）；该表不读 `models.json`，必须同步维护。
> 其余场景（改默认 / 排序 / 禁用 / 官方开关 / 换上游）**只改 models.json 即可**。

---

### 3.5 加一个新模型

例：OpenCodex 上线了 `kimi-k3-high`，想接入。

**Step 1**：先确认 OpenCodex 真有这个模型：

```bash
TOKEN=$(cat ~/.opencodex/admin-api-token)
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:10100/v1/models \
  | python3 -c "import json,sys; print('\n'.join(m['id'] for m in json.load(sys.stdin)['data']))"
```

**Step 2**：在 `opencodex` provider 的 `models[]` 末尾追加：

```json
{
  "id": "kimi-k3-high",
  "enabled": true,
  "maxPromptTokens": 262144,
  "maxContextWindowTokens": 262144,
  "maxOutputTokens": 32000
}
```

**Step 3**（可选）：加入 `preferredOrder` 让它能进 `/model` 列表前几位：

```json
"preferredOrder": [
  "deepseek-v4-flash",
  "kimi-k3-high",   ← 加这里
  ...
]
```

**Step 4**：重启 + 验证。

---

### 3.6 彻底删除一个模型

**不推荐**（用 `enabled: false` 更安全）。但如要彻底删：

**Step 1**：删 provider `models[]` 里对应该模型的整个 `{ ... }` 对象。

**Step 2**：检查顶层 `defaultModel` / `preferredOrder` / `officialFallback` 是否引用了这个 id，如果有，一并删除或替换。

**Step 3**：检查 `config/bots.json` 里每个 bot 的 `defaultModel` / `allowedModels` 是否引用，一并清理。

**Step 4**：重启。

---

## 4. 字段含义全表

### 4.1 顶层

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `defaultModel` | string | 默认模型 id（不带 provider 前缀） |
| `preferredOrder` | string[] | `/model` 列表排序；不存在于任何已启用 provider 的 id（幽灵 id）会被忽略并告警 |
| `officialFallback` | string | 第三方全挂时回退的官方模型（来自 Copilot 目录） |
| `paths.cliproxyConfig` | path | cliproxy yaml 路径（取 port/apiKey），可用 `${HOME}` |
| `paths.agentsMd` | path | AGENTS.md 路径（默认 `../agent-memory/AGENTS.md`） |
| `paths.sessionState` | path | 会话磁盘根目录 |
| `paths.mcpConfig` | path | 用户 MCP 配置 |

### 4.2 Provider 级

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | string | ✅ | 唯一标识（会话模型 id 前缀，如 `opencodex/foo`） |
| `enabled` | bool | ❌ | 缺省 `true`；`false` 整组关闭 |
| `type` | string | ❌ | 缺省 `"openai"` |
| `baseUrl` | string | ✅ | 完整 URL，含 `/v1` |
| `baseUrlEnv` | string[] | ❌ | 优先级高于 `baseUrl` 的环境变量名列表 |
| `apiKeyEnv` | string[] | ❌ | 读环境变量作为 apiKey（按顺序找第一个非空） |
| `apiKeyFromFile` | path | ❌ | 读文件内容作为 apiKey（可用 `${HOME}`）；`apiKeyEnv` 都没值时才用 |
| `apiKeyFromCliproxyYaml` | bool | ❌ | 从 `paths.cliproxyConfig` 读 apiKey |
| `portFromCliproxyYaml` | bool | ❌ | 从 `paths.cliproxyConfig` 读 port |
| `models` | object[] | ✅ | 模型条目数组 |

**apiKey 解析优先级**（高 → 低）：

```
apiKeyEnv（环境变量）→ apiKeyFromFile（文件）→ apiKeyFromCliproxyYaml（yaml）
```

### 4.3 Model 级

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | string | ✅ | 模型 id（与上游 API 接受的 id 一致） |
| `enabled` | bool | ❌ | 缺省 `true`；`false` 单独下线 |
| `maxPromptTokens` | int | ❌ | 单次 prompt 上限 |
| `maxContextWindowTokens` | int | ❌ | 上下文窗口；不写 = `maxPromptTokens` |
| `maxOutputTokens` | int | ❌ | 单次回答上限 |

---

## 5. 修改后的标准验证流程

**每次改完都跑一遍，养成习惯：**

```bash
# 1. JSON 语法
python3 -m json.tool ~/.copilot/extensions/copilot-telegram-bridge/config/models.json > /dev/null && echo "JSON OK"

# 2. 重启
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh restart

# 3. 等 5 秒看日志
sleep 5
tail -30 ~/.copilot/extensions/copilot-telegram-bridge/bots/Headless/daemon.log | grep -E "BYOK|providers=|/models ok"
```

**期望看到**：

```
telegram-bridge: opencodex /models ok count=31
telegram-bridge: headless BYOK config ... model=opencodex/<default> providers=opencodex models=opencodex/<id1>,opencodex/<id2>,...
```

**红线警告（看到 = 出错）**：

| 警告 | 含义 | 处理 |
| :--- | :--- | :--- |
| `models.json parse failed` | JSON 语法错 | 用 `python3 -m json.tool` 找错行 |
| `provider <id> missing baseUrl` | 该 provider 没配 baseUrl | 检查 `baseUrl` 字段 |
| `provider <id> missing api key` | 没拿到 apiKey | 检查 `apiKeyEnv` / `apiKeyFromFile` |
| `allowlist ∩ /models empty` | allowlist 与上游 /models 不匹配 | 检查模型 id 是否拼对 |

---

## 6. 排障速查

| 症状 | 排查 |
| :--- | :--- |
| 改了不生效 | 忘 restart daemon |
| `/model` 列表里找不到某模型 | ① `enabled` 是不是 `false`？② 该模型所在 provider `enabled` 是不是 `false`？③ id 是否拼写一致？ |
| Telegram 报错 "model not found" | 该模型在上游 `/v1/models` 里不存在；用 §3.5 的 curl 命令验证 |
| 两个 provider 都启用导致冲突 | 保证**同一时刻只启用一个**第三方 provider |
| 上下文突然变 128K | 模型条目缺 `maxContextWindowTokens`；参考 [`custom-models-context.md`](./custom-models-context.md) |
| OpenCodex 401 | `~/.opencodex/admin-api-token` 文件被清 / OpenCodex 未启动；`ocx status` |

### Copilot 会员到期 / `model.list()` 403

- **现象**：`/model` 列表只剩本地 BYOK 模型；日志反复出现 `session.model.list failed ... 403 "unauthorized: not authorized to use this Copilot feature"`。
- **根因**：**GitHub Copilot 订阅/会员到期**（或 `GITHUB_TOKEN` 失效）。`model.list()` 是 Copilot CLI 的 RPC，依赖 Copilot 授权；授权没了就 403。
- **影响**：**只影响官方模型**（gpt-5.6-luna、裸 grok-4.5 等 CAPI 模型）。**本地 BYOK 模型完全不受影响**——它们走 `opencodex(10100)` → `cliproxy(8317)`，用自己的 key，与会话授权无关。
- **处理**：`getDisplayModels()` 在 `model.list()` 抛错时**不再 fallback 官方模型**，改为直接展示本地 BYOK 模型（从 `preferredOrder` + 已启用 provider 过滤）。无需任何操作，本地模型照常可用。
- **恢复官方模型**：重新开通 Copilot 会员 / 修复 `GITHUB_TOKEN` 后重启 daemon 即可，`model.list()` 恢复返回官方模型。

---

## 7. 决策树（"我该改哪里？"）

```
想改模型行为?
├── 关掉/打开单个模型
│   → providers[].models[].enabled
├── 换掉整个第三方上游
│   → providers[].enabled（同一时刻只启用一个）
├── 改默认模型
│   ├── 全局 → 顶层 defaultModel
│   └── 单个 bot → config/bots.json 的 defaultModel / allowedModels
├── 加上下文窗口
│   → providers[].models[].maxContextWindowTokens
├── 加新模型
│   → providers[].models[] 追加对象
│   + 若需 /fixctx 修桌面/OpenCodex 上下文 → 同步 scripts/fix-model-tokens.sh 的 MODELS=() 表
└── 删模型
    → providers[].models[] 删条目 + 清理顶层引用 + 清理 bots.json 引用 + 清理 fix-model-tokens.sh 表
```

---

## 8. 相关文档

- [`headless-daemon.md`](./headless-daemon.md) §6 — 无头 BYOK 数据面详解
- [`custom-models-context.md`](./custom-models-context.md) — 上下文窗口机制（桌面 data.db vs 无头 models.json）
- [`editor-bot.md`](./editor-bot.md) — join bot（不读本文件，别混）
- [`prompt-reverse-bot.md`](./prompt-reverse-bot.md) — per-bot `defaultModel` / `allowedModels` 示例

---

## 9. 给 AI 的执行清单

如果主人让你改模型，按这个顺序做：

1. ☐ 先 `view config/models.json` 看清当前结构
2. ☐ 确认要改的模型属于哪个 provider（默认是 `opencodex`）
3. ☐ 用 `edit` 工具改对应字段（**不要用 `create` 覆盖整文件**，容易丢回滚组）
4. ☐ 跑 `python3 -m json.tool` 验证 JSON
5. ☐ `headless-daemon.sh restart`
6. ☐ 看日志 `tail -30 bots/Headless/daemon.log` 确认 `providers=` 和 `models=` 符合预期
7. ☐ 跑 `bash ~/.copilot/extensions/sync-copilot-extensions.sh "<中文说明>"` 同步
