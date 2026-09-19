#!/usr/bin/env bash
# 把成对的 Copilot CLI + pkg（SDK + extension bootstrap）钉进 runtime/。
# 默认从 npm 平台包拉（不需要 Copilot.app）。二进制 gitignore；VERSION 进 Git。
#
# **两阶段**：先看升级内容 → 确认 → 才真的升级。
#   ① 先跑 scripts/preflight-sdk-diff.sh：上游 changelog + 5 个关键 API 面 diff + bootstrap 门闩 pattern
#   ② 关键面有变化时必须完整输入 yes 才继续；非交互环境（无 TTY）默认拒绝，除非显式 --yes
#
# 用法:
#   bash scripts/vendor-copilot-runtime.sh                 # 当前平台 latest
#   bash scripts/vendor-copilot-runtime.sh 1.0.90          # 钉死版本
#   bash scripts/vendor-copilot-runtime.sh 1.0.90 --yes    # 无人值守（自行承担确认责任）
#   bash scripts/vendor-copilot-runtime.sh --no-preflight  # 跳过预览（离线时）
#   bash scripts/vendor-copilot-runtime.sh --from-cache    # 仅当本机还有 App 解包缓存（隐含不出网）
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_PKG_ROOT="${HOME}/Library/Caches/copilot/pkg"
CLI_ROOT="${HOME}/Library/Caches/github-copilot-sdk/cli"
RUNTIME_ROOT="${EXT_DIR}/runtime"

# 平台名 / npm 包名 / 版本解析的唯一真源
# shellcheck source=/dev/null
source "${EXT_DIR}/scripts/runtime-common.sh"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

pkg_complete() {
  local dir="$1"
  [[ -n "${dir}" && -d "${dir}/copilot-sdk" && -f "${dir}/preloads/extension_bootstrap.mjs" ]]
}

# 现在整个 pkg 就是 CLI 的 JS 运行时（headless-daemon 用 COPILOT_CLI_DIST_DIR 钉住它），
# 所以**不再剥** builtin/ builtin-skills/ assets/ changelog.json —— 运行期可能引用，
# 剥掉会变成难查的静默失败（实测这四项合计仅 ~1.4MB，不值得省）。
# 只清真正的垃圾：.DS_Store/._*/inuse 锁残留/旧软化备份。
# 保留 `.extraction-complete`：让 vendored pkg 与 CLI 自己解包出来的结构完全一致。
prune_vendored_pkg() {
  local pkg="$1"
  find "${pkg}" \( -name '.DS_Store' -o -name '._*' -o -name 'inuse.*.lock' \) -delete 2>/dev/null || true
  find "${pkg}/preloads" -name '*.bak-compat-*' -delete 2>/dev/null || true
  echo "vendor-copilot-runtime: cleaned junk (builtin/ assets/ changelog/.extraction-complete 保留：整个 pkg 就是运行时)"
}


# App 解包缓存：~/Library/Caches/copilot/pkg/<plat>/<ver>
detect_cache_plat() {
  local plat
  plat="$(detect_npm_plat)"
  if [[ -d "${CACHE_PKG_ROOT}/${plat}" ]]; then
    echo "${plat}"
    return 0
  fi
  if [[ -d "${CACHE_PKG_ROOT}/darwin-arm64" ]]; then
    echo "darwin-arm64"
    return 0
  fi
  echo "${plat}"
}

