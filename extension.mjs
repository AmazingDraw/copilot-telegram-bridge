// ============================================================
// Copilot CLI Telegram Bridge Extension
// ============================================================

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import dns from "node:dns";

import {
    CHUNK_MAX as MD_CHUNK_MAX,
    chunkMessage,
    escapeHtml,
    hasTable,
    buildRichMessageHtml,
    buildListFallbackHtml,
    markdownToTelegramHtmlSafe,
    normalizeModelHtmlBreaks,
    normalizeModelDefinitionLists,
    normalizeDetailsFold,
    normalizeLooseMarkdownTables,
} from "./lib/markdown-tg.mjs";
import {
    loadShellEnvForByok,
    loadAgentsMdInstructions,
    buildHeadlessSessionConfig,
    loadModelsConfig,
    isOfficialModelBlocked,
    pickStickySessionModel,
    isSingleModelLock,
    ensureUnblockedSessionModel,
    banishBlockedSessionModel,
    collectBotModelFallbacks,
} from "./lib/byok-providers.mjs";
import { loadJsonOrDefault, saveJsonAtomic } from "./lib/json-util.mjs";
import {
    SESSION_UUID_RE,
    SESSION_STATE_DIR,
    getSessionName,
    cleanSessionTitle,
    sessionDirExists,
    isSessionResumable,
    getProtectedSessionIds as getProtectedSessionIdsFromFs,
    isSafeEmptyUnnamedShell,
    listCleanableEmptyShells as listCleanableEmptyShellsFromFs,
    getRecentSessions,
} from "./lib/session-fs.mjs";
import { createHeadlessLeaderApi } from "./lib/headless-leader.mjs";
import { attachCommands } from "./lib/bot-commands.mjs";
import { attachHandlers } from "./lib/bot-handlers.mjs";
import { attachRuntime } from "./lib/bot-runtime.mjs";
import {
    resolveBotProfile,
    createCooldownTracker,
    createDailyQuotaTracker,
    evaluateInboundAccess,
    stripBotMention,
    loadAgentsFromPath,
    loadBotCliproxyApiKey,
} from "./lib/bot-profile.mjs";

dns.setDefaultResultOrder("ipv4first");

// ============================================================
// Section 1: Constants & Configuration
// ============================================================

const EXT_DIR = import.meta.dirname;
const CONFIG_DIR = join(EXT_DIR, "config");
const ACCESS_PATH = join(CONFIG_DIR, "access.json");
const BOTS_REGISTRY_PATH = join(CONFIG_DIR, "bots.json");
const BOTS_DIR = join(EXT_DIR, "bots");

/**
 * Telegram Bot 命令菜单（无头 bot 共用）。
 * 无头 /reboot 靠 launchd KeepAlive 真重启；受限菜单 bot 不加此项。
 * @param {{ includeReboot?: boolean }} [opts]
 */
function buildTelegramBotMenu(opts = {}) {
    const menu = [
        { command: "new", description: "🆕 开启全新对话" },
        { command: "stop", description: "✋ 打断当前任务" },
        { command: "session", description: "📋 查看最近会话" },
        { command: "status", description: "📊 查看当前状态" },
        { command: "model", description: "✴️ 切换 AI 模型" },
        { command: "mode", description: "🎮 切换交互模式" },
        { command: "claude", description: "🤖 Claude 交互" },
        { command: "rename", description: "✏️ 修改会话名称" },
        { command: "clean", description: "♻️ 清理历史会话" },
        { command: "rich", description: "📐 切换表格样式" },
    ];
    if (opts.includeReboot) {
        menu.push({ command: "reboot", description: "🧿 重启无头服务" });
    }
    return menu;
}
const TMP_DIR = join(process.env.TMPDIR || "/tmp", `telegram-bridge-${process.pid}`);

/** 旧版根目录 access/bots.json → config/ 一次性迁移 */
function migrateLegacyConfigFiles() {
    try {
        if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
        for (const name of ["access.json", "bots.json"]) {
            const legacy = join(EXT_DIR, name);
            const dest = join(CONFIG_DIR, name);
            if (existsSync(legacy) && !existsSync(dest)) {
                renameSync(legacy, dest);
                console.error(`telegram-bridge: migrated ${name} → config/${name}`);
            }
        }
    } catch (err) {
        console.error("telegram-bridge: config migrate failed:", err.message);
    }
}
migrateLegacyConfigFiles();

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT = 30;
const CHUNK_MAX = MD_CHUNK_MAX; // from lib/markdown-tg.mjs
const SEND_PACE_MS = 50;
const TYPING_INTERVAL_MS = 4000;
const TYPING_DEBOUNCE_MS = 60000;
const ASK_USER_TIMEOUT_MS = 300000;
const PERMISSION_TIMEOUT_MS = 10 * 60 * 1000; // ask 模式权限卡：10 分钟无操作 → 自动拒绝
const PAIRING_EXPIRY_MS = 300000;
const ERROR_RETRY_BASE_MS = 5000;
const ERROR_RETRY_MAX_MS = 60000;
const API_TIMEOUT_MS = 30000;


// ============================================================
// Section 2: Utility Functions
// ============================================================

const CIRCLE_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
function getCircleNumber(i) {
    return CIRCLE_NUMBERS[i - 1] || `${i}`;
}



function botDir(name) { return join(BOTS_DIR, name); }

/** 用户可见 Bot 名称（bots.json.label），内部 registry key 不变 */
function getBotLabel(name) {
    try {
        const reg = registry || loadJsonOrDefault(BOTS_REGISTRY_PATH, {});
        const label = reg?.[name]?.label;
        if (label && String(label).trim()) return String(label).trim();
    } catch {}
    // 兜底：历史 key 映射（迁移后可删）
    if (name === "translatorbot") return "Headless";
    if (name === "copilotcli") return "Copilot";
    return name;
}

function botStatePath(name) { return join(botDir(name), "state.json"); }
function botLockPath(name) { return join(botDir(name), "lock.json"); }

