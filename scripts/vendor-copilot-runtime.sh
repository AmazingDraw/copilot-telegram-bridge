#!/usr/bin/env bash
# 把成对的 Copilot CLI + pkg（SDK + extension bootstrap）钉进 runtime/。
# 默认从 npm 平台包拉（不需要 Copilot.app）。二进制 gitignore；VERSION 进 Git。
#
# 用法:
#   bash scripts/vendor-copilot-runtime.sh              # 当前平台 latest
#   bash scripts/vendor-copilot-runtime.sh 1.0.80       # 钉死版本
#   bash scripts/vendor-copilot-runtime.sh --from-cache # 仅当本机还有 App 解包缓存
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_PKG_ROOT="${HOME}/Library/Caches/copilot/pkg"
CLI_ROOT="${HOME}/Library/Caches/github-copilot-sdk/cli"
RUNTIME_ROOT="${EXT_DIR}/runtime"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

pkg_complete() {
  local dir="$1"
  [[ -n "${dir}" && -d "${dir}/copilot-sdk" && -f "${dir}/preloads/extension_bootstrap.mjs" ]]
}

# Copilot 自带 skill / 解包垃圾：无头不用，升版本也剥掉。
prune_vendored_pkg() {
  local pkg="$1"
  rm -rf "${pkg}/builtin" "${pkg}/builtin-skills" "${pkg}/assets"
  rm -f "${pkg}/changelog.json"
  find "${pkg}" \( -name '.DS_Store' -o -name '._*' -o -name '.extraction-complete' -o -name 'inuse.*.lock' \) -delete 2>/dev/null || true
  find "${pkg}/preloads" -name '*.bak-compat-*' -delete 2>/dev/null || true
  echo "vendor-copilot-runtime: stripped builtin/ builtin-skills/ assets/ changelog + junk markers"
}

detect_npm_plat() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *)
      echo "error: unsupported arch ${arch}" >&2
      return 1
      ;;
  esac
  case "${os}" in
    darwin) echo "darwin-${arch}" ;;
    linux)
      if ldd /bin/sh 2>&1 | grep -qi musl; then
        echo "linuxmusl-${arch}"
      else
        echo "linux-${arch}"
      fi
      ;;
    *)
      echo "error: unsupported OS ${os} (use a Mac/Linux host, or copy runtime/ by hand)" >&2
      return 1
      ;;
  esac
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

install_from_extract() {
  local ver="$1" copilot_bin="$2" pkg_dir="$3"
  local dest="${RUNTIME_ROOT}/${ver}"
  echo "vendor-copilot-runtime: ${ver}"
  echo "  cli=${copilot_bin}"
  echo "  pkg=${pkg_dir}"
  echo "  dest=${dest}"

  if ! pkg_complete "${pkg_dir}"; then
    echo "error: pkg incomplete (need copilot-sdk/ + preloads/extension_bootstrap.mjs): ${pkg_dir}" >&2
    exit 1
  fi
  if [[ ! -f "${copilot_bin}" ]]; then
    echo "error: CLI binary missing: ${copilot_bin}" >&2
    exit 1
  fi

  mkdir -p "${dest}/cli" "${dest}/pkg"
  rsync -a --delete "${copilot_bin}" "${dest}/cli/copilot"
  chmod +x "${dest}/cli/copilot"
  rsync -a --delete \
    --exclude '*.map' \
    --exclude '/copilot' \
    --exclude '/builtin/' \
    --exclude '/builtin-skills/' \
    "${pkg_dir}/" "${dest}/pkg/"
  prune_vendored_pkg "${dest}/pkg"

  printf '%s\n' "${ver}" >"${RUNTIME_ROOT}/VERSION"

  local bootstrap="${dest}/pkg/preloads/extension_bootstrap.mjs"
  python3 - "${bootstrap}" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
MARKER = "HEADLESS_BOOTSTRAP_COMPAT_V1"
text = path.read_text(encoding="utf-8")
if MARKER in text or "continuing without parent watch (headless-daemon compat)" in text:
    print(f"vendor-copilot-runtime: bootstrap already patched: {path}")
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
        print(f"vendor-copilot-runtime: no parent gate: {path}")
        raise SystemExit(0)
    print(f"vendor-copilot-runtime: bootstrap pattern miss: {path}", file=sys.stderr)
    raise SystemExit(1)
soft = f"""// {MARKER} — telegram-bridge vendored runtime
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
path.write_text(text[: m.start()] + soft + text[m.end() :], encoding="utf-8")
print(f"vendor-copilot-runtime: patched bootstrap {path}")
PY

  echo "vendor-copilot-runtime: done (gitignores binaries; VERSION=${ver})"
  ls -lh "${dest}/cli/copilot"
  du -sh "${dest}"
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
  local plat pkg_name meta_url tmp tgz
  plat="$(detect_npm_plat)"
  pkg_name="@github/copilot-${plat}"
  if [[ "${want_ver}" == "latest" ]]; then
    meta_url="${NPM_REGISTRY}/${pkg_name}/latest"
  else
    meta_url="${NPM_REGISTRY}/${pkg_name}/${want_ver}"
  fi

  echo "vendor-copilot-runtime: npm ${pkg_name}@${want_ver}"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/vendor-copilot.XXXXXX")"
  trap 'rm -rf "${tmp}"' EXIT

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
  vendor_from_cache "${VER_ARG}"
else
  vendor_from_npm "${VER_ARG:-latest}"
fi