# 升级确认闸门：默认**必须**人工确认；非交互环境（无 TTY）一律拒绝，除非 --yes。
# 关键面有变化（rc=1）或预览没做成（rc=3）时，要求完整输入 "yes"（把"顺手回车"挡掉）。
ASSUME_YES=0
confirm_upgrade() {
  local ver="$1" rc="${2:-0}" need="y" note=""
  if [[ "${ASSUME_YES}" -eq 1 ]]; then
    echo "vendor-copilot-runtime: --yes 已给 → 跳过确认（→ ${ver}）"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    echo "error: 非交互环境（stdin 不是 TTY）→ 不盲升。" >&2
    echo "  先看预览：bash ${EXT_DIR}/scripts/preflight-sdk-diff.sh ${ver}" >&2
    echo "  确认无误后：bash $0 ${ver} --yes" >&2
    return 1
  fi
  if [[ "${rc}" -eq 1 ]]; then need="yes"; note="（⚠️ 检测到关键 API 面变化，需完整输入 yes）"; fi
  if [[ "${rc}" -eq 3 ]]; then need="yes"; note="（⚠️ 预览没做成，风险未知，需完整输入 yes）"; fi
  printf '\n确认升级到 %s ？%s\n  输入 %s 继续，其它=中止: ' "${ver}" "${note}" "${need}"
  local ans=""
  read -r ans || ans=""
  if [[ "${ans}" == "${need}" ]]; then
    return 0
  fi
  return 1
}

# 换运行时是「停 → 换 → 自动拉起」闭环：避免 rsync --delete 与运行中的进程抢文件，
# 也省掉主人手动 restart。只有本来就在跑的守护才会被拉起，不擅自开新实例。
DAEMON_WAS_RUNNING=0
stop_daemon_for_swap() {
  local daemon="${EXT_DIR}/scripts/headless-daemon.sh"
  [[ -f "${daemon}" ]] || return 0
  if launchctl print "gui/$(id -u)/com.copilot-telegram-bridge" >/dev/null 2>&1 \
    || [[ -f "${EXT_DIR}/bots/Headless/daemon.pid" ]]; then
    DAEMON_WAS_RUNNING=1
    echo "vendor-copilot-runtime: stopping headless daemon before swapping runtime..."
    bash "${daemon}" stop >/dev/null 2>&1 || true
  fi
}
start_daemon_after_swap() {
  local daemon="${EXT_DIR}/scripts/headless-daemon.sh"
  if [[ "${DAEMON_WAS_RUNNING}" -ne 1 ]]; then
    echo "vendor-copilot-runtime: 守护本来没在跑；需要时: bash ${daemon} start"
    return 0
  fi
  echo "vendor-copilot-runtime: starting headless daemon (align → vendored:$(tr -d '[:space:]' <"${RUNTIME_ROOT}/VERSION"))"
  bash "${daemon}" start || echo "vendor-copilot-runtime: warn: start 失败，手动跑 bash ${daemon} start" >&2
  bash "${daemon}" status || true
}

