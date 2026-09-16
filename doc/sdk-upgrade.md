# SDK / runtime 升级规程（两阶段：先看内容 → 确认 → 再升）

> 触发：`bash scripts/vendor-copilot-runtime.sh [版本]`
> 目的：**升级前先确定升级内容**，确认后才动手；升级后由运行期自证验收。
> 这套不是"记得核对"，而是**代码层固化**——预览、闸门、运行期护栏各司其职。

---

## 1. 一条命令的两阶段

```bash
# ① 只看不升：上游 changelog + 6 个关键面 diff（不下载整包、不碰运行中的守护）
bash scripts/preflight-sdk-diff.sh            # 目标 = npm latest
bash scripts/preflight-sdk-diff.sh 1.0.90     # 指定版本

# ② 确认无误才升级（默认交互确认；关键面有变化时要求完整输入 yes）
bash scripts/vendor-copilot-runtime.sh 1.0.90
```

`vendor-copilot-runtime.sh` 自己也会**先跑 ①**，所以"忘了先预览"这件事不会发生：

```text
→ 预览（changelog + 关键面 diff）
→ 闸门：无变化 = 输入 y 继续；关键面有变化 / 预览没做成 = 必须输入 yes
→ 下载 → sha1 校验 → 停守护 → 换 runtime → 软化 bootstrap → 写 VERSION → 自动拉起 → 打 status
```

| 参数 | 作用 |
| :--- | :--- |
| （无） | 交互确认（推荐） |
| `--yes` | 无人值守跳过确认 —— **自行承担确认责任**；非 TTY 环境必须显式给，否则一律拒绝 |
| `--no-preflight` | 跳过预览（离线场景） |
| `--from-cache` | 离线安装，隐含跳过预览 |

**非交互环境（无 TTY）默认拒绝升级**，并打印"先看预览 / 确认后加 `--yes`"两条命令 —— 不让脚本在无人值守时悄悄换运行时。

---

## 2. 六个核对面

`preflight-sdk-diff.sh` 逐面 diff，退出码 **0=无变化 / 1=关键面有变化 / 2=门闩 pattern 不命中（别升）/ 3=预览没做成**。

| # | 面 | 为什么盯它 | 变化时怎么办 |
| :-- | :--- | :--- | :--- |
| ① | `SystemMessageSection` 段名 | SDK 对未知 section 的 `remove` 是 **silent no-op** → 段名一改，人设裁剪**静默失效** | 对齐 `lib/byok-providers.mjs` 的 `EXPECTED_SDK_SECTIONS` + `doc/system-prompts.md` §3 |
| ② | `permissions` RPC 面 | 1.0.83 把 `setAllowAll/getAllowAll` 换成了 `setMode/getMode`（本次踩过） | 对齐 `lib/bot-handlers.mjs` 的 `applySessionPermissionMode` |
| ③ | `PermissionMode` 取值 | 模式的合法字符串变了会让 `setMode` 报错/失效 | 同步 `manual / assisted / allow-all` 三元组 |
| ④ | `SessionConfig` 字段 | 字段改名 → 我们注入的配置**被静默忽略**（skills/MCP/人设都靠它） | 检查 `byok-providers` 里对应字段名 |
| ⑤ | SDK 导出符号 | 新机制（如 managed 策略层）通常先以新导出/新字段出现 | 判断是否要用；不强制 |
| ⑥ | bootstrap 父进程门闩 pattern | pattern 不命中 = 软化打不上 = **launchd 崩循环**（1.0.83 就是这么炸的） | 对齐 `scripts/patch-bootstrap-compat.py`；pattern miss 时脚本会**拒绝升级** |

> 🔑 **单一真源**：软化逻辑只在 `scripts/patch-bootstrap-compat.py`（daemon / vendor / preflight 三处共用）；
> 平台名与版本解析只在 `scripts/runtime-common.sh`。检查器与被检查的实际行为**同源**，不会各说一套。

---

## 3. 升级后：三道运行期自证（看 `bots/Headless/daemon.log`）

```text
systemMessage 护栏已启用（SDK 目录 12 段，与本方裁剪交叉校验）
systemMessage section 护栏 ok：SDK 12 段 / 本方裁剪 6 段全部命中     ← 段名没漂移
[Headless]     permissions.setMode(allow-all) ok allow-all→allow-all success=true
resolveBootstrapPath: __dir=…/runtime/<ver>/pkg                      ← 跑的是 vendored pkg
```

* **护栏**：`SYSTEM_MESSAGE_SECTIONS` 交叉校验，段名漂移会**响亮告警**（不再静默失效）
* **权限姿态**：`before→after` + `success/mode` 由服务端权威回读，而不是"我们以为设上了"
* **运行时来源**：`status` 里 `dist=runtime/<ver>/pkg`，日志里 `__dir` 必须指向 vendored pkg（不是 Caches）

漂移告警长这样（出这行才需要动手）：

```text
⚠️ systemMessage section 漂移 —— 本方裁剪但 SDK 已无: [guidelines]（remove 会**静默失效**，CLI 底模会渗进来）; SDK 新增未评估: [brand_new_section]（判断是否该裁）
```

---

## 4. 常见场景

