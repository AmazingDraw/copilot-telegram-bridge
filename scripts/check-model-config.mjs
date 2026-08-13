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
    assert(model?.fixctx?.opencodexContextWindow, `catalog.${id}.fixctx is incomplete`);
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
    let fixctxLiveChecked = false;
    for (const provider of config.providers.filter((item) => item.enabled !== false)) {
        const checkFixctx = provider.id === "opencodex";
        const resolved = await resolveProviderCatalog(provider, {
            requireLive: true,
            timeoutMs: 10000,
            requiredModelIds: checkFixctx ? fixctx.models : [],
        });
        assert(resolved, `provider ${provider.id} did not resolve`);
        assert.deepEqual(
            resolved.modelIds,
            provider.models.map((model) => model.id),
            `provider ${provider.id} live catalog order differs from its modelSet`,
        );
        if (checkFixctx) fixctxLiveChecked = true;
    }
    if (!fixctxLiveChecked) {
        const opencodex = config.providers.find((provider) => provider.id === "opencodex");
        assert(opencodex, "an opencodex provider is required to validate fixctx models");
        await resolveProviderCatalog(
            { ...opencodex, enabled: true },
            {
                requireLive: true,
                timeoutMs: 10000,
                requiredModelIds: fixctx.models,
            },
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
