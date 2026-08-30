// claude-commands.mjs — /claude 子命令系统（独立模块）
// Claude Code CLI 桥接：新建/继续/切换模型/查看进度/停止任务/取消排队/退出桥接
// 支持通过 OpenCodex (:10100) / CLI Proxy (:8317) 代理驱动 Claude Code。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { escapeHtml } from "./markdown-tg.mjs";
import { loadModelsConfig } from "./byok-providers.mjs";

/** 读取本机配置 */
function loadBridgeConfig() {
    const home = process.env.HOME || "";
    try {
        const cfg = loadModelsConfig();
        const paths = cfg.paths || {};
        const defaults = cfg.defaults || {};
        return {
            claude: {
                workDir: paths.claudeWorkDir || home,
                sessionDir: (paths.claudeSessionDir ? (paths.claudeSessionDir.endsWith("/sessions") ? dirname(paths.claudeSessionDir) : paths.claudeSessionDir) : `${home}/.claude`),
                stateDir: paths.claudeStateDir || "/tmp/telegram-bridge/claude",
                waitTimeoutMs: Number(defaults.claudeWaitTimeoutMs) || (60 * 60 * 1000),
                defaultModel: String(defaults.claudeDefaultModel || "cliproxy/gemini-flash").trim(),
            },
            launchAgentLabel: cfg.launchAgentLabel || "com.copilot-telegram-bridge",
        };
    } catch (err) {
        console.error("telegram-bridge: loadBridgeConfig failed for claude, use defaults:", err.message);
    }
    return {
        claude: {
            workDir: home,
            sessionDir: `${home}/.claude`,
            stateDir: "/tmp/telegram-bridge/claude",
            waitTimeoutMs: 60 * 60 * 1000,
            defaultModel: "cliproxy/gemini-flash",
        },
        launchAgentLabel: "com.copilot-telegram-bridge",
    };
}

/**
 * 提取 OpenCodex 的环境变量（自动读取 ~/.opencodex/claude-env.sh）
 */
function getOpencodexEnv() {
    const home = process.env.HOME || "";
    const envFile = join(home, ".opencodex", "claude-env.sh");
    const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:10100",
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || "opencodex-proxy",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "829800",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "cliproxy/gemini-flash[1m]",
        ANTHROPIC_SMALL_FAST_MODEL: "cliproxy/gemini-flash[1m]",
    };

    if (existsSync(envFile)) {
        try {
            const content = readFileSync(envFile, "utf-8");
            for (const line of content.split("\n")) {
                const match = line.match(/^export\s+([A-Za-z0-9_]+)=['"]?([^'"]+)['"]?/);
                if (match) {
                    const [, key, val] = match;
                    if (!process.env[key]) {
                        env[key] = val;
                    }
                }
            }
        } catch (_) {}
    }
    return env;
}

/**
 * Claude 子命令系统（挂到 ctx）。
 * @param {any} ctx Bot instance context
 * @returns {{handleClaudeCommand, handleClaudeCallback, tryConsumeClaudeInput, handleClaudeProgress}}
 */
