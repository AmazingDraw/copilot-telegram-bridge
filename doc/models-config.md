# 模型管理手册（单一真源）

> Bridge 的模型 ID、窗口、排序、Headless 列表、回滚列表与单 Bot 模型组，唯一真源都是 `config/models.json`。
> 修改后运行校验并重启 Headless；不要再到代码或文档里复制模型清单。
> Headless / Claude 菜单直接读 catalog。

## 1. 文件结构

```text
config/models.json
├── catalog.<modelId>          模型唯一规格
├── modelSets.<name>           不同场景的有序模型成员
├── providers[].modelSet       provider 引用哪个模型组
├── officialFallback / display
└── paths / launchAgentLabel
```

核心规则：

- `catalog` 是模型元数据唯一存放处；token 数字不得复制到 provider。
- `modelSets.headless.models` 的顺序就是 Headless `/model` 顺序。
- `modelSets.<name>.defaultModel` 必须属于该组。
- `providers[]` 只保存 URL、密钥来源和 `modelSet` 引用。
- `bots.json` 推荐只保存 `modelSet` 名，不直接保存模型 ID。
- `skillSets.<name>` 是可选的 Headless skill 白名单。默认 `skillSet=all` 不过滤；`bots.json` 可写 `skillSet` 或 `skillNames` 收窄。

运行时谁读哪一段：

| 路径 | 运行时读取 | 如何更新 |
| :--- | :--- | :--- |
| Headless Telegram Bot | `catalog` → SDK `ProviderModelConfig` | 改 catalog 后重启 Headless daemon |
| Claude CLI（`/claude`） | `modelSets.claude-cli` + catalog id | 改 set / catalog 后重启 daemon |

无头会话不读 `~/.copilot/data.db`；窗口只走 catalog → SDK。

## 1.1 `auth`：GitHub 身份与官方模型（2026-09-13 新增）

```json
"auth": { "login": false }
```

| 取值 | 行为 |
| :--- | :--- |
| **`login: false`（当前）** | **不登录**（byok-only）：启动时清掉身份 env（`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_API_KEY`），并让 SDK 给 runtime 传 **`--no-auto-login`**（CLI 原话：*Disable automatic login detection (stored OAuth tokens and gh CLI)*）。runtime 以**无身份**运行，官方模型面自动视为关闭。 |
| `login: true` | 保留 GitHub 身份（官方模型可用）；此时官方模型面另由 `display.officialModels.enabled` 控制 |

**实测（2026-09-13 隔离 + 生产）**：无身份时 `start` / `createSession` / **BYOK 回合**全通，
只有官方模型面不可用（`listModels` → `Not authenticated`）—— 而它已被自动跳过。
⇒ **日常使用（cliproxy/BYOK）不依赖 GitHub 身份**；凭证留着更稳、删掉也能跑。

**排查 401 的先验知识**（身份来源与顺序）：
`COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → **`gh` CLI** → **keychain**；
且 `clientMode: "empty"` 会让 SDK 给 runtime 注入 **`COPILOT_DISABLE_KEYTAR=1`**（关掉 keychain）
⇒ 遇到 401 **优先查 env token**；CLI 只认 fine-grained PAT（需 `Copilot Requests`）/ OAuth，**不认经典 `ghp_`**。

**自证**：每次连接会打一行身份实况，改完必须看它 ——
```text
telegram-bridge: GitHub 登录已关闭（auth.login=false）→ 清除身份 env: COPILOT_API_KEY；runtime 将以无身份启动（SDK 传 --no-auto-login）
telegram-bridge: [Headless] auth: isAuthenticated=false (Not authenticated)
```

---

## 1.2 `telegram.proxy`：出站网络与代理配置（2026-09-19 新增）

```json
"telegram": {
  "$comment": "Telegram 出站网络与代理配置。proxy.url 支持 HTTP CONNECT 代理（默认优先 NAS 7212）；enabled=false 或连接失败时自动回退本机直连。",
  "proxy": {
    "enabled": true,
    "url": "http://127.0.0.1:7212",
    "retryCooldownMs": 30000
  }
}
```

| 字段 | 类型 | 默认值 | 作用说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `true` | 是否启用出站代理。设为 `false` 则全局使用本机原生 `fetch` 直连。 |
| `url` | `string` | `http://127.0.0.1:7212` | 代理服务器地址（支持 HTTP CONNECT 代理，优先推荐 本机出口）。环境变量 `TELEGRAM_PROXY_URL` 可覆盖。 |
| `retryCooldownMs` | `number` | `30000` | 代理异常熔断冷却时间（毫秒）。当代理不可达时，自动回退本机网络并在冷却期内避免重试卡顿；冷却结束后自动探测恢复。 |

