// codex-commands.mjs — /codex 子命令系统（独立模块）
// 从 bot-commands.mjs 拆出：Codex 子命令（新建/继续/模型/进度/关闭桌面/退出桥接）
// + 桌面端检测 + 任务执行/排队/停止/取消。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { escapeHtml } from "./markdown-tg.mjs";
import { loadModelsConfig } from "./byok-providers.mjs";

/** 读取本机个性化配置（合并进 config/models.json 的 paths + launchAgentLabel）。缺失时回退默认值。 */
function loadBridgeConfig() {
    const home = process.env.HOME || "";
    try {
        const cfg = loadModelsConfig();
        const paths = cfg.paths || {};
        return {
            codex: {
                agentsDir: paths.codexAgentsDir || `${home}/.gemini/config/plugins/your-plugin/skills/your-skill`,
                sessionDir: paths.codexSessionDir || `${home}/.codex/sessions`,
                stateDir: paths.codexStateDir || "/tmp/cu-card/codex",
            },
            launchAgentLabel: cfg.launchAgentLabel || "com.copilot-telegram-bridge",
        };
    } catch (err) {
        console.error("telegram-bridge: loadBridgeConfig failed, use defaults:", err.message);
    }
    return {
        codex: {
            agentsDir: `${home}/.gemini/config/plugins/your-plugin/skills/your-skill`,
            sessionDir: `${home}/.codex/sessions`,
            stateDir: "/tmp/cu-card/codex",
        },
        launchAgentLabel: "com.copilot-telegram-bridge",
    };
}

/**
 * Codex 子命令系统（挂到 ctx）。
 * @param {any} ctx Bot instance context（enqueue/sendMessage/answerCallbackQuery 等）
 * @returns {{handleCodexCommand, handleCodexCallback, tryConsumeCodexInput, handleCodexProgress}}
 */
