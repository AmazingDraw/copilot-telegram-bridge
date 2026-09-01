#!/bin/bash
# OpenClaw 每天 5:00 调用：成功静默；失败发中文摘要到 Telegram。
set -u
ROOT="~/.copilot/extensions/copilot-telegram-bridge"
OC_TASKS="${HOME}/.openclaw/workspace/任务项目"
ALERT_TO="5575504139"
ALERT_ACCOUNT="daily"
TMP="$(mktemp -t session-cleanup.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

run_step() {
  local name="$1"
  shift
  local rc
  echo "=== ${name} ===" >>"$TMP"
  "$@" >>"$TMP" 2>&1
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo "ok: ${name}" >>"$TMP"
    return 0
  fi
  echo "fail: ${name} exit=${rc}" >>"$TMP"
  return "$rc"
}

FAILED=""
run_step "OpenClaw sqlite 空会话" python3 "${OC_TASKS}/cleanup-stale-sessions.py" || FAILED="OpenClaw sqlite 空会话"
if [[ -z "$FAILED" ]]; then
  run_step "OpenClaw 旧会话文件" bash "${OC_TASKS}/cleanup-old-sessions.sh" || FAILED="OpenClaw 旧会话文件"
fi
if [[ -z "$FAILED" ]]; then
  run_step "Copilot session-state（含附件）" python3 "${ROOT}/scripts/prune-session-state.py" || FAILED="Copilot session-state（含附件）"
fi

if [[ -z "$FAILED" ]]; then
  tail -n 40 "$TMP"
  exit 0
fi

REASON="$(grep -E 'ERROR:|^fail:|Error|Traceback' "$TMP" | tail -n 8 | sed 's/^/  /')"
if [[ -z "$REASON" ]]; then
  REASON="$(tail -n 12 "$TMP" | sed 's/^/  /')"
fi
SUMMARY="$(cat <<MSG
会话清理失败

失败步骤：${FAILED}
原因：
${REASON}

完整日志：~/.copilot/extensions/copilot-telegram-bridge/bots/Headless/prune-session-state.log
MSG
)"
printf '%s\n' "$SUMMARY" >&2
command openclaw message send \
  --channel telegram \
  --account "${ALERT_ACCOUNT}" \
  --target "${ALERT_TO}" \
  --message "${SUMMARY}" >/dev/null 2>>"$TMP" || true
exit 1
