/**
 * Smoke: headless createSession via local cliproxy (8317).
 * Legacy cliproxy-only smoke; dual BYOK now uses opencode+cliproxy — prefer node import of byok-providers.mjs.
 */
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

function latestPath(root, leaf) {
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
    for (const name of dirs) {
        const p = join(root, name, leaf);
        if (existsSync(p)) return p;
    }
    return null;
}

const SDK_PATH = process.env.COPILOT_SDK_PATH
    || latestPath(join(HOME, "Library/Caches/copilot/pkg/darwin-arm64"), "copilot-sdk/index.js");
if (!SDK_PATH) {
    console.error("FAIL: set COPILOT_SDK_PATH or install copilot-sdk under Library/Caches");
    process.exit(2);
}
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(SDK_PATH).href);

const PROVIDER = "cliproxy";
const ALLOWED = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "mimo-v2.5",
    "mimo-v2.5-pro",
    "grok-4.5",
];

function parseYamlKey(text) {
    const keysBlock = text.match(/api-keys:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (!keysBlock) return null;
    const first = keysBlock[1].match(/^\s*-\s*["']?([^\s"'#]+)/m);
    return first ? first[1].trim() : null;
}

function loadCliproxy() {
    const cfg = join(HOME, ".cli-proxy-api", "config.yaml");
    if (!existsSync(cfg)) throw new Error("missing cliproxy config");
    const text = readFileSync(cfg, "utf8");
    const apiKey = process.env.CLIPROXY_API_KEY || parseYamlKey(text);
    const portM = text.match(/^\s*port:\s*(\d+)\s*$/m);
    const port = portM ? Number(portM[1]) : 8317;
    if (!apiKey) throw new Error("no api-keys in config.yaml");
    return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey };
}

async function main() {
    const { baseUrl, apiKey } = loadCliproxy();
    console.log("CLIPROXY:", baseUrl, "key:", apiKey ? "set" : "MISSING");

    const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json();
    const live = new Set((body.data || []).map((m) => m.id));
    const modelIds = ALLOWED.filter((id) => live.has(id));
    console.log("allowlist live:", modelIds.join(", ") || "(none)");
    if (!modelIds.length) {
        console.error("none of allowlist present in cliproxy");
        process.exit(2);
    }
    const desired = modelIds.includes("deepseek-v4-flash") ? "deepseek-v4-flash" : modelIds[0];

    const cliPath = process.env.COPILOT_CLI_PATH
        || latestPath(join(HOME, "Library/Caches/github-copilot-sdk/cli"), "copilot");
    if (!cliPath) {
        console.error("FAIL: set COPILOT_CLI_PATH or install copilot CLI cache");
        process.exit(2);
    }
    const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: cliPath }),
    });
    console.log("starting client via", cliPath);
    await client.start();

    const model = `${PROVIDER}/${desired}`;
    console.log("createSession model:", model);
    const session = await client.createSession({
        model,
        providers: [{
            name: PROVIDER,
            type: "openai",
            baseUrl,
            apiKey,
            bearerToken: apiKey,
        }],
        models: modelIds.map((id) => ({
            id,
            provider: PROVIDER,
            name: id,
            wireModel: id,
        })),
        onPermissionRequest: async () => ({ kind: "approved" }),
    });

    console.log("session:", session.sessionId);
    const listed = await session.rpc.model.list();
    const ids = (listed?.list || []).map((m) => m.id);
    console.log("model count:", ids.length);
    for (const id of ids) console.log(" -", id);

    const byok = ids.filter((id) => id.startsWith(`${PROVIDER}/`) || ALLOWED.some((a) => id.includes(a)));
    console.log("\ncliproxy-like:", byok.join(", ") || "(none)");
    const current = await session.rpc.model.getCurrent().catch(() => null);
    console.log("current:", current);

    const target = ids.find((id) => id.endsWith("grok-4.5") || id.includes("grok-4.5"));
    if (target) {
        console.log("switchTo", target);
        await session.rpc.model.switchTo({ modelId: target, contextTier: "default" });
        console.log("after switch:", await session.rpc.model.getCurrent());
    }

    try { await session.disconnect(); } catch {}
    try { await client.stop(); } catch {}
    console.log("OK");
}

main().catch((err) => {
    console.error("FAIL:", err?.message || err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
});
