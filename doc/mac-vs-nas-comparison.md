# Mac 桌面版 vs NAS 容器版 Copilot Telegram Bridge 深度对比与协同指南

> **文档路径**：`~/.copilot/extensions/copilot-telegram-bridge/doc/mac-vs-nas-comparison.md`
> **适用对象**：GitHub Copilot CLI Telegram Bridge 架构运维与跨机协同
> **编制日期**：2026-08-24（生产环境对齐）

---

## 0. 现场状态（2026-08-24 复核）

| 端 | 实际状态 | 说明 |
| :--- | :--- | :--- |
| **Mac Headless** | 值班目标 | `headless-daemon.sh` / LaunchAgent `com.copilot-telegram-bridge` |
| **NAS `copilot-bridge`** | **已停**（Mac 值班） | 启动崩已修：`undici` 锁 **8.0.2**（`8.10` 在 Node 20 会 `markAsUncloneable`）。镜像仍是 `node:20-amd64` |
| **NAS `cliproxy`** | 已在跑（与 Mac 本机 8317 **对等备机**） | 容器内 loopback `127.0.0.1:8317`；Mac 客户端指针可打铜线或本机，随时可切 |
| **NAS `oixcloud-helper`** | 业务口可用 | `7212` SOCKS 通；**冷启动仍依赖 Mac Stash `17890` 握手** |

**禁止** Mac 与 NAS 同时 `getUpdates` 同一 Bot Token（Telegram **409**）。Mac 值班时 NAS 容器应 `docker stop copilot-bridge`。

---

## 1. 双端定位与架构总览

```text
  【Mac 工作站】                         【NAS AS6602T】
  en0 169.254.154.133  ←铜线 0.36ms→  eth0 169.254.1.2（只管理，无默认网关）
  Stash mixed 127.0.0.1:7890
  stash_lan_forward.py → :17890        wlan0 192.168.3.115 → 路由 192.168.3.1（日常上网）
       ▲ 仅 helper 握手                     │
       └────────────────────────────────────┘ HTTP_PROXY → Mac:17890

  Telegram ──(Mac 值班：本机 Stash)──► Mac Headless Bot
           ──(NAS 值班：helper 7212)──► NAS Headless（undici 已修、按令停止）

  NAS 抽卡 ──铜线──► Mac ComfyUI :8188 / SSH
```

网络真源：`~/.gemini/config/plugins/asustor-nas-ops-plugin/skills/asustor-nas-ops/references/nas-network-and-proxy.md`

---

## 2. Mac 桌面版 vs NAS 容器版 核心差异对比

### 2.1 核心配置与架构对比表

| 对比维度 | Mac 桌面版 (`com.copilot-telegram-bridge`) | NAS 容器版 (`copilot-bridge`) | 说明 |
| :--- | :--- | :--- | :--- |
| **宿主环境** | macOS / Apple Silicon (ARM64) | 华硕 AS6602T / Intel J4125 (Linux AMD64) | NAS 低功耗适合常驻，启动崩已修，容器按令停止以免 409 |
| **运行模式** | `mode=all`（Editor + Headless）或 Headless 独立守护 | **`mode=headless-only`** | NAS 无桌面 Editor |
| **桌面 GUI 依赖** | Editor 依赖 Copilot.app；Headless 守护不依赖窗口 | 无 GUI | **Mac 关机后 NAS Bot 不会自动顶上**：helper 冷启动要 `17890`；wlan0 掉了要 `/usr/sbin/netman start_wifi`；要 NAS 值班须先停 Mac Headless 再 `docker start copilot-bridge` |
| **出站网络** | Mac Stash `127.0.0.1:7890` | helper **US `7212`**（数据面出 **wlan0**） | **不是**「点一次 GLaDOS 就永久独立」。握手仍走 Mac `:17890` |
| **模型后端** | 指针：本机 `127.0.0.1:8317` **或** 铜线 `169.254.1.2:8317` | 容器内永远 `127.0.0.1:8317` | Mac 侧随时可切；NAS 不稳用 `switch-cliproxy-backend.sh mac` |
| **进程守护** | LaunchAgent `gui/501` KeepAlive | Docker（当前 `restart=no`，Mac 值班） | NAS 要值班再改回 `unless-stopped` |
| **人设记忆** | `../agent-memory/AGENTS.md`（相对 extension） | 挂载 `/app/agent-memory/AGENTS.md` | 真源在 copilot-extensions 仓库 |
| **持久化** | `~/.copilot/session-state/` | `/volume1/Docker/copilot-bridge/` | |

### 2.2 机器人角色与实例划分 (Bot Matrix)

| 机器人标识 | 机器人定位 | Mac 版支持 | NAS 版支持 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| **`HuiCopilotCliBot`** | 纯无头全功能主力 Bot | ✅ | ✅（须停 Mac 后再开） | 同一 Token **只能一端轮询** |
| **`SecondaryBotBot`** | 提示词反推专属 Bot | ✅ | ✅ | |
| **`Copilot` (Editor)** | 桌面编辑器联动 Bot | ✅ | ❌ | NAS 无桌面窗口 |