export function attachClaudeCommands(ctx) {
    const bridgeCfg = loadBridgeConfig();
    const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;      // 单任务超时 10 分钟
    const CLAUDE_STUCK_MS = 5 * 60 * 1000;         // 5 分钟无新输出判定卡住
    const CLAUDE_WAIT_MS = Number(bridgeCfg.claude?.waitTimeoutMs) || (60 * 60 * 1000);
    const CLAUDE_STATE_DIR = bridgeCfg.claude.stateDir;
    const CLAUDE_WORK_DIR = bridgeCfg.claude.workDir;
    const CLAUDE_DIR = bridgeCfg.claude.sessionDir || join(process.env.HOME || "", ".claude");
    const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, "projects");
    const CLAUDE_HIST_FILE = join(CLAUDE_DIR, "history.jsonl");

    // Claude 会话 id 哈希映射（resume 的 sid 是 UUID）
    const claudeSidCache = new Map();
    function getClaudeSidHash(sid) {
        const h = createHash("sha256").update(sid).digest("hex").slice(0, 12);
        claudeSidCache.set(h, sid);
        return h;
    }
    function resolveClaudeSid(hash) {
        return claudeSidCache.get(hash) || "";
    }

    // Claude 会话 sid → 标题 缓存
    const claudeTitleCache = new Map();
    function resolveClaudeTitle(sid) {
        return claudeTitleCache.get(sid) || "";
    }

    // Claude 模型 slug 哈希映射
    const claudeModelCache = new Map();
    function getClaudeModelHash(slug) {
        const h = createHash("sha256").update(`c:${slug}`).digest("hex").slice(0, 12);
        claudeModelCache.set(h, slug);
        return h;
    }
    function resolveClaudeModel(hash) {
        return claudeModelCache.get(hash) || "";
    }

    /** 排队待执行的 Claude 指令 */
    const claudePendingQueue = [];
    /** 运行中任务 → child 句柄 */
    const claudeRunningPids = new Map();

    function claudeStateFile() { return join(CLAUDE_STATE_DIR, "tasks.json"); }

    function loadClaudeTasks() {
        try {
            if (!existsSync(claudeStateFile())) return {};
            return JSON.parse(readFileSync(claudeStateFile(), "utf-8"));
        } catch (_) { return {}; }
    }

    function saveClaudeTasks(tasks) {
        try {
            mkdirSync(CLAUDE_STATE_DIR, { recursive: true });
            const ids = Object.keys(tasks).sort((a, b) => (tasks[b].startedAt || 0) - (tasks[a].startedAt || 0));
            for (const id of ids.slice(50)) delete tasks[id];
            writeFileSync(claudeStateFile(), JSON.stringify(tasks, null, 2), "utf-8");
        } catch (err) {
            console.error("telegram-bridge: saveClaudeTasks failed:", err.message);
        }
    }

    function claudeTaskId() {
        return `claude-${Date.now()}`;
    }

    /** 清除 ANSI 颜色与特殊调试日志 */
    function cleanAnsi(str) {
        // eslint-disable-next-line no-control-regex
        let s = String(str || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
        // 过滤 Claude Code 的内部模型警告行，避免污染最终输出
        s = s.replace(/^\[claude-code:[^\]]+\][^\n]*\n?/gm, "");
    return s;
}

    /**
     * 在 Claude 数据目录中查找指定时间戳后最新生成的 Session ID
     */
    function findLatestClaudeSessionId(sinceTimestamp = 0) {
        let latestSid = "";
        let latestTime = sinceTimestamp;

        // 1. Check history.jsonl
        if (existsSync(CLAUDE_HIST_FILE)) {
            try {
                const lines = readFileSync(CLAUDE_HIST_FILE, "utf-8").trim().split("\n");
                for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
                    try {
                        const d = JSON.parse(lines[i]);
                        const ts = Number(d.timestamp) || 0;
                        if (d.sessionId && ts >= latestTime) {
                            latestTime = ts;
                            latestSid = d.sessionId;
                            break;
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // 2. Check projects *.jsonl
        if (existsSync(CLAUDE_PROJECTS_DIR)) {
            try {
                const projDirs = readdirSync(CLAUDE_PROJECTS_DIR);
                for (const pDir of projDirs) {
                    const fullPDir = join(CLAUDE_PROJECTS_DIR, pDir);
                    try {
                        if (!statSync(fullPDir).isDirectory()) continue;
                        const files = readdirSync(fullPDir).filter(f => f.endsWith(".jsonl"));
                        for (const f of files) {
                            const fullPath = join(fullPDir, f);
                            const mtime = statSync(fullPath).mtimeMs;
                            if (mtime >= latestTime) {
                                latestTime = mtime;
                                latestSid = f.replace(/\.jsonl$/, "");
                            }
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }
        return latestSid;
    }

    /** 智能分析 Claude CLI 失败原因 */
    function parseClaudeError({ code, stdout, stderr, timedOut, killed, mode, sessionId }) {
        const rawErr = cleanAnsi(stderr).trim();
        const rawOut = cleanAnsi(stdout).trim();
        const combined = `${rawErr}\n${rawOut}`;

        let reason = "";
        let suggestion = "";

        if (timedOut) {
            reason = "⏱ 任务执行超时（超过 10 分钟未完成）";
            suggestion = "模型生成耗时过长或上游响应挂起，可尝试缩小输入或切换模型。";
        } else if (killed) {
            reason = "✋ 任务被手动停止或系统信号终止";
        } else if (code === 137) {
            reason = "💥 进程被系统强制终止（OOM 内存不足或 SIGKILL）";
            suggestion = "单次对话历史可能过大，建议 /claude 新建对话。";
        } else if (code === 143) {
            reason = "✋ 进程收到 SIGTERM 终止信号";
        } else if (/ECONNREFUSED|connection refused/i.test(combined)) {
            reason = "🔌 本地 OpenCodex/代理服务未启动（127.0.0.1:10100 拒绝连接）";
            suggestion = "请确认 OpenCodex (:10100) 或 CLI Proxy (:8317) 服务已正常运行。";
        } else if (/401|Unauthorized|invalid.*key|authentication failed|not logged in/i.test(combined)) {
            reason = "🔑 上游认证失败（Token/API Key 无效或未登录）";
            suggestion = "请检查 ~/.opencodex/ 或 ~/.cli-proxy-api/ 中的认证凭据。";
        } else if (/429|rate.*limit|quota.*exceeded|too many requests/i.test(combined)) {
            reason = "⏳ 触发上游速率限制或配额耗尽 (429 Too Many Requests)";
            suggestion = "请稍后重试，或通过 /claude 切换其他可用模型。";
        } else if (/overloaded|529|503|Service Unavailable/i.test(combined)) {
            reason = "☁️ 上游服务过载或暂时不可用 (503/529 Overloaded)";
            suggestion = "上游服务器暂时繁忙，请稍后重试或切换模型。";
        } else if (/model.*not found|unsupported model|unknown model/i.test(combined)) {
            reason = "🎛 所选模型不存在或 OpenCodex 未挂载";
            suggestion = "建议使用 /claude 切换至当前可用的模型。";
        } else if (/context.*(limit|length|exceeded|too long)|maximum context/i.test(combined)) {
            reason = "📏 提示词或上下文超限 (Context Window Exceeded)";
            suggestion = "当前会话上下文过长，建议使用 /claude 发起新对话。";
        } else if (/session.*not found|no session/i.test(combined)) {
            reason = "📂 历史会话未找到或已过期";
            suggestion = "该会话已无法继续，请通过 /claude 新建对话。";
        } else if (/502|504|Bad Gateway|Gateway Timeout/i.test(combined)) {
            reason = "☁️ 上游网关超时或网络异常 (50x)";
            suggestion = "请检查本地网络与代理（Stash）连接状态。";
        }

        let errorDetail = "";
        if (rawErr) {
            const errLines = rawErr.split("\n").map((l) => l.trim()).filter(Boolean);
            const meaningful = errLines.filter((l) => !l.startsWith("info:") && !l.startsWith("debug:") && !l.startsWith("[claude-code:"));
            errorDetail = (meaningful.length ? meaningful.slice(-4) : errLines.slice(-3)).join("\n");
        }

        return {
            reason: reason || (errorDetail ? `🔴 ${errorDetail}` : `🔴 执行异常 (退出码 exit=${code})`),
            detail: errorDetail,
            suggestion,
        };
    }

    function clearAwaitingClaude(notifyTimeout = false) {
        const prev = ctx.awaitingClaude;
        if (!prev) return null;
        if (prev.timer) clearTimeout(prev.timer);
        ctx.awaitingClaude = null;
        if (notifyTimeout) {
            ctx.enqueue(() =>
                ctx.sendMessage(prev.chatId, "⏰ <b>Claude 输入等待超时</b>，已退出桥接。再发 /claude 重新开始。", "HTML")
            ).catch(() => {});
        }
        return prev;
    }

    /**
     * 后台执行 Claude 任务
     */
    function launchClaudeTask(chatId, task, prompt, imagePath = "") {
        return new Promise((resolve) => {
            const taskId = task.taskId;
            const doneFile = join(CLAUDE_STATE_DIR, `${taskId}.done.txt`);
            const workDir = CLAUDE_WORK_DIR;
            const defaultModel = bridgeCfg.claude.defaultModel || "cliproxy/gemini-flash";
            const selectedModel = ctx.claudeModel || defaultModel;

            const tasks = loadClaudeTasks();
            const startedAt = Date.now();
            tasks[taskId] = {
                chatId: Number(chatId),
                mode: task.mode || "new",
                sessionId: task.sessionId || "",
                status: "running",
                prompt: String(prompt).slice(0, 200),
                startedAt,
                doneFile,
                model: selectedModel,
            };
            saveClaudeTasks(tasks);

            let effectivePrompt = prompt;
            if (imagePath) {
                effectivePrompt = `[附件图片路径: ${imagePath}]\n\n${prompt}`;
            }

            const cmdArgs = ["-p", effectivePrompt, "--dangerously-skip-permissions", "--model", selectedModel];
            if (task.mode === "resume" && task.sessionId) {
                cmdArgs.push("--resume", task.sessionId);
            }

            const customEnv = getOpencodexEnv();

            const child = spawn("claude", cmdArgs, {
                cwd: workDir,
                env: customEnv,
                stdio: ["ignore", "pipe", "pipe"],
            });
            claudeRunningPids.set(taskId, child);

            let lastOutputAt = Date.now();
            let stdoutBuf = "";
            let stderrBuf = "";

            const stuckCheck = setInterval(() => {
                if (Date.now() - lastOutputAt > CLAUDE_STUCK_MS && child.exitCode === null) {
                    const cur = loadClaudeTasks();
                    const t = cur[taskId];
                    if (t && t.status === "running") {
                        t.status = "stuck";
                        t.stuckAt = Date.now();
                        saveClaudeTasks(cur);
                        ctx.enqueue(() =>
                            ctx.sendMessage(chatId, `⚠️ <b>Claude 任务可能卡住</b>（${CLAUDE_STUCK_MS/60000} 分钟无输出）\n\n任务：${escapeHtml(String(prompt).slice(0,80))}\n\n小白已通知主人，可 /claude progress 查看。`, "HTML")
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
                if (child.exitCode === null && Date.now() - (tasks[taskId]?.startedAt || 0) > CLAUDE_TIMEOUT_MS) {
                    child.claudeTimedOut = true;
                    if (child.claudeTermSent) {
                        try { child.kill("SIGKILL"); } catch (_) {}
                    } else {
                        child.claudeTermSent = true;
                        try { child.kill("SIGTERM"); } catch (_) {}
                    }
                }
            }, 30000);

            child.on("close", (code) => {
                clearInterval(stuckCheck);
                clearInterval(timeoutCheck);
                const cur = loadClaudeTasks();
                const t = cur[taskId] || {};
                const wasCancelled = t.status === "cancelled";
                if (!wasCancelled) {
                    t.status = code === 0 ? "completed" : "failed";
                }
                t.exitCode = code;
                t.finishedAt = Date.now();
                t.stdoutTail = stdoutBuf.slice(-1500);
                t.stderrTail = stderrBuf.slice(-1500);

                // 自动捕获新会话 ID，并无缝将桥接上下文升级为 resume 模式
                if (code === 0 && (!task.sessionId || task.mode === "new")) {
                    const detectedSid = findLatestClaudeSessionId(startedAt - 2000);
                    if (detectedSid) {
                        t.sessionId = detectedSid;
                        task.sessionId = detectedSid;
                        if (ctx.awaitingClaude && (!ctx.awaitingClaude.sessionId || ctx.awaitingClaude.mode === "new")) {
                            ctx.awaitingClaude.sessionId = detectedSid;
                            ctx.awaitingClaude.mode = "resume";
                        }
                    }
                }

                let output = cleanAnsi(stdoutBuf).trim();

                const diag = code !== 0
                    ? parseClaudeError({
                        code,
                        stdout: stdoutBuf,
                        stderr: stderrBuf,
                        timedOut: child.claudeTimedOut,
                        killed: wasCancelled || child.claudeTermSent,
                        mode: task.mode,
                        sessionId: task.sessionId,
                    })
                    : null;

                if (diag) {
                    t.errorReason = diag.reason;
                }
                saveClaudeTasks(cur);
                claudeRunningPids.delete(taskId);

                ctx.enqueue(async () => {
                    try {
                        if (code === 0) {
                            const body = output || "（Claude 已执行完成，无文本输出）";
                            if (typeof ctx.sendFormattedMessage === "function") {
                                await ctx.sendFormattedMessage(chatId, body);
                            } else {
                                await ctx.sendMessage(chatId, body, "HTML");
                            }
                        } else if (wasCancelled) {
                            await ctx.sendMessage(chatId, "✋ <b>Claude 任务已停止。</b>", "HTML");
                        } else if (output) {
                            const errBanner = `\n\n⚠️ **[模型输出意外中断 · exit=${code}]**\n📌 **原因**: ${diag.reason}${diag.suggestion ? `\n💡 **建议**: ${diag.suggestion}` : ""}`;
                            if (typeof ctx.sendFormattedMessage === "function") {
                                await ctx.sendFormattedMessage(chatId, output + errBanner);
                            } else {
                                await ctx.sendMessage(chatId, escapeHtml(output) + `\n\n⚠️ <b>[模型输出意外中断 · exit=${code}]</b>\n📌 <b>原因</b>: ${escapeHtml(diag.reason)}${diag.suggestion ? `\n💡 <b>建议</b>: ${escapeHtml(diag.suggestion)}` : ""}`, "HTML");
                            }
                        } else {
                            let errMsg = `❌ <b>Claude 执行失败</b> <code>(exit=${code})</code>\n\n` +
                                `📌 <b>失败原因</b>:\n${escapeHtml(diag.reason)}`;
                            if (diag.detail && diag.detail !== diag.reason && !diag.reason.includes(diag.detail)) {
                                errMsg += `\n\n<pre>${escapeHtml(diag.detail)}</pre>`;
                            }
                            if (diag.suggestion) {
                                errMsg += `\n\n💡 <b>排查建议</b>: ${escapeHtml(diag.suggestion)}`;
                            }
                            await ctx.sendMessage(chatId, errMsg, "HTML");
                        }
                    } catch (err) {
                        await ctx.sendMessage(chatId, `❌ 发送结果失败: ${escapeHtml(err.message)}`, "HTML");
                    }

                    // 自动唤醒队列中的下一条任务
                    const next = claudePendingQueue.shift();
                    if (next) {
                        if (next.messageId) {
                            ctx.setMessageReaction(next.chatId, next.messageId, "🤔").catch(() => {});
                        }
                        await ctx.sendMessage(next.chatId, "⏳ <b>开始执行排队任务…</b>", "HTML").catch(() => {});
                        launchClaudeTask(next.chatId, next.task, next.prompt, next.imagePath);
                    }
                    resolve();
                });
            });
        });
    }

    /** 停止运行中的 Claude 任务 */
    async function stopRunningClaudeTask(chatId) {
        const tasks = loadClaudeTasks();
        const running = Object.values(tasks).filter((t) => t.status === "running");
        if (running.length === 0) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚪ 当前没有正在运行的 Claude 任务。", "HTML"));
            return;
        }
        let stoppedCount = 0;
        for (const t of running) {
            const child = claudeRunningPids.get(t.taskId);
            if (child && child.exitCode === null) {
                try {
                    child.kill("SIGTERM");
                    setTimeout(() => {
                        if (child.exitCode === null) {
                            try { child.kill("SIGKILL"); } catch (_) {}
                        }
                    }, 2000);
                } catch (_) {}
            }
            t.status = "cancelled";
            t.finishedAt = Date.now();
            stoppedCount++;
        }
        saveClaudeTasks(tasks);
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId, `✋ <b>已停止 ${stoppedCount} 个运行中的 Claude 任务。</b>`, "HTML")
        );
    }

    /** 取消所有排队中的 Claude 任务 */
    async function cancelQueuedClaudeTasks(chatId) {
        const count = claudePendingQueue.length;
        if (count === 0) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚪ 当前队列中没有待执行的 Claude 任务。", "HTML"));
            return;
        }
        claudePendingQueue.length = 0;
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId, `🗑 <b>已取消 ${count} 个排队中的 Claude 任务。</b>`, "HTML")
        );
    }

    /** 视觉宽度与截断辅助 */
    function charVisualWidth(char) {
        const cp = char.codePointAt(0);
        if (!cp) return 1;
        if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff01 && cp <= 0xff60) ||
            (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd) ||
            (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf) ||
            (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xfe10 && cp <= 0xfe1f)) {
            return 2;
        }
        return 1;
    }
    function stringVisualWidth(str) {
        let w = 0;
        for (const ch of String(str || "")) w += charVisualWidth(ch);
        return w;
    }
    function truncateVisual(str, maxW) {
        let w = 0;
        let out = "";
        for (const ch of String(str || "")) {
            const cw = charVisualWidth(ch);
            if (w + cw > maxW - 1) {
                out += "…";
                break;
            }
            out += ch;
            w += cw;
        }
        return out;
    }
    function padVisual(str, targetW) {
        const w = stringVisualWidth(str);
        if (w >= targetW) return str;
        let out = String(str);
        while (targetW - w >= 2) { out += "　"; targetW -= 2; }
        while (targetW > w) { out += " "; targetW -= 1; }
        return out;
    }

    function cleanSessionTitle(raw) {
        let t = String(raw || "").trim();
        if (!t) return "";
        t = t.replace(/\n+/g, " ");
        t = t.replace(/^(请帮我|帮我|请问|我想|请|查看一下|看一下|查询一下)\s*/i, "");
        return t.trim();
    }

    function extractTitleFromJsonl(filepath) {
        try {
            const content = readFileSync(filepath, "utf-8");
            const lines = content.split("\n");
            for (const line of lines.slice(0, 50)) {
                if (!line.trim()) continue;
                try {
                    const d = JSON.parse(line);
                    if (d.type === "user" && d.message?.content) {
                        const c = typeof d.message.content === "string" ? d.message.content : (Array.isArray(d.message.content) ? d.message.content.map(x => x.text || "").join(" ") : "");
                        const cleaned = cleanSessionTitle(c);
                        if (cleaned && !cleaned.startsWith("/")) return cleaned;
                    } else if (d.content && typeof d.content === "string") {
                        const cleaned = cleanSessionTitle(d.content);
                        if (cleaned && !cleaned.startsWith("/")) return cleaned;
                    }
                } catch (_) {}
            }
        } catch (_) {}
        return "";
    }

    async function handleClaudeNew(chatId) {
        clearAwaitingClaude();
        const timer = setTimeout(() => clearAwaitingClaude(true), CLAUDE_WAIT_MS);
        ctx.awaitingClaude = { chatId: Number(chatId), mode: "new", timer, startedAt: Date.now() };
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId,
                "💬 <b>新建 Claude 对话</b>\n\n请输入任务内容（支持发图）。\n\n• <code>/claude exit</code> 退出\n• <code>/cancel</code> 取消",
                "HTML")
        );
    }

    /** 历史会话菜单（resume） */
    async function handleClaudeResumeMenu(chatId) {
        try {
            const CELL_W = 50;
            const tasks = loadClaudeTasks();
            const seen = new Map();

            // 1. 扫描 Bridge 本地保存的任务
            for (const t of Object.values(tasks)) {
                if (!t.sessionId) continue;
                if (!seen.has(t.sessionId)) {
                    seen.set(t.sessionId, {
                        sid: t.sessionId,
                        title: cleanSessionTitle(t.prompt) || `会话 ${t.sessionId.slice(0, 8)}`,
                        time: t.startedAt || 0,
                    });
                }
            }

            // 2. 扫描 ~/.claude/history.jsonl
            if (existsSync(CLAUDE_HIST_FILE)) {
                try {
                    const histLines = readFileSync(CLAUDE_HIST_FILE, "utf-8").split("\n");
                    for (const line of histLines) {
                        if (!line.trim()) continue;
                        try {
                            const d = JSON.parse(line);
                            const sid = d.sessionId;
                            const disp = cleanSessionTitle(d.display);
                            const ts = Number(d.timestamp) || 0;
                            if (sid) {
                                const prev = seen.get(sid) || { sid, title: "", time: 0 };
                                if (disp && !disp.startsWith("/") && !prev.title) {
                                    prev.title = disp;
                                }
                                if (ts > prev.time) prev.time = ts;
                                seen.set(sid, prev);
                            }
                        } catch (_) {}
                    }
                } catch (_) {}
            }

            // 3. 递归扫描 ~/.claude/projects/ 下的项目会话文件 (*.jsonl)
            if (existsSync(CLAUDE_PROJECTS_DIR)) {
                try {
                    const projDirs = readdirSync(CLAUDE_PROJECTS_DIR);
                    for (const pDir of projDirs) {
                        const fullPDir = join(CLAUDE_PROJECTS_DIR, pDir);
                        try {
                            if (!statSync(fullPDir).isDirectory()) continue;
                            const files = readdirSync(fullPDir).filter(f => f.endsWith(".jsonl"));
                            for (const f of files) {
                                const sid = f.replace(/\.jsonl$/, "");
                                const fullPath = join(fullPDir, f);
                                const mtime = statSync(fullPath).mtimeMs;
                                const prev = seen.get(sid) || { sid, title: "", time: 0 };
                                if (mtime > prev.time) prev.time = mtime;
                                if (!prev.title) {
                                    const t = extractTitleFromJsonl(fullPath);
                                    if (t) prev.title = t;
                                }
                                seen.set(sid, prev);
                            }
                        } catch (_) {}
                    }
                } catch (_) {}
            }

            const sorted = [...seen.values()]
                .filter(s => s.sid)
                .sort((a, b) => b.time - a.time)
                .slice(0, 10);
            const buttons = [];
            for (const item of sorted) {
                const sidHash = getClaudeSidHash(item.sid);
                const displayTitle = item.title || `会话 ${item.sid.slice(0, 8)}`;
                claudeTitleCache.set(item.sid, displayTitle);
                buttons.push([{ text: truncateVisual(displayTitle, CELL_W - 4), callback_data: `claude:resume:${sidHash}` }]);
            }

            const nums = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
            buttons.forEach((row, i) => {
                row[0].text = padVisual(`${nums[i] || (i + 1)} ${row[0].text}`, CELL_W);
            });
            if (!buttons.length) {
                buttons.push([{ text: "（无历史会话）", callback_data: "claude:none" }]);
            }
            const keyboard = { inline_keyboard: buttons };
            await ctx.enqueue(() =>
                ctx.sendMessageWithKeyboard(chatId,
                    "📂 <b>继续 Claude 对话</b>\n\n选择要续接的历史会话（按最近活跃排序）：", keyboard, "HTML")
            );
        } catch (err) {
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, `❌ 列出历史会话失败: ${escapeHtml(err.message)}`, "HTML")
            );
        }
    }

    /** 查看 Claude 任务进度 */
    async function handleClaudeProgress(chatId) {
        const tasks = loadClaudeTasks();
        const ids = Object.keys(tasks).sort((a, b) => (tasks[b].startedAt || 0) - (tasks[a].startedAt || 0));
        if (!ids.length) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "📊 <b>Claude 任务进度</b>\n\n暂无任务记录。", "HTML"));
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
            running:   { e: "⏳", t: "运行中" },
            completed: { e: "✅", t: "完成" },
            failed:    { e: "❌", t: "失败" },
            stuck:     { e: "⚠️", t: "卡住" },
            cancelled: { e: "✋", t: "已停止" },
        };
        const lines = ids.slice(0, 10).map((id) => {
            const t = tasks[id];
            const st = stMap[t.status] || { e: "❓", t: t.status };
            const ref = t.finishedAt || t.startedAt;
            const rel = ref
                ? (t.status === "running" ? `已进行 ${fmtDur(Date.now() - ref)}` : `${fmtDur(Date.now() - ref)} 前`)
                : "";
            const title = escapeHtml(String(t.prompt || "").slice(0, 30));
            let tag = `<b>${st.e} ${st.t}</b>`;
            if (t.status === "failed" && t.errorReason) {
                tag += ` · <i>${escapeHtml(t.errorReason.slice(0, 25))}</i>`;
            }
            return `• <b>${title}</b>\n  ${tag}${rel ? ` · <i>${rel}</i>` : ""}`;
        }).join("\n");
        const total = ids.length;
        const shown = Math.min(10, total);
        const header = `📊 <b>Claude 任务进度</b>\n\n`;
        const footer = total > shown ? `\n\n<i>仅显示最近 ${shown} 条 / 共 ${total} 条</i>` : "";
        await ctx.enqueue(() =>
            ctx.sendMessage(chatId, `${header}${lines}${footer}`, "HTML")
        );
    }

    /** 主菜单（六子命令，对齐 Codex） */
    async function handleClaudeCommand(chatId, argText = "") {
        if (argText && argText.trim() && !argText.trim().startsWith("/")) {
            const task = { taskId: claudeTaskId(), mode: "new" };
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId, "⏳ <b>Claude 任务已启动</b>，完成后自动汇报。", "HTML")
            );
            launchClaudeTask(chatId, task, argText.trim());
            return;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: "💬 新建对话", callback_data: "claude:new" },
                    { text: "🎛 切换模型", callback_data: "claude:model" },
                ],
                [
                    { text: "📂 继续对话", callback_data: "claude:resume" },
                    { text: "📊 查看进度", callback_data: "claude:progress" },
                ],
                [
                    { text: "✋ 停止任务", callback_data: "claude:stop" },
                    { text: "🚪 退出桥接", callback_data: "claude:exit" },
                ],
            ],
        };
        await ctx.enqueue(() =>
            ctx.sendMessageWithKeyboard(chatId, "🤖 <b>Claude 子命令</b>\n\n选择操作：", keyboard, "HTML")
        );
    }

    /** 切换模型菜单 */
    async function handleClaudeModel(chatId) {
        const defaultModel = bridgeCfg.claude.defaultModel || "cliproxy/gemini-flash";
        const current = ctx.claudeModel || defaultModel;
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
            models = [
                "cliproxy/claude-sonnet-4-6",
                "cliproxy/deepseek-v4-flash",
                "cliproxy/gemini-flash",
                "cliproxy/cursor-grok-4.6-high",
                "cliproxy/kimi-k3-high",
            ];
        }

        const rows = [];
        for (let i = 0; i < models.length; i += 3) {
            const row = [];
            for (let j = i; j < Math.min(i + 3, models.length); j++) {
                const slug = models[j];
                const mark = slug === current ? " ✅" : "";
                const hash = getClaudeModelHash(slug);
                row.push({ text: `${slug.split("/").pop()}${mark}`, callback_data: `claude:model:${hash}` });
            }
            rows.push(row);
        }
        const keyboard = { inline_keyboard: rows };
        const cur = current || "默认";
        const scope = ctx.claudeModel ? "（当前对话已切换）" : "（默认）";
        await ctx.enqueue(() =>
            ctx.sendMessageWithKeyboard(chatId,
                `🎛 <b>Claude 模型</b>\n\n当前：<code>${escapeHtml(cur)}</code> ${scope}\n\n选择要切换的模型（通过 OpenCodex 代理）：`,
                keyboard, "HTML")
        );
    }

    async function handleClaudeCallback(callbackId, data, chatId) {
        if (data === "claude:new") {
            await ctx.answerCallbackQuery(callbackId, "新对话").catch(() => {});
            await handleClaudeNew(chatId);
        } else if (data === "claude:resume") {
            await ctx.answerCallbackQuery(callbackId, "选择会话").catch(() => {});
            await handleClaudeResumeMenu(chatId);
        } else if (data === "claude:stop") {
            await ctx.answerCallbackQuery(callbackId, "正在停止任务...").catch(() => {});
            await stopRunningClaudeTask(chatId);
        } else if (data === "claude:cancelqueued") {
            await ctx.answerCallbackQuery(callbackId, "正在取消排队...").catch(() => {});
            await cancelQueuedClaudeTasks(chatId);
        } else if (data === "claude:progress") {
            await ctx.answerCallbackQuery(callbackId, "查看进度").catch(() => {});
            await handleClaudeProgress(chatId);
        } else if (data === "claude:model") {
            await ctx.answerCallbackQuery(callbackId, "切换模型").catch(() => {});
            await handleClaudeModel(chatId);
        } else if (data.startsWith("claude:model:")) {
            const hash = data.replace("claude:model:", "");
            const slug = resolveClaudeModel(hash);
            if (!slug) {
                await ctx.answerCallbackQuery(callbackId, "模型已失效，请重新选择").catch(() => {});
                return;
            }
            ctx.claudeModel = slug;
            if (ctx.awaitingClaude) {
                clearTimeout(ctx.awaitingClaude.timer);
                ctx.awaitingClaude.timer = setTimeout(() => clearAwaitingClaude(true), CLAUDE_WAIT_MS);
            }
            await ctx.answerCallbackQuery(callbackId, "已切换").catch(() => {});
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId,
                    `🎛 <b>Claude 模型已切换</b>\n\n<code>${escapeHtml(slug)}</code>\n\n<b>仅当前对话生效</b>，后续任务将使用该模型。\n\n• 退出桥接（<code>/claude exit</code>）后恢复默认。`,
                    "HTML")
            );
        } else if (data === "claude:exit") {
            clearAwaitingClaude();
            ctx.claudeModel = "";
            await ctx.answerCallbackQuery(callbackId, "已退出桥接").catch(() => {});
            await ctx.enqueue(() => ctx.sendMessage(chatId, "🚪 已退出 Claude 连续对话桥接。", "HTML"));
        } else if (data.startsWith("claude:resume:")) {
            const sidHash = data.replace("claude:resume:", "");
            const sid = resolveClaudeSid(sidHash);
            if (!sid) {
                await ctx.answerCallbackQuery(callbackId, "会话已失效，请重新 /claude").catch(() => {});
                return;
            }
            clearAwaitingClaude();
            const timer = setTimeout(() => clearAwaitingClaude(true), CLAUDE_WAIT_MS);
            ctx.awaitingClaude = { chatId: Number(chatId), mode: "resume", sessionId: sid, timer, startedAt: Date.now() };
            await ctx.answerCallbackQuery(callbackId, "已选会话").catch(() => {});
            const sessTitle = resolveClaudeTitle(sid) || sid.slice(0, 10);
            await ctx.enqueue(() =>
                ctx.sendMessage(chatId,
                    `📂 <b>继续 Claude 会话</b>\n\n会话：<b>${escapeHtml(sessTitle)}</b>\n\n请输入要续接的内容。\n\n• <code>/claude exit</code> 退出\n• <code>/cancel</code> 取消`,
                    "HTML")
            );
        } else {
            await ctx.answerCallbackQuery(callbackId, "无效操作").catch(() => {});
        }
    }

    /** 消费 Claude 连续对话输入 */
    async function tryConsumeClaudeInput(chatId, text, messageId, imagePath = "") {
        const pending = ctx.awaitingClaude;
        if (!pending) return false;
        if (Number(pending.chatId) !== Number(chatId)) return false;

        const raw = String(text ?? "").trim();
        if (raw.startsWith("/")) {
            const base = raw.split(/\s+/)[0].split("@")[0].toLowerCase();
            if (base === "/cancel" || base === "/stop" || (base === "/claude" && raw.includes("exit"))) {
                clearAwaitingClaude();
                await ctx.enqueue(() => ctx.sendMessage(chatId, "🚪 已退出 Claude 模式。", "HTML"));
                return true;
            }
            clearAwaitingClaude();
            return false;
        }
        if (!raw && !imagePath) {
            await ctx.enqueue(() => ctx.sendMessage(chatId, "⚠️ 请输入文字内容。取消：/cancel", "HTML"));
            return true;
        }
        const boundSessionId = pending.sessionId || "";
        const boundMode = boundSessionId ? "resume" : (pending.mode || "new");
        const task = { taskId: claudeTaskId(), mode: boundMode, sessionId: boundSessionId };
        if (task.sessionId) {
            const cur = loadClaudeTasks();
            const hasRunning = Object.values(cur).some((t) => t.sessionId === task.sessionId && t.status === "running");
            if (hasRunning) {
                claudePendingQueue.push({ chatId: Number(chatId), task, prompt: raw, imagePath, messageId, queuedAt: Date.now() });
                const kb = {
                    inline_keyboard: [[
                        { text: "✋ 停止任务", callback_data: "claude:stop" },
                        { text: "🗑 取消排队", callback_data: "claude:cancelqueued" },
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
        const newTimer = setTimeout(() => clearAwaitingClaude(true), CLAUDE_WAIT_MS);
        ctx.awaitingClaude = { ...pending, timer: newTimer };

        if (messageId) {
            ctx.setMessageReaction(chatId, messageId, "🤔").catch(() => {});
        }
        const effectivePrompt = raw || "请分析这张图片。";
        launchClaudeTask(chatId, task, effectivePrompt, imagePath);
        return true;
    }

    return {
        handleClaudeCommand,
        handleClaudeCallback,
        tryConsumeClaudeInput,
        handleClaudeProgress,
    };
}