**设计机理与自愈特性**：
- **脱离 Stash 依赖**：Node.js 原生 `fetch` 默认不吃系统环境变量代理。通过 `lib/telegram-fetch.mjs` 在请求层建立 HTTP CONNECT 隧道直连 NAS 出海代理，即使 Mac 本机关闭 Stash，Bot 亦能秒连 Telegram。
- **双向韧性回退**：若 本机拔除或代理端口断开，捕获异常后**立即自动回退本机网络**（不崩溃、不丢消息），并在 30s 冷却后自动无感重测 NAS 恢复状态。
- **生效方式**：修改 `config/models.json` 后执行 `bash scripts/headless-daemon.sh restart` 即可热生效。

---

## 2. Catalog 字段

```json
"catalog": {
  "<model-id>": {
    "label": "<display label>",
    "enabled": true,
    "maxPromptTokens": 1000000,
    "maxContextWindowTokens": 1000000,
    "maxOutputTokens": 32000
  }
}
```

| 字段 | 作用 |
| :--- | :--- |
| `label` | Telegram `/model` 显示名 |
| `enabled` | 显式 `false` 时从所有 provider 展开结果中排除 |
| `maxPromptTokens` | Headless SDK prompt 上限 |
| `maxContextWindowTokens` | Headless SDK 总窗口 |
| `maxOutputTokens` | Headless SDK 输出上限 |

自定义/BYOK 模型若没有向 Copilot SDK 声明窗口，SDK 常回落 **128K**。create/resume 无头会话时 Bridge 把 catalog 字段传给 `ProviderModelConfig`：

```text
catalog.<id>.maxPromptTokens        → SDK maxPromptTokens
catalog.<id>.maxContextWindowTokens → SDK maxContextWindowTokens
catalog.<id>.maxOutputTokens        → SDK maxOutputTokens
```

`/claude` 增删只改 `modelSets.claude-cli` 与 catalog，不另写窗口表。

## 3. Model Sets

```json
"modelSets": {
  "headless": {
    "defaultModel": "<model-id>",
    "models": ["<model-id>", "<another-model-id>"]
  },
  "single-purpose-bot": {
    "defaultModel": "<model-id>",
    "models": ["<model-id>"]
  }
}
```

- `headless`：主无头 Bot 列表与排序。
- `claude-cli`：`/claude` 模型菜单。
- `rollback-*`：各备用 provider 的模型子集。
- 其他命名组：供单 Bot `modelSet` 引用。

同一个模型可以属于多个组，但规格只在 `catalog` 写一次。

### 3.1 `provider`：把一组模型钉到指定上游（2026-09-16 新增）

```json
"single-purpose": {
  "provider": "cliproxy-nas",
  "defaultModel": "<model-id>",
  "models": ["<model-id>"]
}
```

用途：**同一个模型由多台上游提供、按 Bot 选边**。例：某台专用 Bot 的 `cursor-auto` 走 `cliproxy-nas`，其余 Bot 走 Mac `cliproxy`，模型名不变（会话 id 为 `<provider>/<model>`，菜单里仍显示 `cursor-auto`）。

- 语义：`provider` 有几个词就选哪台上游 ⇒ **切换＝改这一个词 + `headless-daemon.sh restart`**（`modelSets.<组>.provider` 与 `providers[].modelSet` 是两回事：前者选上游，后者定义该 upstream 服务哪些模型）。
- 只能填 `providers[].id`；写成别的名字、或指向 `enabled: false` 的 provider、或该 provider 不服务本组模型 ⇒ **加载即抛错**（`models.json invalid`），不会静默换边。
- 未声明 `provider` 的组：由全部非 `bindOnly` provider 装配（历史行为不变）。

## 4. Providers

```json
{
  "id": "<provider-id>",
  "enabled": true,
  "type": "openai",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyFromCliproxyYaml": true,
  "portFromCliproxyYaml": true,
  "modelSet": "headless"
}
```

