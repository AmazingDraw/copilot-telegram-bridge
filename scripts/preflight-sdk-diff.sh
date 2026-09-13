#!/usr/bin/env bash
# 升级前预览：「这次升级会改什么」——不下载整包、不切换任何东西、不碰运行中的守护。
#
# 用法:
#   bash scripts/preflight-sdk-diff.sh              # 目标 = npm latest
#   bash scripts/preflight-sdk-diff.sh 1.0.90       # 指定目标版本
#   bash scripts/preflight-sdk-diff.sh --summary    # 只打结论（给脚本调用）
#
# 原理：npm 平台包的文件可**单文件**取（默认 unpkg；jsdelivr 实测 403 不可用），
# 所以几 MB 就能把 SDK 的 API 面与上游 changelog 拉下来，跟当前 runtime/<ver> 逐面 diff。
#
# 退出码:
#   0 = 关键 API 面无变化（可以升）
#   1 = 关键面有变化（必须逐项确认后再升）
#   2 = 变化 + bootstrap 父进程门闩 pattern 不命中（升了会静默崩循环，先别升）
#   3 = 取不到目标版本信息（网络 / unpkg 不可达）——不代表有变化，但预览没做成
set -uo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ROOT="${EXT_DIR}/runtime"
UNPKG_BASE="${UNPKG_BASE:-https://unpkg.com}"
SUMMARY_ONLY=0

ARGS=()
for a in "$@"; do
  case "$a" in
    --summary) SUMMARY_ONLY=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done

# shellcheck source=/dev/null
source "${EXT_DIR}/scripts/runtime-common.sh"

TARGET_WANT="${ARGS[0]:-latest}"
PKG="$(npm_pkg_name)"

echo "preflight-sdk-diff: 目标 ${PKG}@${TARGET_WANT}"

TARGET_VER="$(resolve_npm_version "${TARGET_WANT}")" || exit 3
CUR_VER="$(tr -d '[:space:]' <"${RUNTIME_ROOT}/VERSION" 2>/dev/null || true)"
CUR_PKG=""
if [[ -n "${CUR_VER}" && -d "${RUNTIME_ROOT}/${CUR_VER}/pkg/copilot-sdk" ]]; then
  CUR_PKG="${RUNTIME_ROOT}/${CUR_VER}/pkg"
fi

echo "preflight-sdk-diff: 当前钉死 ${CUR_VER:-（无）}"
echo

if [[ "${TARGET_VER}" == "${CUR_VER}" && -n "${CUR_VER}" ]]; then
  echo "preflight-sdk-diff: 目标版本与当前钉死版本相同（${TARGET_VER}）—— 只做体检，不会有事需要跟上。"
  echo
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/preflight-sdk.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

fetch() { # fetch <相对路径> <落盘名>
  local rel="$1" out="$2" url code
  url="${UNPKG_BASE}/${PKG}@${TARGET_VER}/${rel}"
  if ! code="$(curl -sS -L --max-time 60 -o "${TMP}/${out}" -w '%{http_code}' "${url}" 2>/dev/null)"; then
    echo "preflight-sdk-diff: 取不到 ${url}（网络不可达？）" >&2
    return 1
  fi
  if [[ "${code}" != "200" ]]; then
    echo "preflight-sdk-diff: ${url} → HTTP ${code}" >&2
    return 1
  fi
  return 0
}

mkdir -p "${TMP}/new"
for f in copilot-sdk/types.d.ts copilot-sdk/generated/session-events.d.ts \
         copilot-sdk/generated/rpc.d.ts copilot-sdk/index.d.ts \
         preloads/extension_bootstrap.mjs changelog.json; do
  if ! fetch "${f}" "$(basename "${f}")"; then
    echo "preflight-sdk-diff: 预览失败（无法取到目标版本的 SDK 文件）。" >&2
    echo "  → 网络恢复后重试；或离线时给 vendor 脚本加 --no-preflight 自行承担风险。" >&2
    exit 3
  fi
done

# ⑥ bootstrap 门闩：用**唯一的软化真源**做 dry-run（检查器与升级时的实际行为同源）
PATCH_RC=0
python3 "${EXT_DIR}/scripts/patch-bootstrap-compat.py" --dry-run --prefix preflight \
  "${TMP}/extension_bootstrap.mjs" >"${TMP}/patch.out" 2>&1 || PATCH_RC=$?

