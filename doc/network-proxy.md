# Bridge 网络与代理

> 实现：`lib/telegram-fetch.mjs`  
> 配置：`config/models.json` → `telegram.proxy`、`providers[]`  
> 相关：[`models-config.md`](./models-config.md) · [`headless-daemon.md`](./headless-daemon.md)  
> NAS 出口总表（网络维护）：`asustor-nas-ops` → `references/nas-vpn-exit-nodes.md` · `scripts/check-us-port.sh`  
> 最近核对：**2026-09-29**

本文只讲 **本机 Telegram 桥** 的出站路径。 bridge **不是** 全程只走 NAS：Telegram API 优先 NAS HTTP CONNECT，失败会回退本机；模型请求走 cliproxy（Mac 或 NAS），不经过 `telegram.proxy`。

```text
                    ┌─ Telegram Bot API ─┐
Telegram 用户 ──► Mac 桥 (poll / send*) ──┤
                    └────────────────────┘
                              │
              优先 CONNECT    │    失败 / 冷却中
         http://127.0.0.1:7214   └─► 本机 fetch（Stash / 直连）
                              │
                         api.telegram.org

无头会话 / BYOK ──► cliproxy（与 telegram.proxy 无关）
  Headless 默认     http://127.0.0.1:8317/v1
  绑定 cliproxy-nas 的 modelSet
                    http://127.0.0.1:8317/v1
```

改 `telegram.proxy` 后 **不用重启**：`resolveProxySettings()` 每次请求读 `models.json`。  
改 `providers[].baseUrl` / BYOK 绑定后一般要 `bash scripts/headless-daemon.sh restart`。

---

## 1. 两条独立出站

| 流量 | 走哪 | 配置 | 失败时 |
| :--- | :--- | :--- | :--- |
| Telegram Bot API（`getUpdates` / `sendMessage` / 传图等） | NAS `127.0.0.1:**7214**` HTTP CONNECT，再 TLS 到 `api.telegram.org` | `telegram.proxy`；可用环境变量 `TELEGRAM_PROXY_URL` 覆盖 | 记失败 + **冷却 `retryCooldownMs`（默认 30s）**，冷却内本机 `fetch` |
| 模型 / cliproxy（无头会话上游） | provider `baseUrl`：Mac `:8317` 或 NAS `:8317` | `providers[]`、`modelSets.*.provider` | 与 Telegram 代理无关；看 cliproxy / 铜线 |

桥进程本身在 Mac 上；**7214 只服务 Telegram HTTPS**，不是把整个 Node 进程塞进 NAS VPN。

---

## 2. Telegram：`telegram.proxy`

### 2.1 现行配置

```json
"telegram": {
  "$comment": "…默认优先 NAS 7214…",
  "proxy": {
    "enabled": true,
    "url": "http://127.0.0.1:7214",
    "retryCooldownMs": 30000
  }
}
```

| 字段 | 含义 |
| :--- | :--- |
| `enabled` | `false` → 全程本机 `fetch`，不碰 NAS |
| `url` | HTTP CONNECT 代理。**Bridge Telegram 出站 = US 出口 7214**（2026-09-29 从 7212 切过来） |
| `retryCooldownMs` | 隧道失败后多少毫秒内不再试代理 |

默认常量与注释在 `lib/telegram-fetch.mjs` 的 `DEFAULT_NAS_PROXY_URL`（应与 json 一致）。

### 2.2 运行时逻辑（`telegramFetch`）

1. `enabled === false` → 直接 `fetch(url)`。  
2. 否则若当前时间 **大于** `proxyFailedUntil` → 走 `tunnelFetch`（CONNECT → TLS → 手写 HTTP/1.1）。  
3. 隧道抛错 → 打 `[telegram-proxy] NAS 代理隧道异常 (…)，自动回退到本机网络...`，设 `proxyFailedUntil = now + retryCooldownMs`，再本机 `fetch`。  
4. 冷却未结束 → 跳过隧道，直接本机 `fetch`。

因此：**优先 NAS，不是钉死 NAS**。7214 抖的时候，日志里会周期性出现代理异常，同时 poll 可能已在本机出口上跑。

### 2.3 谁调用

`extension.mjs` 里凡打 `https://api.telegram.org/bot…` 的路径都经 `telegramFetch`：`callTelegram`（含长轮询）、`sendPhoto` / `sendDocument`、文件下载等。

