#!/usr/bin/env node

import assert from "node:assert/strict";
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

// modelSets.*.provider：绑定必须指向存在/启用的 provider，且它必须真服务该组全部模型（换边不许静默失败）
for (const [setName, set] of Object.entries(config.modelSets)) {
    if (!set.provider) continue;
    const owner = config.providers.find((p) => p.id === set.provider);
    assert(owner, `modelSet ${setName} bound to unknown provider '${set.provider}'`);
    assert(owner.enabled !== false, `modelSet ${setName} bound to disabled provider '${set.provider}'`);
    const missing = set.models.filter((id) => !owner.models.some((m) => m.id === id));
    assert.deepEqual(
        missing,
        [],
        `provider '${set.provider}' does not serve modelSet ${setName}: ${missing.join(",")}`,
    );
}

// bindOnly provider 必须真的被某组 modelSet 绑定 —— 否则是台没人用的死上游
for (const provider of config.providers.filter((p) => p.bindOnly)) {
    const bound = Object.values(config.modelSets).some((set) => set.provider === provider.id);
    assert(bound, `bindOnly provider ${provider.id} is not bound by any modelSet`);
}

// 全局装配（未绑定 Bot 看到的模型面）不得出现同一裸 id 两个来源：
// 选中逻辑是 models.find(id)，双来源会变成"靠数组顺序生效"的隐式行为
{
    const globalProviders = config.providers.filter((p) => p.enabled !== false && p.bindOnly !== true);
    const byId = new Map();
    for (const provider of globalProviders) {
        for (const model of provider.models) {
            const owners = byId.get(model.id) || [];
            owners.push(provider.id);
            byId.set(model.id, owners);
        }
    }
    const dupes = [...byId.entries()].filter(([, owners]) => owners.length > 1);
    assert.deepEqual(
        dupes,
        [],
        `duplicate model id across global providers (would be resolved by array order): ${JSON.stringify(dupes)}`,
    );
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

// paths.claudeBin 校验：如果显式配置了路径，该文件在磁盘上必须真实存在
if (config.paths?.claudeBin) {
    assert(
        existsSync(config.paths.claudeBin),
        `paths.claudeBin '${config.paths.claudeBin}' does not exist on disk`,
    );
}

// paths.claudePersona 校验：如果显式配置了路径，该文件在磁盘上必须真实存在
if (config.paths?.claudePersona) {
    assert(
        existsSync(config.paths.claudePersona),
        `paths.claudePersona '${config.paths.claudePersona}' does not exist on disk`,
    );
}

{
    const setName = config.defaults.claudeModelSet;
    assert(setName, "defaults.claudeModelSet is required");
    const set = config.modelSets[setName];
    assert(set, `defaults.claudeModelSet '${setName}' is missing from modelSets`);
    const prefix = String(config.defaults.claudeModelPrefix || "");
    const bare = (id) => {
        let s = String(id || "").trim();
        if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
        if (s.startsWith("cliproxy/")) s = s.slice("cliproxy/".length);
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
    `sets=${Object.keys(config.modelSets).length} active=${activeCount}` +
    `${live ? " live=ok" : ""}`,
);
