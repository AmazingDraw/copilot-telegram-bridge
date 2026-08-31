// bot-commands.mjs — /model /mode /session /clean /rename (+ callbacks)
// Factory: attachCommands(ctx). Behavior-preserving extract from extension.mjs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml } from "./markdown-tg.mjs";
import { attachCodexCommands } from "./codex-commands.mjs";
import { attachClaudeCommands } from "./claude-commands.mjs";
import {
    buildHeadlessSessionConfig,
    loadAgentsMdInstructions,
    loadModelsConfig,
    isOfficialModelBlocked,
    ensureUnblockedSessionModel,
    banishBlockedSessionModel,
    collectBotModelFallbacks,
    pickStickySessionModel,
    isSingleModelLock,
} from "./byok-providers.mjs";
import {
    SESSION_STATE_DIR,
    getSessionName,
    setSessionUserName,
    cleanSessionTitle,
    getRecentSessions,
    isSessionResumable,
    isSafeEmptyUnnamedShell,
    isSessionDirInUse,
} from "./session-fs.mjs";

/**
 * @param {any} ctx Bot instance context (getters for session/state + shared helpers)
 */
export function attachCommands(ctx) {
    const CIRCLE_NUMBERS = ctx.CIRCLE_NUMBERS;
    // Codex 子命令系统（独立模块：桌面检测/任务执行/排队/停止/取消/回调）
    const codexApi = attachCodexCommands(ctx);
    // Claude 子命令系统（独立模块：cliproxy Anthropic / 任务执行 / 排队 / 停止 / 取消 / 回调）
    const claudeApi = attachClaudeCommands(ctx);

    // ============================================================
    // Section 8b: Model Switching (/model command)
    // ============================================================

    // 缓存模型 ID 的 Mapping，防止 callback_data 超过 Telegram 的 64 字节限制 (Bad Request: BUTTON_DATA_INVALID)
    const modelCache = new Map();
    function getModelHash(id, tier) {
        const key = `${id}:${tier}`;
        const hash = createHash("sha256").update(key).digest("hex").slice(0, 10);
        modelCache.set(hash, { id, contextTier: tier });
        return hash;
    }

    /** 从统一 catalog 展开当前 Bot 可见模型、顺序及真实 provider。 */
    function getEnabledLocalModelState() {
        const modelsConfig = loadModelsConfig();
        const allowedOrder = [];
        const allowedSeen = new Set();
        if (Array.isArray(ctx.botProfile?.allowedModels)) {
            for (const value of ctx.botProfile.allowedModels) {
                const id = String(value || "").split("/").pop();
                if (!id || allowedSeen.has(id)) continue;
                allowedSeen.add(id);
                allowedOrder.push(id);
            }
        }
        const allowed = allowedOrder.length ? new Set(allowedOrder) : null;
        const ids = new Set();
        const providerById = new Map();
        const providerOrder = [];
        for (const p of modelsConfig.providers || []) {
            if (p.enabled === false) continue;
            for (const m of p.models || []) {
                const mid = typeof m === "string" ? m : m?.id;
                if (!mid || m?.enabled === false || (allowed && !allowed.has(mid))) continue;
                if (!ids.has(mid)) providerOrder.push(mid);
                ids.add(mid);
                if (!providerById.has(mid)) providerById.set(mid, p.id);
            }
        }
        const order = [];
        const seen = new Set();
        const preferred = allowed ? allowedOrder : (modelsConfig.preferredOrder || []);
        for (const id of [...preferred, ...providerOrder]) {
            if (!id || !ids.has(id) || seen.has(id)) continue;
            seen.add(id);
            order.push(id);
        }
        return { modelsConfig, ids, providerById, order };
    }

    async function getDisplayModels() {
        try {
            const modelsConfig = loadModelsConfig();
            const disp = modelsConfig.display || {};
            const official = disp.officialModels || {};
            const officialEnabled = official.enabled !== false;
            const allowIds = new Set(official.allowIds || []);
            const nameDedup = disp.nameDedup || "suffix-provider";
            const unknownBareId = disp.unknownBareId || "hide";
            const localState = getEnabledLocalModelState();
            const enabledLocalIds = localState.ids;
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

            const res = await ctx.session.rpc.model.list();
            const allModels = res.list || [];
            const displayModels = [];
            const seenIds = new Set();
            const seenNames = new Set();

            function shortByokLabel(id, name) {
                const parts = String(id).split("/");
                const leaf = parts[parts.length - 1] || name || id;
                const prov = parts.length > 1 ? parts[0] : "";
                let provTag = "";
                if (prov) {
                    provTag = UUID_RE.test(prov) ? prov.slice(0, 8) : prov;
                }
                return { leaf, provTag };
            }

            for (const m of allModels) {
                const id = String(m.id || "");
                if (!id || seenIds.has(id)) continue;
                const name = m.name || id;
                const hasSlash = id.includes("/");
                const bareUuid = UUID_RE.test(id);
                // 官方 auto 永不进键盘（含 provider/auto）；不误伤 cursor-auto
                if (isOfficialModelBlocked(id, modelsConfig)
                    || (!hasSlash && String(name).trim().toLowerCase() === "auto")) {
                    seenIds.add(id);
                    continue;
                }

                if (hasSlash || bareUuid) {
                    // BYOK：有 "/" 或 UUID 前缀。enabled 过滤（providers/models 层）。
                    // id 形如 provider/model-id → leaf = model-id
                    const leaf = hasSlash ? id.split("/").pop() : (name && name !== id ? name : id.slice(0, 8));
                    if (leaf && !enabledLocalIds.has(leaf)) {
                        continue; // 该模型被禁用（不在 enabled provider）
                    }
                    let displayName;
                    if (bareUuid) {
                        displayName = name && name !== id ? name : id.slice(0, 8);
                    } else {
                        const { leaf: l, provTag } = shortByokLabel(id, name);
                        displayName = l;
                        if (nameDedup === "suffix-provider" && seenNames.has(displayName) && provTag) {
                            displayName = `${l}·${provTag}`;
                        }
                    }
                    if (seenNames.has(displayName)) {
                        displayName = `${displayName}·${id.slice(0, 6)}`;
                    }
                    seenIds.add(id);
                    seenNames.add(displayName);
                    displayModels.push({
                        id,
                        hash: getModelHash(id, "default"),
                        name: displayName,
                        contextTier: "default",
                    });
                    continue;
                }

                // 官方 / 未知裸 id（无斜杠、非 UUID）→ 精确白名单匹配
                // 官方屏蔽名单（默认 auto）拥有最高优先级：即使 allowIds/unknownBareId 放行也不显示
                if (isOfficialModelBlocked(id, modelsConfig)) {
                    seenIds.add(id);
                    continue;
                }
                if (officialEnabled && allowIds.has(id)) {
                    displayName = name || id;
                    if (seenNames.has(displayName)) {
                        displayName = `${displayName}·${id.slice(0, 6)}`;
                    }
                    seenIds.add(id);
                    seenNames.add(displayName);
                    displayModels.push({
                        id,
                        hash: getModelHash(id, "default"),
                        name: displayName,
                        contextTier: "default",
                    });
                } else if (unknownBareId === "show") {
                    // 未知无斜杠 id 策略：show → 按自定义模型展示
                    displayName = name || id;
                    if (seenNames.has(displayName)) {
                        displayName = `${displayName}·${id.slice(0, 6)}`;
                    }
                    seenIds.add(id);
                    seenNames.add(displayName);
                    displayModels.push({
                        id,
                        hash: getModelHash(id, "default"),
                        name: displayName,
                        contextTier: "default",
                    });
                }
                // 默认 hide：裸 id 不在白名单 → 不显示
            }
            const rank = new Map(localState.order.map((id, index) => [id, index]));
            displayModels.sort((a, b) => {
                const aLeaf = String(a.id).split("/").pop();
                const bLeaf = String(b.id).split("/").pop();
                const aRank = rank.has(aLeaf) ? rank.get(aLeaf) : Number.MAX_SAFE_INTEGER;
                const bRank = rank.has(bLeaf) ? rank.get(bLeaf) : Number.MAX_SAFE_INTEGER;
                return aRank - bRank;
            });
            return displayModels;
        } catch (err) {
            // model.list() 失败（如 Copilot 授权到期）→ fallback 到统一配置中的本地 BYOK 模型，
            // 不再回退官方模型（官方需 Copilot 授权，到期即不可用）。
            console.error("telegram-bridge: getDisplayModels error, falling back to local BYOK models:", err.message);
            try {
                const localState = getEnabledLocalModelState();
                const localModels = [];
                const seenNames = new Set();
                for (const leaf of localState.order) {
                    if (!leaf) continue;
                    const provider = localState.providerById.get(leaf);
                    if (!provider) continue;
                    const id = leaf.includes("/") ? leaf : `${provider}/${leaf}`;
                    if (localModels.some((m) => m.id === id)) continue;
                    const displayName = leaf.includes("/") ? leaf.split("/").pop() : leaf;
                    if (seenNames.has(displayName)) continue;
                    seenNames.add(displayName);
                    localModels.push({
                        id,
                        hash: getModelHash(id, "default"),
                        name: displayName,
                        contextTier: "default",
                    });
                }
                return localModels;
            } catch (err2) {
                console.error("telegram-bridge: local BYOK fallback also failed:", err2.message);
                return [];
            }
        }
    }

    async function kickOfficialAuto(session = ctx.session) {
        const r = await banishBlockedSessionModel(session, {
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
        return r;
    }

    function publicModelLabel(modelId, fallbackName) {
        if (isOfficialModelBlocked(modelId)) return "已拦截官方路由";
        const name = String(fallbackName || "").trim();
        if (!String(modelId || "").includes("/") && name.toLowerCase() === "auto") {
            return "已拦截官方路由";
        }
        return name || modelId;
    }

    async function handleModelCommand(chatId) {
        try {
            let currentModelId = "unknown";
            let currentContextTier = "default";
            try {
                await kickOfficialAuto();
                const current = await ctx.session.rpc.model.getCurrent();
                currentModelId = current?.modelId || "unknown";
                currentContextTier = current?.contextTier || "default";
            } catch (err) {
                console.error("telegram-bridge: getCurrent error:", err.message);
            }

            const displayModels = await getDisplayModels();
            const currentModel = displayModels.find(m => m.id === currentModelId && (m.contextTier || "default") === currentContextTier);

            let currentModelName = currentModelId;
            if (currentModel) {
                currentModelName = currentModel.name;
            } else if (currentModelId.includes("/")) {
                currentModelName = currentModelId.split("/").pop();
            }
            currentModelName = publicModelLabel(currentModelId, currentModelName);

            const buttons = [];
            for (let i = 0; i < displayModels.length; i += 2) {
                const row = [];
                for (let j = i; j < Math.min(i + 2, displayModels.length); j++) {
                    const m = displayModels[j];
                    const isCurrent = m.id === currentModelId && (m.contextTier || "default") === currentContextTier;
                    const label = isCurrent ? `✅ ${m.name}` : m.name; // 去除小球 emoji
                    row.push({ text: label, callback_data: `model:${m.hash}` }); // callback_data 仅放哈希码，绝不超过 64 字节！
                }
                buttons.push(row);
            }

            const keyboard = { inline_keyboard: buttons };
            const text = `🤖 当前模型: ${currentModelName}\n\n选择要切换的模型：`;
            await ctx.enqueue(() => ctx.sendMessageWithKeyboard(chatId, text, keyboard));
        } catch (err) {
            console.error("telegram-bridge: handleModelCommand error:", err.message);
            await ctx.enqueue(() => ctx.sendMessage(chatId, `❌ 获取模型列表失败: ${err.message}`));
        }
    }

    async function handleUserInputCallback(cq) {
        const data = cq.data; // e.g. ask:choice:ask_xyz123:choiceIndex
        const parts = data.split(":");
        const reqId = parts[2];
        const choiceNum = parseInt(parts[3], 10); // 1-indexed choice number

        const item = ctx.pendingUserInputs.get(reqId);
        if (!item) {
            await ctx.answerCallbackQuery(cq.id, "该请求已过期或不存在").catch(() => {});
            return;
        }

        const { requestId, choices, chatId, messageId, questionText } = item;
        ctx.pendingUserInputs.delete(reqId);

        const answer = choices[choiceNum - 1];

        // 同时也尝试去 resolve 本地悬挂的 Promise 处理器以彻底解冻主会话的 JSON-RPC 强调用
        if (ctx.awaitingInput) {
            const { resolve } = ctx.awaitingInput;
            clearTimeout(ctx.awaitingInput.timer);
            ctx.awaitingInput = null;
            resolve(answer);
        }

        try {
            const res = await ctx.session.rpc.ui.handlePendingUserInput({
                requestId,
                response: {
                    answer,
                    wasFreeform: false,
                }
            });

            await ctx.answerCallbackQuery(cq.id, `选项已提交: ${answer}`).catch(() => {});

            // 更新原消息，去掉按钮并加上已选标志
            const newText = questionText + `\n\n✅ <b>答复完成 (Answered)</b>\n已选择选项: ${ctx.getCircleNumber(choiceNum)} "${escapeHtml(answer)}"`;
            await ctx.callTelegram("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: newText,
                parse_mode: "HTML",
            }).catch(() => {});
        } catch (err) {
            console.error("telegram-bridge: handlePendingUserInput failed:", err.message);
            await ctx.answerCallbackQuery(cq.id, `提交失败: ${err.message}`).catch(() => {});
        }
    }

    async function handlePermissionCallback(cq) {
        const data = cq.data; // e.g. perm:approve:perm_xyz123 or perm:reject:perm_xyz123
        const parts = data.split(":");
        const action = parts[1]; // "approve" or "reject"
        const reqId = parts[2];

        const pending = ctx.pendingPermissionRequests.get(reqId);
        if (!pending) {
            await ctx.answerCallbackQuery(
                cq.id,
                "该请求已过期（进程已重载或 SDK 已超时）。请忽略旧卡；allow-all 时重连即可"
            ).catch(() => {});
            return;
        }

        const { resolve, request, timer } = pending;
        if (timer) clearTimeout(timer);
        ctx.pendingPermissionRequests.delete(reqId);

        const chatId = cq.message.chat.id;
        const messageId = cq.message.message_id;

        // 重建包含高保真 HTML 排版的原始文本
        let originalText = `⚠️ <b>AI 申请操作权限</b>\n\n`;
        originalText += `🔹 <b>操作类型</b>: <code>${escapeHtml(request.kind)}</code>\n`;
        if (request.intention) {
            originalText += `🔹 <b>意图</b>: ${escapeHtml(request.intention)}\n`;
        }

        if (request.kind === "shell") {
            originalText += `🔹 <b>完整命令</b>:\n<pre>${escapeHtml(request.fullCommandText)}</pre>\n`;
            if (request.warning) {
                originalText += `⚠️ <b>风险警告</b>: ${escapeHtml(request.warning)}\n`;
            }
        } else if (request.kind === "write") {
            originalText += `🔹 <b>修改文件</b>: <code>${escapeHtml(request.fileName)}</code>\n`;
            if (request.diff) {
                let diffText = request.diff;
                if (diffText.length > 2000) {
                    diffText = diffText.slice(0, 2000) + "\n... (Diff已截断)";
                }
                originalText += `🔹 <b>代码差异 (Diff)</b>:\n<pre>${escapeHtml(diffText)}</pre>\n`;
            }
        } else if (request.kind === "read") {
            originalText += `🔹 <b>读取路径</b>: <code>${escapeHtml(request.path)}</code>\n`;
        } else if (request.kind === "mcp") {
            originalText += `🔹 <b>MCP 工具</b>: <code>${escapeHtml(request.toolName)}</code>\n`;
            if (request.args) {
                originalText += `🔹 <b>参数</b>:\n<pre>${escapeHtml(JSON.stringify(request.args, null, 2))}</pre>\n`;
            }
        } else if (request.kind === "url") {
            originalText += `🔹 <b>访问 URL</b>: <code>${escapeHtml(request.url)}</code>\n`;
        }

        if (action === "approve") {
            resolve({ kind: "approve-once" });
            await ctx.answerCallbackQuery(cq.id, "操作已授权").catch(() => {});

            const newText = originalText + "\n🟢 <b>操作已授权 (Approved)</b>";
            await ctx.callTelegram("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: newText,
                parse_mode: "HTML",
            }).catch(() => {});
        } else {
            resolve({ kind: "reject", feedback: "User interactively denied permission via Telegram." });
            await ctx.answerCallbackQuery(cq.id, "操作已拒绝").catch(() => {});

            const newText = originalText + "\n🔴 <b>操作已拒绝 (Rejected)</b>";
            await ctx.callTelegram("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: newText,
                parse_mode: "HTML",
            }).catch(() => {});
        }
    }

    const EXIT_PLAN_ACTION_LABELS = {
        interactive: { emoji: "💬", desc: "批准执行（结束后回 Plan）" },
        autopilot: { emoji: "🚀", desc: "批准自动执行（结束后回 Plan）" },
        exit_only: { emoji: "🚪", desc: "离开 Plan，不执行" },
        autopilot_fleet: { emoji: "🛸", desc: "Fleet 执行（结束后回 Plan）" },
    };

    async function handleExitPlanModeCallback(cq) {
        // xplan:<action|reject>:<reqId>
        const data = cq.data || "";
        const parts = data.split(":");
        const action = parts[1];
        const reqId = parts[2];

        const pending = ctx.pendingExitPlanRequests.get(reqId);
        if (!pending) {
            await ctx.answerCallbackQuery(cq.id, "该请求已过期或不存在").catch(() => {});
            return;
        }

        const { resolve, timer, actions, recommended, questionText } = pending;
        ctx.pendingExitPlanRequests.delete(reqId);
        if (timer) clearTimeout(timer);

        const chatId = cq.message?.chat?.id;
        const messageId = cq.message?.message_id;
        const baseText = questionText || "📋 计划批准";

        if (action === "reject") {
            resolve({
                approved: false,
                feedback: "User rejected exiting plan mode via Telegram.",
            });
            await ctx.answerCallbackQuery(cq.id, "已拒绝，继续 Plan").catch(() => {});
            if (chatId != null && messageId != null) {
                await ctx.callTelegram("editMessageText", {
                    chat_id: chatId,
                    message_id: messageId,
                    text: baseText + "\n\n🔴 <b>已拒绝 — 继续停留在 Plan</b>",
                    parse_mode: "HTML",
                }).catch(() => {});
            }
            console.error(`telegram-bridge: [${ctx.name || ctx.currentBotName}] exit_plan_mode rejected`);
            return;
        }

        const allowed = Array.isArray(actions) ? actions : [];
        const selectedAction = allowed.includes(action) ? action : (recommended || "interactive");

        // 必须在 resolve 之前设好粘性标志；resolve 会立刻驱动 SDK 继续执行
        if (selectedAction === "exit_only") {
            ctx.stickyPlanMode = false;
            ctx.restorePlanAfterTurn = false;
            ctx.stickyRestoreArmed = false;
        } else {
            ctx.stickyPlanMode = true;
            ctx.restorePlanAfterTurn = true;
            ctx.stickyRestoreArmed = false; // 等下一次 turn_start 再 arm
        }

        resolve({ approved: true, selectedAction });

        const meta = EXIT_PLAN_ACTION_LABELS[selectedAction] || { emoji: "▶️", desc: selectedAction };
        await ctx.answerCallbackQuery(cq.id, `${meta.desc}...`).catch(() => {});
        if (chatId != null && messageId != null) {
            const stickyNote = selectedAction === "exit_only"
                ? `<i>已离开 Plan；之后需手动 /mode 再进 Plan</i>`
                : `<i>将短暂离开 Plan 执行；全部做完后自动回到 Plan</i>`;
            await ctx.callTelegram("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text: baseText +
                    `\n\n🟢 <b>已批准</b> — ${escapeHtml(meta.emoji + " " + meta.desc)}\n` +
                    stickyNote,
                parse_mode: "HTML",
            }).catch(() => {});
        }
        console.error(
            `telegram-bridge: [${ctx.name || ctx.currentBotName}] exit_plan_mode approved ` +
            `action=${selectedAction} sticky=${ctx.stickyPlanMode} restore=${ctx.restorePlanAfterTurn}`
        );
    }

    async function handleModelCallback(callbackQuery) {
        const chatId = callbackQuery.message?.chat?.id;
        const messageId = callbackQuery.message?.message_id;
        const data = callbackQuery.data;
        const callbackId = callbackQuery.id;

        if (!data || !data.startsWith("model:")) return;

        const hash = data.slice(6);
        if (hash === "noop") {
            await ctx.answerCallbackQuery(callbackId, "这是当前模型").catch(() => {});
            return;
        }

        // 尝试在哈希缓存中查找
        let modelInfo = modelCache.get(hash);
        if (!modelInfo) {
            // 如果缓存因为进程重启等原因空了，重新调用一次以加载缓存
            await getDisplayModels().catch(() => []);
            modelInfo = modelCache.get(hash);
        }

        if (!modelInfo) {
            await ctx.answerCallbackQuery(callbackId, "❌ 操作已过期，请重新使用 /model 命令").catch(() => {});
            return;
        }

        const { id: modelId, contextTier } = modelInfo;
        if (isOfficialModelBlocked(modelId)) {
            await ctx.answerCallbackQuery(callbackId, "该模型已永久屏蔽").catch(() => {});
            await kickOfficialAuto();
            return;
        }

        let modelName = modelId;
        if (modelId.includes("/")) {
            const parts = modelId.split("/");
            modelName = parts[parts.length - 1];
        }

        try {
            await ctx.answerCallbackQuery(callbackId, `切换到 ${modelName}...`);
            if (ctx.isHeadless && ctx.headlessClient) {
                await rehydrateHeadlessForModel(modelId);
            } else {
                await ctx.session.rpc.model.switchTo({ modelId, contextTier });
            }
            const newText = `✅ 模型已切换为 ${modelName}`;
            if (chatId && messageId) {
                try {
                    await ctx.editMessageText(chatId, messageId, newText);
                } catch (editErr) {
                    if (!/message is not modified/i.test(editErr?.message || "")) throw editErr;
                }
                try {
                    await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
                } catch (mkErr) {
                    if (!/message is not modified/i.test(mkErr?.message || "")) {
                        // markup 清理失败不阻断切换成功
                        console.warn("telegram-bridge: clear model keyboard failed:", mkErr.message);
                    }
                }
            }
            console.error(`telegram-bridge: model switched to ${modelId} (${contextTier})`);
            if (typeof ctx.rememberBotModel === "function" && ctx.currentBotName) {
                ctx.rememberBotModel(ctx.currentBotName, modelId);
            }
        } catch (err) {
            console.error("telegram-bridge: model switch error:", err.message);
            await ctx.answerCallbackQuery(callbackId, `❌ 切换失败: ${err.message}`);
        }
    }

    // ============================================================
    // Section 8c: Mode Switching (/mode command)
    // ============================================================

    const AVAILABLE_MODES = [
        { id: "interactive", name: "Interactive", emoji: "💬", desc: "交互模式" },
        { id: "plan", name: "Plan", emoji: "📋", desc: "计划模式" },
        { id: "autopilot", name: "Autopilot", emoji: "🚀", desc: "自动模式" },
    ];

    async function handleModeCommand(chatId) {
        try {
            let currentMode = "unknown";
            try {
                currentMode = await ctx.session.rpc.mode.get();
            } catch (err) {
                console.error("telegram-bridge: mode.get error:", err.message);
            }

            const buttons = AVAILABLE_MODES.map(mode => {
                const isCurrent = mode.id === currentMode;
                const label = isCurrent ? `✅ ${mode.emoji} ${mode.desc}` : `${mode.emoji} ${mode.desc}`;
                return [{ text: label, callback_data: `mode:${mode.id}` }];
            });

            const keyboard = { inline_keyboard: buttons };
            const currentInfo = AVAILABLE_MODES.find(m => m.id === currentMode);
            const text = `🎮 当前模式: ${currentInfo?.emoji || ""} ${currentInfo?.desc || currentMode}\n\n选择要切换的模式：`;
            await ctx.enqueue(() => ctx.sendMessageWithKeyboard(chatId, text, keyboard));
        } catch (err) {
            console.error("telegram-bridge: handleModeCommand error:", err.message);
            await ctx.enqueue(() => ctx.sendMessage(chatId, `❌ 获取模式失败: ${err.message}`));
        }
    }

    async function handleModeCallback(callbackQuery) {
        const chatId = callbackQuery.message?.chat?.id;
        const messageId = callbackQuery.message?.message_id;
        const data = callbackQuery.data;
        const callbackId = callbackQuery.id;

        if (!data || !data.startsWith("mode:")) return;

        const modeId = data.slice(5);
        const modeInfo = AVAILABLE_MODES.find(m => m.id === modeId);
        const modeName = modeInfo?.desc || modeId;

        try {
            await ctx.answerCallbackQuery(callbackId, `切换到 ${modeName}...`);
            await ctx.session.rpc.mode.set({ mode: modeId });

            // 手动 /mode：Plan = 开启粘性；其它模式 = 取消粘性与待恢复
            if (modeId === "plan") {
                ctx.stickyPlanMode = true;
                ctx.restorePlanAfterTurn = false;
                ctx.stickyRestoreArmed = false;
                if (typeof ctx.session.registerExitPlanModeHandler === "function" &&
                    typeof ctx.createExitPlanModeHandler === "function") {
                    ctx.session.registerExitPlanModeHandler(ctx.createExitPlanModeHandler());
                }
            } else {
                ctx.stickyPlanMode = false;
                ctx.restorePlanAfterTurn = false;
                ctx.stickyRestoreArmed = false;
            }

            const stickyHint = modeId === "plan"
                ? "\n\n📌 粘性 Plan：批准执行后本轮结束会自动回到 Plan"
                : "";
            const newText = `✅ 模式已切换为 ${modeInfo?.emoji || ""} ${modeName}${stickyHint}`;
            if (chatId && messageId) {
                try {
                    await ctx.editMessageText(chatId, messageId, newText);
                } catch (editErr) {
                    if (!/message is not modified/i.test(editErr?.message || "")) throw editErr;
                }
                try {
                    await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
                } catch (mkErr) {
                    if (!/message is not modified/i.test(mkErr?.message || "")) {
                        console.warn("telegram-bridge: clear mode keyboard failed:", mkErr.message);
                    }
                }
            }
            console.error(
                `telegram-bridge: mode switched to ${modeId} stickyPlan=${ctx.stickyPlanMode}`
            );
        } catch (err) {
            console.error("telegram-bridge: mode switch error:", err.message);
            await ctx.answerCallbackQuery(callbackId, `❌ 切换失败: ${err.message}`);
        }
    }

    // ============================================================
    // Section 8c2: Thinking / Reasoning Effort (/thinking)
    // ============================================================

    /** 展示元数据；实际可选档位以 model.list().supportedReasoningEfforts 为准 */
    const THINKING_LEVEL_META = {
        none: { label: "无", emoji: "⚪️" },
        low: { label: "低", emoji: "🌱" },
        medium: { label: "中", emoji: "💭" },
        high: { label: "高", emoji: "🧠" },
        xhigh: { label: "极高", emoji: "🚀" },
        max: { label: "最大", emoji: "⚡️" },
    };
    const THINKING_LEVEL_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];

    function normalizeEffortId(raw) {
        const s = String(raw || "").toLowerCase().trim();
        if (!s) return "";
        if (s === "extra_high" || s === "extra-high" || s === "extrahigh" || s === "extra high") {
            return "xhigh";
        }
        return s;
    }

    function sortThinkingLevels(levels) {
        return [...new Set(levels.map(normalizeEffortId).filter(Boolean))].sort((a, b) => {
            const ia = THINKING_LEVEL_ORDER.indexOf(a);
            const ib = THINKING_LEVEL_ORDER.indexOf(b);
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
    }

    function thinkingMeta(id) {
        const key = normalizeEffortId(id);
        return THINKING_LEVEL_META[key] || { label: key || String(id || "?"), emoji: "•" };
    }

    function formatThinkingLevel(id) {
        if (id == null || id === "") return "未知";
        const meta = thinkingMeta(id);
        const key = normalizeEffortId(id);
        // 状态/文案不加 emoji；按钮仍可用 thinkingMeta().emoji
        return `${meta.label} (${key})`;
    }

    /**
     * 按当前模型动态读取可用思考等级（supportedReasoningEfforts）。
     * @returns {Promise<{ supported: boolean, levels: string[], modelId: string, current: string|null, reason?: string }>}
     */
    async function getThinkingCapability() {
        let modelId = "unknown";
        let current = null;
        try {
            const cur = await ctx.session.rpc.model.getCurrent();
            modelId = cur?.modelId || "unknown";
            current = cur?.reasoningEffort != null ? normalizeEffortId(cur.reasoningEffort) : null;
            if (current === "") current = null;
        } catch (err) {
            return {
                supported: false,
                levels: [],
                modelId,
                current: null,
                reason: `getCurrent 失败: ${err.message}`,
            };
        }

        try {
            const res = await ctx.session.rpc.model.list();
            const all = res?.list || [];
            const meta =
                all.find((m) => m.id === modelId) ||
                all.find((m) => String(m.id || "").endsWith("/" + modelId)) ||
                null;

            const fromList = Array.isArray(meta?.supportedReasoningEfforts)
                ? sortThinkingLevels(meta.supportedReasoningEfforts)
                : [];
            const capsSupport = meta?.capabilities?.supports?.reasoningEffort === true;
            const isByok = String(modelId).includes("/");
            const isOfficial = !isByok;

            // 1) 有声明档位 → 完全动态
            if (fromList.length) {
                return { supported: true, levels: fromList, modelId, current };
            }

            // 2) 声明支持但未列档位 → 按家族给保守默认（仍可被 set 失败纠偏）
            if (capsSupport) {
                const idLower = String(modelId).toLowerCase();
                let fallback;
                if (idLower.includes("grok")) {
                    fallback = ["low", "medium", "high"];
                } else if (idLower.includes("gpt") || idLower.includes("luna") || idLower.includes("terra")) {
                    fallback = ["none", "low", "medium", "high", "xhigh", "max"];
                } else {
                    fallback = ["low", "medium", "high", "xhigh"];
                }
                return {
                    supported: true,
                    levels: fallback,
                    modelId,
                    current,
                    reason: "model.list 未给出 supportedReasoningEfforts，按模型族默认档位",
                };
            }

            // 3) 官方模型字段缺失时再兜底；BYOK 不猜
            if (isOfficial) {
                const idLower = String(modelId).toLowerCase();
                const fallback = idLower.includes("grok")
                    ? ["low", "medium", "high"]
                    : ["none", "low", "medium", "high", "xhigh", "max"];
                return {
                    supported: true,
                    levels: fallback,
                    modelId,
                    current,
                    reason: "官方模型未声明 reasoning 字段，按桌面 UI 常见档位尝试",
                };
            }

            return {
                supported: false,
                levels: [],
                modelId,
                current,
                reason: "当前模型不支持思考等级（BYOK / 无 reasoningEffort）",
            };
        } catch (err) {
            const isOfficial = modelId && !String(modelId).includes("/");
            if (isOfficial) {
                const idLower = String(modelId).toLowerCase();
                const fallback = idLower.includes("grok")
                    ? ["low", "medium", "high"]
                    : ["none", "low", "medium", "high", "xhigh", "max"];
                return {
                    supported: true,
                    levels: fallback,
                    modelId,
                    current,
                    reason: `model.list 失败，按官方默认档位尝试: ${err.message}`,
                };
            }
            return {
                supported: false,
                levels: [],
                modelId,
                current,
                reason: `model.list 失败: ${err.message}`,
            };
        }
    }

    async function handleThinkingCommand(chatId) {
        try {
            const cap = await getThinkingCapability();
            const modelShort = String(cap.modelId || "").includes("/")
                ? String(cap.modelId).split("/").pop()
                : cap.modelId;

            if (!cap.supported || !cap.levels.length) {
                const text =
                    `🧠 <b>思考等级</b>\n\n` +
                    `当前模型: <code>${escapeHtml(modelShort || "未知")}</code>\n` +
                    `当前等级: ${escapeHtml(formatThinkingLevel(cap.current))}\n\n` +
                    `⚠️ ${escapeHtml(cap.reason || "当前模型不支持设置思考等级。")}`;
                await ctx.enqueue(() => ctx.sendMessage(chatId, text, "HTML"));
                return;
            }

            const buttons = [];
            for (let i = 0; i < cap.levels.length; i += 2) {
                const row = [];
                for (let j = i; j < Math.min(i + 2, cap.levels.length); j++) {
                    const id = cap.levels[j];
                    const meta = thinkingMeta(id);
                    const isCurrent = normalizeEffortId(id) === normalizeEffortId(cap.current);
                    const label = isCurrent
                        ? `✅ ${meta.emoji} ${meta.label}`
                        : `${meta.emoji} ${meta.label}`;
                    row.push({ text: label, callback_data: `thinking:${normalizeEffortId(id)}` });
                }
                buttons.push(row);
            }

            const hint = cap.reason ? `\n<i>${escapeHtml(cap.reason)}</i>` : "";
            const text =
                `🧠 <b>思考等级</b>\n\n` +
                `当前模型: <code>${escapeHtml(modelShort || "未知")}</code>\n` +
                `当前等级: ${escapeHtml(formatThinkingLevel(cap.current))}\n` +
                `可用档位: <code>${escapeHtml(cap.levels.join(", "))}</code>${hint}\n\n` +
                `选择思考等级：`;
            await ctx.enqueue(() =>
                ctx.sendMessageWithKeyboard(chatId, text, { inline_keyboard: buttons }, "HTML")
            );
        } catch (err) {
            console.error("telegram-bridge: handleThinkingCommand error:", err.message);
            await ctx.enqueue(() => ctx.sendMessage(chatId, `❌ 获取思考等级失败: ${err.message}`));
        }
    }

    async function handleThinkingCallback(callbackQuery) {
        const chatId = callbackQuery.message?.chat?.id;
        const messageId = callbackQuery.message?.message_id;
        const data = callbackQuery.data;
        const callbackId = callbackQuery.id;

        if (!data || !data.startsWith("thinking:")) return;

        const effort = normalizeEffortId(data.slice("thinking:".length));
        const label = formatThinkingLevel(effort);

        try {
            await ctx.answerCallbackQuery(callbackId, `切换到 ${label}...`);

            const result = await ctx.session.rpc.model.setReasoningEffort({
                reasoningEffort: effort,
            });
            const applied = normalizeEffortId(result?.reasoningEffort || effort);
            const newText = `✅ 思考等级已切换为 ${formatThinkingLevel(applied)}`;
            console.error(`telegram-bridge: reasoningEffort → ${applied}`);

            if (chatId && messageId) {
                try {
                    await ctx.editMessageText(chatId, messageId, newText, "HTML");
                } catch (editErr) {
                    if (!/message is not modified/i.test(editErr?.message || "")) {
                        try {
                            await ctx.editMessageText(chatId, messageId, newText.replace(/<[^>]+>/g, ""));
                        } catch (editErr2) {
                            if (!/message is not modified/i.test(editErr2?.message || "")) throw editErr2;
                        }
                    }
                }
                try {
                    await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
                } catch (mkErr) {
                    if (!/message is not modified/i.test(mkErr?.message || "")) {
                        console.warn("telegram-bridge: clear thinking keyboard failed:", mkErr.message);
                    }
                }
            }
        } catch (err) {
            console.error("telegram-bridge: setReasoningEffort error:", err.message);
            await ctx.answerCallbackQuery(callbackId, `❌ 切换失败: ${err.message}`);
        }
    }

    // ============================================================
    // Section 8d: Session Management (/session command)
    // ============================================================

    /**
     * 解析会话展示名：优先 workspace name，其次列表缓存名，最后 ID 前缀。
     */
    function resolveSessionDisplayName(sessionId, fallbackFromList) {
        const fromYaml = getSessionName(sessionId);
        if (fromYaml) return cleanSessionTitle(fromYaml) || fromYaml;
        if (fallbackFromList) return fallbackFromList;
        return String(sessionId || "").slice(0, 8);
    }

    async function handleSessionCommand(chatId) {
        const sid = ctx.currentSessionId || "unknown";
        const botName = ctx.currentBotName || "none";
        const lock = ctx.currentBotName ? ctx.readLock(ctx.currentBotName) : null;
        const connectedSession = lock?.sessionId || "unknown";

        const thisSessionName = resolveSessionDisplayName(sid);
        const connectedSessionName = connectedSession !== "unknown"
            ? resolveSessionDisplayName(connectedSession)
            : "unknown";

        let connectedAtStr = "无";
        if (lock && lock.connectedAt) {
            try {
                connectedAtStr = new Date(lock.connectedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
            } catch {
                connectedAtStr = lock.connectedAt;
            }
        }

        // HTML 直发（配合底部 inline keyboard）
        let text = `📋 <b>会话信息</b>\n\n`;
        text += `• 机器人: <b>${escapeHtml(ctx.getBotLabel(botName))}</b>\n`;
        text += `• 当前活动会话: <b>${escapeHtml(thisSessionName)}</b>\n`;
        if (connectedSession !== sid) {
            text += `• 当前连接会话: <b>${escapeHtml(connectedSessionName)}</b>\n`;
        }
        text += `• 桥接状态: <b>${ctx.connected ? "✅ 已连接" : "⚠️ 未连接"}</b>\n`;
        text += `• 运行模式: <b>无头 (headless)</b>\n`;
        if (lock && !ctx.isLockStale(lock)) {
            text += `• 锁定进程 (PID): <b>${lock.pid}</b>\n`;
            text += `• 连接时间: <b>${escapeHtml(connectedAtStr)}</b>\n`;
        }

        const recentSessions = getRecentSessions();
        // 复用顶部 CIRCLE_NUMBERS（已含 ①…⑩）
        const emojiNumbers = CIRCLE_NUMBERS;
        if (recentSessions.length > 0) {
            text += `\n<b>最近活跃的会话列表：</b>\n`;
            recentSessions.forEach((s, idx) => {
                const isCurrent = s.id === sid ? " <b>【当前】</b>" : "";
                text += `${emojiNumbers[idx]} <b>${escapeHtml(s.name)}</b>${isCurrent}\n`;
            });
            text += `\n👇 点下方数字按钮直接切换会话`;
        } else {
            text += `\n<i>暂无最近会话可切换</i>`;
        }

        // 数字按钮：①…⑩（最多 10 个），callback 带完整 session UUID
        // session UUID ~36 chars → "session:switch:" + uuid ≈ 51 < 64，安全
        const keyboard = { inline_keyboard: [] };
        if (recentSessions.length > 0) {
            const row = [];
            for (let i = 0; i < recentSessions.length; i++) {
                const s = recentSessions[i];
                row.push({
                    text: emojiNumbers[i],
                    callback_data: `session:switch:${s.id}`,
                });
            }
            // Telegram 单行建议 ≤8：1–5 / 6–10 两行
            if (row.length <= 5) {
                keyboard.inline_keyboard.push(row);
            } else {
                keyboard.inline_keyboard.push(row.slice(0, 5));
                keyboard.inline_keyboard.push(row.slice(5));
            }
        }

        await ctx.enqueue(() => ctx.sendMessageWithKeyboard(chatId, text, keyboard, "HTML"));
    }

    /**
     * 无头：在本进程内 resumeSession 切换。
     */
    async function switchHeadlessSession(chatId, targetSessionId, targetName) {
        if (!ctx.headlessClient) {
            throw new Error("无头客户端未就绪，请稍后重试");
        }
        if (ctx.headlessSwitching) {
            throw new Error("正在切换中，请稍候");
        }

        ctx.headlessSwitching = (async () => {
            const prevSession = ctx.session;
            const prevSid = ctx.currentSessionId;

            const { config: resumeConfig, agentsMd } = await buildLiveHeadlessConfig();
            console.error(
                `telegram-bridge: [${ctx.currentBotName}] headless resumeSession → ${targetSessionId} (${targetName})` +
                ` agents=${agentsMd ? `${agentsMd.length}c` : "none"}`
            );
            const next = await ctx.headlessClient.resumeSession(targetSessionId, resumeConfig);
            const perBotLocked = isSingleModelLock(ctx.botProfile?.allowedModels);
            await ensureUnblockedSessionModel(next, {
                desiredModel: resumeConfig.model,
                force: perBotLocked,
                logPrefix: `telegram-bridge: [${ctx.currentBotName}]`,
            });
            await kickOfficialAuto(next);
            return adoptHeadlessSession(next, prevSession, prevSid, targetSessionId);
        })();

        try {
            return await ctx.headlessSwitching;
        } finally {
            ctx.headlessSwitching = null;
        }
    }

    async function buildLiveHeadlessConfig({ defaultModel = null, forceDefaultModel = null } = {}) {
        const agentsMd = (typeof ctx.loadAgentsFromPath === "function")
            ? ctx.loadAgentsFromPath(ctx.botProfile?.agentsMd, () => loadAgentsMdInstructions())
            : loadAgentsMdInstructions(ctx.botProfile?.agentsMd);
        let officialModels = [];
        try {
            if (typeof ctx.headlessClient?.listModels === "function") {
                officialModels = await ctx.headlessClient.listModels();
            }
        } catch (err) {
            console.error(`telegram-bridge: [${ctx.currentBotName}] listModels failed:`, err.message);
        }
        const desired = defaultModel
            || pickStickySessionModel({
                allowedModels: ctx.botProfile?.allowedModels || null,
                defaultModel: ctx.botProfile?.defaultModel || null,
                lastModelId: typeof ctx.readBotModel === "function"
                    ? ctx.readBotModel(ctx.currentBotName)
                    : ctx.state?.lastModelId,
            })
            || ctx.botProfile?.defaultModel
            || null;
        const force = forceDefaultModel != null
            ? !!forceDefaultModel
            : isSingleModelLock(ctx.botProfile?.allowedModels);
        const config = await buildHeadlessSessionConfig({
            officialModels,
            customInstructions: agentsMd,
            onPermissionRequest: ctx.createPermissionHandler(),
            onUserInputRequest: ctx.createUserInputHandler(),
            onExitPlanModeRequest: ctx.createExitPlanModeHandler(),
            defaultModel: desired,
            allowedModels: ctx.botProfile?.allowedModels || null,
            forceDefaultModel: force,
            loadMcp: ctx.botProfile?.loadMcp !== false,
            loadSkills: ctx.botProfile?.loadSkills !== false,
            systemMessageMode: ctx.botProfile?.systemMessageMode || "customize",
            mcpServerNames: ctx.botProfile?.mcpServerNames || null,
            skillNames: ctx.botProfile?.skillNames || null,
        });
        return { config, agentsMd };
    }

    /**
     * 无头换模型：同 sessionId resume，把最新人设重新注入 systemMessage。
     * 纯 switchTo 不会重建系统提示词。
     */
    async function rehydrateHeadlessForModel(modelId) {
        if (!ctx.headlessClient) {
            throw new Error("无头客户端未就绪，请稍后重试");
        }
        const targetSessionId = ctx.currentSessionId;
        if (!targetSessionId) {
            await ctx.session.rpc.model.switchTo({ modelId, contextTier: "default" });
            return;
        }
        if (ctx.headlessSwitching) {
            throw new Error("正在切换中，请稍候");
        }

        ctx.headlessSwitching = (async () => {
            const prevSession = ctx.session;
            const prevSid = ctx.currentSessionId;
            if (ctx.isAgentBusy && prevSession?.abort) {
                try { await prevSession.abort(); } catch (err) {
                    console.error("telegram-bridge: abort before model rehydrate failed:", err.message);
                }
            }
            const leaf = String(modelId || "").split("/").pop();
            const { config: resumeConfig, agentsMd } = await buildLiveHeadlessConfig({
                defaultModel: leaf || modelId,
                forceDefaultModel: true,
            });
            if (String(modelId).includes("/")) {
                resumeConfig.model = modelId;
            }
            const injected = !!(
                resumeConfig.systemMessage?.content
                || resumeConfig.systemMessage?.sections?.custom_instructions?.content
            );
            console.error(
                `telegram-bridge: [${ctx.currentBotName}] headless model rehydrate → ${modelId}` +
                ` session=${targetSessionId} agents=${injected ? `${(agentsMd || "").length}c` : "none"}`
            );
            const next = await ctx.headlessClient.resumeSession(targetSessionId, resumeConfig);
            await ensureUnblockedSessionModel(next, {
                desiredModel: resumeConfig.model || modelId,
                force: true,
                logPrefix: `telegram-bridge: [${ctx.currentBotName}]`,
            });
            await kickOfficialAuto(next);
            return adoptHeadlessSession(next, prevSession, prevSid, targetSessionId);
        })();

        try {
            return await ctx.headlessSwitching;
        } finally {
            ctx.headlessSwitching = null;
        }
    }

    async function adoptHeadlessSession(next, prevSession, prevSid, fallbackSid) {
        ctx.setupEventHandlers(next);
        if (typeof ctx.enableHeadlessAllowAll === "function") {
            await ctx.enableHeadlessAllowAll(next);
        }
        ctx.session = next;
        ctx.currentSessionId = next.sessionId || fallbackSid;
        ctx.connected = true;
        ctx.isAgentBusy = false;
        ctx.stopTyping();
        ctx.dismissBubble();
        if (ctx.currentBotName) {
            ctx.writeLock(ctx.currentBotName, ctx.currentSessionId, process.pid);
            ctx.rememberBotSession(ctx.currentBotName, ctx.currentSessionId);
            if (ctx.state) ctx.state.lastSessionId = ctx.currentSessionId;
        }
        await kickOfficialAuto(next);
        if (typeof ctx.rememberBotModel === "function" && ctx.currentBotName) {
            try {
                const mid = String((await next?.rpc?.model?.getCurrent())?.modelId || "").trim();
                if (mid && !isOfficialModelBlocked(mid)) {
                    ctx.rememberBotModel(ctx.currentBotName, mid);
                    if (ctx.state) ctx.state.lastModelId = mid;
                }
            } catch {}
        }
        // 同 UUID 重注入（/model resume）不能 disconnect 旧句柄：SDK 会拆掉刚 resume 的会话，
        // 随后 send/heartbeat 全部 Session not found。
        const sameId = !!(prevSid && ctx.currentSessionId
            && String(prevSid) === String(ctx.currentSessionId));
        if (prevSession && prevSession !== next && !sameId) {
            try { await prevSession.disconnect(); } catch (err) {
                console.error(`telegram-bridge: prev session disconnect:`, err.message);
            }
        } else if (sameId && prevSession && prevSession !== next) {
            console.error(
                `telegram-bridge: [${ctx.currentBotName}] skip disconnect on same-session rehydrate ${ctx.currentSessionId}`
            );
        }
        console.error(
            `telegram-bridge: [${ctx.currentBotName}] headless session ${prevSid || "-"} → ${ctx.currentSessionId}`
        );
        return ctx.currentSessionId;
    }

    /**
     * 无头：createSession 开一个全新对话（新 UUID，不复用 sticky）。
     */
    async function startHeadlessNewSession() {
        if (!ctx.isHeadless) {
            throw new Error("joinbot 已移除，无法从 Telegram 开新对话。");
        }
        if (!ctx.headlessClient) {
            throw new Error("无头客户端未就绪，请稍后重试");
        }
        if (ctx.headlessSwitching) {
            throw new Error("正在切换中，请稍候");
        }

        ctx.headlessSwitching = (async () => {
            const prevSession = ctx.session;
            const prevSid = ctx.currentSessionId;
            if (ctx.isAgentBusy && prevSession?.abort) {
                try { await prevSession.abort(); } catch (err) {
                    console.error(`telegram-bridge: abort before /new failed:`, err.message);
                }
            }
            let liveModelId = "";
            try {
                liveModelId = String((await prevSession?.rpc?.model?.getCurrent())?.modelId || "").trim();
            } catch {}
            const sticky = pickStickySessionModel({
                allowedModels: ctx.botProfile?.allowedModels || null,
                defaultModel: ctx.botProfile?.defaultModel || null,
                lastModelId: typeof ctx.readBotModel === "function"
                    ? ctx.readBotModel(ctx.currentBotName)
                    : ctx.state?.lastModelId,
                liveModelId,
            });
            const { config } = await buildLiveHeadlessConfig({
                defaultModel: sticky,
                forceDefaultModel: true,
            });
            delete config.sessionId;
            console.error(
                `telegram-bridge: [${ctx.currentBotName}] headless createSession (new)` +
                ` model=${config.model || sticky || "?"}`
            );
            const next = await ctx.headlessClient.createSession(config);
            await ensureUnblockedSessionModel(next, {
                desiredModel: config.model,
                force: true,
                logPrefix: `telegram-bridge: [${ctx.currentBotName}]`,
            });
            await kickOfficialAuto(next);
            return adoptHeadlessSession(next, prevSession, prevSid);
        })();

        try {
            return await ctx.headlessSwitching;
        } finally {
            ctx.headlessSwitching = null;
        }
    }

    async function handleNewCommand(chatId) {
        try {
            await startHeadlessNewSession();
            await ctx.enqueue(() => ctx.sendMessage(
                chatId,
                "✅ <b>已开启全新对话</b>",
                "HTML"
            ));
        } catch (err) {
            console.error("telegram-bridge: /new failed:", err.message);
            await ctx.enqueue(() => ctx.sendMessage(
                chatId,
                `⚠️ <b>无法开启全新对话</b>\n${escapeHtml(err.message || String(err))}`,
                "HTML"
            ));
        }
    }

    async function handleSessionCallback(cq) {
        const data = cq.data;
        const chatId = cq.message?.chat?.id;
        const messageId = cq.message?.message_id;

        if (!chatId || !data.startsWith("session:switch:")) {
            await ctx.answerCallbackQuery(cq.id, "操作无效").catch(() => {});
            return;
        }

        const targetSessionId = data.replace("session:switch:", "");
        const currentSid = ctx.currentSessionId;

        // 列表缓存名（yaml 无 name 时仍可展示）
        const listHit = getRecentSessions().find((s) => s.id === targetSessionId);
        const targetName = resolveSessionDisplayName(targetSessionId, listHit?.name);

        // 目标必须存在且可 resume（空壳目录点切换会 Session not found）
        const yamlPath = join(SESSION_STATE_DIR, targetSessionId, "workspace.yaml");
        if (!existsSync(yamlPath)) {
            await ctx.answerCallbackQuery(cq.id, "目标会话不存在").catch(() => {});
            return;
        }
        if (!isSessionResumable(targetSessionId)) {
            await ctx.answerCallbackQuery(cq.id, "会话不可恢复（空壳）").catch(() => {});
            await ctx.enqueue(() => ctx.sendMessage(
                chatId,
                `⚠️ <b>无法切换</b>\n目标 <b>${escapeHtml(targetName)}</b> 是空壳会话（无可 resume 数据）。\n\n💡 可用 /clean 清理后，再 /session 切换。`,
                "HTML"
            ));
            return;
        }

        if (targetSessionId === currentSid) {
            await ctx.answerCallbackQuery(cq.id, "已经在当前会话中").catch(() => {});
            return;
        }

        await ctx.answerCallbackQuery(cq.id, `切换至「${targetName}」...`).catch(() => {});

        // ---------- 无头：本进程 resumeSession ----------
        if (ctx.isHeadless) {
            try {
                await ctx.enqueue(() => ctx.sendMessage(
                    chatId,
                    `⏳ 正在切换至会话 <b>${escapeHtml(targetName)}</b>…`,
                    "HTML"
                ));
                await switchHeadlessSession(chatId, targetSessionId, targetName);
                // 清掉旧消息上的键盘，避免误点
                if (messageId) {
                    await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
                }
                await ctx.enqueue(() => ctx.sendMessage(
                    chatId,
                    `✅ <b>会话切换成功</b>\n\n当前活动会话：<b>【${escapeHtml(targetName)}】</b>`,
                    "HTML"
                ));
            } catch (err) {
                console.error("telegram-bridge: headless session switch failed:", err.message);
                await ctx.enqueue(() => ctx.sendMessage(
                    chatId,
                    `⚠️ <b>切换失败</b>\n目标：<b>${escapeHtml(targetName)}</b>\n原因：${escapeHtml(err.message || String(err))}`,
                    "HTML"
                ));
            }
            return;
        }

    }

    // ============================================================
    // Section 8e: Session cleanup (/clean) — 空壳一键 + 真会话点号删
    // ============================================================

    /**
     * 物理删除空壳（安全规则再校验）。无二次确认。
     * @returns {{ deleted: number, failed: number, scanned: number, errors: string[] }}
     */
    function deleteEmptyShellsNow() {
        const protectedIds = ctx.getProtectedSessionIds();
        if (ctx.currentSessionId) protectedIds.add(ctx.currentSessionId);

        const candidates = ctx.listCleanableEmptyShells().filter((s) => !protectedIds.has(s.id));
        let deleted = 0;
        let failed = 0;
        const errors = [];

        for (const item of candidates) {
            const yamlPath = join(SESSION_STATE_DIR, item.id, "workspace.yaml");
            if (!existsSync(yamlPath)) continue;
            let content = "";
            try {
                content = readFileSync(yamlPath, "utf8");
            } catch {
                failed++;
                continue;
            }
            if (!isSafeEmptyUnnamedShell(item.id, content, protectedIds)) continue;
            try {
                rmSync(join(SESSION_STATE_DIR, item.id), { recursive: true, force: true });
                deleted++;
            } catch (err) {
                failed++;
                if (errors.length < 5) errors.push(`${item.id.slice(0, 8)}: ${err.message}`);
                console.error(`telegram-bridge: clean shell failed ${item.id}:`, err.message);
            }
        }
        return { deleted, failed, scanned: candidates.length, errors };
    }

    /**
     * 真会话是否允许删除（当前 / 占用 / lock 保护 → 否）
     */
    function canDeleteRealSession(sessionId) {
        const sid = String(sessionId || "");
        if (!sid) return { ok: false, reason: "无效会话" };
        if (sid === ctx.currentSessionId) return { ok: false, reason: "不能删除当前会话" };
        const protectedIds = ctx.getProtectedSessionIds();
        if (protectedIds.has(sid)) return { ok: false, reason: "会话受 bot 锁定保护" };
        if (isSessionDirInUse(sid, [process.pid])) {
            return { ok: false, reason: "会话正被其它进程占用" };
        }
        const dir = join(SESSION_STATE_DIR, sid);
        if (!existsSync(dir)) return { ok: false, reason: "会话目录不存在" };
        return { ok: true, reason: "" };
    }

    /**
     * /clean：空壳只显示数量（一键直删）；真会话列表同 /session，点号二次确认后物理删除。
     */
    async function handleCleanCommand(chatId) {
        const sid = ctx.currentSessionId || null;
        const shellCount = ctx.listCleanableEmptyShells()
            .filter((s) => s.id !== sid).length;

        const recentSessions = getRecentSessions(15);
        const emojiNumbers = CIRCLE_NUMBERS;
        const selfPids = [process.pid];

        let text = `♻️ <b>会话清理</b>\n\n`;
        text += `空壳：<b>${shellCount}</b> 个`;
        if (shellCount > 0) {
            text += `　→ 点下方「一键清理空壳」立即删除（无需再确认）`;
        } else {
            text += `　✅ 无需清理`;
        }

        if (recentSessions.length > 0) {
            text += `\n\n<b>真会话</b>（最多 15）：\n`;
            recentSessions.forEach((s, idx) => {
                const isCurrent = s.id === sid ? " <b>【当前】</b>" : "";
                let busy = "";
                if (s.id !== sid && isSessionDirInUse(s.id, selfPids)) {
                    busy = " 🔒<i>占用</i>";
                }
                text += `${emojiNumbers[idx]} <b>${escapeHtml(s.name)}</b>${isCurrent}${busy}\n`;
            });
            text += `\n👇 点数字 → 二次确认后<strong>物理删除</strong>该会话`;
        } else {
            text += `\n\n<i>暂无真会话可删</i>`;
        }

        const keyboard = { inline_keyboard: [] };
        if (shellCount > 0) {
            keyboard.inline_keyboard.push([
                { text: `🧹 一键清理空壳（${shellCount}）`, callback_data: "clean:shells" },
            ]);
        }
        if (recentSessions.length > 0) {
            const row = [];
            for (let i = 0; i < recentSessions.length; i++) {
                const s = recentSessions[i];
                const isCurrent = s.id === sid;
                const locked = !isCurrent && isSessionDirInUse(s.id, selfPids);
                if (isCurrent) {
                    // 与列表序号一致，点了提示不可删（不用 ⛔）
                    row.push({ text: emojiNumbers[i], callback_data: `clean:blocked:current` });
                } else if (locked) {
                    row.push({ text: "🔒", callback_data: `clean:blocked:busy` });
                } else {
                    row.push({
                        text: emojiNumbers[i],
                        callback_data: `clean:ask:${s.id}`,
                    });
                }
            }
            // 每行最多 5 个（15 → 三行）
            for (let i = 0; i < row.length; i += 5) {
                keyboard.inline_keyboard.push(row.slice(i, i + 5));
            }
        }

        await ctx.enqueue(() => ctx.sendMessageWithKeyboard(chatId, text, keyboard, "HTML"));
    }

    async function handleCleanCallback(cq) {
        const data = String(cq.data || "");
        const chatId = cq.message?.chat?.id;
        const messageId = cq.message?.message_id;

        if (!chatId) {
            await ctx.answerCallbackQuery(cq.id, "操作无效").catch(() => {});
            return;
        }

        if (data === "clean:blocked:current") {
            await ctx.answerCallbackQuery(cq.id, "不能删除当前会话").catch(() => {});
            return;
        }
        if (data === "clean:blocked:busy") {
            await ctx.answerCallbackQuery(cq.id, "会话占用中，无法删除").catch(() => {});
            return;
        }

        if (data === "clean:cancel") {
            await ctx.answerCallbackQuery(cq.id, "已取消").catch(() => {});
            if (messageId) {
                await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
            }
            await ctx.enqueue(() => ctx.sendMessage(chatId, "已取消删除。", "HTML"));
            return;
        }

        // 空壳：一键直删，无二次确认
        if (data === "clean:shells") {
            await ctx.answerCallbackQuery(cq.id, "正在清理空壳…").catch(() => {});
            if (messageId) {
                await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
            }
            const { deleted, failed, scanned, errors } = deleteEmptyShellsNow();
            let msg =
                `♻️ <b>空壳清理完成</b>\n\n` +
                `• 已删除：<b>${deleted}</b>\n` +
                `• 跳过/失败：<b>${failed}</b>\n` +
                `• 扫描：${scanned}`;
            if (errors.length) {
                msg += `\n\n失败样例：\n<code>${escapeHtml(errors.join("\n"))}</code>`;
            }
            await ctx.enqueue(() => ctx.sendMessage(chatId, msg, "HTML"));
            return;
        }

        // 真会话：点号 → 二次确认卡（只显示名称，不显示 id）
        if (data.startsWith("clean:ask:")) {
            const targetId = data.slice("clean:ask:".length);
            const gate = canDeleteRealSession(targetId);
            if (!gate.ok) {
                await ctx.answerCallbackQuery(cq.id, gate.reason).catch(() => {});
                return;
            }
            const displayName = resolveSessionDisplayName(targetId) || "（未命名）";
            await ctx.answerCallbackQuery(cq.id, "请确认删除").catch(() => {});
            if (messageId) {
                await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
            }
            const text =
                `⚠️ <b>确认删除会话？</b>\n\n` +
                `将<strong>物理移除</strong>：\n` +
                `<b>${escapeHtml(displayName)}</b>\n\n` +
                `此操作不可恢复。`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: "🗑 确认删除", callback_data: `clean:del:${targetId}` },
                        { text: "取消", callback_data: "clean:cancel" },
                    ],
                ],
            };
            await ctx.enqueue(() => ctx.sendMessageWithKeyboard(chatId, text, keyboard, "HTML"));
            return;
        }

        // 真会话：确认删除
        if (data.startsWith("clean:del:")) {
            const targetId = data.slice("clean:del:".length);
            const gate = canDeleteRealSession(targetId);
            if (!gate.ok) {
                await ctx.answerCallbackQuery(cq.id, gate.reason).catch(() => {});
                return;
            }
            const displayName = resolveSessionDisplayName(targetId) || "（未命名）";
            await ctx.answerCallbackQuery(cq.id, "正在删除…").catch(() => {});
            if (messageId) {
                await ctx.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
            }
            try {
                rmSync(join(SESSION_STATE_DIR, targetId), { recursive: true, force: true });
                console.error(
                    `telegram-bridge: [${ctx.name || ctx.currentBotName}] deleted session ${targetId}`
                );
                await ctx.enqueue(() =>
                    ctx.sendMessage(
                        chatId,
                        `✅ 已删除会话\n\n<b>${escapeHtml(displayName)}</b>`,
                        "HTML"
                    )
                );
            } catch (err) {
                console.error(`telegram-bridge: delete session failed ${targetId}:`, err.message);
                await ctx.enqueue(() =>
                    ctx.sendMessage(
                        chatId,
                        `❌ 删除失败：${escapeHtml(err.message)}`,
                        "HTML"
                    )
                );
            }
            return;
        }

        // 兼容旧按钮
        if (data === "clean:confirm") {
            await ctx.answerCallbackQuery(cq.id, "请重新 /clean").catch(() => {});
            return;
        }

        await ctx.answerCallbackQuery(cq.id, "操作无效").catch(() => {});
    }

    // ============================================================
    // Section 8f: Rename current session (/rename)
    // ============================================================

    const RENAME_TIMEOUT_MS = 3 * 60 * 1000;
    const RENAME_MAX_LEN = 30;

    function clearAwaitingRename(notifyTimeout = false) {
        const prev = ctx.awaitingRename;
        if (!prev) return null;
        if (prev.timer) clearTimeout(prev.timer);
        ctx.awaitingRename = null;
        return prev;
    }

    function normalizeRenameName(raw) {
        let name = cleanSessionTitle(String(raw ?? ""));
        // 去掉 Telegram 可能带来的零宽字符
        name = name.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
        return name;
    }

    /**
     * 执行当前会话改名，并返回 { ok, msg }。
     * SDK 1.0.71+ 无 session.renameSession，统一写 workspace.yaml + user_named。
     * @param {string} rawName
     * @returns {Promise<{ok: boolean, msg: string}>}
     */
    async function applySessionRename(rawName) {
        if (!ctx.session) {
            return {
                ok: false,
                msg: "⚠️ 会话未连接，无法改名。请先 /new 或等无头连上。",
            };
        }
        const name = normalizeRenameName(rawName);
        if (!name) {
            return { ok: false, msg: "⚠️ 名字不能为空。请重新 /rename 后再发。" };
        }
        if (name.length > RENAME_MAX_LEN) {
            return {
                ok: false,
                msg: `⚠️ 名字过长（${name.length}/${RENAME_MAX_LEN}）。请缩短后再试。`,
            };
        }
        // 避免把别的斜杠命令当名字（一步参数已在路由层切好；两步态里再防一层）
        if (name.startsWith("/")) {
            return {
                ok: false,
                msg: "⚠️ 名字不能以 <code>/</code> 开头（会与命令冲突）。",
            };
        }

        const sid = ctx.currentSessionId || ctx.session?.sessionId || "";
        if (!sid) {
            return { ok: false, msg: "⚠️ 当前没有有效 sessionId，无法改名。" };
        }

        const oldName = getSessionName(sid) || "（未命名）";

        try {
            // 优先 SDK 方法（旧版 / 未来若恢复）；否则写 workspace.yaml
            if (typeof ctx.session.renameSession === "function") {
                await ctx.session.renameSession(name);
            } else {
                setSessionUserName(sid, name);
            }
        } catch (err) {
            console.error("telegram-bridge: rename session failed:", err.message);
            // SDK 失败时再尝试文件落盘（双保险）
            try {
                setSessionUserName(sid, name);
            } catch (err2) {
                console.error("telegram-bridge: setSessionUserName failed:", err2.message);
                return {
                    ok: false,
                    msg: `❌ 改名失败: ${escapeHtml(err2.message || err.message || String(err2))}`,
                };
            }
        }

        const verified = getSessionName(sid) || name;
        console.error(
            `telegram-bridge: renamed session ${String(sid).slice(0, 8)}… ` +
            `"${oldName}" → "${verified}"`
        );
        return {
            ok: true,
            msg:
                `✅ <b>会话已改名</b>\n\n` +
                `• 原名：${escapeHtml(String(oldName))}\n` +
                `• 新名：<b>${escapeHtml(String(verified))}</b>\n` +
                `• ID：<code>${escapeHtml(String(sid).slice(0, 8))}…</code>\n\n` +
                `<i>已写入 user_named，自动 summary 不会再覆盖。</i>`,
        };
    }

    /**
     * /rename [新名字]
     * - 有参数：立刻改名
     * - 无参数：进入两步等待，下一条非命令文本作为新名；/cancel 取消；3 分钟超时
     * @param {number|string} chatId
     * @param {string} [argText] 可选一步改名参数
     */
    async function handleRenameCommand(chatId, argText = "") {
        if (!ctx.session) {
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, "⚠️ 会话未连接，无法改名。请先 /new。", "HTML")
            );
            return;
        }

        const oneShot = normalizeRenameName(argText || "");
        if (oneShot) {
            clearAwaitingRename();
            const { msg } = await applySessionRename(oneShot);
            try {
                await ctx.enqueue(() => ctx.sendMessage(chatId, msg, "HTML"));
            } catch (err) {
                console.error("telegram-bridge: rename result send failed:", err.message);
            }
            return;
        }

        // 两步：清旧等待，开新等待
        clearAwaitingRename();
        const cur =
            getSessionName(ctx.currentSessionId || ctx.session?.sessionId || "") ||
            "（未命名）";

        const timer = setTimeout(() => {
            if (ctx.awaitingRename && ctx.awaitingRename.timer === timer) {
                ctx.awaitingRename = null;
                ctx.enqueue(() =>
                    ctx.sendMessage(
                        chatId,
                        "⌛ 改名等待已超时（3 分钟）。需要时再发 /rename。",
                        "HTML"
                    )
                ).catch(() => {});
            }
        }, RENAME_TIMEOUT_MS);

        ctx.awaitingRename = {
            chatId: Number(chatId),
            timer,
            startedAt: Date.now(),
        };

        await ctx.enqueue(() =>
            ctx.sendMessage(
                chatId,
                `✏️ <b>改名模式</b>\n\n` +
                `当前：<b>${escapeHtml(String(cur))}</b>\n\n` +
                `请直接发送<strong>新名字</strong>（下一步消息）。\n` +
                `• 取消：直接发送 /cancel 取消\n` +
                `• 也可一步：<code>/rename 新名字</code>\n` +
                `• 限长 ${RENAME_MAX_LEN} 字 · 3 分钟内有效`,
                "HTML"
            )
        );
    }

    /**
     * 消费两步改名等待中的下一条文本。
     * @returns {Promise<boolean>} true = 已处理，调用方勿再当普通对话
     */
    async function tryConsumeRenameInput(chatId, text) {
        const pending = ctx.awaitingRename;
        if (!pending) return false;

        // 仅响应同一 chat（防多 chat 串）
        if (Number(pending.chatId) !== Number(chatId)) return false;

        const raw = String(text ?? "").trim();
        // 斜杠命令：不吞掉（让 /session 等仍可走）；取消单独处理
        if (raw.startsWith("/")) {
            const base = raw.split(/\s+/)[0].split("@")[0].toLowerCase();
            if (base === "/cancel" || base === "/stop") {
                clearAwaitingRename();
                await ctx.enqueue(() =>
                    ctx.sendMessage(chatId, "❎ 已取消改名。", "HTML")
                );
                return true;
            }
            if (base === "/rename") {
                // 新的 /rename 交给 handleRenameCommand，先清旧态
                clearAwaitingRename();
                return false;
            }
            // 其它命令：取消改名等待，并把命令留给后续路由
            clearAwaitingRename();
            await ctx.enqueue(() =>
                ctx.sendMessage(
                    chatId,
                    "ℹ️ 已退出改名模式（你发了其它命令）。",
                    "HTML"
                )
            );
            return false;
        }

        if (!raw) {
            try {
                await ctx.enqueue(() =>
                    ctx.sendMessage(
                        chatId,
                        "⚠️ 请发送<strong>文字</strong>作为新名字（空消息无效）。取消：/cancel",
                        "HTML"
                    )
                );
            } catch (_) {}
            return true; // 仍处在改名等待
        }

        // 先改名再清等待：失败时保持 awaitingRename，用户可重试，且绝不把名字当对话发出
        const { ok, msg } = await applySessionRename(raw);
        if (ok) clearAwaitingRename();
        try {
            await ctx.enqueue(() => ctx.sendMessage(chatId, msg, "HTML"));
        } catch (err) {
            console.error("telegram-bridge: rename result send failed:", err.message);
        }
        return true;
    }

    function formatTokenCount(num) {
        if (typeof num !== "number" || isNaN(num) || num < 0) return null;
        if (num >= 1000000) {
            const m = (num / 1000000).toFixed(1);
            return m.endsWith(".0") ? `${parseInt(m)}M` : `${m}M`;
        }
        if (num >= 1000) {
            const k = (num / 1000).toFixed(1);
            return k.endsWith(".0") ? `${parseInt(k)}k` : `${k}k`;
        }
        return String(num);
    }

    function getMaxContextTokens(modelId, contextTier, modelsConfig) {
        const fallback = modelsConfig?.defaults?.maxContextWindowTokens || 0;
        if (!modelId || modelId === "unknown") return fallback;

        const cleanId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
        const catalogModel = modelsConfig?.catalog?.[cleanId];
        if (catalogModel) {
            const limit = catalogModel.maxContextWindowTokens || catalogModel.maxPromptTokens;
            if (limit) return limit;
        }
        // legacy schema compatibility
        if (modelsConfig?.providers) {
            for (const p of modelsConfig.providers) {
                if (!Array.isArray(p.models)) continue;
                for (const m of p.models) {
                    if (typeof m === "object" && m !== null) {
                        if (m.id === modelId || m.id === cleanId) {
                            const limit = m.maxContextWindowTokens || m.maxPromptTokens;
                            if (limit) return limit;
                        }
                    }
                }
            }
        }

        return fallback;
    }

    function getSessionTokenUsage(sessionId) {
        if (!sessionId) return null;

        let fromMap = null;
        if (ctx.sessionTokensMap && ctx.sessionTokensMap.has(sessionId)) {
            const v = ctx.sessionTokensMap.get(sessionId);
            if (typeof v === "number" && Number.isFinite(v) && v > 0) fromMap = v;
        }

        let fromFile = null;
        const logPath = join(SESSION_STATE_DIR || join(process.env.HOME || "~", ".copilot", "session-state"), sessionId, "events.jsonl");
        if (existsSync(logPath)) {
            try {
                const content = readFileSync(logPath, "utf8");
                const lines = content.trim().split("\n");
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i].trim();
                    if (!line || !line.includes("currentTokens")) continue;
                    try {
                        const ev = JSON.parse(line);
                        const t = ev.data?.currentTokens ?? ev.currentTokens;
                        if (typeof t === "number" && Number.isFinite(t) && t > 0) {
                            fromFile = t;
                            break;
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // 取更大的正值，避免内存里被写进 0 后盖掉磁盘真相
        if (fromMap != null && fromFile != null) return Math.max(fromMap, fromFile);
        return fromMap ?? fromFile;
    }

    /**
     * 现查会话上下文占用。返回 null 表示不可信/未就绪（含 totalTokens===0），由调用方回落缓存。
     * @param {{ maxTokens?: number, modelId?: string }} [opts]
     * @returns {Promise<number|null>}
     */
    async function fetchLiveContextTokens(opts = {}) {
        const sess = ctx.session;
        if (!sess?.rpc?.metadata) return null;
        const maxTokens = Number(opts.maxTokens) > 0 ? Math.floor(Number(opts.maxTokens)) : 0;
        const modelId = opts.modelId ? String(opts.modelId) : undefined;

        const trust = (t) =>
            (typeof t === "number" && Number.isFinite(t) && t > 0) ? Math.floor(t) : null;

        try {
            const attr = await sess.rpc.metadata.getContextAttribution();
            const hit = trust(attr?.contextAttribution?.totalTokens);
            if (hit != null) return hit;
        } catch (err) {
            console.error(`telegram-bridge: getContextAttribution failed: ${err.message}`);
        }

        try {
            const heavy = await sess.rpc.metadata.getContextHeaviestMessages({ limit: 1 });
            const hit = trust(heavy?.totalTokens);
            if (hit != null) return hit;
        } catch (err) {
            console.error(`telegram-bridge: getContextHeaviestMessages failed: ${err.message}`);
        }

        try {
            const infoRes = await sess.rpc.metadata.contextInfo({
                promptTokenLimit: maxTokens || 0,
                outputTokenLimit: 0,
                ...(modelId ? { selectedModel: modelId } : {}),
            });
            const hit = trust(infoRes?.contextInfo?.totalTokens);
            if (hit != null) return hit;
        } catch (err) {
            console.error(`telegram-bridge: metadata.contextInfo failed: ${err.message}`);
        }

        return null;
    }

    /**
     * /rich [on|off|status] — 表格投递：开=sendRichMessage HTML 表；关(默认)=列表 HTML。
     * 无参则切换。持久化到 bots/<name>/state.json → richTables。
     */
    async function handleRichCommand(chatId, arg = "") {
        const raw = String(arg || "").trim().toLowerCase();
        const cur = ctx.state?.richTables === true;
        let next = cur;
        let mode = "status";

        if (!raw || raw === "toggle" || raw === "switch") {
            next = !cur;
            mode = "toggle";
        } else if (raw === "on" || raw === "1" || raw === "true" || raw === "开" || raw === "开启") {
            next = true;
            mode = "set";
        } else if (raw === "off" || raw === "0" || raw === "false" || raw === "关" || raw === "关闭") {
            next = false;
            mode = "set";
        } else if (raw === "status" || raw === "show" || raw === "状态") {
            mode = "status";
        } else {
            await ctx.enqueue(() =>
                ctx.sendMessage(
                    chatId,
                    "用法：<code>/rich</code> 切换 · <code>/rich on</code> · <code>/rich off</code> · <code>/rich status</code>",
                    "HTML"
                )
            );
            return;
        }

        if (mode !== "status") {
            if (!ctx.state) ctx.state = { offset: 0 };
            ctx.state.richTables = next;
            if (typeof ctx.persistBotState === "function") ctx.persistBotState();
            console.error(
                `telegram-bridge: [${ctx.name || ctx.currentBotName}] richTables → ${next ? "on" : "off"}`
            );
        }

        const on = mode === "status" ? cur : next;
        const label = on
            ? "🟢 <b>开</b> — 表格走 Telegram 富文本"
            : "⚪ <b>关</b>（默认）— 表格走列表 HTML";
        const verb =
            mode === "status"
                ? "当前"
                : mode === "toggle"
                  ? `已切换为`
                  : `已设为`;
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId, `📐 <b>表格富文本</b> ${verb}\n\n${label}`, "HTML")
        );
    }

    async function handleStatusCommand(chatId) {
        try {
            let modelName = "未知";
            let rawModelId = "unknown";
            let contextTier = "default";
            try {
                await kickOfficialAuto();
                const current = await ctx.session.rpc.model.getCurrent();
                rawModelId = current?.modelId || "unknown";
                contextTier = current?.contextTier || "default";
                const displayModels = await getDisplayModels();
                const found = displayModels.find(m => m.id === rawModelId && (m.contextTier || "default") === contextTier);
                if (found) {
                    modelName = found.name;
                } else if (rawModelId.includes("/")) {
                    modelName = rawModelId.split("/").pop();
                } else if (rawModelId !== "unknown") {
                    modelName = rawModelId;
                }
                modelName = publicModelLabel(rawModelId, modelName);
            } catch (_) {}

            let modeLabel = "未知";
            try {
                const modeId = await ctx.session.rpc.mode.get();
                const modeInfo = AVAILABLE_MODES.find(m => m.id === modeId);
                modeLabel = modeInfo ? modeInfo.desc : modeId;
            } catch (_) {}

            let sessionName = "未知";
            let sid = null;
            try {
                sid = ctx.currentSessionId || ctx.session?.sessionId;
                if (sid) sessionName = getSessionName(sid) || String(sid).slice(0, 8);
            } catch (_) {}

            let contextUsageLabel = null;
            try {
                const modelsConfig = loadModelsConfig();
                const maxTokens = getMaxContextTokens(rawModelId, contextTier, modelsConfig);
                const fallback = getSessionTokenUsage(sid);
                let usedTokens = await fetchLiveContextTokens({
                    maxTokens,
                    modelId: rawModelId,
                });
                // 现查 0/空：用不低于回落值；避免把缓存写成 0
                if (usedTokens == null) {
                    usedTokens = fallback;
                } else if (fallback != null && fallback > usedTokens) {
                    console.error(
                        `telegram-bridge: live context ${usedTokens} < fallback ${fallback}; prefer fallback`
                    );
                    usedTokens = fallback;
                }

                if (usedTokens != null && usedTokens > 0 && sid) {
                    if (!ctx.sessionTokensMap) ctx.sessionTokensMap = new Map();
                    ctx.sessionTokensMap.set(sid, usedTokens);
                }

                if (usedTokens != null && maxTokens > 0) {
                    const formattedUsed = formatTokenCount(usedTokens);
                    const formattedMax = formatTokenCount(maxTokens);
                    const pct = ((usedTokens / maxTokens) * 100).toFixed(1);
                    contextUsageLabel = `${formattedUsed} / ${formattedMax} (${pct}%)`;
                }
            } catch (_) {}

            const msgLines = [
                `📊 <b>当前状态</b>`,
                ``,
                `🤖 <b>模型</b>　　${escapeHtml(modelName)}`,
            ];

            // 思考等级统一走 reasoningEffort：仅在模型支持思考等级时显示该行
            try {
                const cap = await getThinkingCapability();
                if (cap?.supported) {
                    const thinkingLabel = cap.current
                        ? formatThinkingLevel(cap.current)
                        : "默认 / 未设置";
                    msgLines.push(`💡 <b>思考</b>　　${escapeHtml(thinkingLabel)}`);
                }
            } catch (_) {}

            msgLines.push(
                `🎮 <b>模式</b>　　${escapeHtml(modeLabel)}`,
                `📝 <b>会话</b>　　${escapeHtml(sessionName)}`,
            );

            const richOn = ctx.state?.richTables === true;
            msgLines.push(
                `📐 <b>表格</b>　　${richOn ? "富文本 HTML 表" : "列表（默认）"}`
            );

            if (contextUsageLabel) {
                msgLines.push(`🧠 <b>上下文</b>　${escapeHtml(contextUsageLabel)}`);
            }

            const msg = msgLines.join("\n");

            await ctx.enqueue(() => ctx.sendMessage(chatId, msg, "HTML"));
        } catch (err) {
            console.error("telegram-bridge: handleStatusCommand error:", err.message);
            await ctx.enqueue(() => ctx.sendMessage(chatId, `❌ 获取状态失败: ${escapeHtml(err.message)}`, "HTML"));
        }
    }

    return {
        handleModelCommand,
        handleModelCallback,
        handleModeCommand,
        handleModeCallback,
        handleThinkingCommand,
        handleThinkingCallback,
        handleSessionCommand,
        handleSessionCallback,
        handleCleanCommand,
        handleCleanCallback,
        handleRenameCommand,
        tryConsumeRenameInput,
        handleUserInputCallback,
        handlePermissionCallback,
        handleExitPlanModeCallback,
        handleNewCommand,
        switchHeadlessSession,
        getDisplayModels,
        handleStatusCommand,
        handleRichCommand,
        ...codexApi,
        ...claudeApi,
    };
}
