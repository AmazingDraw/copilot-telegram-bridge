// bot-handlers.mjs — outbound session events + permission / ask_user factories
// Factory: attachHandlers(ctx). Behavior-preserving extract from extension.mjs.

import { escapeHtml, chunkMessage, markdownToTelegramHtmlSafe } from "./markdown-tg.mjs";
import {
    isOfficialModelBlocked,
    banishBlockedSessionModel,
    collectBotModelFallbacks,
} from "./byok-providers.mjs";

/**
 * @param {any} ctx Bot instance context
 */
export function attachHandlers(ctx) {
    const ASK_USER_TIMEOUT_MS = ctx.ASK_USER_TIMEOUT_MS;

    /** 回复目标：优先本轮触发 chat（群），否则 allowlist / 最近活跃 */
    function resolveOutboundChatIds() {
        if (ctx.activeReplyChatId != null) return [Number(ctx.activeReplyChatId)];
        if (typeof ctx.getOutboundChatIds === "function") {
            try {
                const ids = ctx.getOutboundChatIds();
                if (ids && ids.length) return ids;
            } catch {}
        }
        return ctx.getAllowedChatIds();
    }

    const TURN_STALL_MS = 3 * 60 * 1000;
    let turnWatchdog = null;

    function formatSessionErrorMessage(data) {
        const raw = String(data?.message || data?.errorType || "Unknown error");
        const lower = raw.toLowerCase();
        if (lower.includes("auth_unavailable")) {
            return "⚠️ 上游模型服务鉴权异常或配额不足（本机登录状态正常）\n\n💡 建议：上游渠道暂不可用，请通过 /model 切换其他可用模型。";
        }
        if (
            lower.includes("internal_error") ||
            lower.includes("internal error") ||
            lower.includes("http2") ||
            lower.includes("stream error") ||
            lower.includes("client conn is closed")
        ) {
            return "⚠️ 上游模型连接或数据传输异常中断\n\n💡 建议：可能为网络瞬断，可直接重试发送；或发 /stop 重置当前轮次。";
        }
        return `Error: ${raw}`;
    }

    function clearTurnWatchdog() {
        if (turnWatchdog) {
            clearTimeout(turnWatchdog);
            turnWatchdog = null;
        }
    }

    function armTurnWatchdog() {
        clearTurnWatchdog();
        turnWatchdog = setTimeout(() => {
            turnWatchdog = null;
            if (!ctx.connected || !ctx.isAgentBusy) return;
            if (ctx.bubbleActive) return;
            if (ctx.activeTools && ctx.activeTools.size > 0) return;
            const chatIds = resolveOutboundChatIds();
            for (const chatId of chatIds) {
                ctx.enqueue(() => ctx.sendMessage(chatId, "还在等模型，没有工具进度。可发 /stop 中止。"));
            }
        }, TURN_STALL_MS);
    }

    // ============================================================
    // Section 10: Event Handlers (outbound to Telegram)
    // ============================================================

    /** 当前已绑定事件的 session 对象；切换 / 重连时必须重绑 */

    function setupEventHandlers(sess) {
        if (!sess) return;
        // 同一 session 实例不重复挂载（避免双推）；换会话则重绑
        if (ctx.boundEventSession === sess) return;
        ctx.boundEventSession = sess;

        sess.on("assistant.message", (event) => {
            if (ctx.restorePlanAfterTurn && ctx.stickyPlanMode) {
                ctx.stickyRestoreArmed = true;
            }
            if (typeof event.data?.currentTokens === "number" && sess.sessionId) {
                if (!ctx.sessionTokensMap) ctx.sessionTokensMap = new Map();
                ctx.sessionTokensMap.set(sess.sessionId, event.data.currentTokens);
            }
            if (!ctx.connected) return;
            if (event.data.parentToolCallId) return;

            const content = event.data.content;
            if (!content || content.trim().length === 0) return;

            ctx.ensureTyping();

            const chatIds = resolveOutboundChatIds();
            const chunks = chunkMessage(content);
            // Plan 模式（stickyPlanMode）下，模型输出的计划正文也走 planStyle 排版
            const sendOpts = ctx.stickyPlanMode ? { planStyle: true } : undefined;
            for (const chatId of chatIds) {
                for (const chunk of chunks) {
                    ctx.enqueue(() => ctx.sendFormattedMessage(chatId, chunk, sendOpts));
                }
            }
        });

        // 实时上下文占用；忽略 0，避免污染缓存
        sess.on("session.usage_info", (event) => {
            const tokens = event?.data?.currentTokens;
            if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0 || !sess.sessionId) return;
            if (!ctx.sessionTokensMap) ctx.sessionTokensMap = new Map();
            const prev = ctx.sessionTokensMap.get(sess.sessionId);
            if (typeof prev === "number" && prev > tokens) return;
            ctx.sessionTokensMap.set(sess.sessionId, tokens);
        });

        sess.on("assistant.message_delta", (event) => {
            if (!ctx.connected) return;
            if (event.data.parentToolCallId) return;
            if (!event.data.deltaContent) return;
            ctx.ensureTyping();
        });

        sess.on("user_input.requested", (event) => {
            if (!ctx.connected) return;
            const { requestId, question, choices } = event.data;
            if (!question) return;

            // 保存等待输入的请求
            const reqId = "ask_" + Math.random().toString(36).substring(2, 9);

            let questionText = `💬 <b>Copilot 正在等待您的回复...</b>\n\n`;
            questionText += `${escapeHtml(question)}`;

            if (choices && choices.length > 0) {
                const choiceList = choices
                    .map((c, i) => `<b>${ctx.getCircleNumber(i + 1)}</b> ${escapeHtml(c)}`)
                    .join("\n");
                questionText += `\n\n${choiceList}`;
            }

            questionText += `\n\n💡 <i>您可以在下方直接打字回复，或点击数字按钮快速选择：</i>`;

            // 如果有预定义选项，我们可以提供快捷按钮选择
            const keyboard = { inline_keyboard: [] };
            if (choices && choices.length > 0) {
                for (let i = 0; i < choices.length; i += 2) {
                    const row = [];
                    row.push({ text: ctx.getCircleNumber(i + 1), callback_data: `ask:choice:${reqId}:${i + 1}` });
                    if (i + 1 < choices.length) {
                        row.push({ text: ctx.getCircleNumber(i + 2), callback_data: `ask:choice:${reqId}:${i + 2}` });
                    }
                    keyboard.inline_keyboard.push(row);
                }
            }

            const chatIds = resolveOutboundChatIds();
            for (const chatId of chatIds) {
                ctx.enqueue(async () => {
                    const res = await ctx.callTelegram("sendMessage", {
                        chat_id: chatId,
                        text: questionText,
                        parse_mode: "HTML",
                        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
                    });

                    // 将 reqId 映射为等待回复的数据
                    ctx.pendingUserInputs.set(reqId, {
                        requestId,
                        choices,
                        chatId,
                        messageId: res.message_id,
                        questionText,
                    });
                });
            }
        });

        sess.on("user_input.completed", (event) => {
            const { requestId, answer } = event.data;

            // 如果本进程有悬挂的 awaitingInput，直接解冻并返回该 answer（跨进程通过广播事件解冻）
            if (ctx.awaitingInput) {
                const { resolve } = ctx.awaitingInput;
                clearTimeout(ctx.awaitingInput.timer);
                ctx.awaitingInput = null;
                resolve(answer || "");
            }

            // 寻找对应的 pending input 并清理，同时把气泡修改为“已答复”
            for (const [reqId, item] of ctx.pendingUserInputs.entries()) {
                if (item.requestId === requestId) {
                    ctx.pendingUserInputs.delete(reqId);
                    const cleanText = item.questionText + `\n\n✅ <b>答复完成 (Answered)</b>\n已提供回答: "${escapeHtml(answer || "")}"`;
                    ctx.callTelegram("editMessageText", {
                        chat_id: item.chatId,
                        message_id: item.messageId,
                        text: cleanText,
                        parse_mode: "HTML",
                    }).catch(() => {});
                }
            }
        });

        sess.on("session.skills_loaded", (event) => {
            const skills = event?.data?.skills;
            const names = Array.isArray(skills)
                ? skills.map((s) => s?.name || s?.id || "").filter(Boolean)
                : [];
            console.error(
                `telegram-bridge: [${ctx.currentBotName}] skills_loaded count=${names.length}` +
                (names.length ? ` sample=${names.slice(0, 12).join(",")}` : "")
            );
        });

        sess.on("session.model_change", (event) => {
            const mid = String(
                event?.data?.modelId
                || event?.data?.model
                || event?.data?.selectedModel
                || ""
            ).trim();
            if (!mid) return;
            if (isOfficialModelBlocked(mid)) {
                console.error(
                    `telegram-bridge: [${ctx.currentBotName}] session.model_change blocked ${mid}; kicking`
                );
                void banishBlockedSessionModel(sess, {
                    fallbacks: collectBotModelFallbacks({
                        lastModelId: typeof ctx.readBotModel === "function"
                            ? ctx.readBotModel(ctx.currentBotName)
                            : ctx.state?.lastModelId,
                        defaultModel: ctx.botProfile?.defaultModel,
                    }),
                    logPrefix: `telegram-bridge: [${ctx.currentBotName}]`,
                }).then((r) => {
                    if (r?.switched && r.desiredModel && typeof ctx.rememberBotModel === "function" && ctx.currentBotName) {
                        ctx.rememberBotModel(ctx.currentBotName, r.desiredModel);
                        if (ctx.state) ctx.state.lastModelId = r.desiredModel;
                    }
                }).catch((err) => {
                    console.error(`telegram-bridge: [${ctx.currentBotName}] banish after model_change: ${err.message}`);
                });
                return;
            }
            if (typeof ctx.rememberBotModel === "function" && ctx.currentBotName) {
                ctx.rememberBotModel(ctx.currentBotName, mid);
                if (ctx.state) ctx.state.lastModelId = mid;
            }
        });

        sess.on("session.error", (event) => {
            clearTurnWatchdog();
            if (!ctx.connected) return;
            const raw = event.data.message || event.data.errorType || "Unknown error";
            console.error(`telegram-bridge: [${ctx.currentBotName}] session.error:`, raw);
            const errMsg = formatSessionErrorMessage(event.data);
            const chatIds = resolveOutboundChatIds();
            for (const chatId of chatIds) {
                ctx.enqueue(() => ctx.sendMessage(chatId, errMsg));
            }
        });

        sess.on("assistant.turn_start", () => {
            ctx.isAgentBusy = true;
            ctx.ensureTyping();
            armTurnWatchdog();
            if (ctx.restorePlanAfterTurn && ctx.stickyPlanMode) {
                ctx.stickyRestoreArmed = true;
            }
        });

        sess.on("assistant.turn_end", () => {
            ctx.isAgentBusy = false;
            clearTurnWatchdog();
            ctx.stopTyping();
            ctx.dismissBubble();
            // 不在 turn_end 回 Plan（exit_plan_mode 等待批准时也会 turn_end）
        });

        sess.on("abort", () => {
            ctx.isAgentBusy = false;
            clearTurnWatchdog();
            ctx.stopTyping();
            ctx.dismissBubble();
            if (typeof ctx.maybeRestoreStickyPlan === "function") {
                ctx.maybeRestoreStickyPlan("abort").catch(() => {});
            }
        });

        sess.on("session.idle", () => {
            ctx.isAgentBusy = false;
            clearTurnWatchdog();
            ctx.stopTyping();
            ctx.dismissBubble();
            if (typeof ctx.maybeRestoreStickyPlan === "function") {
                ctx.maybeRestoreStickyPlan("idle").catch(() => {});
            }
        });

        // Relay images and documents from tool results to Telegram
        const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
        const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

        sess.on("tool.execution_start", (event) => {
            if (ctx.restorePlanAfterTurn && ctx.stickyPlanMode) {
                ctx.stickyRestoreArmed = true;
            }
            if (!ctx.connected) return;
            ctx.ensureTyping();
            const toolCallId = event.data.toolCallId;
            const toolName = event.data.toolName || "unknown";
            const desc = ctx.describeToolCall(toolName, event.data.arguments);
            // desc===null → 内部工具静默；空串也当静默。只有真有展示文案才点亮气泡。
            if (desc) {
                ctx.bubbleActive = true;
                ctx.activeTools.set(toolCallId, { name: toolName, description: desc });
                ctx.scheduleBubbleUpdate();
            }
        });

        sess.on("tool.execution_complete", (event) => {
            if (!ctx.connected) return;
            ctx.ensureTyping();
            const toolCallId = event.data.toolCallId;
            const completed = ctx.activeTools.get(toolCallId);
            if (completed?.description) {
                ctx.lastCompletedToolDesc = completed.description;
            }
            ctx.activeTools.delete(toolCallId);
            ctx.scheduleBubbleUpdate();

            const contents = event.data.result?.contents;
            if (!contents || !Array.isArray(contents)) return;

            const chatIds = resolveOutboundChatIds();
            for (const block of contents) {
                if (block.type === "image" && block.data && block.mimeType) {
                    const bytes = Math.ceil(block.data.length * 3 / 4);
                    if (bytes > MAX_PHOTO_BYTES) {
                        for (const chatId of chatIds) {
                            ctx.enqueue(() => ctx.sendMessage(chatId, "(Image too large for Telegram, >10MB)"));
                        }
                        continue;
                    }
                    for (const chatId of chatIds) {
                        if (PHOTO_MIMES.has(block.mimeType)) {
                            ctx.enqueue(() => ctx.sendPhoto(chatId, block.data, block.mimeType));
                        } else {
                            const ext = block.mimeType.split("/")[1] || "bin";
                            ctx.enqueue(() => ctx.sendDocument(chatId, block.data, block.mimeType, `image.${ext}`));
                        }
                    }
                }
            }
        });
    }

    // ============================================================
    // Section 11: ask_user & permission Handlers
    // ============================================================

    /**
     * 对齐桌面「Run tools without asking」——会话级一路绿灯。
     * 仅 permissionMode=allow-all（或无头缺省）时启用；ask 不动 RPC。
     * setAllowAll = tools + paths + URLs；setApproveAll 再保险 tool 请求。
     */
    async function enableHeadlessAllowAll(sess) {
        if (!sess?.rpc?.permissions) return;
        const mode = String(
            ctx.botProfile?.permissionMode || (ctx.isHeadless ? "allow-all" : "ask")
        ).toLowerCase();
        if (mode === "ask") {
            return;
        }
        if (mode === "deny-all") {
            // 专 bot：不放行工具；尽量关掉 allow-all
            try {
                await sess.rpc.permissions.setAllowAll({ enabled: false, source: "rpc" });
                console.error(`telegram-bridge: [${ctx.name}] permissions.setAllowAll(false) deny-all`);
            } catch (err) {
                console.error(`telegram-bridge: [${ctx.name}] setAllowAll(false) failed: ${err.message}`);
            }
            try {
                await sess.rpc.permissions.setApproveAll({ enabled: false, source: "rpc" });
                console.error(`telegram-bridge: [${ctx.name}] permissions.setApproveAll(false) deny-all`);
            } catch (err) {
                console.error(`telegram-bridge: [${ctx.name}] setApproveAll(false) failed: ${err.message}`);
            }
            return;
        }
        try {
            await sess.rpc.permissions.setAllowAll({ enabled: true, source: "rpc" });
            console.error(`telegram-bridge: [${ctx.name}] permissions.setAllowAll(true) ok`);
        } catch (err) {
            console.error(`telegram-bridge: [${ctx.name}] setAllowAll failed: ${err.message}`);
        }
        try {
            await sess.rpc.permissions.setApproveAll({ enabled: true, source: "rpc" });
            console.error(`telegram-bridge: [${ctx.name}] permissions.setApproveAll(true) ok`);
        } catch (err) {
            console.error(`telegram-bridge: [${ctx.name}] setApproveAll failed: ${err.message}`);
        }
    }

    function createPermissionHandler() {
        const mode = String(ctx.botProfile?.permissionMode || (ctx.isHeadless ? "allow-all" : "ask")).toLowerCase();
        if (mode === "deny-all") {
            return (request) => {
                const kind = request?.kind || "?";
                let detail = "";
                if (kind === "shell") detail = request.fullCommandText || "";
                else if (kind === "write") detail = request.fileName || "";
                else if (kind === "read") detail = request.path || "";
                else if (kind === "mcp") detail = request.toolName || "";
                else if (kind === "url") detail = request.url || "";
                const short = String(detail).slice(0, 120);
                console.error(
                    `telegram-bridge: [${ctx.name}] DENY permission kind=${kind}${short ? ` ${short}` : ""}`
                );
                return { kind: "deny-once" };
            };
        }
        // 无头默认自动放行（与 SDK approveAll / 桌面 allow-all-tools 一致）
        if (ctx.isHeadless || mode === "allow-all") {
            return (request) => {
                const kind = request?.kind || "?";
                let detail = "";
                if (kind === "shell") detail = request.fullCommandText || "";
                else if (kind === "write") detail = request.fileName || "";
                else if (kind === "read") detail = request.path || "";
                else if (kind === "mcp") detail = request.toolName || "";
                else if (kind === "url") detail = request.url || "";
                const short = String(detail).slice(0, 120);
                console.error(
                    `telegram-bridge: [${ctx.name}] auto-approved permission kind=${kind}${short ? ` ${short}` : ""}`
                );
                // SDK 官方 approveAll = { kind: "approve-once" }
                return { kind: "approve-once" };
            };
        }

        const PERMISSION_TIMEOUT_MS = ctx.PERMISSION_TIMEOUT_MS || 10 * 60 * 1000;

        return (request) => {
            return new Promise((resolve) => {
                const reqId = "perm_" + Math.random().toString(36).substring(2, 9);

                // 格式化提问文本
                let text = `⚠️ <b>AI 申请操作权限</b>\n\n`;
                text += `🔹 <b>操作类型</b>: <code>${escapeHtml(request.kind)}</code>\n`;
                if (request.intention) {
                    text += `🔹 <b>意图</b>: ${escapeHtml(request.intention)}\n`;
                }

                if (request.kind === "shell") {
                    text += `🔹 <b>完整命令</b>:\n<pre>${escapeHtml(request.fullCommandText)}</pre>\n`;
                    if (request.warning) {
                        text += `⚠️ <b>风险警告</b>: ${escapeHtml(request.warning)}\n`;
                    }
                } else if (request.kind === "write") {
                    text += `🔹 <b>修改文件</b>: <code>${escapeHtml(request.fileName)}</code>\n`;
                    if (request.diff) {
                        // 如果 diff 太长，截断以防 Telegram 消息超限 (max 4096)
                        let diffText = request.diff;
                        if (diffText.length > 2000) {
                            diffText = diffText.slice(0, 2000) + "\n... (Diff已截断)";
                        }
                        text += `🔹 <b>代码差异 (Diff)</b>:\n<pre>${escapeHtml(diffText)}</pre>\n`;
                    }
                } else if (request.kind === "read") {
                    text += `🔹 <b>读取路径</b>: <code>${escapeHtml(request.path)}</code>\n`;
                } else if (request.kind === "mcp") {
                    text += `🔹 <b>MCP 工具</b>: <code>${escapeHtml(request.toolName)}</code>\n`;
                    if (request.args) {
                        text += `🔹 <b>参数</b>:\n<pre>${escapeHtml(JSON.stringify(request.args, null, 2))}</pre>\n`;
                    }
                } else if (request.kind === "url") {
                    text += `🔹 <b>访问 URL</b>: <code>${escapeHtml(request.url)}</code>\n`;
                }

                text += `\n请问您是否授权该操作？`;

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: "✅ 允许 (Approve)", callback_data: `perm:approve:${reqId}` },
                            { text: "❌ 拒绝 (Reject)", callback_data: `perm:reject:${reqId}` }
                        ]
                    ]
                };

                const cardMessages = [];
                const timer = setTimeout(() => {
                    const pending = ctx.pendingPermissionRequests.get(reqId);
                    if (!pending) return;
                    ctx.pendingPermissionRequests.delete(reqId);
                    console.error(
                        `telegram-bridge: [${ctx.name}] permission timed out (${reqId}); deny`
                    );
                    pending.resolve({
                        kind: "deny-once",
                        feedback: "Timed out waiting for permission approval via Telegram.",
                    });
                    const timedOutText = pending.questionText + "\n⏱ <b>已超时（自动拒绝）</b>";
                    for (const m of pending.cardMessages || []) {
                        ctx.callTelegram("editMessageText", {
                            chat_id: m.chatId,
                            message_id: m.messageId,
                            text: timedOutText,
                            parse_mode: "HTML",
                        }).catch(() => {});
                    }
                }, PERMISSION_TIMEOUT_MS);

                ctx.pendingPermissionRequests.set(reqId, {
                    resolve,
                    request,
                    timer,
                    questionText: text,
                    cardMessages,
                });

                const chatIds = resolveOutboundChatIds();
                for (const chatId of chatIds) {
                    ctx.enqueue(async () => {
                        try {
                            const result = await ctx.callTelegram("sendMessage", {
                                chat_id: chatId,
                                text: text,
                                parse_mode: "HTML",
                                reply_markup: keyboard,
                            });
                            const mid = result?.message_id;
                            const pending = ctx.pendingPermissionRequests.get(reqId);
                            if (mid != null && pending) {
                                pending.cardMessages.push({ chatId, messageId: mid });
                            }
                        } catch (err) {
                            console.error(
                                `telegram-bridge: [${ctx.name}] permission card send failed:`,
                                err.message
                            );
                        }
                    });
                }
            });
        };
    }

    function createUserInputHandler() {
        // 只挂 Promise / 超时，不向 Telegram 发题面。
        // UI 由 sess.on("user_input.requested") 统一发（带 ①② 按钮）；
        // 若此处再 sendFormattedMessage，会出现「先纯文本 1)2) 再卡片」双发。
        return (request) => {
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (ctx.awaitingInput && ctx.awaitingInput.timer === timer) {
                        ctx.awaitingInput = null;
                    }
                    resolve({ answer: "", wasFreeform: true });
                }, ASK_USER_TIMEOUT_MS);

                ctx.awaitingInput = {
                    resolve: (rawText) => {
                        let answer = rawText;
                        let wasFreeform = true;

                        if (request.choices && request.choices.length > 0) {
                            const num = parseInt(rawText.trim(), 10);
                            if (!isNaN(num) && num >= 1 && num <= request.choices.length) {
                                answer = request.choices[num - 1];
                                wasFreeform = false;
                            } else {
                                const match = request.choices.find(
                                    c => c.toLowerCase() === rawText.trim().toLowerCase()
                                );
                                if (match) {
                                    answer = match;
                                    wasFreeform = false;
                                }
                            }
                        }
                        resolve({ answer, wasFreeform });
                    },
                    timer,
                };
            });
        };
    }

    const EXIT_PLAN_ACTION_LABELS = {
        interactive: { emoji: "💬", desc: "批准执行（结束后回 Plan）" },
        autopilot: { emoji: "🚀", desc: "批准自动执行（结束后回 Plan）" },
        exit_only: { emoji: "🚪", desc: "离开 Plan，不执行" },
        autopilot_fleet: { emoji: "🛸", desc: "Fleet 执行（结束后回 Plan）" },
    };

    /** summary = 本次 exit_plan_mode 参数；planContent = 磁盘 plan.md（可能是上一份过期计划） */
    function pickPlanMarkdown(request) {
        const summary = String(request?.summary || "").trim();
        const plan = String(request?.planContent || "").trim();
        if (!summary && !plan) return "";
        if (!summary) return plan;
        if (!plan) return summary;
        const norm = (s) => s.replace(/\s+/g, " ").trim();
        const ns = norm(summary);
        const np = norm(plan);
        if (ns === np) return plan.length >= summary.length ? plan : summary;
        // 仅当 summary 足够长且明显是 plan.md 子集时，才用完整 plan.md（同一次计划）
        if (ns.length >= 80 && (np.includes(ns) || plan.includes(summary))) return plan;
        if (ns.includes(np) || summary.includes(plan)) return summary;
        // 内容对不上：以本次工具 summary 为准，丢掉可能过期的 plan.md（勿拼接）
        console.error(
            `telegram-bridge: [${ctx.name}] plan body prefer summary ` +
            `(summary=${summary.length}c, plan.md=${plan.length}c, divergent)`
        );
        return summary;
    }

    /**
     * 注册后 SDK 才会暴露 exit_plan_mode 工具。
     * 批准 interactive/autopilot 时 SDK 会暂时离 Plan 以执行；粘性 Plan 在 session.idle 切回。
     */
    function createExitPlanModeHandler() {
        return (request) => {
            return new Promise((resolve) => {
                const reqId = "xplan_" + Math.random().toString(36).substring(2, 9);
                const actions = Array.isArray(request?.actions) && request.actions.length
                    ? request.actions.map(String)
                    : ["interactive", "autopilot", "exit_only"];
                const recommended = String(request?.recommendedAction || "interactive");

                const timer = setTimeout(() => {
                    const pending = ctx.pendingExitPlanRequests.get(reqId);
                    if (!pending) return;
                    ctx.pendingExitPlanRequests.delete(reqId);
                    console.error(
                        `telegram-bridge: [${ctx.name}] exit_plan_mode timed out (${reqId}); reject`
                    );
                    pending.resolve({
                        approved: false,
                        feedback: "Timed out waiting for plan approval via Telegram.",
                    });
                }, ASK_USER_TIMEOUT_MS);

                const planMd = pickPlanMarkdown(request);

                // 短批准卡（带按钮）；正文单独用 Markdown 渲染发送，避免 <pre> + 截断 + 重复
                let cardText = `📋 <b>计划已就绪</b>\n\n`;
                cardText += `<i>批准执行会短暂离开 Plan；全部做完后自动回到 Plan（除非选「离开 Plan」）。</i>\n\n`;
                cardText += `推荐: <code>${escapeHtml(recommended)}</code>\n`;
                cardText += `请选择：`;

                const keyboard = { inline_keyboard: [] };
                for (const action of actions) {
                    const meta = EXIT_PLAN_ACTION_LABELS[action] || { emoji: "▶️", desc: action };
                    const star = action === recommended ? "✅ " : "";
                    keyboard.inline_keyboard.push([{
                        text: `${star}${meta.emoji} ${meta.desc}`,
                        callback_data: `xplan:${action}:${reqId}`,
                    }]);
                }
                keyboard.inline_keyboard.push([{
                    text: "❌ 拒绝（继续 Plan）",
                    callback_data: `xplan:reject:${reqId}`,
                }]);

                ctx.pendingExitPlanRequests.set(reqId, {
                    resolve,
                    request,
                    timer,
                    actions,
                    recommended,
                    questionText: cardText,
                });

                console.error(
                    `telegram-bridge: [${ctx.name}] exit_plan_mode requested ` +
                    `actions=${actions.join(",")} recommended=${recommended} ` +
                    `planChars=${planMd.length}`
                );

                const chatIds = resolveOutboundChatIds();
                for (const chatId of chatIds) {
                    ctx.enqueue(async () => {
                        if (planMd) {
                            const chunks = chunkMessage(planMd, 3500);
                            for (const chunk of chunks) {
                                try {
                                    if (typeof ctx.sendFormattedMessage === "function") {
                                        await ctx.sendFormattedMessage(chatId, chunk, { planStyle: true });
                                    } else {
                                        const html = markdownToTelegramHtmlSafe(chunk, { planStyle: true });
                                        await ctx.callTelegram("sendMessage", {
                                            chat_id: chatId,
                                            text: html || escapeHtml(chunk),
                                            parse_mode: "HTML",
                                        });
                                    }
                                } catch (err) {
                                    console.error(
                                        `telegram-bridge: [${ctx.name}] plan body send failed: ${err.message}`
                                    );
                                    await ctx.callTelegram("sendMessage", {
                                        chat_id: chatId,
                                        text: chunk.slice(0, 4000),
                                    }).catch(() => {});
                                }
                            }
                        }
                        await ctx.callTelegram("sendMessage", {
                            chat_id: chatId,
                            text: cardText,
                            parse_mode: "HTML",
                            reply_markup: keyboard,
                        });
                    });
                }
            });
        };
    }

    async function maybeRestoreStickyPlan(reason) {
        if (!ctx.restorePlanAfterTurn || !ctx.stickyPlanMode) return;
        // 用户打断（abort）绝不回 Plan，否则新指令会被 Plan 锁拦住
        if (reason === "abort") {
            console.error(
                `telegram-bridge: [${ctx.name}] sticky Plan restore skipped (abort/interrupt)`
            );
            return;
        }
        // idle：须已 armed（见过批准后的执行活动）
        if (!ctx.stickyRestoreArmed) {
            console.error(
                `telegram-bridge: [${ctx.name}] sticky Plan restore skipped (${reason}, not armed)`
            );
            return;
        }
        ctx.restorePlanAfterTurn = false;
        ctx.stickyRestoreArmed = false;
        const sess = ctx.session;
        if (!sess?.rpc?.mode?.set) return;
        try {
            await sess.rpc.mode.set({ mode: "plan" });
            if (typeof sess.registerExitPlanModeHandler === "function") {
                sess.registerExitPlanModeHandler(createExitPlanModeHandler());
            }
            console.error(
                `telegram-bridge: [${ctx.name}] sticky Plan restored after ${reason}`
            );
            const chatIds = resolveOutboundChatIds();
            for (const chatId of chatIds) {
                ctx.enqueue(() => ctx.sendMessage(
                    chatId,
                    "📋 执行结束，已自动回到 <b>Plan</b> 模式",
                    "HTML"
                ));
            }
        } catch (err) {
            console.error(
                `telegram-bridge: [${ctx.name}] sticky Plan restore failed: ${err.message}`
            );
        }
    }

    ctx.createPermissionHandler = createPermissionHandler;
    ctx.createUserInputHandler = createUserInputHandler;
    ctx.createExitPlanModeHandler = createExitPlanModeHandler;
    ctx.maybeRestoreStickyPlan = maybeRestoreStickyPlan;
    ctx.setupEventHandlers = setupEventHandlers;
    ctx.enableHeadlessAllowAll = enableHeadlessAllowAll;

    return {
        setupEventHandlers,
        createPermissionHandler,
        createUserInputHandler,
        createExitPlanModeHandler,
        maybeRestoreStickyPlan,
        enableHeadlessAllowAll,
    };
}