provider 不再包含 `models[]` 对象。回滚时只切换 provider 的 `enabled`；同一时刻建议只启用一个第三方 provider。cliproxy 的 `baseUrl` 是 **值班指针**（Mac `127.0.0.1:8317` 或 `127.0.0.1:8317`），可随时切，以运行中的 json / `CLIPROXY_BASE_URL` 为准，不要把文档示例当成永久默认。见 cli-proxy-api skill `references/mac-vs-nas-urls.md`。

### 4.1 `bindOnly`：专属上游（2026-09-16 新增）

```json
{
  "id": "cliproxy-nas",
  "enabled": true,
  "bindOnly": true,
  "type": "openai",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyFromFile": "${HOME}/.cli-proxy-api/single-purpose.api-key",
  "modelSet": "single-purpose"
}
```

- `bindOnly: true` ⇒ **不参与未绑定 Bot 的全局模型面**，只被 `modelSets.<组>.provider` 指到它的 Bot 装配。
- 为什么需要它：模型选中逻辑是 `models.find(裸 id)`，**两台 provider 同时提供 `cursor-auto` 会按数组顺序生效**（隐式）。`bindOnly` + 绑定把"走哪台"变成显式配置。
- 契约：`check-model-config.mjs` 断言「全局装配不得出现同裸 id 双来源」与「`bindOnly` provider 必须被某组 `modelSet` 绑定」；`bindOnly` 被摘掉会立刻报错。
- **不要改 `cliproxy` 这个 id**：`/claude` 的上游是 `providers.find(p => p.id === "cliproxy").baseUrl`（硬编码）。

密钥解析优先级：

```text
apiKeyEnv → apiKeyFromFile → apiKeyFromCliproxyYaml
```

## 5. 常见修改

### 5.1 新增模型

1. 在 `catalog` 新增一个模型条目。
2. 把 ID 加入需要的 `modelSets`。
3. 运行：

```bash
node scripts/check-model-config.mjs --live
bash scripts/headless-daemon.sh restart
```

无需修改 `lib/byok-providers.mjs` 或文档模型列表。

### 5.2 禁用或删除模型

- 全局临时禁用：`catalog.<id>.enabled = false`。
- 只从某个场景移除：从对应 `modelSets.<name>.models` 删除 ID。
- 彻底删除：先从所有 model set 移除，再删除 `catalog.<id>`；校验器会阻止悬空引用。

### 5.3 修改默认模型或排序

- 默认模型：`modelSets.headless.defaultModel`。
- `/model` 排序：调整 `modelSets.headless.models` 顺序。
- 单 Bot：在 `bots.json` 写 `"modelSet": "<set-name>"`。

旧版 `defaultModel`、`preferredOrder`、`providers[].models[]`、Bot 的 `allowedModels` 仍可解析，供外部 `HEADLESS_MODELS_CONFIG` 平滑迁移；主配置只使用 schema v2。

### 5.4 修改上下文

- Headless：改 `catalog.<id>.max*Tokens`，重启 daemon。
- 旧会话通常缓存了窗口，需 `/new` 再开 session。

### 5.5 切换某个 Bot 的上游（Mac ↔ NAS，2026-09-16）

改 `modelSets.<该 Bot 的组>.provider` 一个词，然后重启 daemon（模型名不变）：

```bash
# 把 <组名> 那台上游切到 本机（默认）或 Mac 本机
python3 - <<'PY'
import json,pathlib; p=pathlib.Path("config/models.json"); d=json.loads(p.read_text())
d["modelSets"]["single-purpose"]["provider"]="cliproxy-nas"   # 或 "cliproxy"；single-purpose 换成你的组名
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+"\n")
PY
bash scripts/headless-daemon.sh restart

# 自证（daemon.log）：
#   cliproxy-nas /models ok count=<n>
#   headless BYOK config ... model=cliproxy-nas/<model> providers=cliproxy-nas ... bound=cliproxy-nas
#   [<Bot>] session model current: cliproxy-nas/<model>
```

- 只影响该组对应的 Bot；`bindOnly` 上游不会漏进其他 Bot 的模型面。
- **不自动回落**：指定的那台上游不可达时该 Bot 直接失败并报错，不会偷偷换机。
- 想双向验通：`node scripts/probe-isolated-session.mjs --provider <id> --model <id> --send`
  （⚠️ 从 GUI App 里跑时先看 §6 末尾「GUI App 里探 NAS 上游」）。

