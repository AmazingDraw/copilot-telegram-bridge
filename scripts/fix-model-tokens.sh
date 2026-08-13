#!/usr/bin/env bash
# fix-model-tokens.sh — 修复 Copilot 桌面 App 与 OpenCodex 的模型上下文
# 每次增删自定义模型或上下文配置漂移后，跑一次本脚本即可还原正确值。
# 用法: bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/fix-model-tokens.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_CONFIG="${FIXCTX_MODELS_CONFIG:-$SCRIPT_DIR/../config/models.json}"
DB="${FIXCTX_COPILOT_DB:-$HOME/.copilot/data.db}"
OPENCODEX_CONFIG="${FIXCTX_OPENCODEX_CONFIG:-$HOME/.opencodex/config.json}"
OPENCODEX_RESTART_SCRIPT="${FIXCTX_OPENCODEX_RESTART_SCRIPT:-$HOME/.gemini/config/plugins/codex-ops-plugin/skills/codex-ops/scripts/restart-opencodex.sh}"

echo "📦 模型配置: $MODELS_CONFIG"
echo "📦 Copilot 数据库: $DB"
echo "📦 OpenCodex 配置: $OPENCODEX_CONFIG"
echo ""

# ── 从统一 catalog 读取 fixctx 模型组 ──────────────────────────────
# 输出行：model_id | Copilot prompt | Copilot output | OpenCodex context | label | ensureEnabled
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
    context = positive_int(
        fixctx.get("opencodexContextWindow"),
        f"catalog.{model_id}.fixctx.opencodexContextWindow",
    )
    label = str(spec.get("label") or model_id)
    if "|" in label or "\n" in label:
        raise SystemExit(f"catalog.{model_id}.label contains an unsupported separator")
    ensure_enabled = "1" if fixctx.get("ensureEnabled") is True else "0"
    print(f"{model_id}|{prompt}|{output}|{context}|{label}|{ensure_enabled}")
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
        parts = entry.split("|", 5)
        if len(parts) != 6:
            raise SystemExit(f"invalid fixctx row: {entry}")
        model_id, raw_prompt, raw_output, _, label, _ = parts
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

# ── OpenCodex modelContextWindows + catalog ──────────────────────
OPENCODEX_STATUS="未找到 config.json"

if [[ -f "$OPENCODEX_CONFIG" ]]; then
  ocx_result=$(
    python3 - "$OPENCODEX_CONFIG" "${MODELS[@]}" <<'PY'
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
contexts = {}
ensure_enabled = set()
for item in sys.argv[2:]:
    parts = item.split("|", 5)
    if len(parts) != 6:
        raise SystemExit(f"invalid fixctx row: {item}")
    model_id, _, _, raw_context, _, raw_ensure_enabled = parts
    contexts[model_id] = int(raw_context)
    if raw_ensure_enabled == "1":
        ensure_enabled.add(f"cliproxy/{model_id}")

config = json.loads(path.read_text())
providers = config.get("providers")
if not isinstance(providers, dict):
    raise SystemExit("OpenCodex config missing providers object")

cliproxy = providers.get("cliproxy")
if not isinstance(cliproxy, dict):
    raise SystemExit("OpenCodex config missing providers.cliproxy object")

windows = cliproxy.get("modelContextWindows")
if windows is None:
    windows = {}
    cliproxy["modelContextWindows"] = windows
elif not isinstance(windows, dict):
    raise SystemExit("providers.cliproxy.modelContextWindows must be an object")

changed = 0
for model_id, context in contexts.items():
    if windows.get(model_id) != context:
        windows[model_id] = context
        changed += 1

target_count = len(contexts)

disabled = config.get("disabledModels")
if isinstance(disabled, list) and ensure_enabled:
    next_disabled = [model_id for model_id in disabled if model_id not in ensure_enabled]
    removed = len(disabled) - len(next_disabled)
    if removed:
        config["disabledModels"] = next_disabled
        changed += removed

if changed:
    mode = stat.S_IMODE(path.stat().st_mode)
    fd, temp_path = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(config, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise

print(f"{target_count}|{changed}")
PY
  )

  IFS='|' read -r ocx_total ocx_changed <<< "$ocx_result"
  echo "✅ [OpenCodex 配置] → 校验 ${ocx_total} 个上下文，修改 ${ocx_changed} 项"
  OPENCODEX_STATUS="配置已校验"

  if [[ "${FIXCTX_SKIP_OPENCODEX_RESTART:-0}" == "1" ]]; then
    echo "⏭  [OpenCodex Catalog] — 已按环境变量跳过重启"
    OPENCODEX_STATUS="配置已校验（未重启）"
  else
    restart_output=""
    restarted=0
    if [[ -f "$OPENCODEX_RESTART_SCRIPT" ]]; then
      if ! restart_output=$(bash "$OPENCODEX_RESTART_SCRIPT" --sync 2>&1); then
        echo "$restart_output" >&2
        exit 1
      fi
      restarted=1
    elif command -v ocx >/dev/null 2>&1; then
      if ! restart_output=$({ ocx restart && ocx sync --restart-codex; } 2>&1); then
        echo "$restart_output" >&2
        exit 1
      fi
      restarted=1
    else
      echo "⏭  [OpenCodex Catalog] — 未找到重启脚本或 ocx 命令"
      OPENCODEX_STATUS="配置已校验（未重启）"
    fi

    if [[ "$restarted" == "1" ]]; then
      echo "✅ [OpenCodex Catalog] → 已重启代理并同步模型目录"
      OPENCODEX_STATUS="已修复并同步"
    fi
  fi
else
  echo "⏭  [OpenCodex] — config.json 不存在"
fi

echo ""
echo "────────────────────────────────────"
echo "完成：Copilot ${COPILOT_STATUS}；OpenCodex ${OPENCODEX_STATUS}"
echo "重开 Copilot / Codex session 即可看到新的上下文数字。"
