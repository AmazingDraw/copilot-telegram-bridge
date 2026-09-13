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
    DIST_DIR=""
    SDK_PATH=""
    BOOTSTRAP=""
    RUNTIME_FP=""
    return 0
  fi

  PKG_DIR="${RUNTIME_ROOT}/${ver}/pkg"
  COPILOT_BIN="${RUNTIME_ROOT}/${ver}/cli/copilot"
  SDK_PATH="${PKG_DIR}/copilot-sdk"
  BOOTSTRAP="${PKG_DIR}/preloads/extension_bootstrap.mjs"
  # CLI 的 JS 运行时目录（见 run_daemon 里 COPILOT_CLI_DIST_DIR 的说明）
  DIST_DIR="${PKG_DIR}"
  RUNTIME_ALIGN="vendored:${ver}"
  RUNTIME_FP="${COPILOT_BIN}|${SDK_PATH}"
}

# Copilot ≥1.0.79 bootstrap：无 COPILOT_EXTENSION_PARENT_PID 时 silent exit(0)。
# 无头以 `copilot <bootstrap.mjs>` 启动时常不带该 env → launchd 崩循环。
# 幂等软化：有合法 parent 仍守护；未设置则继续跑。软化逻辑在 scripts/patch-bootstrap-compat.py。
ensure_bootstrap_compat() {
  # 软化逻辑的唯一真源：scripts/patch-bootstrap-compat.py（daemon / vendor / preflight 三处共用）。
  # 不要再在别处抄门闩正则 —— 否则「升级前检查器」和「实际行为」会各说一套。
  [[ -n "${BOOTSTRAP:-}" && -f "${BOOTSTRAP}" ]] || return 0
  python3 "${EXT_DIR}/scripts/patch-bootstrap-compat.py" --prefix headless-daemon "${BOOTSTRAP}" \
    >>"${LOG_FILE}" 2>&1 || true
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
  # CLI 的 JS 运行时 = 整个 vendored pkg（见 run_daemon 里 COPILOT_CLI_DIST_DIR）。
  # 缺文件 / 门闩未软化 → 启动即静默 exit(0) 崩循环，所以启动前硬校验，宁可响亮报错。
  local missing=""
  local f
  for f in index.js app.js; do
    [[ -f "${PKG_DIR}/${f}" ]] || missing="${missing} ${f}"
  done
  if [[ -n "${missing}" ]]; then
    echo "error: vendored pkg incomplete (${PKG_DIR}) missing:${missing}" >&2
    echo "  → 重新 vendor: bash ${EXT_DIR}/scripts/vendor-copilot-runtime.sh" >&2
    exit 1
  fi
  if ! grep -q "HEADLESS_BOOTSTRAP_COMPAT_V1" "${BOOTSTRAP}" 2>/dev/null; then
    echo "error: bootstrap parent-pid compat missing: ${BOOTSTRAP}" >&2
    echo "  → 无头环境下会静默 exit(0) 崩循环；重跑 vendor-copilot-runtime.sh（它自带软化）" >&2
    exit 1
  fi
  # 探针：共享缓存 pkg 若又出现，说明 CLI 没走 DIST_DIR（或别的进程重建了它）
  if [[ -d "${HOME}/Library/Caches/copilot/pkg" ]]; then
    echo "headless-daemon: warn: ${HOME}/Library/Caches/copilot/pkg 存在（DIST_DIR 可能未生效 / 有别的进程在用）" >>"${LOG_FILE}"
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
    echo "  dist=${DIST_DIR:-none}"
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
    echo "  dist=${DIST_DIR:-none}"
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
  # CLI 的 JS 运行时钉死在 vendored pkg，一个字节都不读 ~/Library/Caches。
  # 层1 launcher（SEA）认该 env：直接 import <DIST_DIR>/index.js 并跳过「自解包到缓存」分支。
  # 层2 index.js 的 resolveBootstrapPath(argv, __dir) 会把 __dir 认成 DIST_DIR，
  # 于是生效的 bootstrap = <DIST_DIR>/preloads/extension_bootstrap.mjs（就是刚软化那份）；
  # 它优先于 argv 传入的路径，之前正是它指向 Caches 才导致 1.0.83 崩循环。
  # ⚠️ 绝不能给它加 --prefer-version（那个 flag 会让 DIST_DIR 直接被忽略）。
  export COPILOT_CLI_DIST_DIR="${DIST_DIR}"
  # 关掉 CLI 的自动下载/自动换版本（= --no-auto-update，官方写法）：
  # 否则它会在 ~/Library/Caches/copilot/pkg 里偷偷解包新版本，既重建缓存、
  # 又可能让层1 的 fh() 挑中新版本 JS，与钉死的 CLI 二进制错位。
  export COPILOT_AUTO_UPDATE=false
  # LaunchAgent/login shell 会带 HOME；勿写死本机用户名
  if [[ -z "${HOME:-}" ]]; then
    HOME="$(cd ~ && pwd)"
  fi
  export HOME

  echo "headless-daemon: run pid=$$ bin=${COPILOT_BIN}" >>"${LOG_FILE}"
  echo "headless-daemon: sdk=${SDK_PATH}" >>"${LOG_FILE}"
  echo "headless-daemon: dist=${DIST_DIR}" >>"${LOG_FILE}"
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
