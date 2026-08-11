// Shared JSON load/save helpers for telegram-bridge modules.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function loadJsonOrDefault(filePath, defaultValue) {
    try {
        return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
        if (err.code === "ENOENT") return structuredClone(defaultValue);
        if (err instanceof SyntaxError) {
            console.warn(`telegram-bridge: corrupted JSON in ${filePath}, using defaults`);
            return structuredClone(defaultValue);
        }
        throw err;
    }
}

export function saveJsonAtomic(filePath, data, mode) {
    const tmp = filePath + ".tmp";
    const opts = mode != null ? { mode } : undefined;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", opts);
    renameSync(tmp, filePath);
}