function ensureTmpDir() {
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupTmpDir() {
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}

// Markdown helpers: lib/markdown-tg.mjs

function generatePairingCode() {
    return randomBytes(4).toString("hex").slice(0, 6);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** 瞬时网络错误：poll / 附件下载常见 TypeError: fetch failed (+ ECONNRESET 等) */
function isTransientNetworkError(err) {
    if (!err) return false;
    const msg = err.message || String(err);
    const code = err.code || err.cause?.code || "";
    if (err.status >= 500 && err.status < 600) return true;
    if (/fetch failed|AbortError|timed out|timeout|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(msg)) {
        // 主动 abort（关机/切换）不重试
        if (err.name === "AbortError" && /aborted|abort/i.test(msg) && !/timeout/i.test(msg)) return false;
        return true;
    }
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(String(code))) return true;
    if (err.cause && err.cause !== err) return isTransientNetworkError(err.cause);
    return false;
}

/**
 * Telegram 出站请求轻量重试（getUpdates 长轮询除外，由 poll 循环处理）。
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, baseDelayMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function withTelegramFetchRetry(label, fn, opts = {}) {
    const attempts = opts.attempts ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 400;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isTransientNetworkError(err) || i === attempts - 1) throw err;
            const delay = baseDelayMs * (i + 1) + Math.floor(Math.random() * 150);
            const detail = err.cause?.code || err.cause?.message || err.message;
            console.warn(
                `telegram-bridge: ${label} transient (${detail}); retry ${i + 1}/${attempts - 1} in ${delay}ms`
            );
            await sleep(delay);
        }
    }
    throw lastErr;
}

let registry = {};
let access;
const activeInstances = [];

// ============================================================
// Section 3: Telegram Bot API Client
// ============================================================

function createBotInstance(name, token, isHeadless, botRegistryEntry = {}, enabledIndex = 0) {
    const botProfile = resolveBotProfile(name, botRegistryEntry || {}, enabledIndex);
    // role 字段优先于顺序推断
    isHeadless = botProfile.isHeadless;
    let botToken = token;
    let activeReplyChatId = null;
    const cooldown = createCooldownTracker({
        botDir: join(BOTS_DIR, name),
        cooldownSec: botProfile.cooldownSec,
    });
    const vip = null;
    const dailyQuota = createDailyQuotaTracker({
        botDir: join(BOTS_DIR, name),
        dailyLimit: botProfile.dailyLimit,
        timeZone: botProfile.dailyLimitTz,
        getLimit: vip ? (id) => vip.dailyLimitFor(id) : undefined,
    });
    let state;
    let session;
    /** 无头模式下 hoist 的 CopilotClient，供 /session 按钮 resumeSession 切换使用 */
    let headlessClient = null;
    /** 无头切换中的 Promise，防止连点并发切换 */
    let headlessSwitching = null;
    /** 无头 /session 切换超时（只保留最新一次） */
    let desktopHandoffTimer = null;
    let abortController;
    let shutdownRequested = false;
    let awaitingInput = null;
    /** @type {{ chatId: number, timer: ReturnType<typeof setTimeout>, startedAt: number } | null} */
    let awaitingRename = null;
    /** @type {{ chatId: number, mode: string, sessionId?: string, timer: ReturnType<typeof setTimeout>, startedAt: number } | null} */
    let awaitingClaude = null;
    /** 当前对话已切换的 Claude 模型（仅本次会话生效；退出桥接后恢复默认） */
    let claudeModel = "";
    let connected = false;
    let isAgentBusy = false;
    let botInfo = null;
    let currentSessionId = null;
    let currentBotName = name;
    /** 每个 bot 实例独立的挂起请求，避免多 bot 串台 */
    const pendingPermissionRequests = new Map();
    const pendingUserInputs = new Map();
    /** exit_plan_mode 批准卡：reqId → { resolve, request, timer } */
    const pendingExitPlanRequests = new Map();
    /** 用户手动切到 Plan 后保持「粘性」：批准执行后本轮结束自动切回 Plan */
    let stickyPlanMode = false;
    /** 本轮因批准计划暂时离开 Plan，idle 时需切回 */
    let restorePlanAfterTurn = false;
    /** 批准后须先见到 turn_start（真正开始执行）再允许 restore，避免 exit_plan_mode 当轮 turn_end 立刻切回 */
    let stickyRestoreArmed = false;

    async function callTelegram(method, params = {}) {
        if (!botToken) throw new Error("Bot token not configured");
        if (method === "sendMessage") {
            if (params.disable_web_page_preview === undefined) {
                params.disable_web_page_preview = true;
            }
            if (params.link_preview_options === undefined) {
                params.link_preview_options = { is_disabled: true };
            }
        }
        const url = `${TELEGRAM_API}/bot${botToken}/${method}`;
        const timeoutMs = method === "getUpdates"
            ? (POLL_TIMEOUT + 10) * 1000
            : API_TIMEOUT_MS;
        const doFetch = async () => {
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const signal = method === "getUpdates" && abortController
                ? AbortSignal.any([abortController.signal, timeoutSignal])
                : timeoutSignal;
            return fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
                signal,
            });
        };
        // getUpdates 由 poll 退避；附件链路 getFile 可安全重试。
        // send* 不在此重试：若服务端已收包但响应丢失，重 POST 可能重复发消息。
        const res = method === "getFile"
            ? await withTelegramFetchRetry(`api ${method}`, doFetch)
            : await doFetch();
        if (res.status === 409) {
            const err = new Error("Conflict: another process is polling this bot");
            err.status = 409;
            throw err;
        }
        if (res.status === 429) {
            const body = await res.json().catch(() => ({}));
            const err = new Error("Rate limited");
            err.status = 429;
            err.retryAfter = body?.parameters?.retry_after || 5;
            throw err;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            const err = new Error(`Telegram API ${method} failed: ${res.status} ${body}`);
            err.status = res.status;
            throw err;
        }
        const json = await res.json();
        if (!json.ok) throw new Error(`Telegram API ${method} returned ok=false: ${JSON.stringify(json)}`);
        return json.result;
    }

function getMe() { return callTelegram("getMe"); }

function getUpdates(offset, timeout) {
    // 增加 "callback_query" 使得 Telegram 能够将内联键盘按钮点击事件推送给我们
    return callTelegram("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] });
}

function sendMessage(chatId, text, parseMode) {
    const params = {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        link_preview_options: { is_disabled: true },
    };
    if (parseMode) params.parse_mode = parseMode;
    return callTelegram("sendMessage", params);
}

// 检测 Markdown 表格：走 lib/markdown-tg.mjs 的 hasTable（含松散表规范化）

// 检测 Markdown 文本中是否包含富文本排版格式 (粗体、列表、代码块、超链接等)
function hasRichContent(md) {
    return (
        /^#{1,6}\s+/m.test(md) ||          // 标题 (#)
        /^(?:\\*`){3,}/m.test(md) ||        // 代码块 (```, 支持可选斜杠转义)
        /^\s*[-*]\s+/m.test(md) ||          // 无序列表 (-)
        /^\s*\d+\.\s+/m.test(md) ||         // 有序列表 (1.)
        /^>\s/m.test(md) ||                 // 引用块 (>)
        /\*\*.+?\*\*/.test(md) ||           // 粗体 (**)
        /\|\|.+\|\|/.test(md) ||            // 剧透 (||)
        /~~.+?~~/.test(md) ||               // 删除线 (~~)
        /`[^`]+`/.test(md) ||               // 行内代码 (`)
        /\[[^\]]+\]\([^)]+\)/.test(md) ||   // 链接 ([])
        /https?:\/\/[^\s]+/.test(md) ||       // 纯网址 (http)
        /^[-*_─]{3,}\s*$/m.test(md)          // 水平分割线 (---, ***, ___, ───)
    );
}

/**
 * 表格投递：richTables=true → sendRichMessage HTML 表；默认 false → 列表 HTML（与富文本同级，非仅失败降级）。
 * 非表格富文本仍走 sendMessage HTML。
 * 分块由调用方 chunkMessage 完成，本函数不对入参再分块（与历史行为一致）。
 */
function isRichTablesEnabled() {
    return state?.richTables === true;
}

async function sendTableAsListHtml(chatId, markdown, opts) {
    const listHtml = buildListFallbackHtml(markdown, opts);
    if (listHtml) {
        return callTelegram("sendMessage", {
            chat_id: chatId,
            text: listHtml,
            parse_mode: "HTML",
        });
    }
    return callTelegram("sendMessage", { chat_id: chatId, text: markdown });
}

async function sendFormattedMessage(chatId, markdown, opts = {}) {
    if (markdown) {
        // <details> 折叠 → 伪折叠（Telegram 不支持折叠）
        markdown = normalizeDetailsFold(markdown);
        // 裸 <br> → \n；code/围栏内字面量保留（见 normalizeModelHtmlBreaks）
        markdown = normalizeModelHtmlBreaks(markdown);
        // 裸 <dl>/<dt>/<dd> → Markdown 列表（code/表内字面量保留）
        markdown = normalizeModelDefinitionLists(markdown);
        // 松散表（无外侧 |）→ 标准 |…|，再进 hasTable / rich
        markdown = normalizeLooseMarkdownTables(markdown);
    }
    const hasTbl = hasTable(markdown);
    const hasRich = hasRichContent(markdown);

    // 情况一：含表格 — 按开关选 HTML 表 或 列表（二者同级）
    if (hasTbl) {
        if (!isRichTablesEnabled()) {
            try {
                return await sendTableAsListHtml(chatId, markdown, opts);
            } catch (err) {
                console.error("telegram-bridge: table list send failed:", err.message);
                return callTelegram("sendMessage", { chat_id: chatId, text: markdown });
            }
        }

        const html = buildRichMessageHtml(markdown);
        let lastError = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);
                const url = `${TELEGRAM_API}/bot${botToken}/sendRichMessage`;
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        chat_id: chatId,
                        rich_message: { html },
                        disable_web_page_preview: true,
                        link_preview_options: { is_disabled: true },
                    }),
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (res.ok) return await res.json();
                throw new Error(`sendRichMessage ${res.status}`);
            } catch (err) {
                lastError = err;
                console.warn(`telegram-bridge: sendRichMessage attempt ${attempt} failed:`, err.message);
                if (attempt < 2) await sleep(300);
            }
        }

        console.error("telegram-bridge: sendRichMessage all retries failed:", lastError?.message);
        // 富文本通道失败时仍可改走列表（防灾），与开关关闭时的主路径相同
        try {
            return await sendTableAsListHtml(chatId, markdown, opts);
        } catch (_) {}
        return callTelegram("sendMessage", { chat_id: chatId, text: markdown });
    }

    // 情况二：无表格但有富文本，走 sendMessage 兼容的 HTML 解析模式
    // 与 sendRichMessage 对齐：瞬时网络/fetch failed 时最多 2 次，再降级纯文本
    if (hasRich) {
        const html = markdownToTelegramHtmlSafe(markdown, opts);
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                return await callTelegram("sendMessage", {
                    chat_id: chatId,
                    text: html,
                    parse_mode: "HTML",
                });
            } catch (err) {
                lastError = err;
                console.warn(
                    `telegram-bridge: HTML sendMessage attempt ${attempt} failed:`,
                    err.message
                );
                if (attempt < 2) await sleep(300);
            }
        }
        console.error("telegram-bridge: HTML sendMessage all retries failed:", lastError?.message);
        return callTelegram("sendMessage", { chat_id: chatId, text: markdown });
    }

    // 情况三：普通纯文本，直接原样发送
    return callTelegram("sendMessage", { chat_id: chatId, text: markdown });
}

