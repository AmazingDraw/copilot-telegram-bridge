#!/usr/bin/env bash
# fix-model-tokens.sh — 修复 Copilot 桌面 App 与 OpenCodex 的模型上下文
# 每次增删自定义模型或上下文配置漂移后，跑一次本脚本即可还原正确值。
# 用法: bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/fix-model-tokens.sh

set -euo pipefail

DB="${FIXCTX_COPILOT_DB:-$HOME/.copilot/data.db}"
OPENCODEX_CONFIG="${FIXCTX_OPENCODEX_CONFIG:-$HOME/.opencodex/config.json}"
OPENCODEX_RESTART_SCRIPT="${FIXCTX_OPENCODEX_RESTART_SCRIPT:-$HOME/.gemini/config/plugins/codex-ops-plugin/skills/codex-ops/scripts/restart-opencodex.sh}"

echo "📦 Copilot 数据库: $DB"
echo "📦 OpenCodex 配置: $OPENCODEX_CONFIG"
echo ""

# ── 自定义模型上下文规格表 ────────────────────────────────────────
# model_id | Copilot prompt | Copilot output | OpenCodex context | 备注
declare -a MODELS=(
  "cursor-grok-4.5-high|256000|32000|256000|Cursor Grok 4.5 High"
  "cursor-grok-4.5-medium|256000|32000|256000|Cursor Grok 4.5 Medium"
  "cursor-grok-4.5-low|256000|32000|256000|Cursor Grok 4.5 Low"
  "cursor-grok-4.6-low|256000|32000|256000|Cursor Grok 4.6 Low"
  "cursor-grok-4.6-medium|256000|32000|256000|Cursor Grok 4.6 Medium"
  "cursor-grok-4.6-high|256000|32000|256000|Cursor Grok 4.6 High"
  "cursor-grok-4.6-xhigh|256000|32000|256000|Cursor Grok 4.6 XHigh"
  "composer-2.5|200000|32000|200000|Composer 2.5"
  "deepseek-v4-flash|1000000|32000|1048576|DeepSeek V4 Flash"
  "deepseek-v4-pro|1000000|32000|1048576|DeepSeek V4 Pro"
  "mimo-v2.5|1000000|32000|1050000|MiMo V2.5"
  "mimo-v2.5-pro|1000000|32000|1050000|MiMo V2.5 Pro"
  "kimi-k3-low|1000000|32000|1048576|Kimi K3 Low"
  "kimi-k3-high|1000000|32000|1048576|Kimi K3 High"
  "kimi-k3-max|1000000|32000|1048576|Kimi K3 Max"
  "claude-sonnet-4-6|200000|16384|200000|Claude Sonnet 4.6"
  "gemini-3.6-flash-high|1000000|65536|1048576|Gemini 3.6 Flash High"
)

UPDATED=0
SKIPPED=0
COPILOT_STATUS="未找到 data.db"

if [[ -f "$DB" ]]; then
  for entry in "${MODELS[@]}"; do
    IFS='|' read -r model_id max_prompt max_output _ label <<< "$entry"

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
  COPILOT_STATUS="更新 $UPDATED 个 / 跳过 $SKIPPED 个"
else
  echo "⏭  [Copilot Desktop] — data.db 不存在"
fi

# ── OpenCodex modelContextWindows + catalog ──────────────────────
OPENCODEX_STATUS="未找到 config.json"

if [[ -f "$OPENCODEX_CONFIG" ]]; then
  declare -a ocx_context_args=()
  for entry in "${MODELS[@]}"; do
    IFS='|' read -r model_id _ _ ocx_context _ <<< "$entry"
    ocx_context_args+=("${model_id}=${ocx_context}")
  done

  ocx_result=$(
    python3 - "$OPENCODEX_CONFIG" "${ocx_context_args[@]}" <<'PY'
import json
import os
import stat
import sys
import tempfile
from pathlib import Path

path = Path(sys.argv[1])
contexts = {}
for item in sys.argv[2:]:
    model_id, separator, raw_context = item.rpartition("=")
    if not separator or not model_id:
        raise SystemExit(f"invalid OpenCodex context entry: {item}")
    contexts[model_id] = int(raw_context)

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
if isinstance(disabled, list) and "cliproxy/kimi-k3-max" in disabled:
    config["disabledModels"] = [
        model_id for model_id in disabled if model_id != "cliproxy/kimi-k3-max"
    ]
    changed += 1

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