python3 - "${TMP}" "${CUR_PKG}" "${TARGET_VER}" "${CUR_VER}" "${PATCH_RC}" "${SUMMARY_ONLY}" <<'PY'
import json, pathlib, re, sys

tmp, cur_pkg, new_ver, cur_ver, patch_rc, summary_only = (
    pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5]), sys.argv[6] == "1",
)

def strip_comments(t):
    """先剥注释再解析：`/ * ... * /` 与 `// ...`。
    教训：PermissionMode 的文档注释里有分号（"...recommendation; clients..."），
    非贪婪匹配会在注释里就截断 → 只解析到 1 个取值。剥注释后才稳。"""
    if not t:
        return t
    t = re.sub(r"/\*.*?\*/", " ", t, flags=re.S)
    t = re.sub(r"(?<!:)//[^\n]*", " ", t)  # 保留 https:// 之类
    return t


def read(base, rel):
    if not base or not rel:
        return None
    p = base / rel
    try:
        return strip_comments(p.read_text(encoding="utf-8")) if p.is_file() else None
    except Exception:
        return None

# 新版：unpkg 单文件是平铺落盘的；当前版：runtime/<ver>/pkg 下的原路径
NEW_FILES = {
    "types": "types.d.ts",
    "events": "session-events.d.ts",
    "rpc": "rpc.d.ts",
    "index": "index.d.ts",
}
CUR_FILES = {
    "types": "copilot-sdk/types.d.ts",
    "events": "copilot-sdk/generated/session-events.d.ts",
    "rpc": "copilot-sdk/generated/rpc.d.ts",
    "index": "copilot-sdk/index.d.ts",
}

def block_names(text, header, want_any=None):
    """提取 `header: {` / `header {` 块内的标识符字段；want_any 用于在多个同名列中挑对的那个块。"""
    if not text:
        return None
    lines = text.splitlines()
    for i, l in enumerate(lines):
        s = l.strip()
        if s not in (f"{header}: {{", f"{header} {{", f"export interface {header} {{"):
            continue
        depth, names = 0, []
        for l2 in lines[i:]:
            depth += l2.count("{") - l2.count("}")
            s2 = l2.strip()
            if l2 is not lines[i] and s2.endswith(";") and ": " in s2:
                n = s2.split(":")[0].strip()
                if n.isidentifier():
                    names.append(n)
            if depth == 0:
                break
        if want_any is None or any(n in names for n in want_any):
            return sorted(set(names))
    return None

def union(text, name):
    """解析 `export type <name> = "a" | "b" | ...;`（跨行）"""
    if not text:
        return None
    m = re.search(rf"export type {name} =\s*(.*?);", text, re.S)
    if not m:
        return None
    return sorted(set(re.findall(r'"([^"]+)"', m.group(1))))

def session_config_fields(text):
    if not text:
        return None
    m = re.search(r"export interface SessionConfigBase \{", text)
    if not m:
        return None
    depth, names = 0, []
    for l in text[m.end():].splitlines():
        depth += l.count("{") - l.count("}")
        s = l.strip()
        if s.endswith(";") and ": " in s:
            n = re.split(r"[?:]", s.split(":")[0])[0].strip()
            if n.isidentifier():
                names.append(n)
        if depth < 0:
            break
    return sorted(set(names))

def exports(text):
    if not text:
        return None
    names = set()
    for m in re.finditer(r"export \{([^}]*)\}", text, re.S):
        for part in m.group(1).split(","):
            n = part.strip()
            if n.isidentifier():
                names.add(n)
    return sorted(names)

def fields(base, mapping):
    return {
        "① SystemMessageSection（提示词裁剪的段名）": union(read(base, mapping["types"]), "SystemMessageSection"),
        "② permissions RPC 面（放行/收紧权限的入口）": block_names(
            read(base, mapping["rpc"]), "permissions", want_any=("setApproveAll", "setAllowAll", "setMode", "getMode")
        ),
        "③ PermissionMode（权限模式取值）": union(read(base, mapping["events"]), "PermissionMode"),
        "④ SessionConfig 字段（我们注入的配置名）": session_config_fields(read(base, mapping["types"])),
        "⑤ SDK 导出符号": exports(read(base, mapping["index"])),
    }

