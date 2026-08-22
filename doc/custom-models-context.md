# 自定义模型上下文窗口

> 模型规格唯一真源：`config/models.json`。
> Headless 直接读取该文件；Copilot 桌面数据库由 `/fixctx` 从同一 catalog 应用。

## 1. 三条运行路径

| 路径 | 运行时读取 | 如何更新 |
| :--- | :--- | :--- |
| Copilot 桌面 App | `~/.copilot/data.db` → `provider_models` | `/fixctx` 根据统一 catalog 写入 |
| Editor Telegram Bot | 当前桌面会话 | 跟随桌面新 session |
| Headless Telegram Bot | `config/models.json` | 重启 Headless daemon |
| OpenCodex / Codex | `~/.opencodex/config.json` 与生成 catalog | 由 OpenCodex 自身管理，不走 `/fixctx` |

这些运行时存储仍然独立，但不再分别手工维护 Copilot 与 Headless 的模型数字。

## 2. 为什么自定义模型常回落 128K

自定义/BYOK 模型若没有向 Copilot SDK 声明窗口，SDK 常使用 128K fallback。Bridge 在创建 Headless 会话时把统一 catalog 中的字段传给 `ProviderModelConfig`：

```text
catalog.<id>.maxPromptTokens        → SDK maxPromptTokens
catalog.<id>.maxContextWindowTokens → SDK maxContextWindowTokens
catalog.<id>.maxOutputTokens        → SDK maxOutputTokens
```

桌面 App 不读取这些 SDK 配置，而是读取 SQLite：

```text
provider_models.max_prompt_tokens
provider_models.max_output_tokens
```

因此修改 catalog 后：

- Headless 需要重启 daemon。
- 桌面需要执行 `/fixctx`。
- 旧会话通常缓存了窗口，需新开 session。

## 3. 统一 catalog 中的上下文字段

```json
"<model-id>": {
  "label": "<display label>",
  "maxPromptTokens": 1000000,
  "maxContextWindowTokens": 1000000,
  "maxOutputTokens": 32000
}
```

`fixctx` 是可选的：

```json
"fixctx": {
  "copilotPromptTokens": 1000000,
  "copilotOutputTokens": 32000
}
```

规则：

1. `max*Tokens` 是 Headless SDK 规格。
2. Copilot 修复默认复用 `maxPromptTokens` / `maxOutputTokens`。
3. 只有 Copilot 值需要不同，才写 `copilotPromptTokens` / `copilotOutputTokens`。
4. 只有加入 `modelSets.fixctx.models` 的模型会被 `/fixctx` 处理。

## 4. `/fixctx` 数据流

```text
config/models.json
  ├─ catalog
  └─ modelSets.fixctx
          │
          ▼
scripts/fix-model-tokens.sh
  └─ UPDATE ~/.copilot/data.db
```

运行方式：

```bash
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/fix-model-tokens.sh
```

Telegram 中也可使用 `/fixctx`。脚本支持测试覆盖：

```bash
FIXCTX_MODELS_CONFIG=/tmp/models.json \
FIXCTX_COPILOT_DB=/tmp/data.db \
bash scripts/fix-model-tokens.sh
```

## 5. 手工检查生成结果

Copilot：

```bash
sqlite3 ~/.copilot/data.db \
  "SELECT model_id, max_prompt_tokens, max_output_tokens
   FROM provider_models ORDER BY model_id;"
```

Bridge 配置与 live catalog：

```bash
node scripts/check-model-config.mjs --live
```

## 6. 生效条件

### Headless

```bash
bash scripts/headless-daemon.sh restart
```

日志应出现：

```text
headless BYOK config ... providers=<provider> models=<provider>/<id>,...
```

### Copilot 桌面

1. 执行 `/fixctx`。
2. 新开 session。
3. 必要时彻底退出并重启 Copilot App。

## 7. 排障

| 现象 | 检查 |
| :--- | :--- |
| Headless 仍显示旧窗口 | 是否重启 daemon；模型是否属于启用 provider 的 model set |
| 桌面仍显示旧窗口 | `provider_models` 是否存在该 ID；是否新开 session |
| `/fixctx` 直接退出 | 运行 `node scripts/check-model-config.mjs` 查看悬空引用或非法数字 |
| live 模型缺失 | 运行 `node scripts/check-model-config.mjs --live`，核对上游 `/v1/models` |
| 上游截断或 400 | catalog 声明值超过上游真实能力 |

## 8. 边界

- `data.db` 是 `/fixctx` 的生成产物，不提交 Git。
- OpenCodex config 与 Codex catalog 不再由 `/fixctx` 维护。
- Editor Bot 的模型列表来自桌面 session，不使用 Headless model set。
- `/codex` 模型选择器读取 OpenCodex 生成 catalog，不能替代 Bridge allowlist。
- 文档不再复制当前模型清单；实时列表只看 `modelSets`。