| 场景 | 做法 |
| :--- | :--- |
| 例行升级 | `preflight`（或直接 vendor，它会先跑）→ 看结论 → 交互 `y`/`yes` |
| 无人值守 / 脚本里升级 | `vendor-copilot-runtime.sh <ver> --yes`（先人工看过预览） |
| 离线机器 | `vendor-copilot-runtime.sh --from-cache`（不查 npm、不预览） |
| 预览取不到（unpkg 不可达） | 退出码 3：**不代表有变化**，但闸门会要求输入 `yes`；网络恢复后重试更稳 |
| 回滚到旧版本 | `vendor-copilot-runtime.sh <旧版本> --yes` —— 预览会报"反向漂移"（这是正常的），但代码里的 feature-detect 保证旧 API 仍可用 |
| 只想知道上游有没有新版 | `bash scripts/preflight-sdk-diff.sh`（同版本会直接告诉你"与当前相同"） |

---

## 4.1 升级后先跑隔离烟测（比拿生产试安全）

```bash
cd ~/.copilot/extensions/copilot-telegram-bridge
node scripts/probe-isolated-session.mjs --send          # 生产式（保留身份）
node scripts/probe-isolated-session.mjs --no-auth --send # 真·无身份（清 token env + PATH 去掉 gh）
node scripts/probe-isolated-session.mjs --provider cliproxy-nas --model cursor-auto --send
                                                     # 只装配指定上游（modelSets.*.provider 绑定值）+ 钉死模型
```

`--provider <id>` / `--model <id>`（2026-09-16 加）用来验"换上游"那条链路：
绑到 本机时从 GUI App 里跑会 `fetch failed`（Stash 逐进程接管出口）→ 用 launchd 上下文跑，
见 [`models-config.md`](./models-config.md) §6「GUI App 里探 NAS 上游」。

临时 `COPILOT_HOME` + 独立 spawn 一个 CLI 子进程 → 验证 `start / getAuthStatus / listModels / createSession / send`
五步，**完全不碰生产 `~/.copilot`**；硬指标是 `start`/`createSession`/`send`，退出码 0 = 通过。
新 runtime 若在这五步里任一步炸，先修它再动守护。

---

## 4.2 SDK 能力取舍（已用 / 待做 / 搁置）

> 升级前对着这张表看 diff 结果：**已用**那些一旦变化就必须跟着改；**搁置**那些变化可以先不理。

| 能力 | 是什么 | 我们的取舍 |
| :--- | :--- | :--- |
| `disabledMcpServers` | 精确名禁用 MCP（创建/冷恢复不启动、不鉴权） | ✅ **已用**（MCP ①层，见 `headless-daemon.md` §4.1） |
| `RuntimeConnection.forStdio({ args })` | 给 runtime 子进程加参数（**前置追加**，不顶掉 `--headless/--stdio`） | ✅ **已用**（MCP ②层） |
| `permissions.setMode` / `getMode` | 取代旧 `setAllowAll`/`getAllowAll`；**返回权威** post-mutation mode | ✅ **已用**（`allow-all`/`manual` + `before→after` 自证） |
| `SYSTEM_MESSAGE_SECTIONS` 运行时导出 | 系统提示词段名目录 | ✅ **已用**（段名漂移护栏，见 `system-prompts.md` §3.1） |
| `includedBuiltinSkills` | 内置技能白名单；**只在 `mode:"empty"` 下**"省略 = 全不要" | ✅ **已用**（内建技能全关） |
| `CopilotClient({ mode: "empty" })` | SDK 原话：默认 `copilot-cli` **不要用于多用户服务**。硬要求：`baseDirectory`／`sessionFs` ＋ 每会话 `availableTools`；工具过滤变 **deny-wins** | ✅ **已用**（`baseDirectory=~/.copilot` ⇒ sticky 会话位置不变；普通 bot `["builtin:*","mcp:*","custom:*"]`、专用 bot `[]` 无工具） |
| `sess.rpc.skills.list()` | 读回会话**实际**技能面（含 enabled） | ✅ **已用**（技能面自证） |
| `client.getAuthStatus()` | 读回身份实况（`isAuthenticated`/`authType`/`statusMessage`） | ✅ **已用**（每次连接打一行身份自证） |
| `CopilotClient({ useLoggedInUser: false })` | SDK 据此给 runtime 传 **`--no-auto-login`**（禁用 OAuth/gh 自动登录检测） | ✅ **已用**（`auth.login=false` ⇒ 不登录，见 `models-config.md` §1.1） |
| `managedSettings.permissions` | 企业策略层：`deny`/`ask`/`allow` ＋ `disableBypassPermissionsMode`；**startup-only 不持久**；规则写错会**拒建会话** | ⏸️ **明确搁置**（主人"后面再说"） |
| `githubMcpToolConfig` / `enableMcpApps` | 内置 GitHub MCP 的开关面 | ➖ 用不到：它只在 `enableConfigDiscovery: true` 时注入，我们没开 |
| `createAttributedPermissionResult` | 给权限决策打**遥测归因**（"never changes permission behavior"） | ➖ 可选，收益低 |
| CLI `--disable-mcp-server` / `--disable-builtin-mcps` | 进程级 MCP 开关 | ✅ 已用（MCP ②层） |

---

## 5. 为什么不靠"手动核对清单"

今天踩的两个坑都不是"没看文档"，而是**失败是静默的**：

1. `setAllowAll` 被删除 → 调用报错被 try/catch 吞掉，权限面有一半**悄悄失效**（靠 handler 兜住才没炸）
2. `customize.sections` 的 `remove` 对未知段是 **no-op** → 段名一改，CLI 身份会悄悄渗回人设

所以规程的重心是**让静默变响亮**：运行期两道自证 + 升级前后两道 diff/闸门。
