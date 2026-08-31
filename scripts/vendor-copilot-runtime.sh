#!/usr/bin/env bash
# Copy a matched Copilot CLI + pkg (SDK + bootstrap) into Bridge-managed runtime/.
# Binaries are gitignored; VERSION is tracked so status/docs know the pin.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_PKG="${HOME}/Library/Caches/copilot/pkg/darwin-arm64"
CLI_ROOT="${HOME}/Library/Caches/github-copilot-sdk/cli"
RUNTIME_ROOT="${EXT_DIR}/runtime"

pkg_complete() {
  local dir="$1"
  [[ -n "${dir}" && -d "${dir}/copilot-sdk" && -f "${dir}/preloads/extension_bootstrap.mjs" ]]
}

COPILOT_BIN=""
PKG_DIR=""
VER=""
while IFS= read -r bin; do
  [[ -n "${bin}" && -x "${bin}" ]] || continue
  VER="$(basename "$(dirname "${bin}")")"
  candidate="${CACHE_PKG}/${VER}"
  if pkg_complete "${candidate}"; then
    COPILOT_BIN="${bin}"
    PKG_DIR="${candidate}"
    break
  fi
done < <(ls -1t "${CLI_ROOT}"/*/copilot 2>/dev/null || true)

if [[ -z "${COPILOT_BIN}" || -z "${PKG_DIR}" ]]; then
  echo "error: no matched CLI/pkg pair under Caches (need Copilot App unpack once, or copy files yourself)" >&2
  exit 1
fi

DEST="${RUNTIME_ROOT}/${VER}"
echo "vendor-copilot-runtime: ${VER}"
echo "  cli=${COPILOT_BIN}"
echo "  pkg=${PKG_DIR}"
echo "  dest=${DEST}"

mkdir -p "${DEST}/cli" "${DEST}/pkg"
rsync -a --delete "${COPILOT_BIN}" "${DEST}/cli/copilot"
chmod +x "${DEST}/cli/copilot"
rsync -a --delete \
  --exclude '*.map' \
  "${PKG_DIR}/" "${DEST}/pkg/"

printf '%s\n' "${VER}" >"${RUNTIME_ROOT}/VERSION"

# Soften parent-pid gate on the vendored bootstrap (same patch as former cache mutate).
BOOTSTRAP="${DEST}/pkg/preloads/extension_bootstrap.mjs"
python3 - "${BOOTSTRAP}" <<'PY'
import pathlib, re, sys, time
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

echo "vendor-copilot-runtime: done (gitignores binaries; VERSION=${VER})"
ls -lh "${DEST}/cli/copilot"
du -sh "${DEST}"
