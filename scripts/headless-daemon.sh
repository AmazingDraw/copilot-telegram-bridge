#!/usr/bin/env bash
# telegram-bridge 无头独立守护
# 只用 Bridge 自管 runtime/（CLI + SDK + bootstrap），不扫 Copilot.app 缓存。
# 首次或换版本：bash scripts/vendor-copilot-runtime.sh   # npm 平台包，可跟版本号
#
# 用法:
#   bash scripts/headless-daemon.sh start|stop|restart|status|run
#   bash scripts/headless-daemon.sh install|uninstall   # LaunchAgent 开机自启 + KeepAlive
#
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${EXT_DIR}/bots/Headless/daemon.pid"
LOG_FILE="${EXT_DIR}/bots/Headless/daemon.log"
STATE_DIR="${HOME}/.copilot/session-state"
RUNTIME_ROOT="${EXT_DIR}/runtime"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.copilot-telegram-bridge.plist"
LAUNCH_LABEL="com.copilot-telegram-bridge"
LAUNCH_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
UID_NUM="$(id -u)"
LAUNCH_DOMAIN="gui/${UID_NUM}"
LAUNCH_SERVICE="${LAUNCH_DOMAIN}/${LAUNCH_LABEL}"

# 只用 runtime/<VERSION>/；不再读 App Caches。
resolve_runtime() {
  COPILOT_BIN=""
  PKG_DIR=""
  RUNTIME_ALIGN="none"

  local ver
  ver="$(tr -d '[:space:]' < "${RUNTIME_ROOT}/VERSION" 2>/dev/null || true)"
  if [[ -z "${ver}" ]]; then
    echo "error: ${RUNTIME_ROOT}/VERSION missing. Run: bash ${EXT_DIR}/scripts/vendor-copilot-runtime.sh" >&2
    COPILOT_BIN=""
    PKG_DIR=""
    SDK_PATH=""
    BOOTSTRAP=""
    RUNTIME_FP=""
    return 0
  fi

  PKG_DIR="${RUNTIME_ROOT}/${ver}/pkg"
  COPILOT_BIN="${RUNTIME_ROOT}/${ver}/cli/copilot"
  SDK_PATH="${PKG_DIR}/copilot-sdk"
  BOOTSTRAP="${PKG_DIR}/preloads/extension_bootstrap.mjs"
  RUNTIME_ALIGN="vendored:${ver}"
  RUNTIME_FP="${COPILOT_BIN}|${SDK_PATH}"
}

# Copilot ≥1.0.79 bootstrap：无 COPILOT_EXTENSION_PARENT_PID 时 silent exit(0)。
# 无头以 `copilot <bootstrap.mjs>` 启动时常不带该 env → launchd 崩循环。
# 幂等软化：有合法 parent 仍守护；未设置则继续跑。同时处理「CLI 偏好的 latest localBootstrap」。
ensure_bootstrap_compat() {
  local targets=()
  [[ -n "${BOOTSTRAP:-}" && -f "${BOOTSTRAP}" ]] && targets+=("${BOOTSTRAP}")

  # 去重（aligned 与 latest 可能相同）
  local path seen=""
  for path in "${targets[@]}"; do
    case " ${seen} " in
      *" ${path} "*) continue ;;
    esac
    seen="${seen} ${path}"
    BOOTSTRAP_COMPAT_TARGET="${path}" python3 >>"${LOG_FILE}" 2>&1 <<'PY' || true
import os, pathlib, re, shutil, sys, time

path = pathlib.Path(os.environ["BOOTSTRAP_COMPAT_TARGET"])
MARKER = "HEADLESS_BOOTSTRAP_COMPAT_V1"
text = path.read_text(encoding="utf-8")
if MARKER in text or "continuing without parent watch (headless-daemon compat)" in text:
    print(f"headless-daemon: bootstrap compat already applied: {path}")
    raise SystemExit(0)