install_from_extract() {
  local ver="$1" copilot_bin="$2" pkg_dir="${3:-}"
  local dest="${RUNTIME_ROOT}/${ver}"
  echo "vendor-copilot-runtime: ${ver}"
  echo "  cli=${copilot_bin}"
  echo "  dest=${dest}"

  if [[ ! -f "${copilot_bin}" ]]; then
    echo "error: CLI binary missing: ${copilot_bin}" >&2
    exit 1
  fi

  mkdir -p "${dest}/cli" "${dest}/pkg"
  # 换文件前先停守护（已下载完成，停机窗口只有几秒）
  stop_daemon_for_swap
  rsync -a --delete "${copilot_bin}" "${dest}/cli/copilot"
  chmod +x "${dest}/cli/copilot"

  # pkg 内容取自 **CLI 二进制内嵌的 copilot.tgz**（它自己会在无 DIST_DIR 时解包的那份），
  # 不用 npm 平台包里的 JS 外壳：两者只有 package.json 不同（@github/copilot vs
  # @github/copilot-<plat>），而 app.js 会读 package.json —— 现在整个 pkg 就是运行时，
  # 必须与 CLI 自解包的版本逐字节一致。
  # 强制走解包分支：--no-auto-update 关掉「挑缓存里更新的版本」，COPILOT_PKG_CACHE_HOME 指到临时目录。
  local selfhome src
  selfhome="$(mktemp -d "${TMPDIR:-/tmp}/vendor-selfextract.XXXXXX")"
  echo "  self-extract: ${selfhome}"
  if ! COPILOT_PKG_CACHE_HOME="${selfhome}" COPILOT_AUTO_UPDATE=false \
    "${dest}/cli/copilot" --no-auto-update --version >/dev/null 2>&1; then
    echo "error: CLI 自解包失败（--version 退出非 0）" >&2
    rm -rf "${selfhome}"
    echo "  守护已停止；修好后: bash ${EXT_DIR}/scripts/headless-daemon.sh start" >&2
    exit 1
  fi
  src="${selfhome}/pkg/$(detect_npm_plat)/${ver}"
  if [[ ! -f "${src}/index.js" || ! -f "${src}/app.js" ]]; then
    echo "error: CLI 自解包结果不完整: ${src}" >&2
    rm -rf "${selfhome}"
    echo "  守护已停止；修好后: bash ${EXT_DIR}/scripts/headless-daemon.sh start" >&2
    exit 1
  fi
  rsync -a --delete "${src}/" "${dest}/pkg/"
  rm -rf "${selfhome}"
  prune_vendored_pkg "${dest}/pkg"

  if ! pkg_complete "${dest}/pkg"; then
    echo "error: pkg incomplete (need copilot-sdk/ + preloads/extension_bootstrap.mjs): ${dest}/pkg" >&2
    exit 1
  fi

  printf '%s\n' "${ver}" >"${RUNTIME_ROOT}/VERSION"

  local bootstrap="${dest}/pkg/preloads/extension_bootstrap.mjs"
  # 父进程门闩软化：唯一真源 scripts/patch-bootstrap-compat.py（三处共用）。
  # pattern 不命中 = 上游改了写法 → 直接让本脚本失败退出（宁可不升级，也不要静默崩循环）。
  python3 "${EXT_DIR}/scripts/patch-bootstrap-compat.py" --prefix vendor-copilot-runtime "${bootstrap}"

  echo "vendor-copilot-runtime: done (gitignores binaries; VERSION=${ver})"
  ls -lh "${dest}/cli/copilot"
  du -sh "${dest}"
  start_daemon_after_swap
}

