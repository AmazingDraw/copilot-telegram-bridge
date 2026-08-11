// Session filesystem helpers for telegram-bridge (pure fs / yaml scan).

import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadJsonOrDefault } from "./json-util.mjs";
import { loadModelsConfig } from "./byok-providers.mjs";

function resolveSessionStateDir() {
    try {
        const p = loadModelsConfig()?.paths?.sessionState;
        if (p) return p;
    } catch { /* fall through */ }
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return join(home, ".copilot", "session-state");
}

export const SESSION_STATE_DIR = resolveSessionStateDir();
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Empty shell session.db upper bound (bytes). Real sessions grow well past this. */
const EMPTY_DB_MAX_BYTES = 64 * 1024;

/**
 * YAML 标量安全引号（双引号 + 转义）。纯 ASCII 单词可不加引号。
 * @param {string} value
 * @returns {string}
 */
function yamlQuoteScalar(value) {
    const s = String(value);
    // 简单安全字符：字母数字、中文、常见标点以外的空白/YAML 特殊符都加引号
    if (/^[\w.\-/\u4e00-\u9fff]+$/u.test(s) && !/^(true|false|null|~|yes|no|on|off)$/i.test(s)) {
        return s;
    }
    return JSON.stringify(s);
}

/**
 * 从会话状态的 workspace.yaml 中读取会话命名后的名称
 * @param {string} sessionId 会话 ID
 * @returns {string|null} 会话名称，读取失败或不存在时返回 null
 */
export function getSessionName(sessionId) {
    try {
        const yamlPath = join(SESSION_STATE_DIR, sessionId, "workspace.yaml");
        if (existsSync(yamlPath)) {
            const content = readFileSync(yamlPath, "utf8");
            const match = content.match(/^name:\s*(.+)$/m);
            if (match) {
                const cleaned = cleanSessionTitle(match[1]);
                return cleaned || null;
            }
        }
    } catch (err) {
        console.error(`telegram-bridge: failed to read session name for ${sessionId}:`, err.message);
    }
    return null;
}

/**
 * 写入会话显示名并锁定 user_named=true（防自动 summary 覆盖）。
 * SDK 1.0.71+ 已无 session.renameSession，故直接改 workspace.yaml。
 * @param {string} sessionId
 * @param {string} rawName
 * @returns {string} 清洗后的新名字
 */
export function setSessionUserName(sessionId, rawName) {
    if (!sessionId || !SESSION_UUID_RE.test(sessionId)) {
        throw new Error("invalid session id");
    }
    const name = cleanSessionTitle(rawName);
    if (!name) throw new Error("empty name");

    const yamlPath = join(SESSION_STATE_DIR, sessionId, "workspace.yaml");
    if (!existsSync(yamlPath)) {
        throw new Error("workspace.yaml not found");
    }

    let content = readFileSync(yamlPath, "utf8");
    if (!content.trim()) throw new Error("workspace.yaml empty");

    const quoted = yamlQuoteScalar(name);
    const now = new Date().toISOString();

    if (/^name:\s*/m.test(content)) {
        content = content.replace(/^name:\s*.*$/m, `name: ${quoted}`);
    } else if (/^client_name:\s*.*$/m.test(content)) {
        content = content.replace(/^(client_name:\s*.*)$/m, `$1\nname: ${quoted}`);
    } else if (/^branch:\s*.*$/m.test(content)) {
        content = content.replace(/^(branch:\s*.*)$/m, `$1\nname: ${quoted}`);
    } else {
        content = content.replace(/^(id:\s*.*)$/m, `$1\nname: ${quoted}`);
    }

    if (/^user_named:\s*/m.test(content)) {
        content = content.replace(/^user_named:\s*.*$/m, "user_named: true");
    } else {
        content = content.replace(/^(name:\s*.*)$/m, "$1\nuser_named: true");
    }

    if (/^updated_at:\s*/m.test(content)) {
        content = content.replace(/^updated_at:\s*.*$/m, `updated_at: ${now}`);
    }

    const tmp = yamlPath + ".tmp";
    writeFileSync(tmp, content.endsWith("\n") ? content : content + "\n", "utf8");
    renameSync(tmp, yamlPath);
    return name;
}

/**
 * 清洗 workspace.yaml 里的 name 字段（去掉外层引号、折叠空白）。
 * @param {string} raw
 * @returns {string}
 */
export function cleanSessionTitle(raw) {
    if (!raw) return "";
    let s = String(raw).trim();
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
        s = s.slice(1, -1);
    }
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