## 6. 校验与排障

```bash
# 结构、引用、旧版兼容
node scripts/check-model-config.mjs

# 再校验当前启用 provider 的 live /v1/models
node scripts/check-model-config.mjs --live

# 语法检查
python3 -m json.tool config/models.json >/dev/null

# 生效
bash scripts/headless-daemon.sh restart
```

`--live` 成功时日志里应有：

```text
headless BYOK config ... providers=<provider> models=<provider>/<id>,...
```

常见错误：

| 错误 | 含义 |
| :--- | :--- |
| `references missing catalog model` | model set 引用了不存在的 ID |
| `contains duplicate model` | 同一 model set 中重复 ID |
| `defaultModel ... is not in the set` | 默认模型不属于该组 |
| `cannot define both modelSet and models` | provider 同时使用新旧两套声明 |
| `allowlist ∩ /models empty` | 配置 ID 与 live 上游目录不匹配 |
| `modelSets.<组>.provider '...' is not a configured provider` | `provider` 写错名字（必须等于某个 `providers[].id`） |
| `modelSets.<组>.provider '...' is disabled` | 绑到了一台 `enabled: false` 的上游 |
| `modelSets.<组>.provider '...' does not serve: <id>` | 那台上游的 `modelSet` 里没有本组要的模型 |
| `bot bound to unknown/disabled provider '...'` | 会话装配时绑定值失效（配置文件被改过） |
| `duplicate model id across global providers` | 摘掉了 `bindOnly` ⇒ 同裸 id 双来源，选中会按数组顺序（检查器拦下） |
| `bindOnly provider ... is not bound by any modelSet` | 有台专属上游没人用（死配置） |
| `<provider> /models probe failed: fetch failed (…)` | 探活失败；括号里是 undici 的真实原因（ECONNREFUSED/超时）。**非致命**：会退回本地 allowlist，实际请求时才暴露上游不可达 |
| `<provider> ... served none of the allowed models` | 绑定生效但一个模型都没装配出来 ⇒ 直接抛错（不掉回官方模型面） |

| 现象 | 检查 |
| :--- | :--- |
| Headless 仍显示旧窗口 | 是否重启 daemon；模型是否属于启用 provider 的 model set；是否 `/new` |
| live 模型缺失 | `--live` 核对上游 `/v1/models` |
| 上游截断或 400 | catalog 声明值超过上游真实能力 |
| `/claude` 列表不对 | `modelSets.claude-cli` 与 `defaults.claudeDefaultModel` |

上游 `/v1/models` 只负责验证可用性，不会自动把新模型加入 Bridge，避免临时模型污染 Telegram 列表。

### GUI App 里探 NAS 上游

在 Cherry Studio 等 GUI App 的 shell 里直连 `127.0.0.1` 会被 Stash 逐进程接管出口（EHOSTUNREACH / `fetch failed`），
**这不是配置问题**。要在本机验 NAS 上游，用 launchd 上下文跑（见 asustor-nas-ops skill 的 `lrun.sh`），或直接看 daemon 自己的探测行：

```bash
bash ~/.gemini/config/plugins/asustor-nas-ops-plugin/skills/asustor-nas-ops/scripts/lrun.sh \
  'cd ~/.copilot/extensions/copilot-telegram-bridge && node scripts/probe-isolated-session.mjs --provider cliproxy-nas --model cursor-auto --send'
```

## 7. 配置与生成产物

| 类型 | 路径 | 定位 |
| :--- | :--- | :--- |
| 唯一模型真源 | `config/models.json` | 人工维护 |
| Bot token 与 modelSet 引用 | `config/bots.json` | 本机私密配置 |

生成产物不能反向作为 Bridge allowlist。实时列表只看 `modelSets`。

## 8. 同步

本机已安装扩展是编辑真源。验证后运行：

```bash
bash ~/.copilot/extensions/sync-copilot-extensions.sh "更新模型配置"
bash scripts/sync-to-open-source.sh "更新模型配置"
```

单向同步脚本会复制并脱敏开源版本；开源仓不再维护第二份 `models.example.json`。
