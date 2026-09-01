// Per-bot profile helpers: agents path, access mode, cooldown, permission policy.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadModelsConfig } from "./byok-providers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = join(__dirname, "..");
const EXTENSIONS_ROOT = join(BRIDGE_ROOT, "..");

/** @param {string | undefined} p */
export function expandHomePath(p) {
    if (!p || typeof p !== "string") return p;
    const home = process.env.HOME || process.env.USERPROFILE || homedir() || "";
    return p
        .replace(/\$\{HOME\}/g, home)
        .replace(/\$HOME\b/g, home)
        .replace(/\$\{EXTENSIONS\}/g, EXTENSIONS_ROOT)
        .replace(/\$\{BRIDGE_ROOT\}/g, BRIDGE_ROOT)
        .replace(/^~(?=\/|$)/, home);
}

/**
 * 相对路径相对 bridge 根目录解析（bots.json agentsMd 等）。
 * @param {string | undefined | null} p
 */
export function resolveBotPath(p) {
    if (!p || typeof p !== "string") return p;
    const expanded = expandHomePath(p);
    if (!expanded) return expanded;
    if (isAbsolute(expanded)) return normalize(expanded);
    return normalize(join(BRIDGE_ROOT, expanded));
}

/**
 * 仅 headless。`role: editor` 仍返回 editor，启动时会被跳过。
 */
export function inferBotRole(name, bot = {}, enabledIndex = 0) {
    if (bot.role === "editor") return "editor";
    return "headless";
}

/**
 * Normalize registry entry for runtime.
 * @param {string} name
 * @param {Record<string, any>} bot
 * @param {number} enabledIndex 0-based among enabled bots
 */
