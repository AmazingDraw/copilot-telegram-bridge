// ============================================================
// Telegram Fetch with Proxy Tunnel & Fallback
// ============================================================

import http from "node:http";
import tls from "node:tls";
import { loadModelsConfig } from "./byok-providers.mjs";

const DEFAULT_NAS_PROXY_URL = "http://127.0.0.1:7212";
const DEFAULT_COOLDOWN_MS = 30000;

let proxyFailedUntil = 0;

/**
 * 动态解析代理配置（单一真源：config/models.json → telegram.proxy）
 */
function resolveProxySettings() {
    try {
        const cfg = loadModelsConfig()?.telegram?.proxy;
        const enabled = cfg?.enabled !== false;
        const url = process.env.TELEGRAM_PROXY_URL || cfg?.url || DEFAULT_NAS_PROXY_URL;
        const retryCooldownMs = Number.isSafeInteger(cfg?.retryCooldownMs) && cfg.retryCooldownMs > 0
            ? cfg.retryCooldownMs
            : DEFAULT_COOLDOWN_MS;
        return { enabled, url, retryCooldownMs };
    } catch {
        return {
            enabled: true,
            url: process.env.TELEGRAM_PROXY_URL || DEFAULT_NAS_PROXY_URL,
            retryCooldownMs: DEFAULT_COOLDOWN_MS,
        };
    }
}

/**
 * Perform an HTTPS request via HTTP CONNECT proxy tunnel.
 */
function tunnelFetch(targetUrl, options = {}, proxyUrl = DEFAULT_NAS_PROXY_URL) {
    const pUrl = new URL(proxyUrl);
    const tUrl = new URL(targetUrl);

    return new Promise(async (resolve, reject) => {
        let aborted = false;
        if (options.signal?.aborted) {
            return reject(new Error("This operation was aborted"));
        }

        let bodyBuf = null;
        let contentType = options.headers
            ? (options.headers["Content-Type"] || options.headers["content-type"])
            : undefined;

        if (options.body) {
            if (typeof options.body === "string") {
                bodyBuf = Buffer.from(options.body);
            } else if (Buffer.isBuffer(options.body)) {
                bodyBuf = options.body;
            } else if (typeof FormData !== "undefined" && options.body instanceof FormData) {
                const dummy = new Response(options.body);
                contentType = dummy.headers.get("content-type");
                const ab = await dummy.arrayBuffer();
                bodyBuf = Buffer.from(ab);
            }
        }

        const connectReq = http.request({
            host: pUrl.hostname,
            port: pUrl.port,
            method: "CONNECT",
            path: `${tUrl.hostname}:${tUrl.port || 443}`,
        });

        const onAbort = () => {
            aborted = true;
            connectReq.destroy();
            reject(new Error("This operation was aborted"));
        };

        if (options.signal) {
            options.signal.addEventListener("abort", onAbort, { once: true });
        }

        connectReq.on("connect", (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
            }

            const tlsSocket = tls.connect({
                socket,
                servername: tUrl.hostname,
            });

            tlsSocket.on("error", (err) => {
                if (!aborted) reject(err);
            });

            const method = (options.method || "GET").toUpperCase();
            const headers = { ...(options.headers || {}) };
            headers["Host"] = tUrl.hostname;
            headers["Connection"] = "close";
            if (contentType) headers["Content-Type"] = contentType;
            if (bodyBuf) headers["Content-Length"] = bodyBuf.length;

            let headerStr = `${method} ${tUrl.pathname}${tUrl.search} HTTP/1.1\r\n`;
            for (const [k, v] of Object.entries(headers)) {
                headerStr += `${k}: ${v}\r\n`;
            }
            headerStr += "\r\n";

            tlsSocket.write(headerStr);
            if (bodyBuf) {
                tlsSocket.write(bodyBuf);
            }

            let rawData = Buffer.alloc(0);
            tlsSocket.on("data", (chunk) => {
                rawData = Buffer.concat([rawData, chunk]);
            });

            tlsSocket.on("end", () => {
                const headerEnd = rawData.indexOf("\r\n\r\n");
                if (headerEnd === -1) {
                    return reject(new Error("Invalid HTTP response from upstream"));
                }
                const head = rawData.slice(0, headerEnd).toString("utf8");
                const body = rawData.slice(headerEnd + 4);
                const statusLine = head.split("\r\n")[0];
                const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
                const status = statusMatch ? parseInt(statusMatch[1], 10) : 500;

                resolve({
                    status,
                    ok: status >= 200 && status < 300,
                    statusText: statusLine.slice(statusLine.indexOf(" ") + 1),
                    json: async () => JSON.parse(body.toString("utf8")),
                    text: async () => body.toString("utf8"),
                    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
                });
            });
        });

        connectReq.on("error", (err) => {
            if (!aborted) reject(err);
        });

        connectReq.end();
    });
}

/**
 * Fetch wrapper for Telegram API:
 * 优先根据 config/models.json (telegram.proxy) 通过代理隧道发送请求，
 * 若未开启或连接失败，则自动无感回退至本机原生 fetch。
 */
export async function telegramFetch(url, options = {}) {
    const settings = resolveProxySettings();
    if (!settings.enabled) {
        return fetch(url, options);
    }

    const now = Date.now();
    if (now > proxyFailedUntil) {
        try {
            return await tunnelFetch(url, options, settings.url);
        } catch (err) {
            // 首次失败或重试失败，记录告警并进入冷却，防止阻塞后续请求
            console.warn(`[telegram-proxy] NAS 代理隧道异常 (${err.message})，自动回退到本机网络...`);
            proxyFailedUntil = now + settings.retryCooldownMs;
        }
    }
    // 降级回退到本机原生网络（Stash 开启或直连畅通时生效）
    return fetch(url, options);
}
