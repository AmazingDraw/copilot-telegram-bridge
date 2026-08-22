#!/usr/bin/env bash
# fix-model-tokens.sh — 修复 Copilot 桌面 App 的模型上下文
# 每次增删自定义模型或配置上下文漂移后，跑一次本脚本即可还原正确值。
# 用法: bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/fix-model-tokens.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_CONFIG="${FIXCTX_MODELS_CONFIG:-$SCRIPT_DIR/../config/models.json}"
DB="${FIXCTX_COPILOT_DB:-$HOME/.copilot/data.db}"

echo "📦 模型配置: $MODELS_CONFIG"
echo "📦 Copilot 数据库: $DB"
echo ""

# ── 从统一 catalog 读取 fixctx 模型组 ──────────────────────────────
# 输出行：model_id | Copilot prompt | Copilot output | label
declare -a MODELS=()
MODEL_ROWS_FILE="$(mktemp "${TMPDIR:-/tmp}/bridge-fixctx-models.XXXXXX")"
trap 'rm -f "$MODEL_ROWS_FILE"' EXIT
if ! python3 - "$MODELS_CONFIG" >"$MODEL_ROWS_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(f"models config not found: {path}")

config = json.loads(path.read_text())
catalog = config.get("catalog")
sets = config.get("modelSets")
if not isinstance(catalog, dict):
    raise SystemExit("models config missing catalog object")
if not isinstance(sets, dict):
    raise SystemExit("models config missing modelSets object")

fixctx_set = sets.get("fixctx")
if not isinstance(fixctx_set, dict) or not isinstance(fixctx_set.get("models"), list):
    raise SystemExit("models config missing modelSets.fixctx.models")

model_ids = fixctx_set["models"]
if not model_ids:
    raise SystemExit("modelSets.fixctx.models is empty")
if len(model_ids) != len(set(model_ids)):
    raise SystemExit("modelSets.fixctx.models contains duplicate ids")

def positive_int(value, field):
    if isinstance(value, bool):
        raise SystemExit(f"{field} must be a positive integer")
    if isinstance(value, float) and not value.is_integer():
        raise SystemExit(f"{field} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise SystemExit(f"{field} must be a positive integer")
    if parsed <= 0:
        raise SystemExit(f"{field} must be a positive integer")
    return parsed

for model_id in model_ids:
    spec = catalog.get(model_id)
    if not isinstance(spec, dict):
        raise SystemExit(f"fixctx model missing from catalog: {model_id}")
    fixctx = spec.get("fixctx")
    if fixctx is None:
        fixctx = {}
    if not isinstance(fixctx, dict):
        raise SystemExit(f"catalog.{model_id}.fixctx must be an object")

    prompt = positive_int(
        fixctx.get("copilotPromptTokens", spec.get("maxPromptTokens")),
        f"catalog.{model_id}.fixctx.copilotPromptTokens",
    )
    output = positive_int(
        fixctx.get("copilotOutputTokens", spec.get("maxOutputTokens")),
        f"catalog.{model_id}.fixctx.copilotOutputTokens",
    )
    label = str(spec.get("label") or model_id)
    if "|" in label or "\n" in label:
        raise SystemExit(f"catalog.{model_id}.label contains an unsupported separator")
    print(f"{model_id}|{prompt}|{output}|{label}")
PY
then
  echo "❌ 无法从统一模型配置加载 /fixctx 规格" >&2
  exit 1
fi
while IFS= read -r entry; do
  [[ -n "$entry" ]] && MODELS+=("$entry")
done < "$MODEL_ROWS_FILE"
rm -f "$MODEL_ROWS_FILE"
trap - EXIT

if [[ "${#MODELS[@]}" -eq 0 ]]; then
  echo "❌ modelSets.fixctx 未解析出任何有效模型" >&2
  exit 1
fi

UPDATED=0
SKIPPED=0
COPILOT_STATUS="未找到 data.db"

if [[ -f "$DB" ]]; then
  if ! db_result=$(
    python3 - "$DB" "${MODELS[@]}" <<'PY'
import sqlite3
import sys
from pathlib import Path

path = Path(sys.argv[1])
entries = sys.argv[2:]
connection = sqlite3.connect(path)
logs = []
updated = 0
skipped = 0

try:
    connection.execute("BEGIN IMMEDIATE")
    for entry in entries:
        parts = entry.split("|", 3)
        if len(parts) != 4:
            raise SystemExit(f"invalid fixctx row: {entry}")
        model_id, raw_prompt, raw_output, label = parts
        prompt = int(raw_prompt)
        output = int(raw_output)
        exists = connection.execute(
            "SELECT 1 FROM provider_models WHERE model_id = ? LIMIT 1",
            (model_id,),
        ).fetchone()
        if not exists:
            skipped += 1
            logs.append(f"⏭  跳过 [{label}] — 未在 provider_models 中找到（尚未添加）")
            continue
        connection.execute(
            """
            UPDATE provider_models
            SET max_prompt_tokens = ?,
                max_output_tokens = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE model_id = ?
            """,
            (prompt, output, model_id),
        )
        current = connection.execute(
            "SELECT max_prompt_tokens, max_output_tokens FROM provider_models WHERE model_id = ?",
            (model_id,),
        ).fetchone()
        logs.append(
            f"✅ [{label}] → prompt={prompt} output={output}  "
            f"(DB: {current[0]}|{current[1]})"
        )
        updated += 1
    connection.commit()
except BaseException:
    connection.rollback()
    raise
finally:
    connection.close()

for log in logs:
    print(f"LOG|{log}")
print(f"SUMMARY|{updated}|{skipped}")
PY
  ); then
    echo "❌ Copilot 数据库事务更新失败，已回滚" >&2
    exit 1
  fi

  summary_seen=0
  while IFS='|' read -r kind first second; do
    if [[ "$kind" == "LOG" ]]; then
      echo "$first${second:+|$second}"
    elif [[ "$kind" == "SUMMARY" ]]; then
      UPDATED="$first"
      SKIPPED="$second"
      summary_seen=1
    fi
  done <<< "$db_result"
  if [[ "$summary_seen" != "1" ]]; then
    echo "❌ Copilot 数据库事务缺少汇总结果" >&2
    exit 1
  fi
  COPILOT_STATUS="更新 $UPDATED 个 / 跳过 $SKIPPED 个"
else
  echo "⏭  [Copilot Desktop] — data.db 不存在"
fi

echo ""
echo "────────────────────────────────────"
echo "完成：Copilot ${COPILOT_STATUS}"
echo "重开 Copilot session 即可看到新的上下文数字。"