---

## 3. NAS 版反向控制 Mac 执行本地任务（ComfyUI 抽卡）

NAS 机器人修好并值班时，涉及 Mac 本地计算走下面两条链路。

### 3.1 链路 A：ComfyUI HTTP API 直通（推荐）

* **原理**：Mac ComfyUI 监听铜线口 `169.254.154.133:8188`
* **调用流程**：
  1. Telegram 发送抽卡提示词或 `/card`
  2. NAS 向 `http://169.254.154.133:8188/prompt` 提交 Workflow
  3. Mac GPU 渲染
  4. NAS 从 `/view` 取图回传 Telegram

### 3.2 链路 B：铜线 SSH 跨机指令调度

```bash
ssh shuaihui@169.254.154.133 "python3 ~/Desktop/cu-card/main.py --prompt '...'"
```

延迟约 **0.36ms**（直连网线）。

### 3.3 oixcloud-helper 点火（不是「点一次就独立」）

* NAS **有** USB Wi-Fi 上网：`wlan0` `192.168.3.115` → `192.168.3.1`。铜线只做管理，不是「没有外网」。
* helper 从官网拉节点列表：必须经 Mac **Stash** `169.254.154.133:17890`（`stash_lan_forward.py` → `127.0.0.1:7890`）。**不要**用 oixCloud 桌面口 `6152/6153`，也 **不要**写 GLaDOS 当握手通道。
* `17890` **没有 LaunchAgent**，会话没了转发就没了。
* 节点口起来后，**业务包**走 `7212` 出 wlan0，不必再经 Mac 转发。
* helper **重启 / NAS 重启 / 配置过期** → 常出现 `config unavailable`，必须再点一次 Mac Stash + `17890`。
* USB 口还在但 `iw: No such device`：铜线 SSH 执行 `/usr/sbin/netman start_wifi`。

---

## 4. 切流步骤

> [!IMPORTANT]
> **同一 Bot Token 只能一端 `getUpdates`。** 当前生产：Mac 值班，NAS `copilot-bridge` 保持停止。undici 启动崩已在 NAS `src` 锁到 `8.0.2`。

### 步骤 1：Telegram 测 Mac Headless

1. 打开 **`HuiCopilotCliBot`**
2. `/ping` 或 `/start`
3. 再测一条长回复与人设

### 步骤 2：Mac 守护

```bash
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh install   # LaunchAgent KeepAlive
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh status
```

临时停 Mac（将来 NAS 修好切流时）：

```bash
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh stop
# 或
launchctl bootout gui/$(id -u)/com.copilot-telegram-bridge 2>/dev/null || true
```

### 步骤 3：NAS 侧（修好后再开）

```bash
ssh root@169.254.1.2 "docker stop copilot-bridge"    # Mac 值班时保持停
ssh root@169.254.1.2 "docker start copilot-bridge"   # 仅当 Mac Headless 已停
```

---

## 5. 物理目录与运维速查

### 5.1 NAS 部署目录（`/volume1/Docker/copilot-bridge/`）

```text
/volume1/Docker/copilot-bridge/
├── compose.yaml
├── src/
├── config/
│   ├── models.json           # Mac：cliproxy.baseUrl 是值班指针（本机或铜线）；NAS 容器内永远 127.0.0.1:8317
│   ├── bots.json
│   └── access.json
└── agent-memory/
    ├── AGENTS.md
    └── prompt-reverse.md
```

### 5.2 运维命令

```bash
# Mac
bash ~/.copilot/extensions/copilot-telegram-bridge/scripts/headless-daemon.sh status

# NAS（管理只走 169.254.1.2）
ssh root@169.254.1.2 "docker logs --tail 30 copilot-bridge"
ssh root@169.254.1.2 "docker ps -a --filter name=copilot-bridge"
```

---

## 6. 常见故障

| 故障现象 | 根因 | 处理 |
| :--- | :--- | :--- |
| **Telegram 409 Conflict** | 两端同时轮询同一 Token | 停掉其中一端（见 §4） |
| **NAS 容器 `markAsUncloneable`** | `undici` ≥8.0.3 在 Node 20 无 `worker_threads.markAsUncloneable` | NAS `src` 已 `npm install undici@8.0.2 --save`。不要升回 8.10，除非镜像换成 Node ≥22.19 |
| **getUpdates 超时** | `7212` 未就绪或 wlan0 掉了 | `curl -sS http://169.254.1.2:6172/health`；`iw dev wlan0 link`；必要时 `/usr/sbin/netman start_wifi` + Mac `17890` 后 `docker restart oixcloud-helper` |
| **helper `config unavailable`** | 当握手通道 | Stash Connected + `stash_lan_forward.py` 在听 `17890` |
| **ComfyUI 抽卡无响应** | 未绑铜线口 | ComfyUI `--listen 0.0.0.0` 或 `169.254.154.133` |