async function sendPhoto(chatId, base64Data, mimeType, caption) {
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/gif" ? "gif" : "png";
    const buf = Buffer.from(base64Data, "base64");
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", new File([buf], `image.${ext}`, { type: mimeType }));
    if (caption) form.append("caption", caption.slice(0, 1024));

    const url = `${TELEGRAM_API}/bot${botToken}/sendPhoto`;
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Telegram sendPhoto failed: ${res.status} ${body}`);
    }
    return (await res.json()).result;
}

async function sendDocument(chatId, base64Data, mimeType, filename, caption) {
    const buf = Buffer.from(base64Data, "base64");
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new File([buf], filename || "file", { type: mimeType }));
    if (caption) form.append("caption", caption.slice(0, 1024));

    const url = `${TELEGRAM_API}/bot${botToken}/sendDocument`;
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Telegram sendDocument failed: ${res.status} ${body}`);
    }
    return (await res.json()).result;
}

function sendChatAction(chatId, action = "typing") {
    return callTelegram("sendChatAction", { chat_id: chatId, action });
}

async function editMessageText(chatId, messageId, text, parseMode) {
    const params = { chat_id: chatId, message_id: messageId, text };
    if (parseMode) params.parse_mode = parseMode;
    try {
        return await callTelegram("editMessageText", params);
    } catch (err) {
        // 内容完全一致时 Telegram 返回 400 not modified；对 UI 刷新/同模型再点属正常
        if (/message is not modified/i.test(err?.message || "")) {
            return null;
        }
        throw err;
    }
}

/** 落盘 bot state 时合并磁盘上的展示名缓存，避免旧进程 SIGTERM 覆盖 */
function persistBotState() {
    if (!state || !currentBotName) return;
    try {
        const disk = loadJsonOrDefault(botStatePath(currentBotName), {});
        if (disk.lastSetMyName && !state.lastSetMyName) {
            state.lastSetMyName = disk.lastSetMyName;
            if (disk.lastSetMyNameAt != null) state.lastSetMyNameAt = disk.lastSetMyNameAt;
        }
        saveJsonAtomic(botStatePath(currentBotName), state);
    } catch {}
}

/** 推送 Bot 命令菜单；瞬时网络失败重试，避免重启后 Telegram 仍显示旧菜单 */
async function syncBotCommandsMenu(opts = {}) {
    const commands = Array.isArray(opts.commands)
        ? opts.commands
        : buildTelegramBotMenu({
            includeReboot: !!opts.includeReboot,
        });
    const scopes = Array.isArray(opts.scopes) ? opts.scopes.filter(Boolean) : [];
    const clearDefault = opts.clearDefault === true || commands.length === 0;
    try {
        if (clearDefault) {
            await withTelegramFetchRetry(
                `deleteMyCommands[${name}] default`,
                () => callTelegram("deleteMyCommands", {}),
                { attempts: 4, baseDelayMs: 600 }
            );
        }
        for (const scope of (Array.isArray(opts.deleteScopes) ? opts.deleteScopes : [])) {
            await withTelegramFetchRetry(
                `deleteMyCommands[${name}] ${scope?.type || "scope"}`,
                () => callTelegram("deleteMyCommands", { scope }),
                { attempts: 4, baseDelayMs: 600 }
            );
        }
        if (commands.length === 0) {
            for (const scope of scopes) {
                await withTelegramFetchRetry(
                    `deleteMyCommands[${name}] scoped`,
                    () => callTelegram("deleteMyCommands", { scope }),
                    { attempts: 4, baseDelayMs: 600 }
                );
            }
            console.error(`telegram-bridge: [${name}] deleteMyCommands ok (empty menu)`);
            return;
        }
        const batches = [
            { commands, scopes: scopes.length ? scopes : [null] },
            ...((Array.isArray(opts.extra) ? opts.extra : []).map((x) => ({
                commands: x.commands,
                scopes: Array.isArray(x.scopes) && x.scopes.length ? x.scopes : [null],
            }))),
        ];
        let ok = 0;
        let total = 0;
        for (const batch of batches) {
            if (!Array.isArray(batch.commands) || batch.commands.length === 0) continue;
            for (const scope of batch.scopes) {
                total += 1;
                const payload = scope ? { commands: batch.commands, scope } : { commands: batch.commands };
                const label = scope?.chat_id != null
                    ? `chat:${scope.chat_id}`
                    : (scope?.type || "default");
                try {
                    await withTelegramFetchRetry(
                        `setMyCommands[${name}] ${label}`,
                        () => callTelegram("setMyCommands", payload),
                        { attempts: 4, baseDelayMs: 600 }
                    );
                    ok += 1;
                } catch (err) {
                    console.warn(
                        `telegram-bridge: [${name}] setMyCommands failed scope=${label}:`,
                        err.message
                    );
                }
            }
        }
        console.error(
            `telegram-bridge: [${name}] setMyCommands ok (${ok}/${total || 1} scope(s))`
        );
    } catch (err) {
        console.warn(
            `telegram-bridge: [${name}] setMyCommands/deleteMyCommands failed after retries:`,
            err.message
        );
    }
}

/** setMyName 限流友好：同名跳过；成功写入 state；429 只 warn 一次不炸日志 */
async function syncBotDisplayName() {
    const desired = getBotLabel(name);
    if (!desired) return;
    try {
        // 始终以磁盘为准合并缓存，防止内存 state 被 reload 冲掉后重复打 API
        const disk = loadJsonOrDefault(botStatePath(name), { offset: 0 });
        if (!state || typeof state !== "object") {
            state = disk;
        } else {
            if (disk.lastSetMyName && !state.lastSetMyName) {
                state.lastSetMyName = disk.lastSetMyName;
                if (disk.lastSetMyNameAt != null) state.lastSetMyNameAt = disk.lastSetMyNameAt;
            }
            if (disk.offset != null && state.offset == null) state.offset = disk.offset;
        }
        if (state.lastSetMyName === desired) {
            return;
        }
        await callTelegram("setMyName", { name: desired });
        state.lastSetMyName = desired;
        state.lastSetMyNameAt = Date.now();
        persistBotState();
    } catch (err) {
        const msg = err?.message || String(err);
        if (err?.status === 429 || /rate limited/i.test(msg)) {
            console.warn(`telegram-bridge: setMyName rate-limited, keep label "${desired}"`);
            // 记住期望名，避免重连风暴反复打 API
            try {
                if (state && typeof state === "object") {
                    state.lastSetMyName = desired;
                    state.lastSetMyNameAt = Date.now();
                    persistBotState();
                }
            } catch {}
            return;
        }
        // 网络瞬断：不写缓存，下次连通再试；只 warn 不 error 刷屏
        if (/fetch failed|AbortError|timed out|network/i.test(msg)) {
            console.warn("telegram-bridge: setMyName skipped (network):", msg);
            return;
        }
        console.error("telegram-bridge: setMyName failed:", msg);
    }
}

function deleteMessage(chatId, messageId) {
    return callTelegram("deleteMessage", { chat_id: chatId, message_id: messageId });
}

