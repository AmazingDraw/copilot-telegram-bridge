// Headless single-leader + sticky session helpers for telegram-bridge.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadJsonOrDefault, saveJsonAtomic } from "./json-util.mjs";
import { SESSION_UUID_RE, isSessionResumable, isSessionDirInUse } from "./session-fs.mjs";
import { isOfficialModelBlocked } from "./byok-providers.mjs";

/**
 * @param {object} paths
 * @param {(name: string) => string} paths.botDir
 * @param {(name: string) => string} paths.botStatePath
 * @param {(name: string) => string} paths.botLockPath
 * @param {(name: string) => object|null} paths.readLock
 */
export function createHeadlessLeaderApi(paths) {
    const { botDir, botStatePath, botLockPath, readLock } = paths;

    function headlessLeaderPath(botName) {
        return join(botDir(botName), "headless.leader.json");
    }

    /**
     * 无头粘性 sessionId：lock → lastSessionId（目录在即可，即使暂不可 resume）。
     * 用于 createSession({ sessionId }) 复用 UUID，避免重连狂建空壳。
     * @param {string} botName
     * @returns {string|null}
     */
    function resolveHeadlessStickySessionId(botName) {
        try {
            const lock = readLock(botName);
            if (lock?.sessionId && SESSION_UUID_RE.test(lock.sessionId)) {
                return lock.sessionId;
            }
        } catch {}
        try {
            const st = loadJsonOrDefault(botStatePath(botName), {});
            if (st?.lastSessionId && SESSION_UUID_RE.test(st.lastSessionId)) {
                return st.lastSessionId;
            }
        } catch {}
        return null;
    }

    /**
     * 无头启动时优先 resume 的目标（必须可 resume 且无外进程占用）：
     * 1) lock 指向且可 resume
     * 2) lastSessionId 且可 resume
     * 若目标已被桌面 App / 其它 CLI 持有 inuse，则跳过，避免双写导致桌面卡死。
     * @param {string} botName
     * @returns {string|null}
     */
    function resolveHeadlessResumeTarget(botName) {
        const tryId = (sessionId, source) => {
            if (!sessionId || !isSessionResumable(sessionId)) return null;
            if (isSessionDirInUse(sessionId, [process.pid])) {
                console.error(
                    `telegram-bridge: skip resume ${sessionId} (${source}): session in use by another process`
                );
                return null;
            }
            return sessionId;
        };
        try {
            const lock = readLock(botName);
            const hit = tryId(lock?.sessionId, "lock");
            if (hit) return hit;
        } catch {}
        try {
            const st = loadJsonOrDefault(botStatePath(botName), {});
            const hit = tryId(st?.lastSessionId, "lastSessionId");
            if (hit) return hit;
        } catch {}
        return null;
    }

    /**
     * 无头单例：同一 bot 只允许一个存活进程跑 headless 循环，避免多桌面会话连环 create 空壳。
     *
     * @param {string} botName
     * @param {{ mode?: 'app'|'daemon', preferSteal?: boolean }} [opts]
     *   - mode: 写入 leader 文件，便于识别独立守护 vs App 扩展
     *   - preferSteal: daemon 可从 mode!=='daemon' 的存活 leader 手中抢锁（App 侧 refresh 失败后让位）
     * @returns {boolean}
     */
    function tryAcquireHeadlessLeadership(botName, opts = {}) {
        if (!botName) return false;
        const mode = opts.mode === "daemon" ? "daemon" : "app";
        const preferSteal = opts.preferSteal === true;
        try {
            mkdirSync(botDir(botName), { recursive: true });
            const path = headlessLeaderPath(botName);
            const existing = loadJsonOrDefault(path, null);
            if (existing?.pid && existing.pid !== process.pid) {
                try {
                    process.kill(existing.pid, 0);
                    // 对方仍存活
                    const otherMode = existing.mode === "daemon" ? "daemon" : "app";
                    // 仅 daemon 可抢 app；daemon 之间 / app 对 daemon 均不抢
                    if (!(preferSteal && mode === "daemon" && otherMode !== "daemon")) {
                        return false;
                    }
                    console.error(
                        `telegram-bridge: stealing headless leadership from pid=${existing.pid} mode=${otherMode}`
                    );
                } catch {
                    // stale
                }
            }
            const claim = {
                pid: process.pid,
                mode,
                acquiredAt: existing?.acquiredAt || new Date().toISOString(),
                claimedAt: new Date().toISOString(),
            };
            saveJsonAtomic(path, claim);
            // 双读确认：降低双写竞态窗口（后写者覆盖则先写者退出）
            const confirm = loadJsonOrDefault(path, null);
            if (confirm?.pid !== process.pid) return false;
            const busyUntil = Date.now() + 40;
            while (Date.now() < busyUntil) { /* spin */ }
            const confirm2 = loadJsonOrDefault(path, null);
            return confirm2?.pid === process.pid;
        } catch (err) {
            console.error(`telegram-bridge: tryAcquireHeadlessLeadership:`, err.message);
            return false;
        }
    }

    function refreshHeadlessLeadership(botName) {
        if (!botName) return false;
        try {
            const path = headlessLeaderPath(botName);
            const existing = loadJsonOrDefault(path, null);
            if (existing?.pid && existing.pid !== process.pid) {
                try {
                    process.kill(existing.pid, 0);
                    return false;
                } catch {}
            }
            saveJsonAtomic(path, {
                pid: process.pid,
                mode: "daemon",
                acquiredAt: existing?.acquiredAt || new Date().toISOString(),
                refreshedAt: new Date().toISOString(),
            });
            return true;
        } catch {
            return false;
        }
    }

    function releaseHeadlessLeadership(botName) {
        if (!botName) return;
        try {
            const path = headlessLeaderPath(botName);
            const existing = loadJsonOrDefault(path, null);
            if (existing?.pid === process.pid) {
                rmSync(path, { force: true });
            }
        } catch {}
    }

    /**
     * 写入 bot state 的 lastSessionId（保留 offset 等其它字段）。
     * @param {string} botName
     * @param {string} sessionId
     */
    function rememberBotSession(botName, sessionId) {
        if (!botName || !sessionId || !SESSION_UUID_RE.test(sessionId)) return;
        try {
            const st = loadJsonOrDefault(botStatePath(botName), { offset: 0 });
            if (st.lastSessionId === sessionId) return;
            st.lastSessionId = sessionId;
            // 不碰 lastSetMyName*：从磁盘 load 的 st 已带缓存，整文件写回即可
            saveJsonAtomic(botStatePath(botName), st);
        } catch (err) {
            console.error(`telegram-bridge: rememberBotSession failed:`, err.message);
        }
    }

    function rememberBotModel(botName, modelId) {
        const id = String(modelId || "").trim();
        if (!botName) return;
        try {
            const st = loadJsonOrDefault(botStatePath(botName), { offset: 0 });
            if (!id || isOfficialModelBlocked(id)) {
                if (st.lastModelId && isOfficialModelBlocked(st.lastModelId)) {
                    delete st.lastModelId;
                    saveJsonAtomic(botStatePath(botName), st);
                }
                return;
            }
            if (st.lastModelId === id) return;
            st.lastModelId = id;
            saveJsonAtomic(botStatePath(botName), st);
        } catch (err) {
            console.error(`telegram-bridge: rememberBotModel failed:`, err.message);
        }
    }

    function readBotModel(botName) {
        if (!botName) return null;
        try {
            const st = loadJsonOrDefault(botStatePath(botName), {});
            const id = String(st?.lastModelId || "").trim();
            if (!id || isOfficialModelBlocked(id)) return null;
            return id;
        } catch {
            return null;
        }
    }

    return {
        headlessLeaderPath,
        resolveHeadlessStickySessionId,
        resolveHeadlessResumeTarget,
        tryAcquireHeadlessLeadership,
        refreshHeadlessLeadership,
        releaseHeadlessLeadership,
        rememberBotSession,
        rememberBotModel,
        readBotModel,
        // unused but available for callers that need path only
        botLockPath,
    };
}
