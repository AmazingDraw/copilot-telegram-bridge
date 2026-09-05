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

| 现象 | 检查 |
| :--- | :--- |
| Headless 仍显示旧窗口 | 是否重启 daemon；模型是否属于启用 provider 的 model set；是否 `/new` |
| live 模型缺失 | `--live` 核对上游 `/v1/models` |
| 上游截断或 400 | catalog 声明值超过上游真实能力 |
| `/claude` 列表不对 | `modelSets.claude-cli` 与 `defaults.claudeDefaultModel` |

上游 `/v1/models` 只负责验证可用性，不会自动把新模型加入 Bridge，避免临时模型污染 Telegram 列表。

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
