# 自定义模型上下文窗口

> 模型规格唯一真源：`config/models.json`。
> Headless 直接读取该文件；Copilot 桌面数据库与 OpenCodex 配置由 `/fixctx` 从同一 catalog 应用。

## 1. 三条运行路径

| 路径 | 运行时读取 | 如何更新 |
| :--- | :--- | :--- |
| Copilot 桌面 App | `~/.copilot/data.db` → `provider_models` | `/fixctx` 根据统一 catalog 写入 |
| Editor Telegram Bot | 当前桌面会话 | 跟随桌面新 session |
| Headless Telegram Bot | `config/models.json` | 重启 Headless daemon |
| OpenCodex / Codex | `~/.opencodex/config.json` 与生成 catalog | `/fixctx` 写入并执行 catalog sync |

这些运行时存储仍然独立，但不再分别手工维护模型数字。

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
- 桌面与 OpenCodex 需要执行 `/fixctx`。
- 旧会话通常缓存了窗口，需新开 session。

## 3. 统一 catalog 中的上下文字段

```json
"<model-id>": {
  "label": "<display label>",
  "maxPromptTokens": 1000000,
  "maxContextWindowTokens": 1000000,
  "maxOutputTokens": 32000,
  "fixctx": {
    "opencodexContextWindow": 1048576,
    "copilotPromptTokens": 1000000,
    "copilotOutputTokens": 32000,
    "ensureEnabled": false
  }
}
```

规则：

1. `max*Tokens` 是 Headless SDK 规格。
2. Copilot 修复默认复用 `maxPromptTokens` / `maxOutputTokens`。
3. 只有 Copilot 值需要不同，才写 `copilotPromptTokens` / `copilotOutputTokens`。
4. `opencodexContextWindow` 必填，因为 OpenCodex 可能使用与 Headless 不同的精确值。
5. `ensureEnabled` 用于保证目标不被 OpenCodex `disabledModels` 屏蔽。
6. 只有加入 `modelSets.fixctx.models` 的模型会被 `/fixctx` 处理。

十进制 1M 与 1048576/1050000 的差异是目标系统差异，不再要求维护两张模型表。

## 4. `/fixctx` 数据流

```text
config/models.json
  ├─ catalog
  └─ modelSets.fixctx
          │
          ▼
scripts/fix-model-tokens.sh
  ├─ UPDATE ~/.copilot/data.db
  ├─ UPDATE ~/.opencodex/config.json
  ├─ remove configured ensureEnabled models from disabledModels
  └─ restart OpenCodex + sync catalog
```

运行方式：

```bash
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/fix-model-tokens.sh
```

Telegram 中也可使用 `/fixctx`。脚本支持测试覆盖：

```bash
FIXCTX_MODELS_CONFIG=/tmp/models.json \
FIXCTX_COPILOT_DB=/tmp/data.db \
FIXCTX_OPENCODEX_CONFIG=/tmp/opencodex.json \
FIXCTX_SKIP_OPENCODEX_RESTART=1 \
bash scripts/fix-model-tokens.sh
```

## 5. 手工检查生成结果

Copilot：

```bash
sqlite3 ~/.copilot/data.db \
  "SELECT model_id, max_prompt_tokens, max_output_tokens
   FROM provider_models ORDER BY model_id;"
```

OpenCodex：

```bash
python3 - <<'PY'
import json
from pathlib import Path

config = json.loads((Path.home() / ".opencodex/config.json").read_text())
print(json.dumps(
    config["providers"]["cliproxy"]["modelContextWindows"],
    ensure_ascii=False,
    indent=2,
    sort_keys=True,
))
PY
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

### OpenCodex / Codex

`/fixctx` 默认重启 OpenCodex 并同步 catalog。已打开的 Codex session 仍可能缓存旧限制，需新开会话。

## 7. 排障

| 现象 | 检查 |
| :--- | :--- |
| Headless 仍显示旧窗口 | 是否重启 daemon；模型是否属于启用 provider 的 model set |
| 桌面仍显示旧窗口 | `provider_models` 是否存在该 ID；是否新开 session |
| OpenCodex 窗口未更新 | 模型是否属于 `modelSets.fixctx`；是否存在 `fixctx.opencodexContextWindow` |
| `/fixctx` 直接退出 | 运行 `node scripts/check-model-config.mjs` 查看悬空引用或非法数字 |
| live 模型缺失 | 运行 `node scripts/check-model-config.mjs --live`，核对上游 `/v1/models` |
| 上游截断或 400 | catalog 声明值超过上游真实能力 |

## 8. 边界

- `data.db`、OpenCodex config 与 Codex catalog 是生成产物，不提交 Git。
- Editor Bot 的模型列表来自桌面 session，不使用 Headless model set。
- `/codex` 模型选择器读取 OpenCodex 生成 catalog，不能替代 Bridge allowlist。
- 文档不再复制当前模型清单；实时列表只看 `modelSets`。
