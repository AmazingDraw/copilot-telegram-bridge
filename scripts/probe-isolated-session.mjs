#!/usr/bin/env node
/**
 * 隔离会话烟测：在**完全不碰生产 `~/.copilot`** 的前提下，验证 vendored runtime / SDK 是否还能跑通
 * 五步链路：`start → getAuthStatus → listModels → createSession → send`（BYOK 回合）。
 *
 * 用途
 *   · **升级 SDK/runtime 后先跑它** —— 比拿生产去试安全得多（新版本能不能起、能不能建会话、回合能不能出内容）
 *   · 复现「不登录」场景（配合 models.json → auth.login=false 的语义）
 *
 * 用法
 *   node scripts/probe-isolated-session.mjs                # 生产式（保留身份），跳过 send
 *   node scripts/probe-isolated-session.mjs --send          # 连 BYOK 回合一起测
 *   node scripts/probe-isolated-session.mjs --no-auth --send
 *        真·无身份：清掉身份 env + PATH 去掉 gh（SDK 应报 isAuthenticated:false；BYOK 仍应能跑）
 *
 * 隔离手段：临时 `COPILOT_HOME`（会话状态与凭证都不落生产目录）+ 独立 spawn 一个 CLI 子进程。
 * 退出码：0 = start 与 createSession 成功（且 send 未被要求或成功）；1 = 有失败项。
 *
 * ⚠️ 踩过的坑：`buildHeadlessSessionConfig()` **直接返回 config 本体**（生产里是 `const config = await …`），
 *    写成 `const { config } = await …` 会拿到 undefined，SDK 内部读 `config.gitHubToken` 抛
 *    "Cannot read properties of undefined (reading 'gitHubToken')" —— 极易误读成"没身份导致建会话失败"。
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const VER = readFileSync(join(BRIDGE, "runtime/VERSION"), "utf8").trim();
const CLI = join(BRIDGE, `runtime/${VER}/cli/copilot`);
const PKG = join(BRIDGE, `runtime/${VER}/pkg`);

const argv = process.argv.slice(2);
const NO_AUTH = argv.includes("--no-auth");
const DO_SEND = argv.includes("--send");
if (argv.includes("-h") || argv.includes("--help")) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?/, "").trim());
    process.exit(0);
}

// ---- 隔离：临时 COPILOT_HOME（不碰 ~/.copilot），并把 runtime 钉在 vendored pkg ----
const TMP = mkdtempSync(join(tmpdir(), "probe-isolated."));
process.env.COPILOT_HOME = TMP;
process.env.COPILOT_CLI_DIST_DIR = PKG;
process.env.COPILOT_AUTO_UPDATE = "false";

const byok = await import(join(BRIDGE, "lib/byok-providers.mjs"));
byok.loadShellEnvForByok(); // 拿 cliproxy 的 BYOK key（生产同款）
if (NO_AUTH) {
    byok.stripGithubIdentityEnv();
    // gh 也会被 CLI 借用（authType: gh-cli）→ PATH 里去掉它，才是"真·无身份"
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
}

const { CopilotClient, RuntimeConnection } = await import(join(PKG, "copilot-sdk/index.js"));

const client = new CopilotClient({
    mode: "empty",
    baseDirectory: join(homedir(), ".copilot"), // 与生产同值；真正的隔离靠上面的临时 COPILOT_HOME
    useLoggedInUser: !NO_AUTH,
    connection: RuntimeConnection.forStdio({ path: CLI, args: ["--disable-mcp-server", "tavily"] }),
});

const out = { mode: NO_AUTH ? "no-auth" : "with-auth" };
let ok = true;
// hard=true 才算硬指标；auth / listModels 只作信息 —— 无身份时 listModels 必然失败，那是**预期**不是错误
const step = (name, fn, hard = false) => fn().then(
    (v) => { out[name] = v; },
    (e) => { out[name] = `${hard ? "FAIL" : "（预期内失败）"}: ${byok.compactError(e)}`; if (hard) ok = false; },
);

await step("start", async () => { await client.start(); return "ok"; }, true);
await step("auth", async () => { const s = await client.getAuthStatus(); return `isAuthenticated=${s?.isAuthenticated}${s?.authType ? ` type=${s.authType}` : ""}${s?.statusMessage ? ` (${s.statusMessage})` : ""}`; });
await step("listModels", async () => { const m = await client.listModels(); return `ok (${(m?.list || m || []).length} 个)`; });

let session = null;
await step("createSession", async () => {
    const config = await byok.buildHeadlessSessionConfig({   // ← 直接返回 config 本体，别解构
        officialModels: [],
        onPermissionRequest: () => ({ kind: "approve-once" }),
        onUserInputRequest: async () => ({ kind: "text", text: "" }),
        loadMcp: false,
        loadSkills: false,
        clientMode: "empty",
        availableTools: [],
        systemMessageMode: "replace",
    });
    session = await client.createSession(config);
    return `ok (${session?.sessionId || "?"})`;
}, true);

if (DO_SEND && session) {
    await step("send", async () => {
        let text = "";
        const done = new Promise((resolve) => {
            const t = setTimeout(() => resolve("timeout(60s)"), 60000);
            session.on?.((ev) => {
                const s = JSON.stringify(ev || {});
                const m = s.match(/"content":\s*"([^"]{1,200})"/);
                if (m) text += m[1];
                if (/session\.idle|turn_end|completed/.test(s)) { clearTimeout(t); resolve("done"); }
            });
        });
        await session.send({ prompt: "只回复两个字：收到" });
        const why = await done;
        if (why === "timeout(60s)") throw new Error("send 超时（60s 没等到回合结束）");
        return `${why} | 内容片段: ${JSON.stringify(text.slice(0, 120))}`;
    }, true);
}

console.log(`\n================ 隔离烟测（runtime ${VER}）================`);
for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(14)} : ${v}`);
console.log(`结论           : ${ok ? "✅ 通过" : "❌ 有失败项"}`);
try { await client.stop?.(); } catch {}
rmSync(TMP, { recursive: true, force: true });
console.log("（临时目录已清理；生产 ~/.copilot 未被触碰）");
process.exit(ok ? 0 : 1);