### 2.4 长轮询与「Aborted」噪音

- `getUpdates` 服务端超时约 **`POLL_TIMEOUT = 30` 秒**；客户端 `AbortSignal` 约 **40 秒**（`POLL_TIMEOUT + 10`）。  
- 其它 API 超时约 **`API_TIMEOUT_MS = 30s`**。  
- 代理路径上，`signal` abort（含上述超时）也会进 `catch`，被记成「NAS 代理隧道异常」，然后冷却回退。  
- 所以日志里大量 `This operation was aborted` **不一定等于 7214 挂了**：长轮询正常结束/超时、或本机 abort，也会触发同一条告警。排障时优先看是否伴随 `Proxy CONNECT failed` / `Invalid HTTP response`，以及冷却后本机是否还能 `setMyCommands` / poll recovered。

### 2.5 若要「只走 NAS、不回退」

当前代码 **没有**「禁用 fallback」开关。只能：

- 保持 `enabled: true` 且接受失败时回退（默认，稳）；或  
- 临时 `enabled: false` 强制本机（不走 7214）；或  
- 改 `telegram-fetch.mjs`（隧道失败直接抛、不 `fetch`）——需明确接受：7214 挂则 bot 收不到消息。

---

## 3. 模型：cliproxy（不经 7214）

| Provider id | 典型 `baseUrl` | 谁用 |
| :--- | :--- | :--- |
| `cliproxy` | `http://127.0.0.1:8317/v1` | 默认无头找 `id === "cliproxy"` |
| `cliproxy-nas` | `http://127.0.0.1:8317/v1` | 某 `modelSets` 绑定 `provider: "cliproxy-nas"` 的 bot |

这是 **LAN 铜线到 NAS 上的 cli-proxy-api**，不是 Telegram 的 HTTP CONNECT。NAS cliproxy 自己的上游出口由 NAS/代理栈决定，与 Bridge 的 `telegram.proxy` 无关。细则见 [`models-config.md`](./models-config.md) provider / modelSets 节。

---

## 4. 和 NAS 文档的对齐

| 端口 | 角色（Bridge 视角） |
| :--- | :--- |
| **7214** | Telegram Bot API 优先出口（US）。Bridge：`telegram.proxy.url` |
| **7212** | 其它 NAS HTTP 代理用途；**Bridge Telegram 已不再默认用它**（2026-09-29） |
| **8317** | cliproxy HTTP API（Mac 本机或 `127.0.0.1`） |

网络维护侧把「谁消费 7214」写在 `nas-vpn-exit-nodes.md`，`check-us-port.sh` 按该表核对。Bridge 改端口后应同步那两处，避免文档仍写 7212。

---

## 5. 排障速查

```bash
# 现行代理
python3 -c "import json;print(json.load(open('config/models.json'))['telegram']['proxy'])"

# 最近代理 / poll
rg -n 'telegram-proxy|poll error|poll recovered|setMyCommands' bots/Headless/daemon.log | tail -40

# 7214 是否通（在 Mac 上；具体探测以网络维护 check-us-port 为准）
nc -z -w 2 127.0.0.1 7214 && echo ok || echo fail
```

| 现象 | 先看 |
| :--- | :--- |
| 只有 `This operation was aborted` + 偶发 poll timeout | 常见：长轮询/超时触发冷却；确认冷却后是否 recovered |
| `Proxy CONNECT failed: 502` / 连不上 7214 | NAS 出口或铜线；对照 `check-us-port` |
| 完全不走代理 | `enabled: false` 或一直在冷却窗口内 |
| 模型 401 / 连不上，但 Telegram 正常 | cliproxy `:8317`，不是 7214 |
| `Bot token not configured` | 会话重连身份问题，见 headless 自愈 / `restoreTelegramIdentity`，不是代理 |

临时强制本机测 Telegram：

```bash
# 仅调试：改 models.json telegram.proxy.enabled=false 后发一条消息
# 测完改回 true
```

---

## 6. 变更记录

| 日期 | 变更 |
| :--- | :--- |
| 2026-09-19 | 引入 `telegram.proxy`，默认 NAS `127.0.0.1:7212` + 失败回退本机 |
| 2026-09-29 | Telegram 出站改为 **7214**；补充本文；无头重连补挂 bot token（与代理无关） |