export function resolveBotProfile(name, bot = {}, enabledIndex = 0) {
    const role = inferBotRole(name, bot, enabledIndex);
    const isHeadless = role === "headless";
    const accessMode = String(bot.accessMode || "allowlist").toLowerCase();
    const permissionMode = String(bot.permissionMode || "allow-all").toLowerCase();
    const cooldownSec = Math.max(0, Number(bot.cooldownSec ?? 0) || 0);
    const allowedChats = Array.isArray(bot.allowedChats)
        ? bot.allowedChats.map((x) => Number(x)).filter((n) => Number.isFinite(n))
        : [];
    const requireMention =
        bot.requireMention === true ||
        (bot.requireMention == null && accessMode === "open-group");
    const denyPrivate = bot.denyPrivate === true;
    const requireImage =
        bot.requireImage === true ||
        (bot.requireImage == null && bot.profile === "prompt-reverse");
    const restrictedCommands = bot.restrictedCommands !== false && (
        bot.profile === "prompt-reverse" ||
        permissionMode === "deny-all" ||
        accessMode === "open-group"
    );
    const modelSet = bot.modelSet ? String(bot.modelSet).trim() : null;
    const modelsConfig = modelSet ? loadModelsConfig() : null;
    const setPolicy = modelSet ? (modelsConfig.modelSets[modelSet] || null) : null;
    if (modelSet && !setPolicy && modelsConfig.schemaVersion >= 2) {
        throw new Error(`bot '${name}' references unknown modelSet '${modelSet}'`);
    }
    if (modelSet && !setPolicy) {
        console.warn(
            `telegram-bridge: bot '${name}' modelSet '${modelSet}' unavailable in legacy/fallback config`,
        );
    }
    const explicitDefault = bot.defaultModel ? String(bot.defaultModel).trim() : null;
    const defaultModel = explicitDefault || setPolicy?.defaultModel || null;
    let modelAllowlist;
    if (Array.isArray(bot.allowedModels)) {
        // legacy 显式空数组 = 不限制；非空数组继续兼容。
        modelAllowlist = bot.allowedModels.length
            ? bot.allowedModels.map((x) => String(x).trim()).filter(Boolean)
            : null;
    } else if (setPolicy) {
        modelAllowlist = [...setPolicy.models];
    } else {
        // 保持旧语义：只写 defaultModel 时视为单模型锁。
        modelAllowlist = defaultModel ? [defaultModel] : null;
    }
    // MCP：显式 loadMcp 优先；deny-all / prompt-reverse 默认不加载（工具反正 deny）
    let loadMcp;
    if (bot.loadMcp === true) loadMcp = true;
    else if (bot.loadMcp === false) loadMcp = false;
    else loadMcp = !(permissionMode === "deny-all" || bot.profile === "prompt-reverse");
    // Skills：显式 loadSkills 优先；deny-all / prompt-reverse 默认不加载技能（避免无用 33 个技能元数据污染）
    let loadSkills;
    if (bot.loadSkills === true) loadSkills = true;
    else if (bot.loadSkills === false) loadSkills = false;
    else loadSkills = !(permissionMode === "deny-all" || bot.profile === "prompt-reverse");
    // systemMessageMode: "replace" | "customize" | "append"；prompt-reverse 默认 "replace"（0 冗余 CLI 提示词），其他默认 "customize"
    const systemMessageMode = bot.systemMessageMode
        ? String(bot.systemMessageMode).trim().toLowerCase()
        : (bot.profile === "prompt-reverse" ? "replace" : "customize");
    const mcpServerNames = Array.isArray(bot.mcpServerNames)
        ? bot.mcpServerNames.map((x) => String(x).trim()).filter(Boolean)
        : null;
    const modelsCfgForSkills = loadModelsConfig();
    let skillNames = null;
    if (Array.isArray(bot.skillNames) && bot.skillNames.length) {
        skillNames = bot.skillNames.map((x) => String(x).trim()).filter(Boolean);
    } else {
        const skillSetKey = bot.skillSet != null && String(bot.skillSet).trim() !== ""
            ? String(bot.skillSet).trim()
            : (isHeadless && loadSkills ? "all" : "");
        if (skillSetKey === "all") {
            skillNames = null;
        } else if (skillSetKey && modelsCfgForSkills.skillSets?.[skillSetKey]) {
            skillNames = [...modelsCfgForSkills.skillSets[skillSetKey]];
        }
    }
    return {
        name,
        label: (bot.label && String(bot.label).trim()) || name,
        role,
        isHeadless,
        profile: bot.profile || null,
        agentsMd: bot.agentsMd ? resolveBotPath(String(bot.agentsMd)) : null,
        accessMode,
        permissionMode,
        cooldownSec,
        allowedChats,
        requireMention,
        requireImage,
        denyPrivate,
        restrictedCommands,
        modelSet,
        defaultModel,
        allowedModels: modelAllowlist,
        loadMcp,
        loadSkills,
        systemMessageMode,
        mcpServerNames,
        skillNames,
        raw: bot,
    };
}

/** @param {string | null | undefined} agentsPath fallback global loader */
export function loadAgentsFromPath(agentsPath, fallbackLoader) {
    if (agentsPath) {
        const path = resolveBotPath(agentsPath);
        if (path && existsSync(path)) {
            try {
                const text = readFileSync(path, "utf8").trim();
                if (text) return text;
            } catch (err) {
                console.error(`telegram-bridge: failed to read agentsMd ${path}:`, err.message);
            }
        } else {
            console.error(`telegram-bridge: agentsMd missing: ${path || agentsPath}`);
        }
    }
    if (typeof fallbackLoader === "function") return fallbackLoader();
    return undefined;
}

/**
 * Cooldown store per bot (memory + optional disk under bots/<name>/cooldown.json)
 */
export function createCooldownTracker({ botDir, cooldownSec }) {
    const sec = Math.max(0, Number(cooldownSec) || 0);
    const filePath = join(botDir, "cooldown.json");
    /** @type {Record<string, number>} userId -> last ok epoch ms */
    let map = {};
    try {
        if (existsSync(filePath)) {
            map = JSON.parse(readFileSync(filePath, "utf8")) || {};
        }
    } catch {
        map = {};
    }

    function persist() {
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            // keep last 500 keys
            const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 500);
            map = Object.fromEntries(entries);
            writeFileSync(filePath, JSON.stringify(map, null, 2));
        } catch {}
    }

    /**
     * @returns {{ ok: true } | { ok: false, remainSec: number }}
     */
    function check(userId) {
        if (sec <= 0) return { ok: true };
        const id = String(userId);
        const last = map[id] || 0;
        const elapsed = (Date.now() - last) / 1000;
        if (elapsed >= sec) return { ok: true };
        return { ok: false, remainSec: Math.ceil(sec - elapsed) };
    }

    function touch(userId) {
        if (sec <= 0) return;
        map[String(userId)] = Date.now();
        persist();
    }

    return { check, touch, cooldownSec: sec };
}

