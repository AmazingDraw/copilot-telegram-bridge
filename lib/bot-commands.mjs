// bot-commands.mjs — /model /mode /session /clean /rename (+ callbacks)
// Factory: attachCommands(ctx). Behavior-preserving extract from extension.mjs.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { escapeHtml } from "./markdown-tg.mjs";
import { attachCodexCommands } from "./codex-commands.mjs";
import { buildHeadlessSessionConfig, loadAgentsMdInstructions, loadModelsConfig } from "./byok-providers.mjs";
import {
    SESSION_STATE_DIR,
    getSessionName,
    setSessionUserName,
    cleanSessionTitle,
    getRecentSessions,
    isSessionResumable,
    isSafeEmptyUnnamedShell,
    isSessionDirInUse,
    getSessionLiveHolders,
} from "./session-fs.mjs";

/**
 * @param {any} ctx Bot instance context (getters for session/state + shared helpers)
 */
export function attachCommands(ctx) {
    const CIRCLE_NUMBERS = ctx.CIRCLE_NUMBERS;
    // Codex 子命令系统（独立模块：桌面检测/任务执行/排队/停止/取消/回调）
    const codexApi = attachCodexCommands(ctx);

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

    /**
     * 从 models.json 收集「已启用 provider + 未禁用模型」的真实模型 id 集合（主路径过滤用）。
     * @returns {Set<string>} 合法本地模型 id（如 deepseek-v4-flash）
     */
    function getEnabledLocalModelIds() {
        const modelsConfig = loadModelsConfig();
        const ids = new Set();
        for (const p of modelsConfig.providers || []) {
            if (p.enabled === false) continue;
            for (const m of p.models || []) {
                const mid = typeof m === "string" ? m : m?.id;
                if (mid && m?.enabled !== false) ids.add(mid);
            }
        }
        return ids;
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
            const enabledLocalIds = getEnabledLocalModelIds();
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

                if (hasSlash || bareUuid) {
                    // BYOK：有 "/" 或 UUID 前缀。enabled 过滤（providers/models 层）。
                    // id 形如 opencodex/deepseek-v4-flash → leaf = deepseek-v4-flash
                    const leaf = hasSlash ? id.split("/").pop() : (name && name !== id ? name : id.slice(0, 8));
                    if (leaf && enabledLocalIds.size > 0 && !enabledLocalIds.has(leaf)) {
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
            return displayModels;
        } catch (err) {
            // model.list() 失败（如 Copilot 授权到期）→ fallback 到本地 BYOK 模型（opencodex），
            // 不再回退官方模型（官方需 Copilot 授权，到期即不可用）。
            console.error("telegram-bridge: getDisplayModels error, falling back to local BYOK models:", err.message);
            try {
                const modelsConfig = loadModelsConfig();
                // 收集所有已启用 provider 的真实模型 id（排除幽灵 id，如历史遗留的裸 grok-4.5）
                const validIds = new Set();
                for (const p of modelsConfig.providers || []) {
                    if (p.enabled === false) continue;
                    for (const m of p.models || []) {
                        const mid = typeof m === "string" ? m : m?.id;
                        if (mid) validIds.add(mid);
                    }
                }
                const localModels = [];
                const seenNames = new Set();
                for (const leaf of modelsConfig.preferredOrder || []) {
                    if (!leaf) continue;
                    // 只保留真实存在于 providers 的模型（与文档 §4.1 语义一致）
                    if (!validIds.has(leaf)) {
                        console.warn(`telegram-bridge: skip ghost model '${leaf}' (not in any enabled provider)`);
                        continue;
                    }
                    // 统一带 opencodex/ 前缀，与模型配置一致
                    const id = leaf.includes("/") ? leaf : `opencodex/${leaf}`;
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
                return localModels.length ? localModels : [
                    { id: "opencodex/deepseek-v4-flash", hash: getModelHash("opencodex/deepseek-v4-flash", "default"), name: "deepseek-v4-flash", contextTier: "default" },
                ];
            } catch (err2) {
                console.error("telegram-bridge: local BYOK fallback also failed:", err2.message);
                return [];
            }
        }
    }

    async function handleModelCommand(chatId) {
        try {
            let currentModelId = "unknown";
            let currentContextTier = "default";
            try {
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
            } else {
                // 如果不在列表中，但属于第三方模型，也做一次名字清洁化
                if (currentModelId.includes("/")) {
                    const parts = currentModelId.split("/");
                    currentModelName = parts[parts.length - 1];
                }
            }

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

        const { resolve, request } = pending;
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

        let modelName = modelId;
        if (modelId.includes("/")) {
            const parts = modelId.split("/");
            modelName = parts[parts.length - 1];
        }

        try {
            await ctx.answerCallbackQuery(callbackId, `切换到 ${modelName}...`);
            await ctx.session.rpc.model.switchTo({ modelId, contextTier });
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
    /** DeepSeek 经 cliproxy 别名注入的档位（官方无 medium/xhigh 独立档） */
    const DEEPSEEK_ALIAS_LEVELS = ["low", "high", "max"];

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
     * 解析 DeepSeek 思考别名模型：deepseek-v4-flash[-low|high|max] / pro。
     * 无后缀视为官方默认 high。
     * @returns {{ family: string, effort: string, local: string, full: string } | null}
     */
    function parseDeepseekEffortModel(modelId) {
        const full = String(modelId || "");
        const local = full.includes("/") ? full.split("/").pop() : full;
        const m = String(local).match(/^(deepseek-v4-(?:flash|pro))(?:-(low|high|max))?$/i);
        if (!m) return null;
        return {
            family: m[1].toLowerCase(),
            effort: (m[2] || "high").toLowerCase(),
            local: String(local),
            full,
        };
    }

    /**
     * 在 model.list 结果中挑选目标 DeepSeek 别名模型 id（优先 cliproxy）。
     */
    function pickDeepseekAliasModelId(allModels, family, effort) {
        const local = `${family}-${effort}`;
        const ids = (allModels || []).map((m) => String(m?.id || "")).filter(Boolean);
        const exact = ids.filter((id) => id === local || id.endsWith("/" + local));
        if (!exact.length) return null;
        const prefer =
            exact.find((id) => id.startsWith("cliproxy/")) ||
            exact.find((id) => /cliproxy/i.test(id)) ||
            exact[0];
        return prefer;
    }

    /**
     * 按当前模型动态读取可用思考等级（supportedReasoningEfforts）。
     * @returns {Promise<{ supported: boolean, levels: string[], modelId: string, current: string|null, mode?: string, family?: string, reason?: string }>}
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

            const cap = await getThinkingCapability();
            let applied = effort;
            let newText = `✅ 思考等级已切换为 ${formatThinkingLevel(applied)}`;

            if (cap.mode === "deepseek-alias") {
                const family = cap.family || parseDeepseekEffortModel(cap.modelId)?.family;
                if (!family || !DEEPSEEK_ALIAS_LEVELS.includes(effort)) {
                    throw new Error(`DeepSeek 不支持档位: ${effort || "?"}`);
                }
                const res = await ctx.session.rpc.model.list();
                const all = res?.list || [];
                const targetId = pickDeepseekAliasModelId(all, family, effort);
                if (!targetId) {
                    throw new Error(`未找到模型 ${family}-${effort}（请确认 cliproxy / models.json 已配置）`);
                }
                await ctx.session.rpc.model.switchTo({ modelId: targetId });
                applied = effort;
                const short = targetId.includes("/") ? targetId.split("/").pop() : targetId;
                newText =
                    `✅ 思考等级已切换为 ${formatThinkingLevel(applied)}\n` +
                    `模型: <code>${short}</code>`;
                console.error(`telegram-bridge: deepseek-alias thinking → ${targetId}`);
            } else {
                const result = await ctx.session.rpc.model.setReasoningEffort({
                    reasoningEffort: effort,
                });
                applied = normalizeEffortId(result?.reasoningEffort || effort);
                newText = `✅ 思考等级已切换为 ${formatThinkingLevel(applied)}`;
                console.error(`telegram-bridge: reasoningEffort → ${applied}`);
            }

            if (chatId && messageId) {
                try {
                    // DeepSeek 路径可能含 <code>，统一 HTML；官方路径纯文本也兼容
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
            console.error("telegram-bridge: setReasoningEffort/deepseek-alias error:", err.message);
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
        text += `• 运行模式: <b>${ctx.isHeadless ? "无头 (headless)" : "桌面会话 (editor)"}</b>\n`;
        if (lock && !ctx.isLockStale(lock)) {
            text += `• 锁定进程 (PID): <b>${lock.pid}</b>\n`;
            text += `• 连接时间: <b>${escapeHtml(connectedAtStr)}</b>\n`;
        }

        const recentSessions = getRecentSessions();
        // 复用顶部 CIRCLE_NUMBERS（已含 ①…⑩）
        const emojiNumbers = CIRCLE_NUMBERS;
        // 无头：外进程占用的会话不可切换（双写会弄挂桌面 UI）
        const selfPids = [process.pid];
        if (recentSessions.length > 0) {
            text += `\n<b>最近活跃的会话列表：</b>\n`;
            recentSessions.forEach((s, idx) => {
                const isCurrent = s.id === sid ? " <b>【当前】</b>" : "";
                let busy = "";
                if (ctx.isHeadless && s.id !== sid && isSessionDirInUse(s.id, selfPids)) {
                    busy = " 🔒<i>占用</i>";
                }
                text += `${emojiNumbers[idx]} <b>${escapeHtml(s.name)}</b>${isCurrent}${busy}\n`;
            });
            if (ctx.isHeadless) {
                text += `\n<i>🔒 占用 = 桌面/其它进程已打开，无头禁止抢接（防卡死）</i>`;
            }
            text += `\n👇 点下方数字按钮直接切换会话`;
        } else {
            text += `\n<i>暂无最近会话可切换</i>`;
        }

        // 数字按钮：①…⑩（最多 10 个），callback 带完整 session UUID
        // 占用会话只显示 🔒（不叠数字，避免挤）；列表正文仍用 ①…⑩ 对应
        // session UUID ~36 chars → "session:switch:" + uuid ≈ 51 < 64，安全
        const keyboard = { inline_keyboard: [] };
        if (recentSessions.length > 0) {
            const row = [];
            for (let i = 0; i < recentSessions.length; i++) {
                const s = recentSessions[i];
                const locked = ctx.isHeadless && s.id !== sid && isSessionDirInUse(s.id, selfPids);
                row.push({
                    text: locked ? "🔒" : emojiNumbers[i],
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
     * 无头：在本进程内 resumeSession 切换（无需对方桌面会话在线）。
     * 桌面：沿用 lock handoff，由目标会话进程认领。
     */
    async function switchHeadlessSession(chatId, targetSessionId, targetName) {
        if (!ctx.headlessClient) {
            throw new Error("无头客户端未就绪，请稍后重试");
        }
        if (ctx.headlessSwitching) {
            throw new Error("正在切换中，请稍候");
        }

        // 双写防护：目标已被其它进程（常见桌面 App --server）占用则禁止 resume
        const foreignHolders = getSessionLiveHolders(targetSessionId)
            .filter((pid) => pid !== process.pid);
        if (foreignHolders.length > 0) {
            throw new Error(
                `目标会话正被其它进程占用 (pid: ${foreignHolders.join(",")})。` +
                `请先在桌面关闭该会话，或改选无占用的会话。禁止无头与桌面同时打开同一会话（会导致桌面卡死）。`
            );
        }

        ctx.headlessSwitching = (async () => {
            const prevSession = ctx.session;
            const prevSid = ctx.currentSessionId;

            // 二次检查（竞态窗口）：resume 前再扫一次
            const holders2 = getSessionLiveHolders(targetSessionId)
                .filter((pid) => pid !== process.pid);
            if (holders2.length > 0) {
                throw new Error(
                    `目标会话刚被其它进程占用 (pid: ${holders2.join(",")})，已取消切换。`
                );
            }

            // 构造与 create 一致的 BYOK / handlers，保证 resume 后模型与权限仍可用
            // resume 也注入最新 AGENTS.md（systemMessage.append），避免粘性会话丢人设
            const agentsMd = (typeof ctx.loadAgentsFromPath === "function")
                ? ctx.loadAgentsFromPath(ctx.botProfile?.agentsMd, () => loadAgentsMdInstructions())
                : loadAgentsMdInstructions(ctx.botProfile?.agentsMd);
            const resumeConfig = await buildHeadlessSessionConfig({
                officialModels: [],
                customInstructions: agentsMd,
                onPermissionRequest: ctx.createPermissionHandler(),
                onUserInputRequest: ctx.createUserInputHandler(),
                onExitPlanModeRequest: ctx.createExitPlanModeHandler(),
                defaultModel: ctx.botProfile?.defaultModel || null,
                allowedModels: ctx.botProfile?.allowedModels || null,
                forceDefaultModel: !!(ctx.botProfile?.defaultModel || ctx.botProfile?.allowedModels),
                loadMcp: ctx.botProfile?.loadMcp !== false,
                mcpServerNames: ctx.botProfile?.mcpServerNames || null,
            });
            // 有 per-bot 白名单/默认时强制 model；否则沿用目标会话上次模型

            console.error(
                `telegram-bridge: [${ctx.currentBotName}] headless resumeSession → ${targetSessionId} (${targetName})` +
                ` agents=${agentsMd ? `${agentsMd.length}c` : "none"}`
            );
            const next = await ctx.headlessClient.resumeSession(targetSessionId, resumeConfig);

            // 先挂事件，再替换全局引用
            ctx.setupEventHandlers(next);
            if (typeof ctx.enableHeadlessAllowAll === "function") {
                await ctx.enableHeadlessAllowAll(next);
            }
            ctx.session = next;
            ctx.currentSessionId = next.sessionId || targetSessionId;
            ctx.isAgentBusy = false;
            ctx.stopTyping();
            ctx.dismissBubble();
            if (ctx.currentBotName) {
                ctx.writeLock(ctx.currentBotName, ctx.currentSessionId, process.pid);
                ctx.rememberBotSession(ctx.currentBotName, ctx.currentSessionId);
                // 同步内存 state，避免 pollLoop 写回时冲掉 lastSessionId
                if (ctx.state) ctx.state.lastSessionId = ctx.currentSessionId;
            }

            // 断开旧会话（保留磁盘，便于再切回来）
            if (prevSession && prevSession !== next) {
                try { await prevSession.disconnect(); } catch (err) {
                    console.error(`telegram-bridge: prev session disconnect:`, err.message);
                }
            }

            console.error(`telegram-bridge: [${ctx.currentBotName}] headless switched ${prevSid} → ${ctx.currentSessionId}`);
            return ctx.currentSessionId;
        })();

        try {
            return await ctx.headlessSwitching;
        } finally {
            ctx.headlessSwitching = null;
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

        // 无头：目标被外进程占用时提前拒绝（列表有 🔒 标记，点了也拦）
        if (ctx.isHeadless) {
            const foreign = getSessionLiveHolders(targetSessionId)
                .filter((pid) => pid !== process.pid);
            if (foreign.length > 0) {
                await ctx.answerCallbackQuery(cq.id, "会话被占用，禁止抢接").catch(() => {});
                await ctx.enqueue(() => ctx.sendMessage(
                    chatId,
                    `🔒 <b>无法切换</b>\n目标 <b>${escapeHtml(targetName)}</b> 正被其它进程占用` +
                    ` (pid: ${foreign.join(",")})。\n\n` +
                    `💡 无头与桌面 <b>不可同时打开同一会话</b>，否则桌面对话会崩溃/卡死。\n` +
                    `请先在桌面关闭该会话，或改选未占用的会话。`,
                    "HTML"
                ));
                return;
            }
        }

        await ctx.answerCallbackQuery(cq.id, `切换至「${targetName}」...`).catch(() => {});

        // ---------- 无头：本进程 resumeSession ----------
        if (ctx.isHeadless) {
            try {
                await ctx.enqueue(() => ctx.sendMessage(
                    chatId,
                    `⏳ 正在切换至会话 <b>${escapeHtml(targetName)}</b>…\n无头模式将直接恢复历史上下文，无需打开桌面窗口。`,
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

        // ---------- 桌面：lock handoff（目标会话进程需在线认领） ----------
        await ctx.enqueue(() => ctx.sendMessage(
            chatId,
            `⏳ 正在请求切换至会话 <b>${escapeHtml(targetName)}</b>…\n我们将在后台唤醒该会话的桥接进程，请稍候。`,
            "HTML"
        ));

        if (ctx.currentBotName) {
            try {
                ctx.writeLock(ctx.currentBotName, targetSessionId, 0);
                if (ctx.desktopHandoffTimer) {
                    clearTimeout(ctx.desktopHandoffTimer);
                    ctx.desktopHandoffTimer = null;
                }
                const handoffBot = ctx.currentBotName;
                const handoffTarget = targetSessionId;
                const handoffPrev = currentSid;
                const handoffName = targetName;
                ctx.desktopHandoffTimer = setTimeout(async () => {
                    ctx.desktopHandoffTimer = null;
                    try {
                        const checkLock = ctx.readLock(handoffBot);
                        if (checkLock && checkLock.sessionId === handoffTarget && checkLock.pid === 0) {
                            ctx.writeLock(handoffBot, handoffPrev, process.pid);
                            let errMsg = `⚠️ <b>切换失败</b>\n`;
                            errMsg += `目标会话 <b>${escapeHtml(handoffName)}</b> 当前处于离线状态（后台未运行该会话的活跃进程）。\n\n`;
                            errMsg += `💡 <b>如何激活：</b>\n`;
                            errMsg += `因为 Copilot 扩展进程是由桌面窗口生命周期管理的，您需要先在 GitHub Copilot App 历史记录中打开 “<b>${escapeHtml(handoffName)}</b>” 将其唤醒，然后再点数字按钮秒切。`;
                            await ctx.sendMessage(chatId, errMsg, "HTML");
                        }
                    } catch {}
                }, 8000);
            } catch (err) {
                console.error("telegram-bridge: failed to write lock for switch:", err.message);
                await ctx.sendMessage(chatId, `⚠️ 切换异常: ${escapeHtml(err.message)}`, "HTML");
            }
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
                msg: "⚠️ 会话未连接，无法改名。请先 /start 或等无头连上。",
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
                ctx.sendMessage(chatId, "⚠️ 会话未连接，无法改名。请先 /start。", "HTML")
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
        if (!modelId || modelId === "unknown") return 200000;

        const cleanId = modelId.includes("/") ? modelId.split("/").pop() : modelId;
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

        // 未在 models.json 配置：默认 200K（/status 显示用；实际修复走 /fixctx 的脚本表）
        return 200000;
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

            // 思考等级：官方走 reasoningEffort；DeepSeek 走模型别名 *-low/high/max
            let thinkingLabel = "不支持";
            try {
                const cap = await getThinkingCapability();
                if (cap.supported && cap.current) {
                    thinkingLabel = formatThinkingLevel(cap.current);
                } else if (cap.supported) {
                    thinkingLabel = "默认 / 未设置";
                } else if (cap.reason) {
                    thinkingLabel = "不支持";
                }
            } catch (_) {}
            msgLines.push(`💡 <b>思考</b>　　${escapeHtml(thinkingLabel)}`);

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
        switchHeadlessSession,
        getDisplayModels,
        handleStatusCommand,
        handleRichCommand,
        ...codexApi,
    };
}
