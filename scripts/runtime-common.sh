#!/usr/bin/env bash
# 运行时相关的**共享**小函数（单一真源）。被以下脚本 source：
#   scripts/vendor-copilot-runtime.sh   （换版本）
#   scripts/preflight-sdk-diff.sh       （升级前预览）
# 只放"两边都要用、写错就出事"的东西：平台名、npm 包名、版本解析。

NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

# macOS arm64 → darwin-arm64（与 @github/copilot-<plat> 的命名一致）
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

npm_pkg_name() {
  echo "@github/copilot-$(detect_npm_plat)"
}

# 解析 npm 上的版本号：resolve_npm_version latest | <ver>  → 打印确定版本
resolve_npm_version() {
  local want="${1:-latest}" pkg meta ver
  pkg="$(npm_pkg_name)"
  if ! meta="$(curl -fsSL --retry 3 --retry-delay 2 "${NPM_REGISTRY}/${pkg}/${want}")"; then
    echo "error: npm metadata failed: ${NPM_REGISTRY}/${pkg}/${want}" >&2
    echo "（网络卡顿时不要改 Stash，把这行报错给主人。）" >&2
    return 1
  fi
  ver="$(printf '%s' "${meta}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version") or "")')"
  if [[ -z "${ver}" ]]; then
    echo "error: npm metadata 里没有 version 字段" >&2
    return 1
  fi
  echo "${ver}"
}