export function messageHasImage(message) {
    if (!message) return false;
    if (Array.isArray(message.photo) && message.photo.length > 0) return true;
    const d = message.document;
    if (!d) return false;
    const mime = String(d.mime_type || "");
    if (mime.startsWith("image/")) return true;
    return /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(String(d.file_name || ""));
}

function messageMentionsBot(message, botUsername, text) {
    const entities = message.entities || message.caption_entities || [];
    const uname = String(botUsername || "").toLowerCase();
    if (!uname) return false;
    for (const ent of entities) {
        if (ent.type === "mention") {
            const slice = String(text || "").slice(ent.offset, ent.offset + ent.length).toLowerCase();
            if (slice === `@${uname}`) return true;
        }
        if (ent.type === "text_mention" && ent.user?.is_bot) return true;
    }
    if (new RegExp(`^/\\w+@${uname}\\b`, "i").test(String(text || "").trim())) return true;
    return false;
}

/**
 * @param {object} p
 * @param {ReturnType<typeof resolveBotProfile>} p.profile
 * @param {string|number} p.userId
 * @param {object} p.message telegram message
 * @param {(id:string)=>boolean} p.isOwnerAllowed access.json allowlist
 * @param {string|null} p.botUsername without @
 */
export function evaluateInboundAccess({ profile, userId, message, isOwnerAllowed, botUsername }) {
    const chat = message?.chat || {};
    const chatId = chat.id;
    const chatType = chat.type; // private | group | supergroup | channel
    const userIdStr = String(userId);
    const isOwner = typeof isOwnerAllowed === "function" ? isOwnerAllowed(userIdStr) : false;
    const text = message.text || message.caption || "";

    if (profile.accessMode === "allowlist" || !profile.accessMode) {
        return {
            allowed: isOwner,
            reason: isOwner ? "allowlist" : "not-paired",
            chatId,
            chatType,
        };
    }

    // open-group profile
    if (chatType === "private") {
        if (profile.denyPrivate) {
            return { allowed: false, reason: "private-denied", chatId, chatType };
        }
        // private: only owner allowlist (anti-abuse)
        return {
            allowed: isOwner,
            reason: isOwner ? "private-owner" : "private-not-owner",
            chatId,
            chatType,
        };
    }

    // groups / supergroups
    if (chatType === "group" || chatType === "supergroup") {
        if (profile.allowedChats.length > 0 && !profile.allowedChats.includes(Number(chatId))) {
            return { allowed: false, reason: "chat-not-allowlisted", chatId, chatType, silent: true };
        }
        const isSlash = /^\/\w+/.test(String(text || "").trim());
        if (profile.requireMention) {
            let mentioned = messageMentionsBot(message, botUsername, text);
            if (!profile.requireImage) {
                const reply = message.reply_to_message;
                if (reply?.from?.is_bot) mentioned = true;
            }
            if (!mentioned) {
                return { allowed: false, reason: "need-mention", chatId, chatType, silent: true };
            }
        }
        if (profile.requireImage && !isSlash && !messageHasImage(message)) {
            return { allowed: false, reason: "need-image", chatId, chatType, silent: true };
        }
        return { allowed: true, reason: "open-group", chatId, chatType };
    }

    return { allowed: false, reason: "unsupported-chat", chatId, chatType };
}

/** Strip @bot from group commands / mentions for cleaner prompts */
export function stripBotMention(text, botUsername) {
    if (!text) return text;
    let t = text;
    if (botUsername) {
        t = t.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
        t = t.replace(new RegExp(`^/(\\w+)@${botUsername}\\b`, "i"), "/$1");
    }
    return t.replace(/[ \t]{2,}/g, " ").trim();
}
