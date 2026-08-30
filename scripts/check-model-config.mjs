#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    BRIDGE_ROOT,
    loadModelsConfig,
    modelsConfigPath,
    normalizeModelsConfig,
    resolveProviderCatalog,
} from "../lib/byok-providers.mjs";

const live = process.argv.includes("--live");
const rawPath = modelsConfigPath();
const raw = JSON.parse(readFileSync(rawPath, "utf8"));
const config = loadModelsConfig({ force: true });

assert.equal(config.schemaVersion, 2, "models.json must use schemaVersion 2");
assert(Object.keys(config.catalog).length > 0, "catalog must not be empty");
assert(Object.keys(config.modelSets).length > 0, "modelSets must not be empty");

for (const provider of config.providers) {
    if (!provider.modelSet) continue;
    const set = config.modelSets[provider.modelSet];
    assert(set, `provider ${provider.id} has an unknown modelSet`);
    const expected = set.models.filter((id) => config.catalog[id]?.enabled !== false);
    assert.deepEqual(
        provider.models.map((model) => model.id),
        expected,
        `provider ${provider.id} did not expand its modelSet in order`,
    );
}

const fixctx = config.modelSets.fixctx;
assert(fixctx, "modelSets.fixctx is required");
for (const id of fixctx.models) {
    const model = config.catalog[id];
    assert(model?.maxPromptTokens, `catalog.${id}.maxPromptTokens is required by fixctx`);
    assert(model?.maxOutputTokens, `catalog.${id}.maxOutputTokens is required by fixctx`);
}

for (const botsPath of [
    join(BRIDGE_ROOT, "config", "bots.json"),
    join(BRIDGE_ROOT, "config", "bots.example.json"),
]) {
    if (!existsSync(botsPath)) continue;
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    for (const [name, bot] of Object.entries(bots)) {
        if (!bot?.modelSet) continue;
        assert(config.modelSets[bot.modelSet], `bot ${name} references unknown modelSet '${bot.modelSet}'`);
    }
}

{
    const setName = config.defaults.claudeModelSet;
    assert(setName, "defaults.claudeModelSet is required");
    const set = config.modelSets[setName];
    assert(set, `defaults.claudeModelSet '${setName}' is missing from modelSets`);
    const prefix = config.defaults.claudeModelPrefix || "cliproxy/";
    const bare = (id) => {
        let s = String(id || "").trim();
        if (s.startsWith(prefix)) s = s.slice(prefix.length);
        return s.replace(/\[.*\]$/, "");
    };
    const defaultId = bare(config.defaults.claudeDefaultModel || set.defaultModel);
    const fallbackId = bare(config.defaults.claudeFallbackModel);
    if (defaultId) {
        assert(set.models.includes(defaultId), `claudeDefaultModel '${defaultId}' is not in modelSets.${setName}`);
        assert(config.catalog[defaultId], `claudeDefaultModel '${defaultId}' is missing from catalog`);
    }
    if (fallbackId) {
        assert(set.models.includes(fallbackId), `claudeFallbackModel '${fallbackId}' is not in modelSets.${setName}`);
        assert(config.catalog[fallbackId], `claudeFallbackModel '${fallbackId}' is missing from catalog`);
    }
}

// Legacy schema remains accepted for external HEADLESS_MODELS_CONFIG users.
const legacy = normalizeModelsConfig({
    defaultModel: "legacy-model",
    providers: [{
        id: "legacy",
        enabled: true,
        baseUrl: "http://127.0.0.1:1/v1",
        models: [{
            id: "legacy-model",
            maxPromptTokens: 1000,
            maxContextWindowTokens: 1000,
            maxOutputTokens: 100,
        }],
    }],
});
assert.equal(legacy.schemaVersion, 1);
assert.equal(legacy.providers[0].models[0].id, "legacy-model");

assert.throws(
    () => normalizeModelsConfig({
        schemaVersion: 2,
        catalog: { known: { maxPromptTokens: 1 } },
        modelSets: { invalid: { models: ["missing"] } },
        providers: [],
    }),
    /references missing catalog model/,
);
assert.throws(
    () => normalizeModelsConfig({
        schemaVersion: 2,
        catalog: { known: { maxPromptTokens: 1 } },
        modelSets: { invalid: { defaultModel: "missing", models: ["known"] } },
        providers: [],
    }),
    /defaultModel .* is not in the set/,
);
assert.throws(
    () => normalizeModelsConfig({
        schemaVersion: 2,
        catalog: { known: { maxPromptTokens: 1 } },
        modelSets: { valid: { models: ["known"] } },
        providers: [{ id: "invalid", models: ["known"] }],
    }),
    /must reference a modelSet in schema v2/,
);

if (!process.argv.includes("--skip-fixctx-fixture")) {
    execFileSync(
        "python3",
        [join(BRIDGE_ROOT, "scripts", "test-fixctx.py"), rawPath],
        { stdio: "inherit" },
    );
}

if (live) {
    for (const provider of config.providers.filter((item) => item.enabled !== false)) {
        const resolved = await resolveProviderCatalog(provider, {
            requireLive: true,
            timeoutMs: 10000,
        });
        assert(resolved, `provider ${provider.id} did not resolve`);
        assert.deepEqual(
            resolved.modelIds,
            provider.models.map((model) => model.id),
            `provider ${provider.id} live catalog order differs from its modelSet`,
        );
    }
}

const activeCount = config.providers
    .filter((provider) => provider.enabled !== false)
    .reduce((sum, provider) => sum + provider.models.length, 0);
console.log(
    `model config OK: catalog=${Object.keys(config.catalog).length} ` +
    `sets=${Object.keys(config.modelSets).length} active=${activeCount} ` +
    `fixctx=${fixctx.models.length}${live ? " live=ok" : ""}`,
);