/**
 * 会话目录是否存在（有 workspace.yaml）。
 * @param {string} sessionId
 * @returns {boolean}
 */
export function sessionDirExists(sessionId) {
    if (!sessionId || !SESSION_UUID_RE.test(sessionId)) return false;
    return existsSync(join(SESSION_STATE_DIR, sessionId, "workspace.yaml"));
}

/**
 * 运行时能否 resume：仅有空 workspace.yaml 的 sdk 空壳会报 Session not found。
 * 有 session.db 或非空 events.jsonl 才视为可 resume。
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionResumable(sessionId) {
    if (!sessionDirExists(sessionId)) return false;
    const dir = join(SESSION_STATE_DIR, sessionId);
    try {
        if (existsSync(join(dir, "session.db"))) return true;
        const eventsPath = join(dir, "events.jsonl");
        if (existsSync(eventsPath) && statSync(eventsPath).size > 0) return true;
    } catch {}
    return false;
}

/**
 * 收集所有 bot lock 指向的 sessionId（当前/最近连接的会话，禁止清理）。
 * @param {string} botsDir
 * @param {(name: string) => string} botLockPath
 * @returns {Set<string>}
 */
export function getProtectedSessionIds(botsDir, botLockPath) {
    const protectedIds = new Set();
    try {
        if (!existsSync(botsDir)) return protectedIds;
        for (const name of readdirSync(botsDir)) {
            if (!name || name.startsWith(".")) continue;
            const lock = loadJsonOrDefault(botLockPath(name), null);
            if (lock?.sessionId && SESSION_UUID_RE.test(lock.sessionId)) {
                protectedIds.add(lock.sessionId);
            }
        }
    } catch (err) {
        console.error("telegram-bridge: getProtectedSessionIds:", err.message);
    }
    return protectedIds;
}

/**
 * 会话目录上存活的 inuse 持有者 PID 列表（过滤 stale lock）。
 * @param {string} sessionId
 * @returns {number[]}
 */
export function getSessionLiveHolders(sessionId) {
    const dir = join(SESSION_STATE_DIR, sessionId);
    if (!existsSync(dir)) return [];
    const holders = [];
    try {
        for (const f of readdirSync(dir)) {
            const m = f.match(/^inuse\.(\d+)\.lock$/);
            if (!m) continue;
            const pid = Number(m[1]);
            if (!Number.isFinite(pid) || pid <= 0) continue;
            try {
                process.kill(pid, 0);
                holders.push(pid);
            } catch {
                // stale lock
            }
        }
    } catch {}
    return holders;
}

/**
 * 会话目录是否被进程占用（inuse.<pid>.lock 且 pid 存活）。
 * @param {string} sessionId
 * @param {number[]} [excludePids] 忽略这些 PID（通常为本进程 / 已知自持）
 * @returns {boolean}
 */
export function isSessionDirInUse(sessionId, excludePids = []) {
    const exclude = new Set(
        (Array.isArray(excludePids) ? excludePids : [])
            .map(Number)
            .filter((p) => Number.isFinite(p) && p > 0)
    );
    return getSessionLiveHolders(sessionId).some((pid) => !exclude.has(pid));
}

/**
 * 判定是否为「安全可删」的空壳未命名会话。
 * 硬性条件（全部满足才可删）：
 * 1. 标准 UUID 目录 + 有 workspace.yaml
 * 2. 无 name 字段（清洗后为空）
 * 3. summary_count 缺失或 0
 * 4. 无有内容的 events.jsonl / session.db（db 仅允许极小空库）
 * 5. checkpoints 仅允许 index.md，files/research 为空
 * 6. 不在 bot lock 保护集、非 inuse 存活进程
 */
export function isSafeEmptyUnnamedShell(sessionId, yamlContent, protectedIds) {
    if (!SESSION_UUID_RE.test(sessionId)) return false;
    if (protectedIds?.has(sessionId)) return false;
    if (isSessionDirInUse(sessionId)) return false;

    const name = cleanSessionTitle(yamlContent.match(/^name:\s*(.+)$/m)?.[1] || "");
    if (name) return false;

    const sc = yamlContent.match(/^summary_count:\s*(\d+)/m);
    const summaryCount = sc ? Number(sc[1]) : 0;
    if (Number.isFinite(summaryCount) && summaryCount > 0) return false;

    const dir = join(SESSION_STATE_DIR, sessionId);
    try {
        const eventsPath = join(dir, "events.jsonl");
        if (existsSync(eventsPath) && readFileSync(eventsPath, "utf8").trim().length > 0) return false;

        const dbPath = join(dir, "session.db");
        if (existsSync(dbPath)) {
            if (statSync(dbPath).size > EMPTY_DB_MAX_BYTES) return false;
        }

        const cpDir = join(dir, "checkpoints");
        if (existsSync(cpDir)) {
            const extra = readdirSync(cpDir).filter((f) => !f.startsWith(".") && f !== "index.md");
            if (extra.length > 0) return false;
        }

        for (const sub of ["files", "research"]) {
            const p = join(dir, sub);
            if (!existsSync(p)) continue;
            const files = readdirSync(p).filter((f) => !f.startsWith("."));
            if (files.length > 0) return false;
        }
    } catch {
        return false;
    }

    return true;
}