vendor_from_cache() {
  local want_ver="${1:-}"
  local cache_plat copilot_bin="" pkg_dir="" ver=""
  cache_plat="$(detect_cache_plat)"
  local cache_pkg="${CACHE_PKG_ROOT}/${cache_plat}"

  while IFS= read -r bin; do
    [[ -n "${bin}" && -x "${bin}" ]] || continue
    ver="$(basename "$(dirname "${bin}")")"
    if [[ -n "${want_ver}" && "${ver}" != "${want_ver}" ]]; then
      continue
    fi
    local candidate="${cache_pkg}/${ver}"
    if pkg_complete "${candidate}"; then
      copilot_bin="${bin}"
      pkg_dir="${candidate}"
      break
    fi
  done < <(ls -1t "${CLI_ROOT}"/*/copilot 2>/dev/null || true)

  if [[ -z "${copilot_bin}" || -z "${pkg_dir}" ]]; then
    echo "error: no matched CLI/pkg pair under Caches (plat=${cache_plat}). Use npm (default) or copy files yourself." >&2
    exit 1
  fi
  install_from_extract "${ver}" "${copilot_bin}" "${pkg_dir}"
}

vendor_from_npm() {
  local want_ver="${1:-latest}"
  local plat pkg_name meta_url tgz
  plat="$(detect_npm_plat)"
  pkg_name="@github/copilot-${plat}"
  if [[ "${want_ver}" == "latest" ]]; then
    meta_url="${NPM_REGISTRY}/${pkg_name}/latest"
  else
    meta_url="${NPM_REGISTRY}/${pkg_name}/${want_ver}"
  fi

  echo "vendor-copilot-runtime: npm ${pkg_name}@${want_ver}"
  # tmp 必须是脚本级变量：EXIT trap 在函数返回后才执行，local 会在 set -u 下报 unbound variable
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/vendor-copilot.XXXXXX")"
  trap 'rm -rf "${tmp:-}"' EXIT

  if ! curl -fsSL --retry 3 --retry-delay 2 "${meta_url}" >"${tmp}/meta.json"; then
    echo "error: npm metadata failed: ${meta_url}" >&2
    echo "（网络卡顿时不要改 Stash，把这段报错给主人。）" >&2
    exit 1
  fi

  python3 - "${tmp}/meta.json" "${tmp}" <<'PY'
import json, pathlib, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
ver = d.get("version")
dist = d.get("dist") or {}
tarball = dist.get("tarball")
shasum = dist.get("shasum") or ""
if not ver or not tarball:
    raise SystemExit("npm metadata missing version/tarball")
out = pathlib.Path(sys.argv[2])
(out / "ver").write_text(ver, encoding="utf-8")
(out / "tarball").write_text(tarball, encoding="utf-8")
(out / "shasum").write_text(shasum, encoding="utf-8")
PY
  local ver tarball shasum
  ver="$(tr -d '[:space:]' <"${tmp}/ver")"
  tarball="$(tr -d '[:space:]' <"${tmp}/tarball")"
  shasum="$(tr -d '[:space:]' <"${tmp}/shasum")"

  echo "  tarball=${tarball}"
  tgz="${tmp}/copilot.tgz"
  if ! curl -fL --retry 3 --retry-delay 2 -o "${tgz}" "${tarball}"; then
    echo "error: download failed: ${tarball}" >&2
    echo "（网络卡顿时不要改 Stash，把这段报错给主人。）" >&2
    exit 1
  fi

  if [[ -n "${shasum}" ]]; then
    python3 - "${tgz}" "${shasum}" <<'PY'
import hashlib, pathlib, sys
path, expect = pathlib.Path(sys.argv[1]), sys.argv[2].lower()
got = hashlib.sha1(path.read_bytes()).hexdigest()
if got != expect:
    raise SystemExit(f"tarball sha1 mismatch: got={got} expect={expect}")
print(f"vendor-copilot-runtime: sha1 ok {got}")
PY
  fi

  mkdir -p "${tmp}/extract"
  tar -xzf "${tgz}" -C "${tmp}/extract"
  local pkg_root="${tmp}/extract/package"
  install_from_extract "${ver}" "${pkg_root}/copilot" "${pkg_root}"
}

FROM_CACHE=0
NO_PREFLIGHT=0
VER_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --from-cache)
      FROM_CACHE=1
      shift
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    --no-preflight)
      NO_PREFLIGHT=1
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown flag $1 (see --help)" >&2
      exit 1
      ;;
    *)
      if [[ -n "${VER_ARG}" ]]; then
        echo "error: extra argument: $1" >&2
        exit 1
      fi
      VER_ARG="$1"
      shift
      ;;
  esac
done

if [[ "${FROM_CACHE}" -eq 1 ]]; then
  # 离线路径：不查 npm、不预览（本来就没网）
  echo "vendor-copilot-runtime: --from-cache（离线）→ 跳过升级预览与关键面 diff"
  confirm_upgrade "${VER_ARG:-<cache 里最新>}" 0 || { echo "已中止，未改动任何文件。"; exit 1; }
  vendor_from_cache "${VER_ARG}"
else
  # 入口处把 latest 解析成确定版本：保证"预览的版本"就是"实际拉的版本"
  TARGET_VER="$(resolve_npm_version "${VER_ARG:-latest}")" || exit 3
  PRE_RC=0
  if [[ "${NO_PREFLIGHT}" -eq 1 ]]; then
    echo "vendor-copilot-runtime: --no-preflight → 跳过升级内容预览与关键面 diff"
  else
    set +e
    bash "${EXT_DIR}/scripts/preflight-sdk-diff.sh" "${TARGET_VER}"
    PRE_RC=$?
    set -e
    if [[ "${PRE_RC}" -eq 3 ]]; then
      echo "vendor-copilot-runtime: warn: 预览没做成（网络 / unpkg 不可达）" >&2
    fi
  fi
  confirm_upgrade "${TARGET_VER}" "${PRE_RC}" || { echo "已中止，未改动任何文件。"; exit 1; }
  vendor_from_npm "${TARGET_VER}"
fi