new_path = tmp
cur_path = pathlib.Path(cur_pkg) if cur_pkg else None
new_f = fields(tmp, NEW_FILES)
cur_f = fields(cur_path, CUR_FILES) if cur_path else fields(None, CUR_FILES)

# ---- 升级内容：上游 changelog（版本 > 当前） ----
def ver_tuple(v):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?", v or "")
    return tuple(int(x) if x else 0 for x in m.groups()) if m else None

entries = []
try:
    cl = json.loads(read(tmp, "changelog.json") or "{}")
    tv = ver_tuple(new_ver)
    cv = ver_tuple(cur_ver) if cur_ver else None
    for k, v in cl.items():
        if k.startswith("$") or k == "unpublished" or not isinstance(v, list):
            continue
        kt = ver_tuple(k)
        if not kt or (tv and kt > tv):
            continue
        if cv and kt <= cv:
            continue
        for e in v:
            if isinstance(e, dict) and e.get("description"):
                entries.append((k, e.get("type", "?"), e["description"]))
except Exception:
    pass

if not summary_only:
    print("═" * 78)
    print(f"升级内容（上游 changelog，{cur_ver or '—'} → {new_ver}）")
    print("═" * 78)
    if cur_ver and entries:
        for v, t, d in entries[:25]:
            print(f"  [{v}] ({t}) {d[:150]}")
        if len(entries) > 25:
            print(f"  … 另有 {len(entries) - 25} 条")
    elif not cur_ver:
        print("  （没有当前版本可比，跳过）")
    else:
        print("  （changelog 里没有落在该区间的条目）")
    print()

print("═" * 78)
print(f"关键 API 面 diff：{cur_ver or '—'} → {new_ver}")
print("═" * 78)

CRITICAL = ("①", "②", "③", "④")
changed, critical_changed = [], []

for label in ("① SystemMessageSection（提示词裁剪的段名）",
              "② permissions RPC 面（放行/收紧权限的入口）",
              "③ PermissionMode（权限模式取值）",
              "④ SessionConfig 字段（我们注入的配置名）",
              "⑤ SDK 导出符号"):
    n, c = new_f[label], cur_f[label]
    if n is None:
        print(f"{label}\n    ⚠️ 新版本里没解析到（写法变了？）")
        if label.startswith(CRITICAL):
            changed.append(label); critical_changed.append(label)
        continue
    if c is None:
        print(f"{label}\n    ℹ️ 无当前版本可对比：新版共 {len(n)} 项")
        continue
    added, removed = [x for x in n if x not in c], [x for x in c if x not in n]
    if not added and not removed:
        print(f"{label}\n    ✅ 无变化（{len(n)} 项）")
        continue
    changed.append(label)
    if label.startswith(CRITICAL):
        critical_changed.append(label)
    print(f"{label}")
    if removed:
        print(f"    ⚠️ 消失: {', '.join(removed)}")
    if added:
        print(f"    ℹ️ 新增: {', '.join(added)}")

print()
print("⑥ bootstrap 父进程门闩（软化 pattern 是否仍命中）")
patch_out = (tmp / "patch.out").read_text(encoding="utf-8").strip() if (tmp / "patch.out").is_file() else ""
if patch_rc == 2:
    print("    ⚠️ pattern miss —— 升级后**会静默崩循环**，先人工对齐 scripts/patch-bootstrap-compat.py")
elif patch_rc == 0:
    print(f"    ✅ {patch_out.split('compat', 1)[-1].strip(': ') if patch_out else 'ok'}")
else:
    print(f"    ⚠️ 检查器返回 {patch_rc}：{patch_out}")

print()
print("═" * 78)
if patch_rc == 2:
    print("结论：❌ 别升 —— 门闩 pattern 不命中，升级会崩循环。")
    rc = 2
elif critical_changed:
    print(f"结论：⚠️ 关键面有变化（{len(critical_changed)} 项）→ 逐项确认后再升级，见 doc/sdk-upgrade.md")
    rc = 1
else:
    print("结论：✅ 关键 API 面无变化 → 可以升级。")
    rc = 0
print("═" * 78)
sys.exit(rc)
PY