function answerCallbackQuery(callbackQueryId, text) {
    return callTelegram("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return callTelegram("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
}

function sendMessageWithKeyboard(chatId, text, replyMarkup, parseMode = "HTML") {
    // 默认启用 HTML 解析模式，使按钮上的说明文本支持富文本转译
    const params = { chat_id: chatId, text, reply_markup: replyMarkup };
    if (parseMode) params.parse_mode = parseMode;
    return callTelegram("sendMessage", params);
}

function setMessageReaction(chatId, messageId, emoji) {
    return callTelegram("setMessageReaction", {
        chat_id: chatId, message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
    });
}

function getFile(fileId) {
    return callTelegram("getFile", { file_id: fileId });
}

/**
 * 下载 Telegram 文件。
 * @param {string} filePath Telegram getFile 返回的 file_path
 * @param {{ destDir?: string, destName?: string }} [opts]
 * @returns {Promise<{ path: string, buffer: Buffer }>}
 */
async function downloadFile(filePath, opts = {}) {
    const url = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
    const label = `download ${basename(filePath)}`;
    const res = await withTelegramFetchRetry(label, async () => {
        const r = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
        if (!r.ok) {
            const err = new Error(`Download failed: ${r.status}`);
            err.status = r.status;
            // 5xx 走 isTransientNetworkError 重试；4xx 直接抛
            throw err;
        }
        return r;
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const destDir = opts.destDir || TMP_DIR;
    if (destDir === TMP_DIR) ensureTmpDir();
    else mkdirSync(destDir, { recursive: true });
    const localName = opts.destName || basename(filePath);
    const localPath = join(destDir, localName);
    writeFileSync(localPath, buffer);
    return { path: localPath, buffer };
}

// ============================================================
// Section 5b: Lock File Management
// ============================================================

function readLock(name) {
    const data = loadJsonOrDefault(botLockPath(name), null);
    // 必须精确判断 undefined / null，因为 pid 为 0 时也是有效占位锁
    if (!data || data.pid === undefined || !data.sessionId) return null;
    return data;
}

function writeLock(name, sessionId, pid = process.pid) {
    saveJsonAtomic(botLockPath(name), {
        pid,
        sessionId,
        connectedAt: new Date().toISOString(),
    });
}

function removeLock(name, sessionId) {
    const lock = readLock(name);
    // 必须 pid 匹配：App 让位时 sessionId 常与 sticky 相同，若只比 session
    // 会误删独立 daemon 刚写入的 lock，导致 poll 立刻 “lock changed (undefined)”。
    if (lock && lock.sessionId === sessionId && lock.pid === process.pid) {
        try { rmSync(botLockPath(name), { force: true }); } catch {}
    }
}

function isLockStale(lock) {
    if (!lock) return true;
    if (lock.pid === 0) return true; // pid 为 0 时是待接管占位锁，视为已过期/可认领
    try {
        process.kill(lock.pid, 0);
        return false;
    } catch {
        return true;
    }
}

/**
 * 原子认领「待接管占位锁」（pid=0）。
 *
 * 竞态说明：多扩展实例（SDK 新版下同会话可挂多个 server 进程）的 poller
 * 会在同一 5s 周期内同时读到 pid=0 的锁。为避免「读锁→判 pid→写锁」三步
 * 非原子导致的重复认领/重复广播，这里用 O_EXCL 创建 claim 门闩文件，保证
 * 同一时刻只有一个实例能进入「判锁→写锁」临界区；claim 持有者崩溃后按
 * pid 存活与否清理残留。
 *
 * @param {string} name bot 名
 * @param {string} sessionId 目标会话 id
 * @returns {boolean} 是否认领成功（锁已改写为本进程 pid）
 */
function tryClaimLock(name, sessionId) {
    const claimPath = botLockPath(name) + ".claim";
    const claim = {
        pid: process.pid,
        sessionId,
        claimedAt: new Date().toISOString(),
    };
    let acquired = false;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(claimPath, JSON.stringify(claim), { flag: "wx" });
            acquired = true;
            break;
        } catch (err) {
            if (err.code !== "EEXIST") throw err;
            // 已有 claim：持有者存活则本轮放弃；已死则清残留重试一次
            let holder = null;
            try {
                holder = JSON.parse(readFileSync(claimPath, "utf8"));
            } catch {}
            if (holder && typeof holder.pid === "number" && holder.pid !== process.pid) {
                try {
                    process.kill(holder.pid, 0);
                    return false; // 他人正在认领
                } catch {
                    // holder 已死，清理残留后重试
                }
            }
            try { rmSync(claimPath, { force: true }); } catch {}
        }
    }
    if (!acquired) return false;

    try {
        // 持门闩后重新读锁：仅当锁指向目标会话且「占位（pid=0）或持有者已死」才认领，
        // 避免覆盖他人已写好的活锁
        const lock = readLock(name);
        if (!lock || lock.sessionId !== sessionId) {
            return false;
        }
        if (lock.pid === process.pid) return false; // 自己已持有
        if (lock.pid !== 0 && !isLockStale(lock)) return false; // 他人存活持有
        writeLock(name, sessionId, process.pid);
        return true;
    } finally {
        try { rmSync(claimPath, { force: true }); } catch {}
    }
}

// Headless leader/sticky (lib/headless-leader.mjs) — needs readLock above
const {
    resolveHeadlessStickySessionId,
    resolveHeadlessResumeTarget,
    tryAcquireHeadlessLeadership,
    refreshHeadlessLeadership,
    releaseHeadlessLeadership,
    rememberBotSession,
    rememberBotModel,
    readBotModel,
} = createHeadlessLeaderApi({
    botDir,
    botStatePath,
    botLockPath,
    readLock,
});

function getProtectedSessionIds() {
    return getProtectedSessionIdsFromFs(BOTS_DIR, botLockPath);
}

function listCleanableEmptyShells() {
    return listCleanableEmptyShellsFromFs(BOTS_DIR, botLockPath);
}

// ============================================================
// Section 6–12: Runtime + handlers/commands assembly
// ============================================================

/** 当前已绑定事件的 session 对象；切换 / 重连时必须重绑 */
let boundEventSession = null;

const ctx = {
    name,
    isHeadless,
    botProfile,
    get activeReplyChatId() { return activeReplyChatId; },
    set activeReplyChatId(v) { activeReplyChatId = v; },
    cooldown,
    dailyQuota,
    vip,
    evaluateInboundAccess,
    stripBotMention,
    loadAgentsFromPath,
    CIRCLE_NUMBERS,
    ASK_USER_TIMEOUT_MS,
    PERMISSION_TIMEOUT_MS,
    SEND_PACE_MS,
    TYPING_INTERVAL_MS,
    TYPING_DEBOUNCE_MS,
    POLL_TIMEOUT,
    ERROR_RETRY_BASE_MS,
    ERROR_RETRY_MAX_MS,
    sleep,
    saveJsonAtomic,
    persistBotState,
    botStatePath,
    get access() { return access; },
    get session() { return session; },
    set session(v) { session = v; },
    get state() { return state; },
    set state(v) { state = v; },
    get botToken() { return botToken; },
    set botToken(v) { botToken = v; },
    get botInfo() { return botInfo; },
    set botInfo(v) { botInfo = v; },
    get connected() { return connected; },
    set connected(v) { connected = v; },
    get headlessClient() { return headlessClient; },
    set headlessClient(v) { headlessClient = v; },
    get headlessSwitching() { return headlessSwitching; },
    set headlessSwitching(v) { headlessSwitching = v; },
    get desktopHandoffTimer() { return desktopHandoffTimer; },
    set desktopHandoffTimer(v) { desktopHandoffTimer = v; },
    get awaitingInput() { return awaitingInput; },
    set awaitingInput(v) { awaitingInput = v; },
    get awaitingRename() { return awaitingRename; },
    set awaitingRename(v) { awaitingRename = v; },
    get awaitingClaude() { return awaitingClaude; },
    set awaitingClaude(v) { awaitingClaude = v; },
    get claudeModel() { return claudeModel; },
    set claudeModel(v) { claudeModel = v; },
    get isAgentBusy() { return isAgentBusy; },
    set isAgentBusy(v) { isAgentBusy = v; },
    get currentSessionId() { return currentSessionId; },
    set currentSessionId(v) { currentSessionId = v; },
    get currentBotName() { return currentBotName; },
    set currentBotName(v) { currentBotName = v; },
    get boundEventSession() { return boundEventSession; },
    set boundEventSession(v) { boundEventSession = v; },
    get pendingPermissionRequests() { return pendingPermissionRequests; },
    get pendingUserInputs() { return pendingUserInputs; },
    get pendingExitPlanRequests() { return pendingExitPlanRequests; },
    get stickyPlanMode() { return stickyPlanMode; },
    set stickyPlanMode(v) { stickyPlanMode = !!v; },
    get restorePlanAfterTurn() { return restorePlanAfterTurn; },
    set restorePlanAfterTurn(v) { restorePlanAfterTurn = !!v; },
    get stickyRestoreArmed() { return stickyRestoreArmed; },
    set stickyRestoreArmed(v) { stickyRestoreArmed = !!v; },
    get shutdownRequested() { return shutdownRequested; },
    set shutdownRequested(v) { shutdownRequested = v; },
    get abortController() { return abortController; },
    set abortController(v) { abortController = v; },
    callTelegram,
    getMe,
    getUpdates,
    sendMessage,
    sendFormattedMessage,
    sendMessageWithKeyboard,
    answerCallbackQuery,
    editMessageText,
    editMessageReplyMarkup,
    sendPhoto,
    sendDocument,
    sendChatAction,
    setMessageReaction,
    deleteMessage,
    getFile,
    downloadFile,
    getCircleNumber,
    getBotLabel,
    readLock,
    writeLock,
    removeLock,
    isLockStale,
    tryClaimLock,
    rememberBotSession,
    rememberBotModel,
    readBotModel,
    refreshHeadlessLeadership,
    getProtectedSessionIds,
    listCleanableEmptyShells,
};

// 1) Runtime first (queue / typing / bubble / processUpdate / poll)
const {
    enqueue,
    ensureTyping,
    stopTyping,
    startTyping,
    dismissBubble,
    scheduleBubbleUpdate,
    describeToolCall,
    getAllowedChatIds,
    handleFileAttachment,
    processUpdate,
    pollLoop,
    startLockPoller,
    autoConnectWithRetry,
    activeTools,
    bubbleMessageIds,
    allBubbleIds,
} = attachRuntime(ctx);
    
// 2) Access control (needs enqueue)
// ============================================================
// Section 6: Access Control & Pairing
// ============================================================

function reloadAccess() {
    access = loadJsonOrDefault(ACCESS_PATH, { allowedUsers: [], pending: {} });
}

function isAllowed(userId) {
    return access.allowedUsers.includes(String(userId));
}

function cleanExpiredPending() {
    const now = Date.now();
    let changed = false;
    for (const [chatId, entry] of Object.entries(access.pending || {})) {
        if (now - entry.timestamp > PAIRING_EXPIRY_MS) {
            delete access.pending[chatId];
            changed = true;
        }
    }
    if (changed) saveJsonAtomic(ACCESS_PATH, access);
}

async function handlePairing(chatId, userId, text) {
    const chatIdStr = String(chatId);
    const userIdStr = String(userId);

    const pending = access.pending?.[chatIdStr];
    if (pending) {
        if (text.trim().toLowerCase() === pending.code.toLowerCase()) {
            if (!access.allowedUsers.includes(userIdStr)) {
                access.allowedUsers.push(userIdStr);
            }
            delete access.pending[chatIdStr];
            saveJsonAtomic(ACCESS_PATH, access);
            await enqueue(() => sendMessage(chatId, "Paired! You can now send messages to Copilot CLI."));
            await session.log(`Telegram user ${userIdStr} paired successfully.`);
            return;
        } else {
            await enqueue(() => sendMessage(chatId, "Invalid code. Try again."));
            return;
        }
    }

    cleanExpiredPending();
    const code = generatePairingCode();
    if (!access.pending) access.pending = {};
    access.pending[chatIdStr] = { code, timestamp: Date.now() };
    saveJsonAtomic(ACCESS_PATH, access);
    await enqueue(() => sendMessage(chatId, "A pairing code has been generated. Check the Copilot CLI terminal for the code and send it here to confirm."));
    await session.log(`Telegram pairing request from user ${userIdStr}. Pairing code: ${code}`);
}


ctx.reloadAccess = reloadAccess;
ctx.isAllowed = isAllowed;
ctx.handlePairing = handlePairing;

// 3) Outbound handlers + slash command modules
const {
    setupEventHandlers,
    createPermissionHandler,
    createUserInputHandler,
    createExitPlanModeHandler,
    enableHeadlessAllowAll,
} = attachHandlers(ctx);

const {
    handleModelCommand,
    handleModelCallback,
    handleModeCommand,
    handleModeCallback,
    handleThinkingCommand,
    handleThinkingCallback,
    handleNewCommand,
    handleSessionCommand,
    handleSessionCallback,
    handleCleanCommand,
    handleCleanCallback,
    handleRenameCommand,
    tryConsumeRenameInput,
    handleUserInputCallback,
    handlePermissionCallback,
    handleExitPlanModeCallback,
    switchHeadlessSession,
    getDisplayModels,
    handleStatusCommand,
    handleRichCommand,
    handleClaudeCommand,
    handleClaudeCallback,
    tryConsumeClaudeInput,
    handleClaudeProgress,
} = attachCommands(ctx);

// Late-bind command handlers for processUpdate (runtime closed over ctx)
Object.assign(ctx, {
    handleModelCommand,
    handleModelCallback,
    handleModeCommand,
    handleModeCallback,
    handleThinkingCommand,
    handleThinkingCallback,
    handleNewCommand,
    handleSessionCommand,
    handleSessionCallback,
    handleCleanCommand,
    handleCleanCallback,
    handleRenameCommand,
    tryConsumeRenameInput,
    handleUserInputCallback,
    handlePermissionCallback,
    handleExitPlanModeCallback,
    switchHeadlessSession,
    getDisplayModels,
    handleStatusCommand,
    handleRichCommand,
    handleClaudeCommand,
    handleClaudeCallback,
    tryConsumeClaudeInput,
    handleClaudeProgress,
});

// bubbleActive / lastCompletedToolDesc live in runtime via defineProperty on ctx

// ============================================================
// Section 11b: Slash Command Handlers
// ============================================================

let pendingSetupName = null;

async function handleSetup(name) {
    registry = loadJsonOrDefault(BOTS_REGISTRY_PATH, {});

    if (!name) {
        await session.log("Usage: /telegram setup <name>");
        return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        await session.log("Bot name must be letters, numbers, hyphens, or underscores.");
        return;
    }
    if (registry[name]) {
        await session.log(`Bot '${name}' already registered. Remove it first.`);
        return;
    }

    pendingSetupName = name;
    await session.log(
        "Telegram Bridge Setup\n\n" +
        "Steps:\n" +
        "1. Open Telegram, search for @BotFather\n" +
        "2. Send /newbot and follow the prompts\n" +
        "3. Copy the bot token BotFather gives you\n" +
        "4. Paste it here"
    );
}

async function handleConnect(name, sessionId) {
    registry = loadJsonOrDefault(BOTS_REGISTRY_PATH, {});

    if (!name) {
        await listBots(sessionId);
        return;
    }
    if (!registry[name]) {
        await session.log(`No bot named '${name}'. Run /telegram setup ${name} first.`);
        return;
    }
    if (connected) {
        await session.log(`Already connected to '${currentBotName}'. Disconnect first.`);
        return;
    }

    // Check lock -- if another live session holds it, take over (Telegram 409 will release them)
    const lock = readLock(name);
    let tookOverFrom = null;
    if (lock && !isLockStale(lock) && lock.sessionId !== sessionId) {
        tookOverFrom = lock.sessionId;
    }

    // Validate token via getMe
    botToken = registry[name].token;
    try {
        botInfo = await getMe();
    } catch (err) {
        console.error(`telegram-bridge: getMe failed: ${err.message}`, err.stack);
        botToken = null;
        botInfo = null;
        if (err.status === 401) {
            await session.log(
                `Bot token is invalid or revoked. Re-register with \`/telegram remove ${name}\` then \`/telegram setup ${name}\`.`,
                { level: "error" }
            );
        } else {
            await session.log(`Failed to reach Telegram API: ${err.message}. Check your network and try again.`, { level: "error" });
        }
        return;
    }

    // Claim lock and connect
    mkdirSync(botDir(name), { recursive: true });
    writeLock(name, sessionId);
    currentBotName = name;
    currentSessionId = sessionId;
    shutdownRequested = false;

    access = loadJsonOrDefault(ACCESS_PATH, { allowedUsers: [], pending: {} });
    state = loadJsonOrDefault(botStatePath(name), { offset: 0 });
    setupEventHandlers(session);

    connected = true;

    // Register bot command menu with Telegram（editor = 无头菜单 + reboot）
    void syncBotCommandsMenu({ includeReboot: true });

    // 同步 Telegram 显示名（内部 registry key 不变；同名/限流不反复打 API）
    void syncBotDisplayName();

    const chatIds = getAllowedChatIds();

    if (chatIds.length === 0) {
        await session.log(
            `Telegram bridge connected (@${botInfo.username}).\n\n` +
            `No paired users yet. To pair:\n` +
            `1. Open Telegram and send any message to @${botInfo.username}\n` +
            `2. The bot will reply that a pairing code has been generated\n` +
            `3. The pairing code will appear here in the Copilot CLI terminal\n` +
            `4. Send that code to @${botInfo.username} in Telegram to complete pairing`
        );
    } else {
        if (tookOverFrom) {
            await session.log(`Took over bot '${name}' from session ${tookOverFrom}. Telegram bridge connected (@${botInfo.username}).`);
        } else {
            await session.log(`Telegram bridge connected (@${botInfo.username}).`);
            // 不再向 TG 发「session connected」：App 多进程/重连会刷屏（曾同一分钟多条）
        }
    }

    pollLoop().catch(err => {
        console.error("telegram-bridge: poll loop error:", err.message);
    });
}

async function handleDisconnect(sessionId) {
    if (!connected) {
        await session.log("Not connected. Nothing to disconnect.");
        return;
    }

    // 1. Stop poll loop
    shutdownRequested = true;
    if (abortController) abortController.abort();

    // 2. Save state before anything else（合并磁盘 lastSetMyName 缓存）
    persistBotState();

    // 3. 不再向 TG 发 disconnect 通知（与 connected/ended 一并关掉，避免刷屏）

    // 4. Stop typing and dismiss bubble (need botToken for API calls)
    stopTyping();
    await dismissBubble(true);

    // 5. Mark disconnected and release lock
    connected = false;
    if (currentBotName) removeLock(currentBotName, sessionId);

    // 6. Clear all bot-specific state
    botToken = null;
    botInfo = null;
    currentBotName = null;
    currentSessionId = null;
    state = null;

    await session.log("Telegram bridge disconnected.");
}

function formatBotLines(registry) {
    const names = Object.keys(registry);
    const lines = [];
    for (const name of names) {
        const username = registry[name].username || "unknown";
        const lock = readLock(name);
        let status;
        if (connected && currentBotName === name) {
            status = "(connected, this session)";
        } else if (lock && !isLockStale(lock)) {
            status = `(in use by session ${lock.sessionId})`;
        } else {
            status = "(available)";
        }
        const label = getBotLabel(name);
        lines.push(label === name
            ? `  ${label}  @${username}  ${status}`
            : `  ${label} (${name})  @${username}  ${status}`);
    }
    return lines;
}

async function handleStatus(sessionId) {
    registry = loadJsonOrDefault(BOTS_REGISTRY_PATH, {});
    const names = Object.keys(registry);

    if (names.length === 0) {
        await session.log("No bots registered. Use /telegram setup <name> to add one.");
        return;
    }

    const lines = ["Registered bots:", ...formatBotLines(registry)];

    const pairedCount = access?.allowedUsers?.length || 0;
    lines.push(`\nPaired users: ${pairedCount}`);

    await session.log(lines.join("\n"));
}

async function listBots(sessionId) {
    registry = loadJsonOrDefault(BOTS_REGISTRY_PATH, {});
    const names = Object.keys(registry);

    if (names.length === 0) {
        await session.log("No bots registered. Use /telegram setup <name> to add one.");
        return;
    }

    const lines = ["Available bots:", ...formatBotLines(registry)];

    lines.push("\nUse: /telegram connect <name>");
    await session.log(lines.join("\n"));
}

async function handleRemove(name, sessionId) {
    registry = loadJsonOrDefault(BOTS_REGISTRY_PATH, {});

    if (!name) {
        await session.log("Usage: /telegram remove <name>");
        return;
    }
    if (!registry[name]) {
        await session.log(`No bot named '${name}'.`);
        return;
    }

    const lock = readLock(name);
    if (lock && !isLockStale(lock)) {
        if (lock.sessionId === sessionId) {
            await session.log(`Bot '${name}' is connected to this session. Disconnect first.`);
        } else {
            await session.log(`Bot '${name}' is in use by session ${lock.sessionId}. Disconnect that session first.`);
        }
        return;
    }

    delete registry[name];
    saveJsonAtomic(BOTS_REGISTRY_PATH, registry, 0o600);
    try { rmSync(botDir(name), { recursive: true, force: true }); } catch {}

    await session.log(`Bot '${name}' removed.`);
}

ctx.handleConnect = handleConnect;
ctx.handleDisconnect = handleDisconnect;
ctx.handleSetup = handleSetup;

// ============================================================
// Section 11c: Command Router
// ============================================================

// Route /telegram subcommands dispatched via SDK command protocol.
async function handleTelegramCommand(args, sessionId) {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase() || "help";
    const botName = parts[1] || "";

    switch (subcommand) {
        case "setup":
            await handleSetup(botName);
            break;
        case "connect":
            await handleConnect(botName, sessionId);
            break;
        case "disconnect":
            await handleDisconnect(sessionId);
            break;
        case "status":
            await handleStatus(sessionId);
            break;
        case "remove":
            await handleRemove(botName, sessionId);
            break;
        default:
            await session.log("Available: /telegram setup|connect|disconnect|status|remove");
            break;
    }
}

// Register /telegram as an SDK slash command via the wire protocol.
// session.resume merges commands additively -- undefined fields are skipped.
async function registerSlashCommand(sess) {
    const commands = [{ name: "telegram", description: "Telegram bridge: setup, connect, disconnect, status, remove" }];
    await sess.connection.sendRequest("session.resume", {
        sessionId: sess.sessionId,
        commands,
        hooks: true,
    });

    sess.on("command.execute", (event) => {
        const { requestId, commandName, args } = event.data;
        if (commandName !== "telegram") return;
        handleTelegramCommand(args, sess.sessionId)
            .then(() => sess.rpc.commands.handlePendingCommand({ requestId }))
            .catch(err => {
                console.error("telegram-bridge: command error:", err.message);
                sess.rpc.commands.handlePendingCommand({ requestId, error: err.message });
            });
    });
}

    return {
        name,
        start: async (sid) => {
            currentSessionId = sid;
            if (isHeadless) {
                // 运行 Headless 自愈与防断线心跳守护循环
                (async () => {
                    let client = null;
                    let isLeader = false;
                    // daemon：独立常驻进程；app：桌面扩展内嵌无头（可被 daemon 抢占）
                    const leaderOpts = {
                        mode: "daemon",
                        preferSteal: true,
                    };

                    while (!shutdownRequested) {
                    isLeader = false;
                    while (!shutdownRequested && !tryAcquireHeadlessLeadership(name, leaderOpts)) {
                        console.error(
                            `telegram-bridge: [${name}] another headless leader is active; standby...`
                        );
                        await sleep(15000);
                    }
                    if (shutdownRequested) return;
                    isLeader = true;
                    console.error(
                        `telegram-bridge: [${name}] acquired headless leadership (pid=${process.pid} mode=daemon)`
                    );

                    while (!shutdownRequested) {
                        try {
                            if (!refreshHeadlessLeadership(name)) {
                                console.error(`telegram-bridge: [${name}] lost headless leadership; stepping down`);
                                // 释放 lock，便于外部 daemon 立刻 resume 同 sticky，避免同进程仍存活导致 isLockStale=false 死等
                                try {
                                    if (currentSessionId) removeLock(name, currentSessionId);
                                } catch {}
                                isLeader = false;
                                break;
                            }

                            // 若本 bot 已有其它存活进程持有 lock（非本 pid）：
                            // - App 侧：等待（避免多桌面会话连环 create）
                            // - 独立 daemon：强制清锁。App 被系统节流时可能既不 poll 也不 release，
                            //   若只等 isLockStale 会死等；leader 已归 daemon，sticky 在 state 里。
                            const existingLock = readLock(name);
                            if (existingLock && existingLock.pid !== process.pid) {
                                console.error(
                                    `telegram-bridge: [${name}] clearing lock held by pid=${existingLock.pid} session=${existingLock.sessionId}`
                                );
                                try {
                                    rmSync(botLockPath(name), { force: true });
                                } catch (rmLockErr) {
                                    console.error(
                                        `telegram-bridge: [${name}] clear lock failed:`,
                                        rmLockErr.message
                                    );
                                }
                            }

                            // 独立守护时 argv[0] 仍是 copilot；也可用 COPILOT_CLI_PATH 覆盖
                            const copilotCliPath =
                                process.env.COPILOT_CLI_PATH ||
                                process.env.COPILOT_CLI_BINARY ||
                                process.argv[0];
                            client = new CopilotClient({
                                connection: RuntimeConnection.forStdio({
                                    path: copilotCliPath,
                                })
                            });
                            headlessClient = client;
                            console.error(`telegram-bridge: [${name}] connecting to client...`);
                            await client.start();
                            console.error(`telegram-bridge: [${name}] client connected. Listing models...`);
                            let officialModels = [];
                            try {
                                officialModels = await client.listModels();
                            } catch (listErr) {
                                console.error(`telegram-bridge: [${name}] listModels failed:`, listErr.message);
                            }

                            const customInstructions = loadAgentsFromPath(botProfile.agentsMd, () => loadAgentsMdInstructions()); if (customInstructions) { console.error(`telegram-bridge: [${name}] loaded AGENTS.md instructions (${customInstructions.length} chars${botProfile.agentsMd ? `, profile=${botProfile.profile || "custom"}` : ", global"})`); }

                            const lastModelId = typeof readBotModel === "function" ? readBotModel(name) : null;
                            const desiredModel = pickStickySessionModel({
                                allowedModels: botProfile.allowedModels || null,
                                defaultModel: botProfile.defaultModel || null,
                                lastModelId,
                            });
                            const singleLock = isSingleModelLock(botProfile.allowedModels);
                            let didResume = false;
                            const sessionConfig = await buildHeadlessSessionConfig({
                                officialModels,
                                customInstructions,
                                // createPermissionHandler / createUserInputHandler 定义在 createBotInstance 作用域内，
                                // 必须在此注入；顶层 buildHeadlessSessionConfig 不能直接引用它们。
                                onPermissionRequest: createPermissionHandler(),
                                onUserInputRequest: createUserInputHandler(),
                                onExitPlanModeRequest: createExitPlanModeHandler(),
                                defaultModel: desiredModel || botProfile.defaultModel || null,
                                allowedModels: botProfile.allowedModels || null,
                                forceDefaultModel: singleLock,
                                loadMcp: botProfile.loadMcp !== false,
                                loadSkills: botProfile.loadSkills !== false,
                                systemMessageMode: botProfile.systemMessageMode || "customize",
                                mcpServerNames: botProfile.mcpServerNames || null,
                                skillNames: botProfile.skillNames || null,
                                cliproxyApiKey: loadBotCliproxyApiKey(botProfile),
                            });

                            // 1) 可 resume 才走 resume（空壳只有 workspace.yaml 会 Session not found）
                            // resume 同样保留 systemMessage，保证粘性会话也吃到最新人设
                            const resumeTarget = resolveHeadlessResumeTarget(name);
                            if (resumeTarget) {
                                try {
                                    const resumeConfig = { ...sessionConfig };
                                    const injected = !!resumeConfig.systemMessage?.content;
                                    console.error(
                                        `telegram-bridge: [${name}] resuming headless session ${resumeTarget} ` +
                                        `(model=${sessionConfig.model}, agents=${injected ? "inject" : "none"})...`
                                    );
                                    session = await client.resumeSession(resumeTarget, resumeConfig);
                                    currentSessionId = session.sessionId || resumeTarget;
                                    didResume = true;
                                    console.error(`telegram-bridge: [${name}] headless session resumed: ${currentSessionId}`);
                                } catch (resumeErr) {
                                    console.error(`telegram-bridge: [${name}] resume failed (${resumeTarget}): ${resumeErr.message}; falling back to createSession`);
                                    session = null;
                                }
                            } else {
                                const sticky = resolveHeadlessStickySessionId(name);
                                if (sticky && !isSessionResumable(sticky)) {
                                    console.error(
                                        `telegram-bridge: [${name}] sticky ${sticky} not resumable yet (empty shell); will reuse id on create`
                                    );
                                } else if (sticky) {
                                    console.error(
                                        `telegram-bridge: [${name}] sticky ${sticky} skipped by resume resolver; will try create`
                                    );
                                }
                            }

                            // 2) create：优先复用 sticky sessionId，避免每次新 UUID 空壳
                            if (!session) {
                                const stickyId = resolveHeadlessStickySessionId(name);
                                const createConfig = { ...sessionConfig };
                                if (stickyId) {
                                    // 空壳无法 resume，目录占同 id 会 create 失败 → 仅当安全空壳时删除后复用
                                    let canReuseSticky = true;
                                    if (sessionDirExists(stickyId) && !isSessionResumable(stickyId)) {
                                        try {
                                            const yamlPath = join(SESSION_STATE_DIR, stickyId, "workspace.yaml");
                                            let yamlContent = "";
                                            try {
                                                yamlContent = readFileSync(yamlPath, "utf8");
                                            } catch {}
                                            // lock 可能指向 sticky 自身，临时移出保护集再判定
                                            const protectedIds = getProtectedSessionIds();
                                            protectedIds.delete(stickyId);
                                            if (isSafeEmptyUnnamedShell(stickyId, yamlContent, protectedIds)) {
                                                rmSync(join(SESSION_STATE_DIR, stickyId), {
                                                    recursive: true,
                                                    force: true,
                                                });
                                                console.error(
                                                    `telegram-bridge: [${name}] removed safe empty shell ${stickyId} before sticky create`
                                                );
                                            } else {
                                                canReuseSticky = false;
                                                console.error(
                                                    `telegram-bridge: [${name}] sticky ${stickyId} not safe empty; create with new id`
                                                );
                                            }
                                        } catch (rmErr) {
                                            canReuseSticky = false;
                                            console.error(
                                                `telegram-bridge: [${name}] remove empty shell failed:`,
                                                rmErr.message
                                            );
                                        }
                                    }
                                    if (canReuseSticky) {
                                        createConfig.sessionId = stickyId;
                                        console.error(
                                            `telegram-bridge: [${name}] creating headless session reusing id ${stickyId} model=${sessionConfig.model}...`
                                        );
                                    } else {
                                        console.error(
                                            `telegram-bridge: [${name}] creating headless session with model ${sessionConfig.model}...`
                                        );
                                    }
                                } else {
                                    console.error(
                                        `telegram-bridge: [${name}] creating headless session with model ${sessionConfig.model}...`
                                    );
                                }
                                try {
                                    session = await client.createSession(createConfig);
                                    currentSessionId = session.sessionId;
                                    console.error(`telegram-bridge: [${name}] headless session created: ${session.sessionId}`);
                                } catch (createErr) {
                                    // 指定 id 失败时再无 id 创建一次
                                    if (createConfig.sessionId) {
                                        console.error(
                                            `telegram-bridge: [${name}] create with sticky id failed: ${createErr.message}; retry without id`
                                        );
                                        delete createConfig.sessionId;
                                        session = await client.createSession(createConfig);
                                        currentSessionId = session.sessionId;
                                        console.error(`telegram-bridge: [${name}] headless session created: ${session.sessionId}`);
                                    } else {
                                        throw createErr;
                                    }
                                }
                            }

                            // 诊断：列出会话内可见模型（含 BYOK）
                            try {
                                const listed = await session.rpc.model.list();
                                const ids = (listed?.list || []).map((m) => m.id).slice(0, 20);
                                console.error(`telegram-bridge: [${name}] session models sample: ${ids.join(", ")}`);
                            } catch (listErr) {
                                console.error(`telegram-bridge: [${name}] session.model.list failed:`, listErr.message);
                            }
                            
                            mkdirSync(botDir(name), { recursive: true });
                            writeLock(name, currentSessionId);
                            rememberBotSession(name, currentSessionId);
                            
                            state = loadJsonOrDefault(botStatePath(name), { offset: 0 });
                            // 保证内存 state 带上 lastSessionId（reload 后仍可 resume）
                            if (currentSessionId) state.lastSessionId = currentSessionId;
                            setupEventHandlers(session);
                            // 无头：对齐桌面「Run tools without asking」
                            await enableHeadlessAllowAll(session);

                            // BYOK：单模型锁或新建会话才强制切；resume 保留会话里已选模型。
                            // 官方 auto 无论何时一律踢走。
                            if (sessionConfig.model) {
                                const applied = await ensureUnblockedSessionModel(session, {
                                    desiredModel: sessionConfig.model,
                                    force: singleLock || !didResume,
                                    logPrefix: `telegram-bridge: [${name}]`,
                                });
                                if (applied?.currentId && !isOfficialModelBlocked(applied.currentId)) {
                                    rememberBotModel(name, applied.currentId);
                                }
                                if (applied?.switched && applied.desiredModel) {
                                    rememberBotModel(name, applied.desiredModel);
                                }
                            }
                            {
                                const kicked = await banishBlockedSessionModel(session, {
                                    fallbacks: collectBotModelFallbacks({
                                        lastModelId: typeof readBotModel === "function" ? readBotModel(name) : null,
                                        defaultModel: botProfile.defaultModel,
                                        sessionModel: sessionConfig.model,
                                    }),
                                    logPrefix: `telegram-bridge: [${name}]`,
                                });
                                if (kicked?.switched && kicked.desiredModel) {
                                    rememberBotModel(name, kicked.desiredModel);
                                }
                            }

                            connected = true;

                            // 菜单/显示名均为 best-effort：绝不 await，避免 TG 瞬断阻塞 pollLoop 进入
                            {
                                if (Array.isArray(botProfile.commandsMenu)) {
                                    const scopes = (botProfile.requireImage && Array.isArray(botProfile.allowedChats))
                                        ? botProfile.allowedChats.map((id) => ({ type: "chat", chat_id: Number(id) }))
                                        : [];
                                    const vipPublic = !!(botProfile.requireImage && vip?.isPublicEnabled?.());
                                    void syncBotCommandsMenu({
                                        commands: botProfile.commandsMenu,
                                        scopes,
                                        clearDefault: !!botProfile.denyPrivate,
                                        extra: [],
                                        deleteScopes: [],
                                    });
                                } else if (botProfile.restrictedCommands) {
                                    void syncBotCommandsMenu({
                                        commands: [
                                            { command: "new", description: "🆕 开启全新对话" },
                                            { command: "stop", description: "✋ 打断当前任务" },
                                        ],
                                    });
                                } else {
                                    void syncBotCommandsMenu({ includeReboot: true });
                                }
                            }
                            void syncBotDisplayName();

                            // /reboot KeepAlive：新进程起来后再通知触发聊天（普通崩溃重启不写这个文件）
                            try {
                                const notifyPath = join(botDir(name), "reboot-notify.json");
                                const pending = loadJsonOrDefault(notifyPath, null);
                                if (pending && pending.chatId != null) {
                                    try { rmSync(notifyPath, { force: true }); } catch {}
                                    const age = Date.now() - Number(pending.at || 0);
                                    if (age >= 0 && age <= 120000) {
                                        void sendMessage(
                                            pending.chatId,
                                            "♻️ <b>无头服务已上线</b>",
                                            "HTML"
                                        ).catch((err) => {
                                            console.error(
                                                `telegram-bridge: [${name}] reboot online notify failed: ${err.message}`
                                            );
                                        });
                                    }
                                }
                            } catch (err) {
                                console.error(`telegram-bridge: [${name}] reboot-notify read failed: ${err.message}`);
                            }

                            // 进入长轮询，如果是因 session 掉线跳出循环，本自愈逻辑会重新触发外层 while 重连
                            await pollLoop();
                        } catch (err) {
                            console.error(`telegram-bridge: [${name}] headless session loop encountered error:`, err.message);
                        }

                        // 每次断开后，重置状态，销毁旧连接并等待 10s 后重试连接
                        connected = false;
                        boundEventSession = null;
                        if (session) {
                            try { await session.disconnect(); } catch (_) {}
                            session = null;
                        }
                        if (client) {
                            try { await client.stop(); } catch (_) {}
                            client = null;
                        }
                        headlessClient = null;

                        if (shutdownRequested) break;
                        if (isLeader && !refreshHeadlessLeadership(name)) {
                            console.error(
                                `telegram-bridge: [${name}] lost headless leadership after disconnect; re-standby`
                            );
                            try {
                                if (currentSessionId) removeLock(name, currentSessionId);
                            } catch {}
                            isLeader = false;
                            break;
                        }
                        console.error(`telegram-bridge: [${name}] headless session lost. Reconnecting in 10 seconds...`);
                        await sleep(10000);
                    }

                    if (isLeader) {
                        releaseHeadlessLeadership(name);
                        isLeader = false;
                    }
                    if (shutdownRequested) break;
                    // 丢 leader 后短暂等待再抢（给 daemon 稳定时间）
                    await sleep(5000);
                    } // end outer leadership loop

                })().catch(err => {
                    console.error(`telegram-bridge: [${name}] headless self-healing daemon crashed:`, err);
                    try { releaseHeadlessLeadership(name); } catch {}
                });
            } else {
                console.error(`telegram-bridge: [${name}] editor/joinbot removed; skip start`);
            }
        },
        shutdown: async () => {
            shutdownRequested = true;
            if (abortController) abortController.abort();
            if (desktopHandoffTimer) {
                clearTimeout(desktopHandoffTimer);
                desktopHandoffTimer = null;
            }
            boundEventSession = null;
            if (connected) {
                const lock = readLock(name);
                const weOwnLock = lock && lock.pid === process.pid;
                if (weOwnLock) {
                    // editor：不再发「session ended」TG 通知（多实例重连会刷屏）
                    removeLock(name, currentSessionId);
                }
            }
            if (isHeadless) {
                try { releaseHeadlessLeadership(name); } catch {}
            }
            try {
                if (state && currentBotName) {
                    // 保留 lastSessionId，便于下次 resume / sticky create
                    if (currentSessionId) state.lastSessionId = currentSessionId;
                    persistBotState();
                }
            } catch {}
            stopTyping();
        }
    };
}

