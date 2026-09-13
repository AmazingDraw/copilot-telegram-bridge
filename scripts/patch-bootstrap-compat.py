#!/usr/bin/env python3
"""bootstrap 父进程门闩软化 —— **单一真源**。

Copilot >= 1.0.79 的 `pkg/preloads/extension_bootstrap.mjs` 里有这一段：

    const parentPid = Number(process.env.COPILOT_EXTENSION_PARENT_PID);
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || process.ppid !== parentPid) {
        process.exit(0);
    }
    ... parentWatch ...

无头用 `copilot <bootstrap.mjs>` 启动时通常**不带**该 env → 直接 **静默 exit(0)**
→ launchd KeepAlive 崩循环（2026-09-13 升级 1.0.83 就是这么炸的）。
本脚本**幂等**软化它：有合法 parent 仍守护，未设置则继续跑。

为什么单独成文件：软化逻辑原来在 headless-daemon.sh 与 vendor-copilot-runtime.sh 里各写一份，
再加"升级前检查器"就会变成三份 → 检查器与实际行为可能各说一套（正是我们要消灭的静默漂移）。
现在三处共用本文件：

    scripts/headless-daemon.sh          每次 run 前（防被覆盖）
    scripts/vendor-copilot-runtime.sh   换版本、装完 pkg 后
    scripts/preflight-sdk-diff.sh       升级前 dry-run：验证新版 pattern 是否仍命中

退出码：0 = 已软化 / 无需软化 / 早已软化   2 = pattern 不命中（写法变了，要人工看）   3 = 文件不存在
"""

import argparse
import pathlib
import re
import shutil
import sys
import time

MARKER = "HEADLESS_BOOTSTRAP_COMPAT_V1"
LEGACY_HINT = "continuing without parent watch (headless-daemon compat)"

# 「这里有没有父进程门闩」的语义信号（改写/改名后仍能被认出来 → 报 pattern miss 而不是「无需软化」）
GATE_SIGNALS = (
    "!Number.isSafeInteger(parentPid)",
    "process.ppid !== parentPid",
)

# 与历史实现逐字一致：只认原样的门闩写法
GATE_PATTERN = re.compile(
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

SOFT = f"""// {MARKER} — telegram-bridge headless compat
// Soften parent-pid gate: unset COPILOT_EXTENSION_PARENT_PID used to silent-exit(0) and crash-loop launchd.
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
    process.stderr.write(`[extension-bootstrap] COPILOT_EXTENSION_PARENT_PID unset/invalid; {LEGACY_HINT}\\n`);
}}"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Idempotently soften the extension_bootstrap parent-pid gate.")
    ap.add_argument("path", help="preloads/extension_bootstrap.mjs")
    ap.add_argument("--dry-run", action="store_true", help="只检查，不写文件（升级前预览用）")
    ap.add_argument("--prefix", default="bootstrap-compat", help="日志前缀，如 headless-daemon / vendor-copilot-runtime")
    args = ap.parse_args()

    p = args.prefix
    path = pathlib.Path(args.path)

    if not path.is_file():
        print(f"{p}: bootstrap compat: file not found: {path}", file=sys.stderr)
        return 3

    text = path.read_text(encoding="utf-8")

    if MARKER in text or LEGACY_HINT in text:
        if args.dry_run:
            print(f"{p}: bootstrap compat: already applied (ok) {path}")
        else:
            print(f"{p}: bootstrap compat already applied: {path}")
        return 0

    m = GATE_PATTERN.search(text)
    if not m:
        # 判定「真没有门闩」还是「门闩被改写了」：只认门闩的**语义信号**，不认某个具体字符串。
        # 教训（变异测试抓到的假阴性）：曾经用 "COPILOT_EXTENSION_PARENT_PID" not in text 判「无门闩」，
        # 于是上游只要把这个常量改个名，检查器就会说「无需软化」放你升级，而实际会静默崩循环。
        if not any(sig in text for sig in GATE_SIGNALS):
            print(f"{p}: bootstrap compat skip (no parent gate): {path}")
            return 0
        print(f"{p}: bootstrap compat **pattern miss**（门闩写法变了，必须人工核对）: {path}", file=sys.stderr)
        return 2

    if args.dry_run:
        print(f"{p}: bootstrap compat dry-run: pattern ok，可安全软化 {path}")
        return 0

    bak = path.with_suffix(path.suffix + f".bak-compat-{time.strftime('%Y%m%d%H%M%S')}")
    shutil.copy2(path, bak)
    path.write_text(text[: m.start()] + SOFT + text[m.end():], encoding="utf-8")
    print(f"{p}: bootstrap compat applied: {path} (backup {bak.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
