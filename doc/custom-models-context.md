# 自定义模型上下文窗口

> 模型规格唯一真源：`config/models.json`。
> Headless / Claude 菜单直接读 catalog；Codex 走自身 catalog，不回写 Bridge。

## 1. 运行路径

| 路径 | 运行时读取 | 如何更新 |
| :--- | :--- | :--- |
| Headless Telegram Bot | `config/models.json` → SDK `ProviderModelConfig` | 改 catalog 后重启 Headless daemon |
| Claude CLI（`/claude`） | `modelSets.claude-cli` + catalog id | 改 set / catalog 后重启 daemon |
| Codex CLI（`/codex`） | `~/.codex` 与生成 catalog | 由 Codex / `ocx sync` 管理 |

无桌面 Copilot.app，不再维护 `~/.copilot/data.db` 窗口补丁。

## 2. 为什么自定义模型常回落 128K

自定义/BYOK 模型若没有向 Copilot SDK 声明窗口，SDK 常使用 128K fallback。Bridge 在 create/resume 无头会话时把统一 catalog 中的字段传给 `ProviderModelConfig`：

```text
catalog.<id>.maxPromptTokens        → SDK maxPromptTokens
catalog.<id>.maxContextWindowTokens → SDK maxContextWindowTokens
catalog.<id>.maxOutputTokens        → SDK maxOutputTokens
```

因此修改 catalog 后：

- Headless 需要重启 daemon。
- 旧会话通常缓存了窗口，需 `/new` 再开 session。

## 3. 统一 catalog 中的上下文字段

```json
"<model-id>": {
  "label": "<display label>",
  "maxPromptTokens": 1000000,
  "maxContextWindowTokens": 1000000,
  "maxOutputTokens": 32000
}
```

规则：

1. `max*Tokens` 是 Headless SDK 规格。
2. `/claude` 模型增删只改 `modelSets.claude-cli` 与 catalog，不另写窗口表。
3. `/codex` 不使用这组数字作为 allowlist。

## 4. 校验

```bash
node scripts/check-model-config.mjs --live
bash scripts/headless-daemon.sh restart
```

日志应出现：

```text
headless BYOK config ... providers=<provider> models=<provider>/<id>,...
```

## 5. 排障

| 现象 | 检查 |
| :--- | :--- |
| Headless 仍显示旧窗口 | 是否重启 daemon；模型是否属于启用 provider 的 model set |
| live 模型缺失 | 运行 `node scripts/check-model-config.mjs --live`，核对上游 `/v1/models` |
| 上游截断或 400 | catalog 声明值超过上游真实能力 |
| `/claude` 列表不对 | `modelSets.claude-cli` 与 `defaults.claudeDefaultModel` |

## 6. 边界

- Codex catalog 不能替代 Bridge allowlist。
- 文档不再复制当前模型清单；实时列表只看 `modelSets`。