pat = re.compile(
    r"const parentPid = Number\(process\.env\.COPILOT_EXTENSION_PARENT_PID\);\n"
    r"if \(!Number\.isSafeInteger\(parentPid\) \|\| parentPid <= 0 \|\| process\.ppid !== parentPid\) \{\n"
    r"    process\.exit\(0\);\n"
    r"\}\n"
    r"const parentWatch = setInterval\(\(\) => \{\n"
    r"    try \{\n"
    r"        if \(process\.ppid !== parentPid\) \{\n"
    r"            process\.exit\(0\);\n"
    r"        \}\n"
    r"        process\.kill\(parentPid, 0\);\n"
    r"    \} catch \{\n"
    r"        process\.exit\(0\);\n"
    r"    \}\n"
    r"\}, 1000\);\n"
    r"parentWatch\.unref\(\);",
    re.M,
)
m = pat.search(text)
if not m:
    if "COPILOT_EXTENSION_PARENT_PID" not in text:
        print(f"headless-daemon: bootstrap compat skip (no parent gate): {path}")
        raise SystemExit(0)
    print(f"headless-daemon: bootstrap compat pattern miss: {path}", file=sys.stderr)
    raise SystemExit(1)

soft = f"""// {MARKER} — telegram-bridge headless-daemon
// Soften parent-pid gate: unset PARENT_PID used to silent-exit(0) and crash-loop launchd.
const parentPid = Number(process.env.COPILOT_EXTENSION_PARENT_PID);
if (Number.isSafeInteger(parentPid) && parentPid > 0) {{
    if (process.ppid !== parentPid) {{
        process.stderr.write(`[extension-bootstrap] parent pid mismatch env=${{parentPid}} ppid=${{process.ppid}}, exiting\\n`);
        process.exit(0);
    }}
    const parentWatch = setInterval(() => {{
        try {{
            if (process.ppid !== parentPid) {{
                process.exit(0);
            }}
            process.kill(parentPid, 0);
        }} catch {{
            process.exit(0);
        }}
    }}, 1000);
    parentWatch.unref();
}} else {{
    process.stderr.write(`[extension-bootstrap] COPILOT_EXTENSION_PARENT_PID unset/invalid; continuing without parent watch (headless-daemon compat)\\n`);
}}"""

bak = path.with_suffix(path.suffix + f".bak-compat-{time.strftime('%Y%m%d%H%M%S')}")
shutil.copy2(path, bak)
path.write_text(text[: m.start()] + soft + text[m.end() :], encoding="utf-8")
print(f"headless-daemon: bootstrap compat applied: {path} (backup {bak.name})")
PY
  done
}

require_runtime() {
  if [[ -z "${COPILOT_BIN}" || ! -x "${COPILOT_BIN}" ]]; then
    echo "error: vendored copilot CLI missing (${COPILOT_BIN:-none}). Run: bash ${EXT_DIR}/scripts/vendor-copilot-runtime.sh" >&2
    exit 1
  fi
  if [[ -z "${BOOTSTRAP}" || ! -f "${BOOTSTRAP}" ]]; then
    echo "error: extension_bootstrap.mjs not found (pkg=${PKG_DIR:-none})" >&2
    exit 1
  fi
  if [[ -z "${SDK_PATH}" || ! -d "${SDK_PATH}" ]]; then
    echo "error: copilot-sdk not found at ${SDK_PATH:-none}" >&2
    exit 1
  fi
}

EXTENSION_PATH="${EXT_DIR}/extension.mjs"
RUNTIME_FP_FILE="${EXT_DIR}/bots/Headless/active-runtime.fp"

resolve_runtime
require_runtime

is_running() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null
}

launchd_loaded() {
  launchctl print "${LAUNCH_SERVICE}" >/dev/null 2>&1
}

launchd_pid() {
  launchctl print "${LAUNCH_SERVICE}" 2>/dev/null \
    | awk '/^\s*pid = / { print $3; exit }' || true
}

write_pid() {
  mkdir -p "${EXT_DIR}/bots/Headless"
  echo "$1" >"${PID_FILE}"
}