export function attachCodexCommands(ctx) {
    const bridgeCfg = loadBridgeConfig();
    const CODEX_TIMEOUT_MS = 10 * 60 * 1000;      // 单任务超时 10 分钟
    const CODEX_STUCK_MS = 5 * 60 * 1000;         // 5 分钟无新输出判定卡住
    const CODEX_WAIT_MS = 10 * 60 * 1000;         // 输入等待超时 10 分钟（长时间不说话才退出）
    const CODEX_STATE_DIR = bridgeCfg.codex.stateDir;
    const CODEX_AGENTS_DIR = bridgeCfg.codex.agentsDir;
    const CODEX_SESSION_DIR = bridgeCfg.codex.sessionDir;

    // Codex 会话 id 哈希映射（resume 的 sid 是 UUID，callback_data 超 64 字节会被拒）
    const codexSidCache = new Map();
    function getCodexSidHash(sid) {
        const h = createHash("sha256").update(sid).digest("hex").slice(0, 12);
        codexSidCache.set(h, sid);
        return h;
    }
    function resolveCodexSid(hash) {
        return codexSidCache.get(hash) || "";
    }

    // Codex 会话 sid → 标题 缓存（resume 回调显示标题用）
    const codexTitleCache = new Map();
    function resolveCodexTitle(sid) {
        return codexTitleCache.get(sid) || "";
    }

    // Codex 模型 slug 哈希映射（切换模型 callback）
    const codexModelCache = new Map();
    function getCodexModelHash(slug) {
        const h = createHash("sha256").update(`m:${slug}`).digest("hex").slice(0, 12);
        codexModelCache.set(h, slug);
        return h;
    }
    function resolveCodexModel(hash) {
        return codexModelCache.get(hash) || "";
    }

    /** 排队待执行的 Codex 指令（当前任务结束后自动执行；可取消） */
    const codexPendingQueue = []; // [{chatId, task, prompt, imagePath, queuedAt}]
    /** 运行中任务 → child 句柄（供「停止任务」kill） */
    const codexRunningPids = new Map(); // taskId → child

    /** ChatGPT/Codex 桌面端进程匹配模式 */
    const CODEX_DESKTOP_PS_PAT = /ChatGPT\.app|Codex Framework|codex app-server/;

    /**
     * 列出 ChatGPT/Codex 桌面端相关存活 PID（ps 匹配，等价 chatgpt-app.sh 的内置实现）。
     * @returns {number[]}
     */
    function codexDesktopPids() {
        try {
            const out = execFileSync("ps", ["aux"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
            const pids = [];
            for (const line of out.split("\n")) {
                if (!CODEX_DESKTOP_PS_PAT.test(line)) continue;
                const pid = Number(line.trim().split(/\s+/)[1]);
                if (Number.isFinite(pid) && pid > 0) pids.push(pid);
            }
            return [...new Set(pids)];
        } catch {
            return [];
        }
    }

    /** 检测 ChatGPT/Codex 桌面端是否在运行（内置实现，不依赖外部脚本）。true = 桌面端开着 */
    function isCodexDesktopRunning() {
        return Promise.resolve(codexDesktopPids().length > 0);
    }

    /** 关闭 ChatGPT/Codex 桌面端（kill 主 App + 关联进程，等价 chatgpt-app.sh quit） */
    function closeCodexDesktop() {
        return new Promise((resolve) => {
            const pids = codexDesktopPids();
            if (pids.length === 0) {
                resolve({ ok: true, msg: "⚪ 桌面端（ChatGPT/Codex）未运行，无需关闭。" });
                return;
            }
            try {
                const main = execFileSync("pgrep", ["-f", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"], { encoding: "utf8" })
                    .trim().split("\n").filter(Boolean);
                for (const p of main) {
                    try { process.kill(Number(p), "SIGTERM"); } catch (_) {}
                }
                for (const p of pids) {
                    try { process.kill(p, "SIGTERM"); } catch (_) {}
                }
                setTimeout(() => {
                    const left = codexDesktopPids();
                    for (const p of left) {
                        try { process.kill(p, "SIGKILL"); } catch (_) {}
                    }
                    const still = codexDesktopPids().length > 0;
                    resolve({
                        ok: !still,
                        msg: still
                            ? "⚠️ 部分桌面端进程未退出，请手动检查 ChatGPT App。"
                            : "🖥 <b>桌面端已关闭</b>\n\n现在可以继续 Codex 对话了。",
                    });
                }, 2500);
            } catch (err) {
                resolve({ ok: false, msg: `❌ 关闭桌面端失败: ${escapeHtml(err.message)}` });
            }
        });
    }

    function codexStateFile() { return join(CODEX_STATE_DIR, "tasks.json"); }

    function loadCodexTasks() {
        try {
            if (!existsSync(codexStateFile())) return {};
            return JSON.parse(readFileSync(codexStateFile(), "utf-8"));
        } catch (_) { return {}; }
    }

    function saveCodexTasks(tasks) {
        try {
            mkdirSync(CODEX_STATE_DIR, { recursive: true });
            const ids = Object.keys(tasks).sort((a, b) => (tasks[b].startedAt || 0) - (tasks[a].startedAt || 0));
            for (const id of ids.slice(50)) delete tasks[id];
            writeFileSync(codexStateFile(), JSON.stringify(tasks, null, 2), "utf-8");
        } catch (err) {
            console.error("telegram-bridge: saveCodexTasks failed:", err.message);
        }
    }

    function codexTaskId() {
        return `codex-${Date.now()}`;
    }

    function clearAwaitingCodex(notifyTimeout = false) {
        const prev = ctx.awaitingCodex;
        if (!prev) return null;
        if (prev.timer) clearTimeout(prev.timer);
        ctx.awaitingCodex = null;
        if (notifyTimeout) {
            ctx.enqueue(() =>
                ctx.sendMessage(prev.chatId, "⏰ <b>Codex 输入等待超时</b>，已退出桥接。再发 /codex 重新开始。", "HTML")
            ).catch(() => {});
        }
        return prev;
    }

    /**
     * 后台执行 codex 任务，轮询完成文件，超时/卡住检测。
     * @param {number} chatId
     * @param {object} task 任务记录 {taskId, sessionId?, mode}
     * @param {string} prompt
     * @param {string} [imagePath] 可选图片/文档本地路径（-i 注入）
     */
    function launchCodexTask(chatId, task, prompt, imagePath = "") {
        return new Promise((resolve) => {
            const taskId = task.taskId;
            const doneFile = join(CODEX_STATE_DIR, `${taskId}.done.txt`);
            const workDir = CODEX_AGENTS_DIR;

            const tasks = loadCodexTasks();
            tasks[taskId] = {
                chatId: Number(chatId),
                mode: task.mode || "new",
                sessionId: task.sessionId || "",
                status: "running",
                prompt: String(prompt).slice(0, 200),
                startedAt: Date.now(),
                doneFile,
                model: ctx.codexModel || "",
            };
            saveCodexTasks(tasks);

            let cmdArgs;
            const basePrompt = `${prompt}`;
            const modelArg = ctx.codexModel ? ["-m", ctx.codexModel] : [];
            const imageArg = imagePath ? ["-i", imagePath] : [];
            if (task.mode === "resume" && task.sessionId) {
                cmdArgs = ["exec", "resume", task.sessionId, basePrompt, ...modelArg, ...imageArg, "-o", doneFile, "--skip-git-repo-check"];
            } else {
                cmdArgs = ["exec", basePrompt, ...modelArg, ...imageArg, "-o", doneFile, "--skip-git-repo-check"];
            }

            const child = spawn("codex", cmdArgs, {
                cwd: workDir,
                env: { ...process.env, HOME: process.env.HOME },
                stdio: ["ignore", "pipe", "pipe"],
            });
            codexRunningPids.set(taskId, child);

            let lastOutputAt = Date.now();
            let stdoutBuf = "";
            let stderrBuf = "";

            const stuckCheck = setInterval(() => {
                if (Date.now() - lastOutputAt > CODEX_STUCK_MS && child.exitCode === null) {
                    const cur = loadCodexTasks();
                    const t = cur[taskId];
                    if (t && t.status === "running") {
                        t.status = "stuck";
                        t.stuckAt = Date.now();
                        saveCodexTasks(cur);
                        ctx.enqueue(() =>
                            ctx.sendMessage(chatId, `⚠️ <b>Codex 任务可能卡住</b>（${CODEX_STUCK_MS/60000} 分钟无输出）\n\n任务：${escapeHtml(String(prompt).slice(0,80))}\n\n小白已通知主人，可 /codex progress 查看。`, "HTML")
                        ).catch(() => {});
                    }
                }
            }, 60000);

            child.stdout.on("data", (d) => {
                lastOutputAt = Date.now();
                stdoutBuf += d.toString();
            });
            child.stderr.on("data", (d) => {
                lastOutputAt = Date.now();
                stderrBuf += d.toString();
            });

            const timeoutCheck = setInterval(() => {
                if (child.exitCode === null && Date.now() - (tasks[taskId]?.startedAt || 0) > CODEX_TIMEOUT_MS) {
                    // 超时：先优雅终止；已发过 TERM 仍存活则强杀（必停兜底）
                    if (child.codexTermSent) {
                        try { child.kill("SIGKILL"); } catch (_) {}
                    } else {
                        child.codexTermSent = true;
                        try { child.kill("SIGTERM"); } catch (_) {}
                    }
                }
            }, 30000);

            child.on("close", (code) => {
                clearInterval(stuckCheck);
                clearInterval(timeoutCheck);
                const cur = loadCodexTasks();
                const t = cur[taskId] || {};
                // 已被主动停止（cancelled）时不覆盖状态；否则按退出码判定
                if (t.status !== "cancelled") {
                    t.status = code === 0 ? "completed" : "failed";
                }
                t.exitCode = code;
                t.finishedAt = Date.now();
                t.stdoutTail = stdoutBuf.slice(-1500);
                t.stderrTail = stderrBuf.slice(-500);
                saveCodexTasks(cur);
                codexRunningPids.delete(taskId);

                let output = "";
                try {
                    if (existsSync(doneFile)) output = readFileSync(doneFile, "utf-8");
                } catch (_) {}
                if (!output && stdoutBuf) output = stdoutBuf.slice(-1500);

                const statusEmoji = code === 0 ? "✅" : "❌";
                ctx.enqueue(async () => {
                    try {
                        const body = output?.trim() || `（Codex 无输出，exit=${code}）`;
                        if (typeof ctx.sendFormattedMessage === "function") {
                            await ctx.sendFormattedMessage(chatId, body);
                        } else {
                            await ctx.sendMessage(chatId, body, "HTML");
                        }
                    } catch (err) {
                        await ctx.sendMessage(chatId, `${statusEmoji} Codex 汇报失败: ${err.message}`, "HTML");
                    }
                }).catch(() => {});

                resolve({ ok: true, taskId, code });
                drainCodexPendingQueue();
            });

            child.on("error", (err) => {
                clearInterval(stuckCheck);
                clearInterval(timeoutCheck);
                const cur = loadCodexTasks();
                const t = cur[taskId] || {};
                t.status = "failed";
                t.error = err.message;
                saveCodexTasks(cur);
                codexRunningPids.delete(taskId);
                ctx.enqueue(() =>
                    ctx.sendMessage(chatId, `❌ <b>Codex 启动失败</b>: ${escapeHtml(err.message)}`, "HTML")
                ).catch(() => {});
                resolve({ ok: false, taskId, error: err.message });
                drainCodexPendingQueue();
            });
        });
    }

    /** 任务结束后消费队列：有排队指令则自动执行下一条（FIFO）。 */
    function drainCodexPendingQueue() {
        if (codexPendingQueue.length === 0) return;
        const item = codexPendingQueue.shift();
        const task = item.task;
        if (task.sessionId) {
            const cur = loadCodexTasks();
            const hasRunning = Object.values(cur).some((t) => t.sessionId === task.sessionId && t.status === "running");
            if (hasRunning) {
                codexPendingQueue.unshift(item);
                return;
            }
        }
        // 开始处理排队指令时，给对应消息加 🤔 反应（与首次指令一致）
        if (item.messageId) {
            ctx.setMessageReaction(item.chatId, item.messageId, "🤔").catch(() => {});
        }
        launchCodexTask(item.chatId, task, item.prompt, item.imagePath);
    }

    /** 停止当前运行中的 Codex 任务（kill 进程 + 标记取消） */
    async function stopRunningCodexTask(chatId) {
        const cur = loadCodexTasks();
        const running = Object.entries(cur).filter(([, t]) => t.status === "running");
        if (running.length === 0) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚪ 当前没有运行中的 Codex 任务。", "HTML"));
            return;
        }
        for (const [taskId, t] of running) {
            const child = codexRunningPids.get(taskId);
            if (child && child.exitCode === null) {
                // 优雅终止（SIGTERM）：让 codex exec 有机会收尾，resume 更稳
                try { child.kill("SIGTERM"); } catch (_) {}
                // 兜底：5 秒后仍存活则强杀，保证一定能停
                setTimeout(() => {
                    if (child.exitCode === null) {
                        try { child.kill("SIGKILL"); } catch (_) {}
                    }
                }, 5000);
            }
            t.status = "cancelled";
            t.finishedAt = Date.now();
            saveCodexTasks(cur);
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, `✋ <b>已停止任务</b>\n\n任务：${escapeHtml(String(t.prompt || "").slice(0, 60))}\n\n排队中的指令将继续执行。`, "HTML")
            );
        }
    }

    /** 取消所有排队中的指令（不执行，供用户调整后重发） */
    async function cancelQueuedCodexTasks(chatId) {
        if (codexPendingQueue.length === 0) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚪ 当前没有排队中的指令。", "HTML"));
            return;
        }
        const n = codexPendingQueue.length;
        codexPendingQueue.length = 0;
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId, `🗑 <b>已取消 ${n} 条排队指令</b>\n\n可调整后再发送。`, "HTML")
        );
    }

    async function handleCodexNew(chatId) {
        clearAwaitingCodex();
        const timer = setTimeout(() => clearAwaitingCodex(true), CODEX_WAIT_MS);
        ctx.awaitingCodex = { chatId: Number(chatId), mode: "new", timer, startedAt: Date.now() };
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId,
                "📝 <b>Codex 新对话</b>\n\n请输入任务内容（将新建 Codex 会话执行）。\n\n• 完成后自动汇报结果\n• 可连续发消息继续对话\n• <code>/codex exit</code> 退出桥接\n• <code>/cancel</code> 取消",
                "HTML")
        );
    }

    /** 视觉宽度：CJK/全角/带圈数字/emoji 记 2，其余记 1 */
    function visualWidth(s) {
        let w = 0;
        for (const ch of String(s)) {
            const c = ch.codePointAt(0);
            if ((c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
                (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
                (c >= 0x2460 && c <= 0x24FF) || // 带圈数字 ①-⑩ Enclosed Alphanumerics
                (c >= 0xFE10 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) ||
                (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x1F000 && c <= 0x1FAFF) ||
                (c >= 0x20000 && c <= 0x3FFFD)) w += 2;
            else w += 1;
        }
        return w;
    }

    /** 按视觉宽度截断，超长结尾加省略号 … */
    function truncateVisual(s, maxW) {
        const str = String(s);
        let w = 0, out = "";
        for (const ch of str) {
            const cw = visualWidth(ch);
            if (w + cw > maxW) break;
            out += ch;
            w += cw;
        }
        return out.length < str.length ? out + "…" : out;
    }

    /** 用空格填充到固定视觉宽度（实现左侧对齐）：全角优先，差 1 用半角补 */
    function padVisual(s, targetW) {
        let out = String(s);
        let w = visualWidth(out);
        while (targetW - w >= 2) { out += "　"; w += 2; }
        while (w < targetW) { out += " "; w += 1; }
        return out;
    }

    /** 列出可续接的 Codex 历史会话（session_id 去重 + 序号①-⑩ + 视觉等宽对齐 + 注入标题过滤） */
    async function handleCodexResumeMenu(chatId) {
        try {
            const CELL_W = 50;
            const gs = JSON.parse(readFileSync(join(process.env.HOME || "~", ".codex/.codex-global-state.json"), "utf-8"));
            const titles = gs?.["electron-persisted-atom-state"]?.["thread-descriptions-v1"] || {};
            const files = execFileSync("find", [CODEX_SESSION_DIR, "-name", "*.jsonl", "-type", "f"], { encoding: "utf-8" })
                .trim().split("\n").filter(Boolean)
                .sort((a, b) => {
                    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; }
                    catch (_) { return 0; }
                });
            const seen = new Map();
            for (const f of files) {
                try {
                    const lines = readFileSync(f, "utf-8").split("\n");
                    let sid = "";
                    let threadId = "";
                    for (const l of lines.slice(0, 3)) {
                        try {
                            const d = JSON.parse(l);
                            if (d.type === "session_meta") {
                                if (d.payload?.session_id) sid = d.payload.session_id;
                                if (d.payload?.id) threadId = d.payload.id;
                                break;
                            }
                        } catch (_) {}
                    }
                    if (!sid) continue;
                    if (seen.has(sid)) continue;
                    seen.set(sid, f);
                } catch (_) {}
            }
            const buttons = [];
            for (const [key, f] of seen) {
                try {
                    const lines = readFileSync(f, "utf-8").split("\n");
                    let sid = "";
                    let threadId = "";
                    for (const l of lines.slice(0, 3)) {
                        try {
                            const d = JSON.parse(l);
                            if (d.type === "session_meta") {
                                if (d.payload?.session_id) sid = d.payload.session_id;
                                if (d.payload?.id) threadId = d.payload.id;
                                break;
                            }
                        } catch (_) {}
                    }
                    let title = titles[threadId] || titles[sid] || "";
                    if (!title) {
                        for (const l of lines.slice(0, 200)) {
                            try {
                                const d = JSON.parse(l);
                                if (d.type === "response_item" && d.payload?.type === "message" && d.payload?.role === "user") {
                                    const content = d.payload?.content || [];
                                    const t = content.map((c) => c.text || "").join("").trim();
                                    if (!t) continue;
                                    if (/^(# AGENTS\.md|<recommended_plugins>|<INSTRUCTIONS)/.test(t)) continue;
                                    if (/^<environment_context>/.test(t)) continue;
                                    if (/^The following is (the|a)/i.test(t)) continue;
                                    if (/^#? ?Files? mentioned by the user/i.test(t)) continue;
                                    const cleanT = t
                                        .replace(/<\/?image[^>]*>/gi, "")
                                        .replace(/<\/?file[^>]*>/gi, "")
                                        .replace(/image content omitted because it could not be processed/gi, "")
                                        .trim();
                                    if (!cleanT) continue;
                                    title = cleanT.replace(/\s+/g, " ").slice(0, 45);
                                    break;
                                }
                            } catch (_) {}
                        }
                    }
                    const label = title || sid.slice(0, 10);
                    const sidHash = getCodexSidHash(sid);
                    codexTitleCache.set(sid, title || "");
                    buttons.push([{ text: truncateVisual(label, CELL_W - 4), callback_data: `codex:resume:${sidHash}` }]);
                } catch (_) {}
            }
            buttons.splice(10);
            const nums = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
            buttons.forEach((row, i) => {
                row[0].text = padVisual(`${nums[i] || (i + 1)} ${row[0].text}`, CELL_W);
            });
            if (!buttons.length) {
                buttons.push([{ text: "（无历史会话）", callback_data: "codex:none" }]);
            }
            const keyboard = { inline_keyboard: buttons };
            await ctx.enqueue(() =>
                ctx.sendMessageWithKeyboard(chatId,
                    "📂 <b>继续 Codex 对话</b>\n\n选择要续接的历史会话：", keyboard, "HTML")
            );
        } catch (err) {
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, `❌ 列出历史会话失败: ${escapeHtml(err.message)}`, "HTML")
            );
        }
    }

    /** 展示 Codex 任务进度（最近 10 条；运行中 ⏳ / 完成 ✅ / 失败 ❌ / 卡住 ⚠️ / 已停止 ✋） */
    async function handleCodexProgress(chatId) {
        const tasks = loadCodexTasks();
        const ids = Object.keys(tasks).sort((a, b) => (tasks[b].startedAt || 0) - (tasks[a].startedAt || 0));
        if (!ids.length) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "📊 <b>Codex 任务进度</b>\n\n暂无任务记录。", "HTML"));
            return;
        }
        function fmtDur(ms) {
            if (ms < 60_000) return "不到 1 分钟";
            const totalMin = Math.floor(ms / 60_000);
            if (totalMin < 60) return `${totalMin} 分钟`;
            const h = Math.floor(totalMin / 60);
            const rm = totalMin % 60;
            if (h < 24) return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
            const d = Math.floor(h / 24);
            const rh = h % 24;
            return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
        }
        const stMap = {
            running:  { e: "⏳", t: "运行中" },
            completed: { e: "✅", t: "完成" },
            failed:   { e: "❌", t: "失败" },
            stuck:    { e: "⚠️", t: "卡住" },
            cancelled: { e: "✋", t: "已停止" },
        };
        const lines = ids.slice(0, 10).map((id, i) => {
            const t = tasks[id];
            const st = stMap[t.status] || { e: "❓", t: t.status };
            const ref = t.finishedAt || t.startedAt;
            const rel = ref
                ? (t.status === "running" ? `已进行 ${fmtDur(Date.now() - ref)}` : `${fmtDur(Date.now() - ref)} 前`)
                : "";
            const title = escapeHtml(String(t.prompt || "").slice(0, 30));
            const tag = `<b>${st.e} ${st.t}</b>`;
            return `• <b>${title}</b>\n  ${tag}${rel ? ` · <i>${rel}</i>` : ""}`;
        }).join("\n");
        const total = ids.length;
        const shown = Math.min(10, total);
        const header = `📊 <b>Codex 任务进度</b>\n\n`;
        const footer = total > shown ? `\n\n<i>仅显示最近 ${shown} 条 / 共 ${total} 条</i>` : "";
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId, `${header}${lines}${footer}`, "HTML")
        );
    }

    async function handleCodexCommand(chatId, argText = "") {
        if (!existsSync(CODEX_AGENTS_DIR)) {
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, "⚠️ Codex agents 目录不存在，无法确定 workdir。仍可尝试运行。", "HTML")
            );
        }
        // 显式参数：/codex <prompt> → 直接新对话执行
        if (argText && argText.trim() && !argText.trim().startsWith("/")) {
            if (await isCodexDesktopRunning()) {
                const kb = {
                    inline_keyboard: [[
                        { text: "🖥 关闭桌面", callback_data: "codex:desktop" },
                    ]],
                };
                await ctx.enqueue(() =>
                    ctx.sendMessageWithKeyboard(
                        chatId,
                        `🖥 <b>桌面端正在运行</b>\n\nChatGPT/Codex 桌面端开着时，CLI 无法正常响应。\n请先关闭桌面再继续：`,
                        kb,
                        "HTML"
                    )
                );
                return;
            }
            const task = { taskId: codexTaskId(), mode: "new" };
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, "⏳ <b>Codex 任务已启动</b>，完成后自动汇报。", "HTML")
            );
            launchCodexTask(chatId, task, argText.trim());
            return;
        }
        // 主菜单（六子命令）
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "💬 新建对话", callback_data: "codex:new" },
                    { text: "🎛 切换模型", callback_data: "codex:model" },
                ],
                [
                    { text: "📂 继续对话", callback_data: "codex:resume" },
                    { text: "📊 查看进度", callback_data: "codex:progress" },
                ],
                [
                    { text: "🖥 关闭桌面", callback_data: "codex:desktop" },
                    { text: "🚪 退出桥接", callback_data: "codex:exit" },
                ],
            ],
        };
        await ctx.enqueue(() =>
            ctx.sendMessageWithKeyboard(chatId, "🤖 <b>Codex 子命令</b>\n\n选择操作：", keyboard, "HTML")
        );
    }

    /** 展示 Codex 模型选择菜单（3 列；排除 opencodex 禁用模型；当前对话已切换则打勾） */
    async function handleCodexModel(chatId) {
        let defaultModel = "";
        try {
            const cfg = readFileSync(join(process.env.HOME || "~", ".codex/config.toml"), "utf-8");
            const m = cfg.match(/^model\s*=\s*"([^"]+)"/m);
            if (m) defaultModel = m[1];
        } catch (_) {}
        const current = ctx.codexModel || defaultModel;
        let models = [];
        try {
            const cat = JSON.parse(readFileSync(join(process.env.HOME || "~", ".codex/opencodex-catalog.json"), "utf-8"));
            if (Array.isArray(cat.models)) {
                models = cat.models.map((m) => m.slug || "").filter(Boolean);
            }
            try {
                const ocx = JSON.parse(readFileSync(join(process.env.HOME || "~", ".opencodex/config.json"), "utf-8"));
                const disabled = new Set(ocx.disabledModels || []);
                models = models.filter((s) => !disabled.has(s));
            } catch (_) {}
        } catch (_) {}
        if (!models.length) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚠️ 无法读取 codex 模型列表。", "HTML"));
            return;
        }
        const rows = [];
        for (let i = 0; i < models.length; i += 3) {
            const row = [];
            for (let j = i; j < Math.min(i + 3, models.length); j++) {
                const slug = models[j];
                const mark = slug === current ? " ✅" : "";
                const hash = getCodexModelHash(slug);
                row.push({ text: `${slug.split("/").pop()}${mark}`, callback_data: `codex:model:${hash}` });
            }
            rows.push(row);
        }
        const keyboard = { inline_keyboard: rows };
        const cur = current || "未知";
        const scope = ctx.codexModel ? "（当前对话已切换）" : "（默认）";
        await ctx.enqueue(() =>
            ctx.sendMessageWithKeyboard(chatId,
                `🎛 <b>Codex 模型</b>\n\n当前：<code>${escapeHtml(cur)}</code> ${scope}\n\n选择要切换的模型（仅当前对话生效）：`,
                keyboard, "HTML")
        );
    }

    async function handleCodexCallback(callbackId, data, chatId) {
        if (data === "codex:new") {
            if (await isCodexDesktopRunning()) {
                await ctx.answerCallbackQuery(callbackId, "桌面端运行中").catch(() => {});
                const kb = { inline_keyboard: [[{ text: "🖥 关闭桌面", callback_data: "codex:desktop" }]] };
                await ctx.enqueue(() =>
                    ctx.sendMessageWithKeyboard(
                        chatId,
                        `🖥 <b>桌面端正在运行</b>\n\nChatGPT/Codex 桌面端开着时，CLI 无法正常响应。\n请先关闭桌面再继续：`,
                        kb,
                        "HTML"
                    )
                );
                return;
            }
            await ctx.answerCallbackQuery(callbackId, "新对话").catch(() => {});
            await handleCodexNew(chatId);
        } else if (data === "codex:resume") {
            if (await isCodexDesktopRunning()) {
                await ctx.answerCallbackQuery(callbackId, "桌面端运行中").catch(() => {});
                const kb = { inline_keyboard: [[{ text: "🖥 关闭桌面", callback_data: "codex:desktop" }]] };
                await ctx.enqueue(() =>
                    ctx.sendMessageWithKeyboard(
                        chatId,
                        `🖥 <b>桌面端正在运行</b>\n\nChatGPT/Codex 桌面端开着时，CLI 无法正常响应。\n请先关闭桌面再继续：`,
                        kb,
                        "HTML"
                    )
                );
                return;
            }
            await ctx.answerCallbackQuery(callbackId, "选择会话").catch(() => {});
            await handleCodexResumeMenu(chatId);
        } else if (data === "codex:desktop") {
            if (!(await isCodexDesktopRunning())) {
                await ctx.answerCallbackQuery(callbackId, "桌面端未运行").catch(() => {});
                await ctx.enqueue(() =>
                    ctx.sendMessage(chatId, "⚪ 桌面端（ChatGPT/Codex）未运行，无需关闭。", "HTML")
                );
                return;
            }
            await ctx.answerCallbackQuery(callbackId, "正在关闭桌面...").catch(() => {});
            await ctx.enqueue(() => ctx.sendMessage(chatId, "🖥 正在关闭桌面，请稍候…", "HTML"));
            const { msg } = await closeCodexDesktop();
            await ctx.enqueue(() => ctx.sendMessage(chatId, msg, "HTML"));
        } else if (data === "codex:stop") {
            await ctx.answerCallbackQuery(callbackId, "正在停止任务...").catch(() => {});
            await stopRunningCodexTask(chatId);
        } else if (data === "codex:cancelqueued") {
            await ctx.answerCallbackQuery(callbackId, "正在取消排队...").catch(() => {});
            await cancelQueuedCodexTasks(chatId);
        } else if (data === "codex:progress") {
            await ctx.answerCallbackQuery(callbackId, "查看进度").catch(() => {});
            await handleCodexProgress(chatId);
        } else if (data === "codex:model") {
            await ctx.answerCallbackQuery(callbackId, "切换模型").catch(() => {});
            await handleCodexModel(chatId);
        } else if (data.startsWith("codex:model:")) {
            const hash = data.replace("codex:model:", "");
            const slug = resolveCodexModel(hash);
            if (!slug) {
                await ctx.answerCallbackQuery(callbackId, "模型已失效，请重新选择").catch(() => {});
                return;
            }
            ctx.codexModel = slug;
            if (ctx.awaitingCodex) {
                clearTimeout(ctx.awaitingCodex.timer);
                ctx.awaitingCodex.timer = setTimeout(() => clearAwaitingCodex(true), CODEX_WAIT_MS);
            }
            await ctx.answerCallbackQuery(callbackId, "已切换").catch(() => {});
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId,
                    `🎛 <b>Codex 模型已切换</b>\n\n<code>${escapeHtml(slug)}</code>\n\n<b>仅当前对话生效</b>，后续任务将使用该模型。\n\n• 退出桥接（<code>/codex exit</code>）后恢复默认。`,
                    "HTML")
            );
        } else if (data === "codex:exit") {
            clearAwaitingCodex();
            ctx.codexModel = "";
            await ctx.answerCallbackQuery(callbackId, "已退出桥接").catch(() => {});
            await ctx.enqueue(() => ctx.sendMessage(chatId, "🚪 已退出 Codex 连续对话桥接。", "HTML"));
        } else if (data.startsWith("codex:resume:")) {
            const sidHash = data.replace("codex:resume:", "");
            const sid = resolveCodexSid(sidHash);
            if (!sid) {
                await ctx.answerCallbackQuery(callbackId, "会话已失效，请重新 /codex").catch(() => {});
                return;
            }
            clearAwaitingCodex();
            const timer = setTimeout(() => clearAwaitingCodex(true), CODEX_WAIT_MS);
            ctx.awaitingCodex = { chatId: Number(chatId), mode: "resume", sessionId: sid, timer, startedAt: Date.now() };
            await ctx.answerCallbackQuery(callbackId, "已选会话").catch(() => {});
            const sessTitle = resolveCodexTitle(sid) || sid.slice(0, 10);
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId,
                    `📂 <b>继续 Codex 会话</b>\n\n会话：<b>${escapeHtml(sessTitle)}</b>\n\n请输入要续接的内容。\n\n• <code>/codex exit</code> 退出\n• <code>/cancel</code> 取消`,
                    "HTML")
            );
        } else {
            await ctx.answerCallbackQuery(callbackId, "无效操作").catch(() => {});
        }
    }

    /** 消费 Codex 连续对话输入（支持图片/文档附件 → imagePath 注入 -i） */
    async function tryConsumeCodexInput(chatId, text, messageId, imagePath = "") {
        const pending = ctx.awaitingCodex;
        if (!pending) return false;
        if (Number(pending.chatId) !== Number(chatId)) return false;

        const raw = String(text ?? "").trim();
        if (raw.startsWith("/")) {
            const base = raw.split(/\s+/)[0].split("@")[0].toLowerCase();
            if (base === "/cancel" || base === "/stop" || base === "/codex" && raw.includes("exit")) {
                clearAwaitingCodex();
                await ctx.enqueue(() => ctx.sendMessage(chatId, "🚪 已退出 Codex 模式。", "HTML"));
                return true;
            }
            clearAwaitingCodex();
            return false;
        }
        if (!raw && !imagePath) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚠️ 请输入文字内容。取消：/cancel", "HTML"));
            return true;
        }
        const task = { taskId: codexTaskId(), mode: pending.mode, sessionId: pending.sessionId };
        // 并发保护：同一会话已有 running 任务时，入队（不丢消息），任务结束后自动执行
        if (task.sessionId) {
            const cur = loadCodexTasks();
            const hasRunning = Object.values(cur).some((t) => t.sessionId === task.sessionId && t.status === "running");
            if (hasRunning) {
                codexPendingQueue.push({ chatId: Number(chatId), task, prompt: raw, imagePath, messageId, queuedAt: Date.now() });
                const kb = {
                    inline_keyboard: [[
                        { text: "✋ 停止任务", callback_data: "codex:stop" },
                        { text: "🗑 取消排队", callback_data: "codex:cancelqueued" },
                    ]],
                };
                await ctx.enqueue(() =>
                    ctx.sendMessageWithKeyboard(
                        chatId,
                        `⏳ <b>已排队，任务结束后自动执行</b>\n\n指令：<i>${escapeHtml(String(raw).slice(0, 60))}</i>`,
                        kb,
                        "HTML"
                    )
                ).catch(() => {});
                return true;
            }
        }
        clearTimeout(pending.timer);
        const newTimer = setTimeout(() => clearAwaitingCodex(true), CODEX_WAIT_MS);
        ctx.awaitingCodex = { ...pending, timer: newTimer };

        if (messageId) {
            ctx.setMessageReaction(chatId, messageId, "🤔").catch(() => {});
        }
        const effectivePrompt = raw || "请分析这张图片。";
        launchCodexTask(chatId, task, effectivePrompt, imagePath);
        return true;
    }

    return {
        handleCodexCommand,
        handleCodexCallback,
        tryConsumeCodexInput,
        handleCodexProgress,
    };
}
