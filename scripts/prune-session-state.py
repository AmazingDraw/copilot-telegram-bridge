#!/usr/bin/env python3
"""Prune idle Copilot session-state dirs. Never touch live/sticky bot sessions."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.I,
)
INUSE_RE = re.compile(r"^inuse\.(\d+)\.lock$")
EMPTY_DB_MAX = 64 * 1024
KEEP_DAYS = int(os.environ.get("PRUNE_KEEP_DAYS", "7"))
EMPTY_SHELL_DAYS = int(os.environ.get("PRUNE_EMPTY_SHELL_DAYS", "1"))
DRY_RUN = os.environ.get("PRUNE_DRY_RUN", "").strip() in {"1", "true", "yes"}

HOME = Path.home()
EXT = Path(__file__).resolve().parents[1]
BOTS = EXT / "bots"
SESSION_STATE = HOME / ".copilot" / "session-state"
LOG = BOTS / "Headless" / "prune-session-state.log"


def log(msg: str) -> None:
    line = msg.rstrip()
    print(line)
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def collect_protected() -> set[str]:
    ids: set[str] = set()
    if not BOTS.is_dir():
        raise RuntimeError(f"bots dir missing: {BOTS}")
    bot_dirs = [p for p in BOTS.iterdir() if p.is_dir() and not p.name.startswith(".")]
    parsed = 0
    for bot in bot_dirs:
        for name in ("state.json", "lock.json"):
            p = bot / name
            if not p.is_file():
                continue
            data = load_json(p)
            parsed += 1
            if not isinstance(data, dict):
                raise RuntimeError(f"unreadable {p}")
            sid = data.get("lastSessionId") if name == "state.json" else data.get("sessionId")
            if isinstance(sid, str) and UUID_RE.match(sid):
                ids.add(sid)
    if parsed == 0:
        raise RuntimeError("no bot state/lock files; refusing to prune")
    return ids


def last_activity_ts(dir_path: Path) -> float:
    latest = 0.0
    for rel in ("events.jsonl", "session.db", "workspace.yaml"):
        p = dir_path / rel
        if p.is_file():
            latest = max(latest, p.stat().st_mtime)
    files = dir_path / "files"
    if files.is_dir():
        for child in files.rglob("*"):
            try:
                latest = max(latest, child.stat().st_mtime)
            except OSError:
                continue
    if latest == 0.0:
        try:
            latest = dir_path.stat().st_mtime
        except OSError:
            latest = time.time()
    return latest


def is_empty_shell(dir_path: Path) -> bool:
    events = dir_path / "events.jsonl"
    if events.is_file() and events.stat().st_size > 0:
        if events.read_text(encoding="utf-8", errors="ignore").strip():
            return False
    db = dir_path / "session.db"
    if db.is_file() and db.stat().st_size > EMPTY_DB_MAX:
        return False
    for sub in ("files", "research"):
        p = dir_path / sub
        if p.is_dir():
            for child in p.iterdir():
                if not child.name.startswith("."):
                    return False
    return True


def live_inuse(dir_path: Path) -> bool:
    try:
        names = os.listdir(dir_path)
    except OSError:
        return False
    for name in names:
        m = INUSE_RE.match(name)
        if not m:
            continue
        if pid_alive(int(m.group(1))):
            return True
    return False


def safe_rmtree(root: Path, target: Path) -> None:
    root_r = root.resolve()
    target_r = target.resolve()
    if target_r == root_r or root_r not in target_r.parents:
        raise RuntimeError(f"refuse to delete outside session-state: {target}")
    if not UUID_RE.match(target_r.name):
        raise RuntimeError(f"refuse non-uuid dir: {target}")
    shutil.rmtree(target_r)


def main() -> int:
    if KEEP_DAYS < 1 or EMPTY_SHELL_DAYS < 1:
        log("ERROR: keep days must be >= 1")
        return 1
    if not SESSION_STATE.is_dir():
        log(f"skip: session-state missing {SESSION_STATE}")
        return 0
    try:
        protected = collect_protected()
    except Exception as err:
        log(f"ERROR: {err}")
        return 1

    now = time.time()
    keep_cut = now - KEEP_DAYS * 86400
    empty_cut = now - EMPTY_SHELL_DAYS * 86400
    deleted = 0
    freed = 0
    skipped_live = 0
    errors = 0

    mode = "DRY-RUN" if DRY_RUN else "prune"
    log(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {mode} keep={KEEP_DAYS}d empty_shell={EMPTY_SHELL_DAYS}d protected={len(protected)}")

    for child in sorted(SESSION_STATE.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or not UUID_RE.match(child.name):
            continue
        sid = child.name
        if sid in protected:
            skipped_live += 1
            continue
        if live_inuse(child):
            skipped_live += 1
            continue
        try:
            empty = is_empty_shell(child)
            ts = last_activity_ts(child)
        except OSError as err:
            log(f"ERROR stat {sid}: {err}")
            errors += 1
            continue
        cut = empty_cut if empty else keep_cut
        if ts > cut:
            continue
        age_d = (now - ts) / 86400
        size = 0
        try:
            for p in child.rglob("*"):
                if p.is_file():
                    size += p.stat().st_size
        except OSError:
            pass
        kind = "empty-shell" if empty else "idle"
        if DRY_RUN:
            log(f"  would delete {sid} ({kind}, {age_d:.1f}d, {size} bytes)")
            deleted += 1
            freed += size
            continue
        try:
            safe_rmtree(SESSION_STATE, child)
            log(f"  deleted {sid} ({kind}, {age_d:.1f}d, {size} bytes)")
            deleted += 1
            freed += size
        except Exception as err:
            log(f"ERROR delete {sid}: {err}")
            errors += 1

    mb = freed / 1048576
    log(f"done: deleted={deleted} skipped_live={skipped_live} freed={mb:.2f}MB errors={errors}")
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        log(f"ERROR: {err}")
        raise SystemExit(1)
