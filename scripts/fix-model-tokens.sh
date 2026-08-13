#!/usr/bin/env bash
# fix-model-tokens.sh — 修复桌面 App 自定义模型的上下文窗口设置
# 每次在 Copilot App 里移除/重新添加模型后，跑一次本脚本即可还原正确值。
# 用法: bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/fix-model-tokens.sh

set -euo pipefail

DB="$HOME/.copilot/data.db"

if [[ ! -f "$DB" ]]; then
  echo "❌ data.db 不存在: $DB"
  exit 1
fi

echo "📦 目标数据库: $DB"
echo ""

# ── 自定义模型上下文规格表 ────────────────────────────────────────
# model_id | max_prompt_tokens | max_output_tokens | 备注
declare -a MODELS=(
  "grok-4.5|500000|32000|Grok 4.5"
  "cursor-grok-4.5-high|256000|32000|Cursor Grok 4.5 High"
  "cursor-grok-4.5-medium|256000|32000|Cursor Grok 4.5 Medium"
  "cursor-grok-4.5-low|256000|32000|Cursor Grok 4.5 Low"
  "cursor-grok-4.6-low|256000|32000|Cursor Grok 4.6 Low"
  "cursor-grok-4.6-medium|256000|32000|Cursor Grok 4.6 Medium"
  "cursor-grok-4.6-high|256000|32000|Cursor Grok 4.6 High"
  "cursor-grok-4.6-xhigh|256000|32000|Cursor Grok 4.6 XHigh"
  "composer-2.5|200000|32000|Composer 2.5"
  "deepseek-v4-flash|1000000|32000|DeepSeek V4 Flash"
  "deepseek-v4-pro|1000000|32000|DeepSeek V4 Pro"
  "mimo-v2.5|1000000|32000|MiMo V2.5"
  "mimo-v2.5-pro|1000000|32000|MiMo V2.5 Pro"
  "kimi-k3-low|1000000|32000|Kimi K3 Low"
  "kimi-k3-high|1000000|32000|Kimi K3 High"
  "kimi-k3-max|1000000|32000|Kimi K3 Max"
  "claude-sonnet-4-6|200000|16384|Claude Sonnet 4.6"
  "gemini-3.6-flash-high|1000000|65536|Gemini 3.6 Flash High"
)

UPDATED=0
SKIPPED=0

for entry in "${MODELS[@]}"; do
  IFS='|' read -r model_id max_prompt max_output label <<< "$entry"

  # 检查模型是否存在于 provider_models
  exists=$(sqlite3 "$DB" "SELECT COUNT(*) FROM provider_models WHERE model_id='$model_id';")

  if [[ "$exists" == "0" ]]; then
    echo "⏭  跳过 [$label] — 未在 provider_models 中找到（尚未添加）"
    ((SKIPPED++)) || true
    continue
  fi

  sqlite3 "$DB" <<SQL
UPDATE provider_models
SET max_prompt_tokens = $max_prompt,
    max_output_tokens = $max_output,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE model_id = '$model_id';
SQL

  current=$(sqlite3 "$DB" "SELECT max_prompt_tokens, max_output_tokens FROM provider_models WHERE model_id='$model_id';")
  echo "✅ [$label] → prompt=${max_prompt} output=${max_output}  (DB: $current)"
  ((UPDATED++)) || true
done

echo ""
echo "────────────────────────────────────"
echo "完成：更新 $UPDATED 个 / 跳过 $SKIPPED 个（未添加）"
echo "重开一个 Copilot session 即可看到新的上下文数字。"