cmd_status() {
  local launchd_state="not-installed"
  if [[ -f "${LAUNCH_PLIST}" ]]; then
    if launchd_loaded; then
      launchd_state="loaded"
    else
      launchd_state="installed-unloaded"
    fi
  fi

  if is_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    echo "headless-daemon: running pid=${pid}"
    echo "  bin=${COPILOT_BIN}"
    echo "  sdk=${SDK_PATH}"
    echo "  align=${RUNTIME_ALIGN:-unknown}"
    echo "  log=${LOG_FILE}"
    echo "  launchd=${launchd_state} label=${LAUNCH_LABEL}"
    if [[ -f "${RUNTIME_FP_FILE}" ]]; then
      echo "  active_fp=$(cat "${RUNTIME_FP_FILE}")"
    fi
    echo "  latest_fp=${RUNTIME_FP}"
    if [[ -f "${RUNTIME_FP_FILE}" ]]; then
      local active
      active="$(cat "${RUNTIME_FP_FILE}")"
      if [[ "${active}" != "${RUNTIME_FP}" ]]; then
        echo "  update=available (restart will pick latest)"
      else
        echo "  update=current"
      fi
    fi
    if [[ -f "${EXT_DIR}/bots/Headless/headless.leader.json" ]]; then
      echo "  leader=$(cat "${EXT_DIR}/bots/Headless/headless.leader.json")"
    fi
    return 0
  fi

  # launchd may own the process before pidfile is written / after crash recovery
  local lpid
  lpid="$(launchd_pid)"
  if [[ -n "${lpid}" && "${lpid}" != "0" ]]; then
    echo "headless-daemon: running pid=${lpid} (via launchd)"
    echo "  bin=${COPILOT_BIN}"
    echo "  sdk=${SDK_PATH}"
    echo "  align=${RUNTIME_ALIGN:-unknown}"
    echo "  log=${LOG_FILE}"
    echo "  launchd=${launchd_state} label=${LAUNCH_LABEL}"
    write_pid "${lpid}"
    return 0
  fi

  echo "headless-daemon: stopped"
  echo "  launchd=${launchd_state} label=${LAUNCH_LABEL}"
  return 1
}

cmd_stop() {
  # If LaunchAgent is loaded with KeepAlive, must bootout or it will respawn.
  if launchd_loaded; then
    echo "headless-daemon: bootout ${LAUNCH_SERVICE} (disables KeepAlive until start/install)"
    launchctl bootout "${LAUNCH_SERVICE}" 2>/dev/null || true
    sleep 0.5
  fi

  if ! is_running; then
    local lpid
    lpid="$(launchd_pid 2>/dev/null || true)"
    if [[ -n "${lpid}" && "${lpid}" != "0" ]]; then
      kill -TERM "${lpid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
    echo "headless-daemon: stopped"
    return 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  echo "headless-daemon: stopping pid=${pid}..."
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  if kill -0 "${pid}" 2>/dev/null; then
    echo "headless-daemon: force kill pid=${pid}"
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
  echo "headless-daemon: stopped"
}

run_daemon() {
  # 每次 run 重新解析，避免脚本顶层缓存过期
  resolve_runtime
  require_runtime
  mkdir -p "${EXT_DIR}/bots/Headless" "${STATE_DIR}"
  # 必须在 exec 前：桌面更新会覆盖 bootstrap，每次启动幂等软化父进程门闩
  ensure_bootstrap_compat

  # After exec, PID is unchanged → safe for launchd + status.
  write_pid "$$"
  printf '%s\n' "${RUNTIME_FP}" >"${RUNTIME_FP_FILE}"

  export TELEGRAM_BRIDGE_MODE=headless-only
  export EXTENSION_PATH
  export COPILOT_SDK_PATH="${SDK_PATH}"
  export SESSION_ID="${SESSION_ID:-headless-daemon}"
  export COPILOT_CLI_PATH="${COPILOT_BIN}"
  # LaunchAgent/login shell 会带 HOME；勿写死本机用户名
  if [[ -z "${HOME:-}" ]]; then
    HOME="$(cd ~ && pwd)"
  fi
  export HOME

  echo "headless-daemon: run pid=$$ bin=${COPILOT_BIN}" >>"${LOG_FILE}"
  echo "headless-daemon: sdk=${SDK_PATH}" >>"${LOG_FILE}"
  echo "headless-daemon: align=${RUNTIME_ALIGN}" >>"${LOG_FILE}"
  cd "${EXT_DIR}"
  exec "${COPILOT_BIN}" "${BOOTSTRAP}"
}