/**
 * 列出可安全清理的空壳未命名会话（全量扫描，不截断）。
 * @param {string} botsDir
 * @param {(name: string) => string} botLockPath
 * @returns {{id: string, updatedAt: number, clientName: string, cwd: string}[]}
 */
export function listCleanableEmptyShells(botsDir, botLockPath) {
    if (!existsSync(SESSION_STATE_DIR)) return [];
    const protectedIds = getProtectedSessionIds(botsDir, botLockPath);
    const list = [];
    try {
        for (const dirName of readdirSync(SESSION_STATE_DIR)) {
            if (!SESSION_UUID_RE.test(dirName)) continue;
            const yamlPath = join(SESSION_STATE_DIR, dirName, "workspace.yaml");
            if (!existsSync(yamlPath)) continue;
            let content;
            try {
                content = readFileSync(yamlPath, "utf8");
            } catch {
                continue;
            }
            if (!isSafeEmptyUnnamedShell(dirName, content, protectedIds)) continue;

            const updateMatch = content.match(/^updated_at:\s*(.+)$/m);
            const createdMatch = content.match(/^created_at:\s*(.+)$/m);
            const updatedAt = updateMatch
                ? new Date(updateMatch[1].trim()).getTime()
                : (createdMatch ? new Date(createdMatch[1].trim()).getTime() : 0);
            const clientName = (content.match(/^client_name:\s*(.+)$/m)?.[1] || "").trim();
            const cwd = (content.match(/^cwd:\s*(.+)$/m)?.[1] || "").trim();
            list.push({ id: dirName, updatedAt, clientName, cwd });
        }
        list.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
        console.error("telegram-bridge: listCleanableEmptyShells:", err.message);
    }
    return list;
}

/**
 * 扫描 ~/.copilot/session-state 获取最近 N 个**可 resume** 会话。
 * 跳过 pending-session*、不可 resume 空壳（无 session.db / 空 events，点切换会 Session not found）。
 * 未命名可 resume 会话回退到 ID 前缀展示。
 * @param {number} [limit=10]
 * @returns {{id: string, name: string, updatedAt: number}[]}
 */
export function getRecentSessions(limit = 10) {
    const max = Math.max(1, Math.min(20, Number(limit) || 10));
    if (!existsSync(SESSION_STATE_DIR)) return [];
    try {
        const dirs = readdirSync(SESSION_STATE_DIR);
        const list = [];
        for (const dirName of dirs) {
            if (!dirName || dirName.startsWith("pending-session") || dirName.startsWith(".")) continue;
            if (!SESSION_UUID_RE.test(dirName)) continue;
            // 列表必须与 resume 能力对齐，否则 /session 按钮会点到死会话
            if (!isSessionResumable(dirName)) continue;
            const yamlPath = join(SESSION_STATE_DIR, dirName, "workspace.yaml");
            if (!existsSync(yamlPath)) continue;
            try {
                const content = readFileSync(yamlPath, "utf8");
                const nameMatch = content.match(/^name:\s*(.+)$/m);
                const updateMatch = content.match(/^updated_at:\s*(.+)$/m);
                const createdMatch = content.match(/^created_at:\s*(.+)$/m);
                const updatedAt = updateMatch
                    ? new Date(updateMatch[1].trim()).getTime()
                    : (createdMatch ? new Date(createdMatch[1].trim()).getTime() : 0);
                if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;

                let name = cleanSessionTitle(nameMatch?.[1] || "");
                if (!name) name = dirName.slice(0, 8);
                if (name.length > 48) name = name.slice(0, 45) + "…";

                list.push({ id: dirName, name, updatedAt });
            } catch {}
        }
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        return list.slice(0, max);
    } catch (err) {
        console.error("telegram-bridge: failed to get recent sessions:", err.message);
        return [];
    }
}