// Headless BYOK helpers: lib/byok-providers.mjs

// ============================================================
// Section 13: Lifecycle (startup + shutdown)
// ============================================================

/** 仅无头；joinbot / TELEGRAM_BRIDGE_MODE=all|editor-only 已移除 */
const BRIDGE_MODE = String(process.env.TELEGRAM_BRIDGE_MODE || "headless-only").trim().toLowerCase();

async function main() {
    loadShellEnvForByok();
    registry = loadJsonOrDefault(BOTS_REGISTRY_PATH, {});
    access = loadJsonOrDefault(ACCESS_PATH, { allowedUsers: [], pending: {} });
    cleanupTmpDir();

    const enabledBots = Object.entries(registry).filter(([, bot]) => {
        if (bot?.disabled) {
            return false;
        }
        return true;
    });
    if (enabledBots.length === 0) {
        console.error("Telegram bridge: no bots registered. Please run setup first.");
        return;
    }

    console.error(`telegram-bridge: starting (mode=${BRIDGE_MODE}, bots=${enabledBots.length})`);

    const sid = process.env.SESSION_ID || "unknown";
    // 角色：bot.role 优先；否则启用顺序第 1 个 editor，其后 headless
    for (let i = 0; i < enabledBots.length; i++) {
        const [name, bot] = enabledBots[i];
        if (bot.disabled) {
            console.error(`telegram-bridge: bot '${name}' is disabled in bots.json. Skipping.`);
            continue;
        }
        const profile = resolveBotProfile(name, bot, i);
        if (profile.role === "editor" || !profile.isHeadless) {
            console.error(`telegram-bridge: skip '${name}' (joinbot/editor removed)`);
            continue;
        }
        const isHeadless = true;
        if (BRIDGE_MODE && BRIDGE_MODE !== "headless-only" && BRIDGE_MODE !== "all") {
            console.error(`telegram-bridge: TELEGRAM_BRIDGE_MODE=${BRIDGE_MODE} ignored (headless-only)`);
        }
        const chatNotes = (bot.allowedChatNotes && typeof bot.allowedChatNotes === "object")
            ? bot.allowedChatNotes
            : {};
        const chatList = (profile.allowedChats || []).map((id) => {
            const note = chatNotes[String(id)];
            return note ? `${id}:${note}` : String(id);
        }).join(",");
        console.error(
            `telegram-bridge: boot bot='${name}' role=${profile.role} profile=${profile.profile || "-"} ` +
            `access=${profile.accessMode} perm=${profile.permissionMode} cd=${profile.cooldownSec}s ` +
            `mcp=${profile.loadMcp === false ? "off" : "on"}` +
            (profile.dailyLimit > 0 ? ` quota=${profile.dailyLimit}/day` : "") +
            (chatList ? ` chats=${chatList}` : "")
        );
        const instance = createBotInstance(name, bot.token, isHeadless, bot, i);
        activeInstances.push(instance);
        instance.start(sid).catch(err => {
            console.error(`telegram-bridge: failed to start bot '${name}':`, err);
        });
    }

    if (activeInstances.length === 0) {
        console.error(`telegram-bridge: no bot instances started for mode=${BRIDGE_MODE}`);
    }
}

// SIGTERM handler
process.on("SIGTERM", async () => {
    console.log("telegram-bridge: SIGTERM received, shutting down all bot instances...");
    const promises = activeInstances.map(inst => inst.shutdown());
    await Promise.race([
        Promise.allSettled(promises),
        sleep(3000),
    ]);
    cleanupTmpDir();
    process.exit(0);
});

// 防止未捕获的异步 Promise 异常直接导致整个 Node 进程崩溃退出
process.on("unhandledRejection", (err) => {
    console.error("telegram-bridge: unhandled rejection (suppressed):", err?.message || err);
});

main().catch(err => {
    console.error("telegram-bridge: fatal error:", err);
    process.exit(1);
});