cmd_start() {
  # Prefer LaunchAgent path when installed (KeepAlive always-on).
  if [[ -f "${LAUNCH_PLIST}" ]]; then
    if ! launchd_loaded; then
      echo "headless-daemon: bootstrap ${LAUNCH_SERVICE}"
      launchctl bootstrap "${LAUNCH_DOMAIN}" "${LAUNCH_PLIST}" 2>/dev/null \
        || launchctl load "${LAUNCH_PLIST}" 2>/dev/null || true
    fi
    launchctl enable "${LAUNCH_SERVICE}" 2>/dev/null || true
    launchctl kickstart -k "${LAUNCH_SERVICE}" 2>/dev/null \
      || launchctl start "${LAUNCH_LABEL}" 2>/dev/null || true
    sleep 1
    cmd_status || true
    return 0
  fi

  if is_running; then
    echo "headless-daemon: already running pid=$(cat "${PID_FILE}")"
    return 0
  fi
  mkdir -p "${EXT_DIR}/bots/Headless"
  resolve_runtime
  require_runtime
  nohup env \
    TELEGRAM_BRIDGE_MODE=headless-only \
    EXTENSION_PATH="${EXTENSION_PATH}" \
    COPILOT_SDK_PATH="${SDK_PATH}" \
    COPILOT_CLI_PATH="${COPILOT_BIN}" \
    SESSION_ID=headless-daemon \
    HOME="${HOME}" \
    bash "${EXT_DIR}/scripts/headless-daemon.sh" run \
    >>"${LOG_FILE}" 2>&1 &
  local pid=$!
  write_pid "${pid}"
  sleep 0.5
  if kill -0 "${pid}" 2>/dev/null; then
    echo "headless-daemon: started pid=${pid} (manual nohup; run install for login autostart)"
    echo "  log=${LOG_FILE}"
  else
    echo "headless-daemon: failed to stay up; see ${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    exit 1
  fi
}

cmd_restart() {
  if [[ -f "${LAUNCH_PLIST}" ]]; then
    if launchd_loaded; then
      launchctl kickstart -k "${LAUNCH_SERVICE}" 2>/dev/null \
        || { cmd_stop || true; sleep 1; cmd_start; }
    else
      cmd_start
    fi
    sleep 1
    cmd_status || true
    return 0
  fi
  cmd_stop || true
  sleep 1
  cmd_start
}

cmd_install() {
  if [[ ! -f "${PLIST_SRC}" ]]; then
    echo "error: missing ${PLIST_SRC}" >&2
    exit 1
  fi
  mkdir -p "${HOME}/Library/LaunchAgents" "${EXT_DIR}/bots/Headless"

  # Stop manual nohup instance first to avoid dual leaders.
  if is_running && ! launchd_loaded; then
    echo "headless-daemon: stopping manual instance before install..."
    # don't call cmd_stop (would bootout nonexistent); just kill
    local pid
    pid="$(cat "${PID_FILE}")"
    kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "${pid}" 2>/dev/null || true
    rm -f "${PID_FILE}"
    sleep 1
  fi

  # 从模板渲染绝对路径（launchd 不认相对路径；勿在仓库写死用户目录）
  if [[ -z "${HOME:-}" ]]; then
    HOME="$(cd ~ && pwd)"
  fi
  export HOME
  sed -e "s|__HOME__|${HOME}|g" -e "s|__EXT_DIR__|${EXT_DIR}|g" \
    "${PLIST_SRC}" > "${LAUNCH_PLIST}"
  plutil -lint "${LAUNCH_PLIST}" >/dev/null

  if launchd_loaded; then
    echo "headless-daemon: reloading existing LaunchAgent..."
    launchctl bootout "${LAUNCH_SERVICE}" 2>/dev/null || true
    sleep 0.5
  fi

  launchctl bootstrap "${LAUNCH_DOMAIN}" "${LAUNCH_PLIST}"
  launchctl enable "${LAUNCH_SERVICE}" 2>/dev/null || true
  launchctl kickstart -k "${LAUNCH_SERVICE}" 2>/dev/null || true
  sleep 1.5

  echo "headless-daemon: LaunchAgent installed"
  echo "  plist=${LAUNCH_PLIST}"
  echo "  label=${LAUNCH_LABEL}"
  echo "  RunAtLoad=true KeepAlive=true (login session gui/${UID_NUM})"
  cmd_status || true
}

cmd_uninstall() {
  if launchd_loaded; then
    launchctl bootout "${LAUNCH_SERVICE}" 2>/dev/null || true
  fi
  launchctl disable "${LAUNCH_SERVICE}" 2>/dev/null || true
  rm -f "${LAUNCH_PLIST}"
  if is_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    kill -TERM "${pid}" 2>/dev/null || true
    sleep 0.5
    kill -KILL "${pid}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
  echo "headless-daemon: LaunchAgent uninstalled (${LAUNCH_LABEL})"
}

usage() {
  echo "Usage: $0 {start|stop|restart|status|run|install|uninstall}"
  echo "  runtime: bash ${EXT_DIR}/scripts/vendor-copilot-runtime.sh"
  exit 2
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  run) run_daemon ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  *) usage ;;
esac
