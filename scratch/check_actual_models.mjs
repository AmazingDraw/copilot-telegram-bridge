import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(__dirname, "..");

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
    console.error("FAIL: set COPILOT_SDK_PATH or install copilot-sdk cache");
    process.exit(2);
}
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(SDK_PATH).href);

function getActiveSessionId() {
    const candidates = [
        join(EXT_DIR, "bots", "copilotcli", "lock.json"),
        join(EXT_DIR, "bots", "Headless", "lock.json"),
    ];
    for (const lockPath of candidates) {
        if (!existsSync(lockPath)) continue;
        try {
            const data = JSON.parse(readFileSync(lockPath, "utf8"));
            if (data.sessionId) return data.sessionId;
        } catch {}
    }
    return null;
}

async function run() {
    const sessionId = getActiveSessionId();
    if (!sessionId) {
        console.error("No active session found in lock file. Please make sure Copilot is running.");
        return;
    }
    console.log(`Connecting to active session: ${sessionId}`);
    console.log(`SDK: ${SDK_PATH}`);

    const cliPath = process.env.COPILOT_CLI_PATH
        || latestPath(join(HOME, "Library/Caches/github-copilot-sdk/cli"), "copilot");
    const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
            path: cliPath || process.argv[0],
        }),
    });

    await client.start();
    const models = await client.listModels();
    console.log("\n--- List of All Models via client.listModels() ---");
    console.log(JSON.stringify(models, null, 2));

    try {
        const session = await client.joinSession({ sessionId });
        const rpcModels = await session.rpc.model.list();
        console.log("\n--- List of All Models via session.rpc.model.list() ---");
        console.log(JSON.stringify(rpcModels.list, null, 2));
        await session.destroy();
    } catch (e) {
        console.log("Could not join session to get RPC model list:", e.message);
    }

    await client.stop();
}

run().catch((err) => {
    console.error("Error checking models:", err);
});
