// bot-runtime.mjs — send queue, typing, tool bubble, inbound processUpdate, poll/lock/autoConnect
// Factory: attachRuntime(ctx). Behavior-preserving extract from extension.mjs.

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { escapeHtml } from "./markdown-tg.mjs";
import { getSessionName, SESSION_STATE_DIR } from "./session-fs.mjs";
import { banishBlockedSessionModel, collectBotModelFallbacks } from "./byok-providers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = join(__dirname, "..");

function safeFileName(name) {
    const base = basename(String(name || "file")).replace(/[^\w.\-()+@]+/g, "_");
    return base || "file";
}

/**
 * @param {any} ctx Bot instance context (getters for mutable state + telegram helpers)
 */
export function attachRuntime(ctx) {
    const SEND_PACE_MS = ctx.SEND_PACE_MS;
    const TYPING_INTERVAL_MS = ctx.TYPING_INTERVAL_MS;
    const TYPING_DEBOUNCE_MS = ctx.TYPING_DEBOUNCE_MS;
    const POLL_TIMEOUT = ctx.POLL_TIMEOUT;
    const ERROR_RETRY_BASE_MS = ctx.ERROR_RETRY_BASE_MS;
    const ERROR_RETRY_MAX_MS = ctx.ERROR_RETRY_MAX_MS;
    const sleep = ctx.sleep;
    const saveJsonAtomic = ctx.saveJsonAtomic;
    const botStatePath = ctx.botStatePath;

    // Section 4: Send Queue (outbound message pacing)
    // ============================================================



    const sendQueue = [];
    let sendQueueRunning = false;

    function enqueue(fn) {
        return new Promise((resolve, reject) => {
            sendQueue.push({ fn, resolve, reject });
            if (!sendQueueRunning) drainQueue();
        });
    }

    async function drainQueue() {
        sendQueueRunning = true;
        while (sendQueue.length > 0) {
            const { fn, resolve, reject } = sendQueue.shift();
            try {
                const result = await fn();
                resolve(result);
            } catch (err) {
                if (err.status === 429) {
                    sendQueue.unshift({ fn, resolve, reject });
                    await ctx.sleep(err.retryAfter * 1000);
                    continue;
                }
                reject(err);
            }
            if (sendQueue.length > 0) await ctx.sleep(ctx.SEND_PACE_MS);
        }
        sendQueueRunning = false;
    }




    // Section 7: Typing Indicator
    // ============================================================

    let typingInterval = null;
    let typingDebounceTimer = null;

    function startTyping(chatIds) {
    stopTyping();
    const doType = () => {
        // chatAction 旁路 sendQueue：不与正文抢串行位，也避免「正在输入」本身拖慢出站
        for (const chatId of chatIds) {
            ctx.sendChatAction(chatId).catch(() => {});
        }
        // bubble 或 agent 仍忙时续命 debounce；二者皆假则 60s 后自然停
        if (bubbleActive || ctx.isAgentBusy) resetTypingDebounce();
    };
    doType();
    typingInterval = setInterval(doType, ctx.TYPING_INTERVAL_MS);
    resetTypingDebounce();
    }

    function resetTypingDebounce() {
    if (typingDebounceTimer) clearTimeout(typingDebounceTimer);
    typingDebounceTimer = setTimeout(stopTyping, ctx.TYPING_DEBOUNCE_MS);
    }

    function ensureTyping() {
    if (!typingInterval && ctx.connected) {
        const allChatIds = getAllowedChatIds();
        if (allChatIds.length > 0) {
            startTyping(allChatIds);
            return;
        }
    }
    resetTypingDebounce();
    }

    function stopTyping() {
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    if (typingDebounceTimer) { clearTimeout(typingDebounceTimer); typingDebounceTimer = null; }
    }


    // Section 7c: Tool Call Bubble (ephemeral status message)
    // ============================================================

    const activeTools = new Map(); // toolCallId -> { name, description }
    const bubbleMessageIds = new Map(); // chatId -> messageId (current, for editing)
    const allBubbleIds = new Map(); // chatId -> Set<messageId> (every bubble msg ever created, for guaranteed cleanup)
    let bubbleDebounceTimer = null;
    let bubbleActive = false; // guards against stale updates after dismiss
    let flushInProgress = false; // mutex: prevents concurrent flushBubble from creating duplicate messages
    let reflushNeeded = false; // set when an update arrives while a flush is in-flight
    let lastCompletedToolDesc = null; // persists last tool description so it stays visible between tool calls
    let bubbleDismissTimers = []; // delayed purge timers for the latest dismiss generation
    let bubbleEpoch = 0; // bumps on each dismiss; in-flight flush must not resurrect dismissed msgs
    let pendingBubbleDeletes = new Set(); // "chatId:msgId" entries whose delete failed; retried across turns
    let scheduledBubbleSnapshot = new Map(); // chatId -> Set<messageId> whose purge is scheduled; survives repeated dismisses
    const BUBBLE_DEBOUNCE_MS = 300;
    const BUBBLE_DISMISS_DELAY_MS = 1000; // show final status briefly, then delete
    // Multi-wave purge: long sendQueue + network jitter used to leave orphans after 1s/3s only
    const BUBBLE_DISMISS_RETRY_MS_LIST = [1000, 3000, 9000, 30000, 60000];
    // Telegram sendMessage hard limit is 4096; keep bubble well under it
    const BUBBLE_MAX_CHARS = 900;
    const BUBBLE_LINE_MAX = 300;

    function trackBubbleMsg(chatId, messageId) {
    bubbleMessageIds.set(chatId, messageId);
    if (!allBubbleIds.has(chatId)) allBubbleIds.set(chatId, new Set());
    allBubbleIds.get(chatId).add(messageId);
    }

    function untrackBubbleMsg(chatId, messageId) {
    if (bubbleMessageIds.get(chatId) === messageId) bubbleMessageIds.delete(chatId);
    allBubbleIds.get(chatId)?.delete(messageId);
    }

    /** Copy all IDs from source into target; both are chatId -> Set<messageId> maps. */
    function mergeBubbleSnapshot(target, source) {
    for (const [chatId, ids] of source) {
        if (!ids || ids.size === 0) continue;
        let targetIds = target.get(chatId);
        if (!targetIds) {
            targetIds = new Set();
            target.set(chatId, targetIds);
        }
        for (const msgId of ids) targetIds.add(msgId);
    }
    }

    /** Collapse whitespace + hard-cap length so bash/story args never blow up the bubble. */
    function compactBubbleLine(text, maxLen = BUBBLE_LINE_MAX) {
    const one = String(text || "").replace(/\s+/g, " ").trim();
    if (!one) return "";
    if (one.length <= maxLen) return one;
    return `${one.slice(0, Math.max(0, maxLen - 1))}…`;
    }

    function describeToolCall(toolName, args) {
    if (!args) return compactBubbleLine(toolName.replace(/_/g, " "));
    try {
        const fileParam = args.TargetFile || args.AbsolutePath || args.path || args.filePath || args.file || "";
        const fileBase = fileParam ? basename(fileParam) : "";

        switch (toolName) {
            case "bash":
            case "powershell": {
                const cmd = args.command || "";
                // Prefer first non-empty logical line; still compact long one-liners
                const first = String(cmd).split("\n").map((l) => l.trim()).find(Boolean) || cmd;
                return compactBubbleLine(first);
            }
            case "grep": {
                const pat = args.pattern || "";
                const g = args.glob ? ` ${args.glob}` : (fileBase ? ` ${fileBase}` : "");
                return compactBubbleLine(`grep "${pat}"${g}`);
            }
            case "glob":
                return compactBubbleLine(`glob ${args.pattern || ""}`);
            case "view":
            case "view_file":
            case "read_file":
                return fileBase ? `view ${fileBase}` : "view";
            case "edit":
            case "replace_file_content":
            case "multi_replace_file_content":
            case "write_file":
            case "write_to_file":
                return fileBase ? `edit ${fileBase}` : "edit";
            case "create":
                return fileBase ? `create ${fileBase}` : "create";
            case "task": {
                const desc = args.description || args.agent_type || "";
                return desc ? compactBubbleLine(`task: ${desc}`) : "task";
            }
            case "web_fetch":
                try { return `fetch ${new URL(args.url).hostname}`; } catch { return "fetch"; }
            case "sql":
                return compactBubbleLine(args.description || "sql");
            case "skill":
                return args.skill ? `skill: ${args.skill}` : "skill";
            case "ask_user":
                return "waiting for input";
            case "read_agent":
            case "write_agent":
            case "list_agents":
            case "read_bash":
            case "write_bash":
            case "stop_bash":
                return null; // suppress noisy internal tools
            case "report_intent":
            case "store_memory":
                return null;
            default:
                if (fileBase) {
                    return compactBubbleLine(`${toolName.replace(/_/g, " ")} ${fileBase}`);
                }
                return compactBubbleLine(toolName.replace(/_/g, " "));
        }
    } catch {
        return compactBubbleLine(toolName.replace(/_/g, " "));
    }
    }

    function composeBubbleText() {
    const lines = [];
    for (const [, info] of activeTools) {
        if (info.description) {
            lines.push(`● ${info.description}`);
        }
    }
    let text;
    if (lines.length === 0) {
        if (lastCompletedToolDesc) {
            text = `● ${lastCompletedToolDesc}`;
        } else {
            return null; // nothing to show
        }
    } else {
        text = lines.join("\n");
    }
    // Hard cap whole bubble (multi-tool bash can still stack long lines)
    if (text.length > BUBBLE_MAX_CHARS) {
        text = `${text.slice(0, BUBBLE_MAX_CHARS - 1)}…`;
    }
    return text;
    }

    function scheduleBubbleUpdate() {
    if (!bubbleActive) return;
    if (bubbleDebounceTimer) clearTimeout(bubbleDebounceTimer);
    bubbleDebounceTimer = setTimeout(flushBubble, BUBBLE_DEBOUNCE_MS);
    }

    async function flushBubble() {
    bubbleDebounceTimer = null;
    if (!bubbleActive) return;

    if (flushInProgress) {
        reflushNeeded = true;
        return;
    }
    flushInProgress = true;
    const epochAtStart = bubbleEpoch;

    try {
        const text = composeBubbleText();
        if (!text) { return; } // nothing to display
        // Dismissed while waiting for mutex / compose — do not send
        if (!bubbleActive || epochAtStart !== bubbleEpoch) return;

        const chatIds = getAllowedChatIds();
        for (const chatId of chatIds) {
            if (!bubbleActive || epochAtStart !== bubbleEpoch) break;

            const existingId = bubbleMessageIds.get(chatId);
            if (existingId) {
                try {
                    await enqueue(() => ctx.editMessageText(chatId, existingId, text));
                    // edit completed after dismiss → best-effort delete (message may still show old/long text)
                    if (!bubbleActive || epochAtStart !== bubbleEpoch) {
                        try { await enqueue(() => ctx.deleteMessage(chatId, existingId)); } catch {}
                        untrackBubbleMsg(chatId, existingId);
                    }
                } catch (err) {
                    const msg = err?.message || "";
                    if (/message is not modified/i.test(msg)) {
                        // Text unchanged, message still exists, keep tracking it
                        if (!bubbleActive || epochAtStart !== bubbleEpoch) {
                            try { await enqueue(() => ctx.deleteMessage(chatId, existingId)); } catch {}
                            untrackBubbleMsg(chatId, existingId);
                        }
                    } else if (/message to edit not found/i.test(msg)) {
                        untrackBubbleMsg(chatId, existingId);
                        if (!bubbleActive || epochAtStart !== bubbleEpoch) continue;
                        try {
                            const sent = await enqueue(() => ctx.sendMessage(chatId, text));
                            const mid = sent?.message_id;
                            if (!mid) continue;
                            if (!bubbleActive || epochAtStart !== bubbleEpoch) {
                                try { await enqueue(() => ctx.deleteMessage(chatId, mid)); } catch {}
                            } else {
                                trackBubbleMsg(chatId, mid);
                            }
                        } catch (sendErr) {
                            console.warn("telegram-bridge: bubble send after edit-miss failed:", sendErr?.message || sendErr);
                        }
                    } else if (/message is too long|MESSAGE_TOO_LONG/i.test(msg)) {
                        // Long text cannot be edited in — drop this bubble id and try a truncated re-send
                        console.warn("telegram-bridge: bubble edit too long, recreating truncated");
                        untrackBubbleMsg(chatId, existingId);
                        try { await enqueue(() => ctx.deleteMessage(chatId, existingId)); } catch {}
                        if (!bubbleActive || epochAtStart !== bubbleEpoch) continue;
                        const short = text.length > 400 ? `${text.slice(0, 399)}…` : text;
                        try {
                            const sent = await enqueue(() => ctx.sendMessage(chatId, short));
                            const mid = sent?.message_id;
                            if (!mid) continue;
                            if (!bubbleActive || epochAtStart !== bubbleEpoch) {
                                try { await enqueue(() => ctx.deleteMessage(chatId, mid)); } catch {}
                            } else {
                                trackBubbleMsg(chatId, mid);
                            }
                        } catch (sendErr) {
                            console.warn("telegram-bridge: bubble truncated re-send failed:", sendErr?.message || sendErr);
                        }
                    } else {
                        console.warn("telegram-bridge: bubble edit failed:", msg);
                    }
                }
            } else {
                if (!bubbleActive || epochAtStart !== bubbleEpoch) continue;
                try {
                    const sent = await enqueue(() => ctx.sendMessage(chatId, text));
                    const mid = sent?.message_id;
                    if (!mid) continue;
                    if (!bubbleActive || epochAtStart !== bubbleEpoch) {
                        try { await enqueue(() => ctx.deleteMessage(chatId, mid)); } catch {}
                    } else {
                        trackBubbleMsg(chatId, mid);
                    }
                } catch (sendErr) {
                    const msg = sendErr?.message || String(sendErr);
                    if (/message is too long|MESSAGE_TOO_LONG/i.test(msg)) {
                        const short = text.length > 400 ? `${text.slice(0, 399)}…` : text;
                        try {
                            if (!bubbleActive || epochAtStart !== bubbleEpoch) continue;
                            const sent = await enqueue(() => ctx.sendMessage(chatId, short));
                            const mid = sent?.message_id;
                            if (!mid) continue;
                            if (!bubbleActive || epochAtStart !== bubbleEpoch) {
                                try { await enqueue(() => ctx.deleteMessage(chatId, mid)); } catch {}
                            } else {
                                trackBubbleMsg(chatId, mid);
                            }
                        } catch (e2) {
                            console.warn("telegram-bridge: bubble short-send failed:", e2?.message || e2);
                        }
                    } else {
                        console.warn("telegram-bridge: bubble send failed:", msg);
                    }
                }
            }
        }
    } finally {
        flushInProgress = false;
        if (reflushNeeded && bubbleActive && epochAtStart === bubbleEpoch) {
            reflushNeeded = false;
            scheduleBubbleUpdate();
        } else {
            reflushNeeded = false;
        }
    }
    }

    /**
     * End tool-bubble visibility.
     * Snapshot message IDs at dismiss time and always purge that snapshot after delay,
     * even if a new turn sets bubbleActive=true (old logic skipped delete when active → stuck bubbles).
     * Also bump bubbleEpoch so any in-flight flushBubble cannot re-track / leave orphans.
     */
    async function dismissBubble(immediate = false) {
    // 先重试历史删除失败的气泡（跨 turn 持久兜底，解决网络抖动导致的残留）
    if (pendingBubbleDeletes.size > 0) {
        const retrySnapshot = new Map();
        for (const key of pendingBubbleDeletes) {
            const [chatId, msgId] = key.split(":");
            if (!retrySnapshot.has(chatId)) retrySnapshot.set(chatId, new Set());
            retrySnapshot.get(chatId).add(Number(msgId));
        }
        await purgeBubbleSnapshot(retrySnapshot);
    }

    bubbleActive = false;
    reflushNeeded = false;
    bubbleEpoch += 1;
    if (bubbleDebounceTimer) {
        clearTimeout(bubbleDebounceTimer);
        bubbleDebounceTimer = null;
    }
    activeTools.clear();
    lastCompletedToolDesc = null;

    // Cancel prior delayed purges, but reclaim their snapshots first. Repeated
    // dismisses (e.g. sess.on("abort") + /stop handler + turn_end) must not drop
    // already-tracked message IDs — that is what used to strand interrupt bubbles.
    for (const t of bubbleDismissTimers) clearTimeout(t);
    bubbleDismissTimers = [];

    // Snapshot + untrack immediately so a new turn can own a fresh bubble
    // while these IDs still get deleted on the timer.
    const snapshot = new Map();
    mergeBubbleSnapshot(snapshot, scheduledBubbleSnapshot);
    mergeBubbleSnapshot(snapshot, allBubbleIds);
    scheduledBubbleSnapshot = snapshot;
    allBubbleIds.clear();
    bubbleMessageIds.clear();

    if (immediate) {
        // disconnect: purge now before token may be cleared
        await purgeBubbleSnapshot(snapshot);
        return;
    }

    // Stay visible ~1s, then multi-wave delete (same snapshot, not bubbleActive-gated).
    for (const delay of BUBBLE_DISMISS_RETRY_MS_LIST) {
        bubbleDismissTimers.push(setTimeout(() => {
            void purgeBubbleSnapshot(snapshot);
        }, delay));
    }
    }

    async function purgeBubbleSnapshot(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    for (const [chatId, ids] of snapshot) {
        // Copy ids — successful deletes drop from set so later waves shrink work
        for (const msgId of [...ids]) {
            try {
                await enqueue(() => ctx.deleteMessage(chatId, msgId));
                ids.delete(msgId);
                pendingBubbleDeletes.delete(`${chatId}:${msgId}`);
            } catch (err) {
                const msg = err?.message || "";
                // Already gone / too old — treat as success
                if (/message to delete not found|message can't be deleted|message_id_invalid/i.test(msg)) {
                    ids.delete(msgId);
                    pendingBubbleDeletes.delete(`${chatId}:${msgId}`);
                } else {
                    // 网络抖动等导致的删除失败 → 记入跨 turn 待删队列，下次 dismiss 再试
                    pendingBubbleDeletes.add(`${chatId}:${msgId}`);
                }
                // else keep for next retry wave
            }
        }
    }
    // Drop empty chat buckets
    for (const [chatId, ids] of [...snapshot.entries()]) {
        if (!ids || ids.size === 0) snapshot.delete(chatId);
    }
    }

    /** Immediate purge of currently tracked bubbles (no delay). Used by disconnect paths. */
    async function deleteAllBubbleMessages() {
    const snapshot = new Map();
    for (const [chatId, ids] of allBubbleIds) {
        snapshot.set(chatId, new Set(ids));
    }
    allBubbleIds.clear();
    bubbleMessageIds.clear();
    await purgeBubbleSnapshot(snapshot);
    }


    // Section 8: File/Photo Handling
    // ============================================================



    /**
 * 下载 TG 附件到会话 files/，一律以 type:file 路径附件送入 session。
 *
 * 不要用 type:blob + base64：会在 events.jsonl 写入整图 session.binary_asset，
 * 无头写入后再用桌面打开同一 session 时极易卡死/崩溃；文字无附件则正常。
 * 磁盘路径既给模型读图，也便于回溯。
 *
 * @returns {Promise<null | { attachment: object, displayName: string, path: string }>}
 */
    function imageCooldownIds(profile, userIdStr) {
        if (profile?.requireImage) return ["__global__", String(userIdStr)];
        return [String(userIdStr)];
    }

    async function rejectIfImageBusyOrCooling(chatId, profile, userIdStr) {
        if (profile?.requireImage && ctx.isAgentBusy) {
            stopTyping();
            dismissBubble();
            await enqueue(() => ctx.sendMessage(chatId, "⏳ 正在处理，请等这轮结束。"));
            return true;
        }
        if (ctx.cooldown && typeof ctx.cooldown.check === "function") {
            for (const id of imageCooldownIds(profile, userIdStr)) {
                const cd = ctx.cooldown.check(id);
                if (!cd.ok) {
                    stopTyping();
                    dismissBubble();
                    await enqueue(() =>
                        ctx.sendMessage(chatId, `⏳ 冷却中，请 ${cd.remainSec}s 后再试。`)
                    );
                    return true;
                }
            }
        }
        if (profile?.requireImage && ctx.dailyQuota && typeof ctx.dailyQuota.check === "function") {
            const q = ctx.dailyQuota.check(userIdStr);
            if (!q.ok) {
                stopTyping();
                dismissBubble();
                await enqueue(() =>
                    ctx.sendMessage(
                        chatId,
                        `今日次数已用完（${q.used}/${q.limit}），明天 0 点（上海时间）后再试。`
                    )
                );
                return true;
            }
        }
        return false;
    }

    function touchImageCooldown(profile, userIdStr) {
        if (ctx.cooldown && typeof ctx.cooldown.touch === "function") {
            for (const id of imageCooldownIds(profile, userIdStr)) ctx.cooldown.touch(id);
        }
        if (profile?.requireImage && ctx.dailyQuota && typeof ctx.dailyQuota.touch === "function") {
            ctx.dailyQuota.touch(userIdStr);
        }
    }

async function handleFileAttachment(message) {
    let fileId, displayName;
    if (message.photo && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        fileId = photo.file_id;
        displayName = `photo_${message.message_id}.jpg`;
    } else if (message.document) {
        fileId = message.document.file_id;
        displayName = message.document.file_name || `document_${message.message_id}`;
    } else {
        return null;
    }

    displayName = safeFileName(displayName);
    const fileInfo = await ctx.getFile(fileId);
    const sid = ctx.currentSessionId || ctx.session?.sessionId || null;
    const destDir = sid
        ? join(SESSION_STATE_DIR, sid, "files")
        : null;
    if (destDir) {
        try { mkdirSync(destDir, { recursive: true }); } catch {}
    }

    // destDir 落盘即可；不再取 buffer 做 base64
    const { path: localPath } = await ctx.downloadFile(fileInfo.file_path, {
        destDir: destDir || undefined,
        destName: displayName,
    });

    return {
        displayName,
        path: localPath,
        attachment: {
            type: "file",
            path: localPath,
            displayName,
        },
    };
}


    // Section 9: Message Processing (inbound from Telegram)
    // ============================================================

    function getAllowedChatIds() {
        // 历史：私聊 allowlist = userId 即 chatId
        // open-group：优先本轮 inbound chat
        if (ctx.activeReplyChatId != null) {
            return [Number(ctx.activeReplyChatId)];
        }
        const users = (ctx.access?.allowedUsers || []).map(Number).filter((n) => Number.isFinite(n));
        return users;
    }

    async function processUpdate(update) {
    // --------------------------------------------------------
    // 1. 拦截并处理内联键盘按钮点击事件（Callback Query）
    // --------------------------------------------------------
    if (update.callback_query) {
        const cq = update.callback_query;
        const userId = cq.from?.id;

        // 仅处理已授权用户的按钮点击事件
        if (userId != null && ctx.isAllowed(String(userId))) {
            if (cq.data?.startsWith("model:")) {
                // 点击了模型切换按钮，触发模型切换回调函数
                await ctx.handleModelCallback(cq);
            } else if (cq.data?.startsWith("mode:")) {
                // 点击了模式切换按钮，触发模式切换回调函数
                await ctx.handleModeCallback(cq);
            } else if (cq.data?.startsWith("thinking:")) {
                await ctx.handleThinkingCallback(cq);
            } else if (cq.data?.startsWith("session:")) {
                // 点击了会话切换按钮，触发会话切换回调函数
                await ctx.handleSessionCallback(cq);
            } else if (cq.data?.startsWith("clean:")) {
                // 点击了 /clean 二次确认按钮
                await ctx.handleCleanCallback(cq);
            } else if (cq.data?.startsWith("perm:")) {
                // 点击了权限授权按钮，触发权限处理函数
                await ctx.handlePermissionCallback(cq);
            } else if (cq.data?.startsWith("xplan:")) {
                await ctx.handleExitPlanModeCallback(cq);
            } else if (cq.data?.startsWith("ask:")) {
                // 点击了用户提问选择按钮，触发输入回复处理函数
                await ctx.handleUserInputCallback(cq);
            } else if (cq.data?.startsWith("codex:")) {
                // Codex 子命令按钮
                const chatId = cq.message?.chat?.id;
                if (chatId != null && typeof ctx.handleCodexCallback === "function") {
                    await ctx.handleCodexCallback(cq.id, cq.data, chatId);
                } else {
                    await ctx.answerCallbackQuery(cq.id, "codex 回调未加载").catch(() => {});
                }
            } else if (cq.data?.startsWith("claude:")) {
                // Claude 子命令按钮
                const chatId = cq.message?.chat?.id;
                if (chatId != null && typeof ctx.handleClaudeCallback === "function") {
                    await ctx.handleClaudeCallback(cq.id, cq.data, chatId);
                } else {
                    await ctx.answerCallbackQuery(cq.id, "claude 回调未加载").catch(() => {});
                }
            }
        } else {
            // 未授权用户点击时，调用 Telegram API 弹窗提示未授权
            await ctx.answerCallbackQuery(cq.id, "未授权").catch(() => {});
        }
        return;
    }

    const message = update.message;
    if (!message) return;
    // 加群/改名/置顶等服务消息一律静默
    if (message.new_chat_members || message.left_chat_member || message.new_chat_title
        || message.new_chat_photo || message.delete_chat_photo || message.group_chat_created
        || message.supergroup_chat_created || message.migrate_to_chat_id || message.pinned_message) {
        return;
    }

    const chatId = message.chat.id;
    const userId = message.from?.id;
    if (userId == null) return;
    let text = message.text || message.caption || "";
    const userIdStr = String(userId);
    const botUsername = ctx.botInfo?.username || ctx.botProfile?.raw?.username || null;
    const profile = ctx.botProfile || { accessMode: "allowlist", requireMention: false, restrictedCommands: false };

    // 每次收到新消息时重新加载 access.json（实现用户授权热更新）
    ctx.reloadAccess();

    // 统一准入：allowlist 或 open-group profile
    let inboundGate;
    if (typeof ctx.evaluateInboundAccess === "function") {
        inboundGate = ctx.evaluateInboundAccess({
            profile,
            userId: userIdStr,
            message,
            isOwnerAllowed: (id) => ctx.isAllowed(String(id)),
            botUsername,
        });
    } else {
        inboundGate = {
            allowed: ctx.isAllowed(userIdStr),
            reason: ctx.isAllowed(userIdStr) ? "allowlist" : "not-paired",
            chatId,
            chatType: message.chat?.type,
        };
    }


    // 处理等待输入 (ask_user) 的响应（仅已准入用户）
    if (inboundGate.allowed) {
        // /rename 两步等待：优先于 ask_user，避免改名被当成 agent 答复
        // （ask_user 进行中时仍让 agent 输入优先——仅当没有 pendingUserInputs/awaitingInput）
        const agentWaitingInput =
            ctx.pendingUserInputs.size > 0 || !!ctx.awaitingInput;
        if (!agentWaitingInput && ctx.awaitingRename && typeof ctx.tryConsumeRenameInput === "function") {
            const consumed = await ctx.tryConsumeRenameInput(chatId, text);
            if (consumed) return;
            // false = 其它斜杠命令，继续往下路由
        }

        // /codex 两步等待：消费 Codex 连续对话输入
        if (!agentWaitingInput && ctx.awaitingCodex && typeof ctx.tryConsumeCodexInput === "function") {
            // Codex 模式支持发图：图片消息先下载落盘，把本地路径传给 codex
            let codexImagePath = "";
            if (message.photo || message.document) {
                try {
                    const prepared = await handleFileAttachment(message);
                    if (prepared?.path) codexImagePath = prepared.path;
                } catch (err) {
                    console.error("telegram-bridge: codex attachment download failed:", err.message);
                }
            }
            const consumed = await ctx.tryConsumeCodexInput(chatId, text, message.message_id, codexImagePath);
            if (consumed) return;
            // false = 其它斜杠命令，继续往下路由
        }

        // /claude 两步等待：消费 Claude 连续对话输入
        if (!agentWaitingInput && ctx.awaitingClaude && typeof ctx.tryConsumeClaudeInput === "function") {
            let claudeImagePath = "";
            if (message.photo || message.document) {
                try {
                    const prepared = await handleFileAttachment(message);
                    if (prepared?.path) claudeImagePath = prepared.path;
                } catch (err) {
                    console.error("telegram-bridge: claude attachment download failed:", err.message);
                }
            }
            const consumed = await ctx.tryConsumeClaudeInput(chatId, text, message.message_id, claudeImagePath);
            if (consumed) return;
            // false = 其它斜杠命令，继续往下路由
        }

        // 优先使用最新的广播事件方式应答（支持子代理）
        if (ctx.pendingUserInputs.size > 0) {
            const [reqId, item] = ctx.pendingUserInputs.entries().next().value;
            ctx.pendingUserInputs.delete(reqId);

            // 与按钮回调对齐：同时解冻本地 onUserInputRequest Promise，避免只靠 completed 事件
            if (ctx.awaitingInput) {
                const { resolve } = ctx.awaitingInput;
                clearTimeout(ctx.awaitingInput.timer);
                ctx.awaitingInput = null;
                resolve(text);
            }

            try {
                await ctx.session.rpc.ui.handlePendingUserInput({
                    requestId: item.requestId,
                    response: {
                        answer: text,
                        wasFreeform: true,
                    }
                });

                await enqueue(() => ctx.sendMessage(chatId, `✅ 答复已提交: "${text}"`));
            } catch (err) {
                console.error("telegram-bridge: handlePendingUserInput freeform failed:", err.message);
                await enqueue(() => ctx.sendMessage(chatId, `❌ 提交答复失败: ${err.message}`));
            }
            return;
        }

        // 降级使用主会话本地 Promise 方式应答
        if (ctx.awaitingInput) {
            const { resolve } = ctx.awaitingInput;
            clearTimeout(ctx.awaitingInput.timer);
            ctx.awaitingInput = null;
            resolve(text);
            return;
        }
    }

    if (!inboundGate.allowed) {
        // open-group 未 @提及：静默忽略，不弹配对
        if (inboundGate.silent || inboundGate.reason === "need-mention") {
            return;
        }
        if (inboundGate.reason === "private-denied") {
            await enqueue(() =>
                ctx.sendMessage(
                    chatId,
                    "本 Bot 仅在群组内使用。",
                    profile.requireImage ? "HTML" : undefined
                )
            );
            return;
        }
        if (inboundGate.reason === "chat-not-allowlisted") {
            return;
        }
        // 默认：allowlist pairing（editor / 主无头）
        if (profile.accessMode === "allowlist" || !profile.accessMode) {
            await ctx.handlePairing(chatId, userId, text);
        }
        return;
    }

    // 禁止并发（方案 B）：agent 忙碌时，其它 chat 直接拒收，避免 sticky 出站串聊
    if (
        ctx.isAgentBusy &&
        ctx.activeReplyChatId != null &&
        Number(ctx.activeReplyChatId) !== Number(chatId)
    ) {
        await enqueue(() =>
            ctx.sendMessage(
                chatId,
                "⏳ 当前正忙（另一对话处理中），请稍后再发。",
                "HTML"
            )
        );
        return;
    }

    // 绑定本轮回复目标 chat（群消息回源 chat，不再错推到私聊 allowlist）
    ctx.activeReplyChatId = chatId;

    // 收到消息后立即给消息点个“眼睛 👁️”的回应（Ack Reaction）
    enqueue(() => ctx.setMessageReaction(chatId, message.message_id, "\uD83D\uDC40").catch(() => {}));

    // 正在输入：优先当前 chat
    const allChatIds = [chatId];
    startTyping(allChatIds);

    // 处理文件与图片附件
    if (message.photo || message.document) {
        try {
            const prepared = await handleFileAttachment(message);
            if (prepared) {
                if (!ctx.session) {
                    stopTyping();
                    dismissBubble();
                    await enqueue(() => ctx.sendMessage(chatId, "⚠️ 会话未连接，无法发送附件。请先 /new 或 /telegram connect。"));
                    return;
                }
                if (await rejectIfImageBusyOrCooling(chatId, profile, userIdStr)) return;
                // 一律 path 附件（见 handleFileAttachment 注释：blob 会炸桌面 resume）
                const ignoreCaption = !!profile.requireImage;
                const stripped = (typeof ctx.stripBotMention === "function"
                    ? ctx.stripBotMention(text || "", botUsername)
                    : text);
                const promptText = ignoreCaption
                    ? (stripped || "Please analyze this image.")
                    : (stripped || "User sent a file.");
                await ctx.session.send({
                    prompt: promptText,
                    attachments: [prepared.attachment],
                });
                touchImageCooldown(profile, userIdStr);
                return;
            }
        } catch (err) {
            stopTyping();
            dismissBubble();
            const detail = err?.cause?.code || err?.cause?.message || err?.message || String(err);
            const tag = ctx.currentBotName || ctx.name ? `[${ctx.currentBotName || ctx.name}] ` : "";
            console.error(`telegram-bridge: ${tag}attachment failed:`, detail);
            await enqueue(() =>
                ctx.sendMessage(
                    chatId,
                    `Failed to process attachment: ${err.message}${/fetch failed|timed out|network|ECONN/i.test(String(err.message)) ? "（网络抖动，可再发一次图）" : ""}`
                )
            );
            return;
        }
    }

    if (text) {
        // 去掉群里 @Bot /command@Bot 噪音
        if (typeof ctx.stripBotMention === "function") {
            text = ctx.stripBotMention(text, botUsername);
        }
        const trimmedText = text.trim();

        // --------------------------------------------------------
        // 2. 拦截并分发自定义的斜杠快捷命令（避免被当做普通对话发送给 Copilot）
        // 注意：上面已 startTyping + bubbleActive=true；slash 不进 agent turn，
        // 若不清理，bubbleActive 会每 4s 重置 60s debounce →「正在输入」挂很久。
        // --------------------------------------------------------

        const restricted = !!profile.restrictedCommands;
        const blockedCmd = (label) => {
            stopTyping();
            dismissBubble();
            return enqueue(() =>
                ctx.sendMessage(chatId, `本 Bot 不支持 ${label}。`)
            );
        };

        // /status 命令：显示当前模型、模式、会话名称
        if (trimmedText === "/status" || trimmedText.startsWith("/status@")) {
            if (restricted) { await blockedCmd("/status"); return; }
            stopTyping();
            dismissBubble();
            if (typeof ctx.handleStatusCommand === "function") {
                await ctx.handleStatusCommand(chatId);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ status 命令未加载。", "HTML"));
            }
            return;
        }

        // /codex [prompt]：Codex 子命令系统
        if (
            trimmedText === "/codex" ||
            trimmedText.startsWith("/codex@") ||
            trimmedText.startsWith("/codex ") ||
            trimmedText.startsWith("/codex\n")
        ) {
            if (restricted) { await blockedCmd("/codex"); return; }
            stopTyping();
            dismissBubble();
            let arg = "";
            const m = trimmedText.match(/^\/codex(?:@\w+)?(?:\s+([\s\S]+))?$/i);
            if (m && m[1]) arg = m[1].trim();
            if (typeof ctx.handleCodexCommand === "function") {
                await ctx.handleCodexCommand(chatId, arg);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ codex 命令未加载。", "HTML"));
            }
            return;
        }

        // /claude [prompt]：Claude 子命令系统
        if (
            trimmedText === "/claude" ||
            trimmedText.startsWith("/claude@") ||
            trimmedText.startsWith("/claude ") ||
            trimmedText.startsWith("/claude\n")
        ) {
            if (restricted) { await blockedCmd("/claude"); return; }
            stopTyping();
            dismissBubble();
            let arg = "";
            const m = trimmedText.match(/^\/claude(?:@\w+)?(?:\s+([\s\S]+))?$/i);
            if (m && m[1]) arg = m[1].trim();
            if (typeof ctx.handleClaudeCommand === "function") {
                await ctx.handleClaudeCommand(chatId, arg);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ claude 命令未加载。", "HTML"));
            }
            return;
        }

        // /rich [on|off|status]：表格富文本开关（默认关 → 列表）
        if (
            trimmedText === "/rich" ||
            trimmedText.startsWith("/rich@") ||
            trimmedText.startsWith("/rich ")
        ) {
            if (restricted) { await blockedCmd("/rich"); return; }
            stopTyping();
            dismissBubble();
            let arg = "";
            const m = trimmedText.match(/^\/rich(?:@\w+)?(?:\s+([\s\S]+))?$/i);
            if (m && m[1]) arg = m[1].trim();
            if (typeof ctx.handleRichCommand === "function") {
                await ctx.handleRichCommand(chatId, arg);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ rich 命令未加载。", "HTML"));
            }
            return;
        }

        // /reboot：重启无头 daemon
        // 无头进程里直接 bash restart → launchctl kickstart -k 会把正在跑 restart 的子进程一起杀掉，菜单有命令也等于没重启。
        // 有 LaunchAgent KeepAlive 时：发完提示后退出，由 launchd 在 ThrottleInterval（约 10s）后拉起。
        // 编辑器侧 / 无 launchd：仍可同步执行 restart 脚本。
        if (trimmedText === "/reboot" || trimmedText.startsWith("/reboot@")) {
            if (restricted) { await blockedCmd("/reboot"); return; }
            stopTyping();
            dismissBubble();
            const daemonScript = join(BRIDGE_ROOT, "scripts", "headless-daemon.sh");
            const launchPlist = join(homedir(), "Library/LaunchAgents/com.copilot-telegram-bridge.plist");
            const headlessKeepAlive = !!(ctx.isHeadless && existsSync(launchPlist));
            const hint = "♻️ <b>正在重启无头服务</b>";
            if (headlessKeepAlive && ctx.currentBotName && typeof ctx.saveJsonAtomic === "function") {
                try {
                    const notifyPath = join(dirname(ctx.botStatePath(ctx.currentBotName)), "reboot-notify.json");
                    ctx.saveJsonAtomic(notifyPath, { chatId, at: Date.now() });
                } catch (err) {
                    console.error(`telegram-bridge: reboot-notify write failed: ${err.message}`);
                }
            }
            await enqueue(() => ctx.sendMessage(chatId, hint, "HTML"));
            if (headlessKeepAlive) {
                console.error(
                    `telegram-bridge: [${ctx.currentBotName}] /reboot: exit for launchd KeepAlive`
                );
                setTimeout(() => process.exit(0), 1500);
                return;
            }
            setTimeout(() => {
                execFile("bash", [daemonScript, "restart"], { timeout: 30000 }, async (err, _out, stderr) => {
                    if (err && !ctx.connected) return;
                    if (err) {
                        await enqueue(() => ctx.sendMessage(chatId,
                            `❌ <b>重启失败</b>\n<pre>${escapeHtml(stderr || err.message)}</pre>`, "HTML"));
                    } else {
                        await enqueue(() => ctx.sendMessage(chatId,
                            `♻️ <b>无头服务已上线</b>`, "HTML"));
                    }
                });
            }, 1500);
            return;
        }


        // /new：无头 createSession 开新对话；/start 兼容别名（非专用 bot）
        if (
            trimmedText === "/new" ||
            trimmedText.startsWith("/new@") ||
            (!profile.requireImage && (trimmedText === "/start" || trimmedText.startsWith("/start@")))
        ) {
            stopTyping();
            dismissBubble();
            if (typeof ctx.handleNewCommand === "function") {
                await ctx.handleNewCommand(chatId);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ new 命令未加载。", "HTML"));
            }
            return;
        }

        // /session 命令：向用户发送当前 Copilot 的 Session 详情和连接锁状态
        if (trimmedText === "/session" || trimmedText.startsWith("/session@")) {
            if (restricted) { await blockedCmd("/session"); return; }
            stopTyping();
            dismissBubble();
            await ctx.handleSessionCommand(chatId);
            return;
        }

        // /clean 命令：预览并二次确认清理空壳未命名会话
        if (trimmedText === "/clean" || trimmedText.startsWith("/clean@")) {
            if (restricted) { await blockedCmd("/clean"); return; }
            stopTyping();
            dismissBubble();
            await ctx.handleCleanCommand(chatId);
            return;
        }

        // /model 命令：向用户发送模型切换的内联选择键盘
        if (trimmedText === "/model" || trimmedText.startsWith("/model@")) {
            if (restricted) { await blockedCmd("/model"); return; }
            stopTyping();
            dismissBubble();
            await ctx.handleModelCommand(chatId);
            return;
        }

        // /mode 命令：向用户发送模式切换的内联选择键盘
        if (trimmedText === "/mode" || trimmedText.startsWith("/mode@")) {
            if (restricted) { await blockedCmd("/mode"); return; }
            stopTyping();
            dismissBubble();
            await ctx.handleModeCommand(chatId);
            return;
        }

        // /thinking 命令：切换推理思考等级（官方模型 reasoningEffort）
        if (trimmedText === "/thinking" || trimmedText.startsWith("/thinking@")) {
            if (restricted) { await blockedCmd("/thinking"); return; }
            stopTyping();
            dismissBubble();
            if (typeof ctx.handleThinkingCommand === "function") {
                await ctx.handleThinkingCommand(chatId);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ 思考等级命令未加载。", "HTML"));
            }
            return;
        }

        // /rename [新名字]：改当前 session 显示名（不经 agent）
        if (trimmedText === "/rename" || trimmedText.startsWith("/rename@") || trimmedText.startsWith("/rename ")) {
            if (restricted) { await blockedCmd("/rename"); return; }
            stopTyping();
            dismissBubble();
            // 解析可选参数：/rename 名字 | /rename@Bot 名字
            let arg = "";
            const m = trimmedText.match(/^\/rename(?:@\w+)?(?:\s+([\s\S]+))?$/i);
            if (m && m[1]) arg = m[1].trim();
            if (arg.toLowerCase() === "cancel") {
                if (ctx.awaitingRename) {
                    if (ctx.awaitingRename.timer) clearTimeout(ctx.awaitingRename.timer);
                    ctx.awaitingRename = null;
                    await enqueue(() => ctx.sendMessage(chatId, "❎ 已取消改名。", "HTML"));
                } else {
                    await enqueue(() => ctx.sendMessage(chatId, "ℹ️ 当前没有进行中的改名。", "HTML"));
                }
                return;
            }
            if (typeof ctx.handleRenameCommand === "function") {
                await ctx.handleRenameCommand(chatId, arg);
            } else {
                await enqueue(() => ctx.sendMessage(chatId, "⚠️ 改名命令未加载。", "HTML"));
            }
            return;
        }

        // /stop 或 /cancel 命令：强行打断当前 Copilot 正在运行的任务
        // 若正在改名等待，/cancel 只取消改名、不 abort agent
        if (trimmedText === "/stop" || trimmedText.startsWith("/stop@") || trimmedText === "/cancel" || trimmedText.startsWith("/cancel@")) {
            if (ctx.awaitingRename && (trimmedText === "/cancel" || trimmedText.startsWith("/cancel@"))) {
                if (ctx.awaitingRename.timer) clearTimeout(ctx.awaitingRename.timer);
                ctx.awaitingRename = null;
                stopTyping();
                dismissBubble();
                await enqueue(() => ctx.sendMessage(chatId, "❎ 已取消改名。", "HTML"));
                return;
            }
            if (ctx.session) {
                try {
                    await ctx.session.abort();
                } catch (err) {
                    console.error("telegram-bridge: session.abort failed:", err.message);
                }
            }
            // /stop：取消「做完回 Plan」，留在当前执行模式
            ctx.restorePlanAfterTurn = false;
            ctx.stickyRestoreArmed = false;
            ctx.isAgentBusy = false;
            stopTyping();
            dismissBubble();
            await enqueue(() => ctx.sendMessage(chatId, "✋ <b>停！当前任务已成功打断</b>", "HTML"));
            return;
        }


        // --------------------------------------------------------
        // 3. 普通对话消息：若 AI 正在忙碌执行任务，自动打断前一任务再发送
        // --------------------------------------------------------
        if (ctx.isAgentBusy && ctx.session) {
            if (profile.requireImage) {
                stopTyping();
                dismissBubble();
                await enqueue(() => ctx.sendMessage(chatId, "⏳ 正在处理，请等这轮结束。"));
                return;
            }
            try {
                await ctx.session.abort();
                // 打断后不要立刻回 Plan；解除 armed，等新指令真正开跑后再在 idle 回 Plan
                if (ctx.stickyPlanMode && ctx.restorePlanAfterTurn) {
                    ctx.stickyRestoreArmed = false;
                }
                await enqueue(() => ctx.sendMessage(chatId, "✋ <i>已打断上一个任务，正在处理新指令...</i>", "HTML"));
            } catch (err) {
                console.error("telegram-bridge: auto-abort failed:", err.message);
            }
            ctx.isAgentBusy = false;
            stopTyping();
            dismissBubble();
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (!ctx.session) {
            stopTyping();
            dismissBubble();
            await enqueue(() => ctx.sendMessage(chatId, "⚠️ 会话未连接，无法发送。请先 /new 或 /telegram connect。"));
            return;
        }
        // CD：防滥用（按 userId；斜杠命令不在此路径）
        if (await rejectIfImageBusyOrCooling(chatId, profile, userIdStr)) return;
        await ctx.session.send({ prompt: text });
        touchImageCooldown(profile, userIdStr);
        return;
    }

    stopTyping();
    dismissBubble();
    await enqueue(() => ctx.sendMessage(chatId, "Unsupported message type. Text, photos, and documents only."));
    }


    // Section 12: Poll Loop
    // ============================================================

    async function pollLoop() {
    let errorDelay = ctx.ERROR_RETRY_BASE_MS;
    // 心跳节流：原先每轮 await model.list() 会堵在 getUpdates 之前，
    // RPC 慢/挂时表现为「半天没响应，过一会又一下全回来」
    const HEARTBEAT_INTERVAL_MS = 60_000;
    const HEARTBEAT_TIMEOUT_MS = 8_000;
    let lastHeartbeatAt = 0;
    // poll 瞬断日志：首错 + 原因变化 + 长故障心跳；恢复时一条 recovered（不改退避语义）
    let pollFailCount = 0;
    let lastPollFailMsg = "";
    // long poll 与 webhook 互斥；启动轮询前清掉 webhook，避免 409/空转
    try {
        await ctx.callTelegram("deleteWebhook", { drop_pending_updates: false });
    } catch (err) {
        console.warn(`telegram-bridge: deleteWebhook failed:`, err.message);
    }

    while (!ctx.shutdownRequested) {
        // 在每次轮询前，检查锁文件是否依然指派给当前会话。如果已被其他会话切走，则优雅退出轮询。
        if (ctx.currentBotName) {
            const lock = ctx.readLock(ctx.currentBotName);
            if (!lock || lock.sessionId !== ctx.currentSessionId) {
                console.error(`telegram-bridge: lock changed to another session (${lock?.sessionId}), releasing connection.`);
                ctx.connected = false;
                break;
            }
            // 无头：leader 被独立 daemon 抢走时也要退出 poll，避免双 poll / App 挂起后假活
            if (ctx.isHeadless && typeof ctx.refreshHeadlessLeadership === "function") {
                if (!ctx.refreshHeadlessLeadership(ctx.currentBotName)) {
                    console.error(
                        `telegram-bridge: [${ctx.currentBotName}] headless leadership lost during poll; releasing`
                    );
                    ctx.connected = false;
                    break;
                }
            }
        }

        // 心跳：节流 + 超时；超时/失败不阻塞下一轮 getUpdates，连续失败才断线自愈
        if (ctx.session && Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeatAt = Date.now();
            try {
                await Promise.race([
                    (async () => {
                        await ctx.session.rpc.model.list();
                        const r = await banishBlockedSessionModel(ctx.session, {
                            fallbacks: collectBotModelFallbacks({
                                lastModelId: typeof ctx.readBotModel === "function"
                                    ? ctx.readBotModel(ctx.currentBotName)
                                    : ctx.state?.lastModelId,
                                defaultModel: ctx.botProfile?.defaultModel,
                            }),
                            logPrefix: `telegram-bridge: [${ctx.currentBotName}]`,
                        });
                        if (r?.switched && r.desiredModel && typeof ctx.rememberBotModel === "function" && ctx.currentBotName) {
                            ctx.rememberBotModel(ctx.currentBotName, r.desiredModel);
                            if (ctx.state) ctx.state.lastModelId = r.desiredModel;
                        }
                    })(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("heartbeat timeout")), HEARTBEAT_TIMEOUT_MS)
                    ),
                ]);
            } catch (rpcErr) {
                console.error(`telegram-bridge: [${ctx.currentBotName}] session heartbeat failed:`, rpcErr.message);
                // 超时多半是暂时卡顿，不立即拆连接；明确连接死亡类错误再退出
                const msg = String(rpcErr.message || rpcErr);
                if (/not connected|disconnected|ECONN|socket|closed|destroyed/i.test(msg)) {
                    ctx.connected = false;
                    break;
                }
            }
        }

        ctx.abortController = new AbortController();
        try {
            const updates = await ctx.getUpdates(ctx.state.offset, ctx.POLL_TIMEOUT);
            if (pollFailCount > 0) {
                const tag = ctx.currentBotName ? `[${ctx.currentBotName}] ` : "";
                if (pollFailCount >= 3) {
                    console.error(
                        `telegram-bridge: ${tag}poll recovered after ${pollFailCount} consecutive error(s)` +
                            (lastPollFailMsg ? `: ${lastPollFailMsg}` : "")
                    );
                }
                pollFailCount = 0;
                lastPollFailMsg = "";
            }
            errorDelay = ctx.ERROR_RETRY_BASE_MS;

            for (const update of updates) {
                try {
                    await processUpdate(update);
                } catch (err) {
                    console.error("telegram-bridge: error processing update:", err.message);
                }
                ctx.state.offset = update.update_id + 1;
            }

            if (updates.length > 0 && ctx.currentBotName) {
                if (typeof ctx.persistBotState === "function") ctx.persistBotState();
                else ctx.saveJsonAtomic(ctx.botStatePath(ctx.currentBotName), ctx.state);
            }
        } catch (err) {
            if (ctx.abortController.signal.aborted) break;

            if (err.status === 409) {
                // Save state before clearing
                if (ctx.state && ctx.currentBotName) {
                    try {
                        if (typeof ctx.persistBotState === "function") ctx.persistBotState();
                        else ctx.saveJsonAtomic(ctx.botStatePath(ctx.currentBotName), ctx.state);
                    } catch {}
                }

                // Stop typing and dismiss bubble (need botToken for API calls)
                stopTyping();
                try { await dismissBubble(); } catch {}

                ctx.connected = false;
                if (ctx.currentBotName && ctx.currentSessionId) ctx.removeLock(ctx.currentBotName, ctx.currentSessionId);

                const lostBotName = ctx.currentBotName;
                ctx.botToken = null;
                ctx.botInfo = null;
                ctx.currentBotName = null;
                ctx.currentSessionId = null;
                ctx.state = null;

                await ctx.session.log(
                    `Telegram bridge released (another session took over). Type /telegram connect ${lostBotName || "<name>"} to reclaim.`,
                    { level: "warning" }
                );
                break;
            }

            const failMsg = String(err?.message || err);
            pollFailCount += 1;
            const tag = ctx.currentBotName ? `[${ctx.currentBotName}] ` : "";
            const shouldLog =
                pollFailCount === 1 ||
                failMsg !== lastPollFailMsg ||
                pollFailCount === 10 ||
                pollFailCount === 50 ||
                pollFailCount % 100 === 0;
            if (shouldLog) {
                if (pollFailCount > 1 && failMsg !== lastPollFailMsg) {
                    console.error(
                        `telegram-bridge: ${tag}poll error changed after ${pollFailCount - 1}x ` +
                            `(${lastPollFailMsg} → ${failMsg}); retry in ${errorDelay}ms`
                    );
                } else if (pollFailCount === 1) {
                    console.error(`telegram-bridge: ${tag}poll error (retry in ${errorDelay}ms):`, failMsg);
                } else {
                    console.error(
                        `telegram-bridge: ${tag}poll still failing (${pollFailCount}x, retry in ${errorDelay}ms):`,
                        failMsg
                    );
                }
            }
            lastPollFailMsg = failMsg;
            await ctx.sleep(errorDelay);
            errorDelay = Math.min(errorDelay * 2, ctx.ERROR_RETRY_MAX_MS);
        }
    }
    }

    // 专用 id：热重载 / 多次 join 时 clear 自身，勿动 typingInterval
    let lockPollerId = null;

    /**
     * 认领「待接管占位锁」（pid=0）并广播「会话切换成功」。
     *
     * 由 poller 与 autoConnectWithRetry 共用，保证切换通知至多发送一次：
     * 1. tryClaimLock 以 O_EXCL 门闩做原子认领，同一时刻仅一个实例能成功；
     * 2. handleConnect 成功后、广播前再次校验锁归属，防期间被他人覆盖；
     * 3. 连接失败（getMe/握手异常）不广播。
     *
     * @param {string} botName
     * @param {string} sessionId
     * @returns {Promise<boolean>} 是否完成认领 + 广播
     */
    async function claimLockAndAnnounce(botName, sessionId) {
        if (ctx.connected) return false;
        // 仅「占位锁（pid=0）被接管」属于用户发起的切换，需要广播；
        // 死锁残留（认领后崩溃）接管时静默——用户此前已收到过切换通知，避免重复。
        const wasHandoff = (() => {
            const lock = ctx.readLock(botName);
            return !!(lock && lock.sessionId === sessionId && lock.pid === 0);
        })();
        if (!ctx.tryClaimLock(botName, sessionId)) return false;

        try {
            await ctx.handleConnect(botName, sessionId);
        } catch (err) {
            console.error(`telegram-bridge: claim lock connect failed:`, err.message);
            return false;
        }
        if (!ctx.connected) return false; // 连接未建立（token 失效/网络失败），不广播

        // 广播前兜底校验：锁必须仍归本进程且仍是目标会话，否则放弃广播
        const verify = ctx.readLock(botName);
        if (!verify || verify.sessionId !== sessionId || verify.pid !== process.pid) {
            console.error(`telegram-bridge: lock re-assigned during connect; skip announce`);
            return false;
        }

        if (!wasHandoff) return true; // 死锁残留接管：不广播
        const chatIds = getAllowedChatIds();
        const sessionName = getSessionName(sessionId) || String(sessionId || "").slice(0, 8);
        for (const chatId of chatIds) {
            await ctx.sendMessage(
                chatId,
                `✅ <b>会话切换成功</b>\n\n当前活动会话已切换至：<b>【${escapeHtml(sessionName)}】</b>`,
                "HTML"
            );
        }
        return true;
    }

    function startLockPoller(botName, sessionId) {
        if (lockPollerId != null) {
            clearInterval(lockPollerId);
            lockPollerId = null;
        }
        lockPollerId = setInterval(async () => {
            if (ctx.connected) return;

            try {
                const lock = ctx.readLock(botName);
                // 自有锁但未连接（handoff 超时写回 / handleConnect 失败残留）：直接重连
                if (
                    lock &&
                    lock.sessionId === sessionId &&
                    lock.pid === process.pid &&
                    typeof ctx.handleConnect === "function"
                ) {
                    console.error(
                        `telegram-bridge: session ${sessionId} lock owned but disconnected; reconnecting...`
                    );
                    try {
                        await ctx.handleConnect(botName, sessionId);
                    } catch (reconErr) {
                        console.error(
                            `telegram-bridge: self-lock reconnect failed:`,
                            reconErr.message
                        );
                    }
                    return;
                }
                // 可认领：锁指向本会话，且「占位（pid=0）或持有者已死」；他人活锁不抢
                const claimable = lock && lock.sessionId === sessionId &&
                    lock.pid !== process.pid &&
                    (lock.pid === 0 || ctx.isLockStale(lock));
                if (claimable) {
                    console.error(`telegram-bridge: session ${sessionId} is assigned. Claiming lock and connecting...`);
                    await claimLockAndAnnounce(botName, sessionId);
                }
            } catch (err) {
                console.error("telegram-bridge: lock poller error:", err.message);
            }
        }, 5000);
    }

    async function autoConnectWithRetry(botName, sessionId) {
        while (!ctx.shutdownRequested && !ctx.connected) {
            const lock = ctx.readLock(botName);
            // 待接管占位锁（pid=0）匹配本会话：走原子认领 + 广播，补上原 autoConnect 漏发的切换通知
            const claimable = lock && lock.sessionId === sessionId &&
                lock.pid !== process.pid &&
                (lock.pid === 0 || ctx.isLockStale(lock));
            if (claimable) {
                console.error(`telegram-bridge: session ${sessionId} is assigned. Claiming lock and connecting...`);
                if (await claimLockAndAnnounce(botName, sessionId)) {
                    break;
                }
                await ctx.sleep(5000);
                continue;
            }
            // 锁被存活进程持有：
            if (lock && !ctx.isLockStale(lock)) {
                if (lock.sessionId !== sessionId) {
                    // 他会话持有桥 → 本会话不抢（切到本会话时由 handoff 占位锁触发认领）
                    console.error(`telegram-bridge: another active session (${lock.sessionId}) holds the lock. Stopping auto-connect retry.`);
                    break;
                }
                if (lock.pid !== process.pid) {
                    // 本会话已被其它实例接管（pid≠0）→ 不重复连接，等待 poller 或下次 handoff
                    console.error(`telegram-bridge: session ${sessionId} already held by pid=${lock.pid}; waiting...`);
                    await ctx.sleep(5000);
                    continue;
                }
                // pid===process.pid 且未连接 → 上次 handleConnect 失败残留，走下方重连
            }

            try {
                console.error(`telegram-bridge: attempting auto-connect to '${botName}' (session: ${sessionId})...`);
                await ctx.handleConnect(botName, sessionId);
                if (ctx.connected) {
                    console.error(`telegram-bridge: auto-connect successful!`);
                    break;
                }
            } catch (err) {
                console.error(`telegram-bridge: auto-connect attempt failed: ${err.message}`);
            }

            await ctx.sleep(10000);
        }
    }



    // Expose runtime helpers on ctx for handlers/commands and late-bound slash connect
    Object.assign(ctx, {
        enqueue,
        drainQueue,
        startTyping,
        ensureTyping,
        stopTyping,
        describeToolCall,
        scheduleBubbleUpdate,
        dismissBubble,
        getAllowedChatIds,
        handleFileAttachment,
        processUpdate,
        pollLoop,
        startLockPoller,
        autoConnectWithRetry,
        activeTools,
        bubbleMessageIds,
        allBubbleIds,
    });

    // Mutable bubble flags via getters (handlers use ctx.bubbleActive / lastCompletedToolDesc)
    Object.defineProperties(ctx, {
        bubbleActive: {
            configurable: true,
            enumerable: true,
            get() { return bubbleActive; },
            set(v) { bubbleActive = v; },
        },
        lastCompletedToolDesc: {
            configurable: true,
            enumerable: true,
            get() { return lastCompletedToolDesc; },
            set(v) { lastCompletedToolDesc = v; },
        },
    });

    return {
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
        get bubbleActive() { return bubbleActive; },
        set bubbleActive(v) { bubbleActive = v; },
        get lastCompletedToolDesc() { return lastCompletedToolDesc; },
        set lastCompletedToolDesc(v) { lastCompletedToolDesc = v; },
    };
}
