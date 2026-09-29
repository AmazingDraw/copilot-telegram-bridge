# Copilot Telegram Bridge 工具调用权限精细化控制设计与配置规范

> **文档性质**：架构设计、权限控制机制剖析与未来配置实施规范  
> **所属工程**：`~/.copilot/extensions/copilot-telegram-bridge`  
> **目标**：详细阐明 Bridge 中工具调用权限的多层防御架构，定义标准配置 Schema，实现后续需要时**一步到位、即配即用**。

---

## 〇、架构全景：四层立体防御体系

Copilot Bridge 的工具权限控制不是单点的，而是由 **4 层递进式安全漏斗** 构成的完整防御体系：

```text
+-------------------------------------------------------------------------------+
| ① 静态工具面暴露层 (Static Tool Surface Filtering)                           |
|    • 控制模型「看得到哪些工具」                                               |
|    • availableTools / excludedTools / disabledMcpServers / skillNames         |
+---------------------------------------+---------------------------------------+
                                        | (模型发起工具调用申请)
                                        v
+---------------------------------------+---------------------------------------+
| ② 运行时权限姿态层 (Session RPC Mode)                                          |
|    • 决定当前会话底座是「全自动放行」还是「委托 Host 审计」                   |
|    • permissions.setMode("allow-all" | "manual")                              |
+---------------------------------------+---------------------------------------+
                                        | (进入 manual 模式，抛出事件)
                                        v
+---------------------------------------+---------------------------------------+
| ③ 动态规则防火墙 (Dynamic onPermissionRequest Gatekeeper)                     |
|    • Bridge 在代码层实时解析操作类型、参数、命令特征与路径                    |
|    • [安全只读] ──→ 自动放行 (approve-once)                                   |
|    • [高危破坏] ──→ 自动阻断并反馈原因 (deny-once)                            |
|    • [写盘/未知] ──→ 移交人工审批                                             |
+---------------------------------------+---------------------------------------+
                                        | (需要主人裁决)
                                        v
+-------------------------------------------------------------------------------+
| ④ Telegram 交互审批终端 (Interactive Approval Card)                           |
|    • 推送带 Diff 预览、命令高亮与参数明细的结构化消息卡片                     |
|    • [✅ 允许 (Approve)] | [❌ 拒绝 (Reject)] 实时回调，超时 10min 自动安全闭环 |
+-------------------------------------------------------------------------------+
```

---

## 一、各层实现机制与技术底层

### 1. 静态工具面暴露层（模型可见性控制）

利用 Copilot SDK 在 `mode: "empty"` 下的工具过滤机制。当客户端处于 `empty` 模式时，SDK 会启用 `toolFilterPrecedence: "excluded"`（即**拒绝优先于允许**，支持“允许集合 A，但强行排除其中 B”的自然语义）。

#### (1) 工具名匹配语法（Pattern Matching）
SDK 支持 4 类源限定与通配符语法：
- `builtin:*`：所有 Copilot 内置工具（`read_file`, `edit_file`, `bash`, `view`, `glob`, `grep` 等）
- `builtin:<name>`：精确匹配内置工具，例如 `builtin:read_file`
- `mcp:*`：所有已挂载 MCP 服务器提供的工具
- `mcp:<serverName>__*` 或 `mcp:<toolName>`：指定 MCP 服务提供的工具
- `custom:*`：自定义扩展或 Agent 工具

#### (2) 静态排除（Deny-wins）
通过 `excludedTools` 显式列出要封杀的工具。即使 `availableTools` 声明了 `builtin:*`，只要 `excludedTools` 中包含 `builtin:bash`，模型就绝对无法感知到终端执行工具。

#### (3) 核心控制字段
- **`availableTools`**：工具白名单数组。若设为 `[]`，则模型完全没有工具可用。
- **`excludedTools`**：工具黑名单数组。排除优先级高于白名单。
- **`disabledMcpServers`**：MCP 服务级硬禁用。运行时在冷启动与热恢复阶段都不会启动这些 MCP 进程。
- **`skillNames` / `skillSet`**：Skills 技能白名单。Bridge 会通过 `materializeSkillAllowDir` 在临时目录仅符号链接白名单内的技能，未被允许的技能连元数据都不会注入上下文。

---

### 2. 运行时权限姿态层（Session Permission Mode）

会话建立后，Bridge 通过 RPC 与运行时的 `permissions` 模块通信：
- **`allow-all`**：调用 `permissions.setMode({ mode: "allow-all" })` 且 `setApproveAll({ enabled: true })`。所有工具调用在 SDK 内部直接通过，不触发外部询问。
- **`manual`**：调用 `permissions.setMode({ mode: "manual" })` 且 `setApproveAll({ enabled: false })`。所有工具调用都会暂停，并向 Bridge 注册的 `onPermissionRequest(request)` 抛出事件等待决策。

---

### 3. 动态规则防火墙（onPermissionRequest 判定引擎）

当会话处于 `manual` 模式时，SDK 每次调用工具都会传入详细的 `PermissionRequest` 对象：

| `request.kind` | 附带的关键参数 | 审计与判定依据 |
| :--- | :--- | :--- |
| **`read`** | `request.path` | 文件读取绝对路径。可检查是否越界访问敏感私密文件。 |
| **`write`** | `request.fileName`<br>`request.diff` | 目标修改文件及代码变更 Diff。可核实修改范围、是否触碰系统文件。 |
| **`shell`** | `request.fullCommandText`<br>`request.warning`<br>`request.intention` | 完整终端命令行、SDK 评估的风险告警与执行意图。 |
| **`mcp`** | `request.serverName`<br>`request.toolName`<br>`request.args` | MCP 服务名、工具名及调用参数对象。 |
| **`url`** | `request.url` | 发起网络出站访问的完整 URL。可进行域名白名单过滤。 |

判定引擎返回 3 种权威决策结果之一：
1. **`{ kind: "approve-once" }`**：批准本次调用执行。
2. **`{ kind: "deny-once", feedback: "拒绝原因" }`**：直接拦截本次调用，并将拒绝原因回填给模型，模型会收到失败提示并调整思路。
3. **返回 `Promise`**：向 Telegram 触发人机交互卡片，等待手机端点击或超时。

---

### 4. Telegram 交互审批终端（人机协同状态机）

Bridge 的 `lib/bot-handlers.mjs` 中已封装完整的异步等待与卡片渲染流水线：
- **卡片内容构造**：将操作类型、意图、高危警告、格式化命令、以及裁剪至 2000 字符以内的安全 Diff，组装为 Telegram HTML 消息。
- **按键绑定**：生成唯一的 `reqId`（如 `perm_abc123`），绑定 Inline Keyboard：
  - `[✅ 允许 (Approve)]` -> 回调触发 `resolve({ kind: "approve-once" })`
  - `[❌ 拒绝 (Reject)]` -> 回调触发 `resolve({ kind: "deny-once" })`
- **生命周期与超时**：设定 10 分钟倒计时计时器。若超时未点击，自动触发拒批，并将已发出的 Telegram 消息编辑为 `⏱ 已超时（自动拒绝）`，消息卡片原地失效。

---

## 二、精细化规则库设计（防火墙规则）

当启用智能混合模式（`permissionMode: "smart"`）时，动态防火墙建议采用以下规则表：

### 1. 命令与操作白名单（自动放行 Fast-Path）

符合以下特征的请求，无需人工点击，直接秒通：

```javascript
// 1. 安全只读 Shell 命令白名单
const SAFE_READ_COMMANDS = /^\s*(ls|cat|head|tail|grep|rg|pwd|which|where|git status|git diff|git log|git branch|node -v|python3? --version|pnpm -v|npm -v)\b/;

// 2. 安全读取路径（工作区及受管目录内）
function isSafeReadPath(filePath) {
    const safePrefixes = [
        process.env.HOME + "/.agents/workspace",
        process.env.HOME + "/Projects",
    ];
    return safePrefixes.some(prefix => filePath.startsWith(prefix));
}
```

### 2. 高危与破坏性黑名单（硬拦截 Hard-Deny）

命中以下任意特征的请求，直接就地阻断，并提示安全违规：

```javascript
// 破坏性文件删除与磁盘擦除
/(^|[;&|\s])(rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]|mkfs|dd\s+if=)/

// 破坏性 Git 远端与本地历史重写
/\bgit\s+(push\b.*(--force|-f)|reset\s+--hard|clean\s+-[a-zA-Z]*f)/

// 提权与全局权限篡改
/(^|[;&|\s])(sudo|su|chmod\s+-R\s+777|chown\s+-R)/

// 敏感凭证与系统核心路径写入
const SENSITIVE_WRITE_PATHS = [
    /\/\.ssh\//,
    /\/\.bashrc$/,
    /\/\.bash_profile$/,
    /\/\.zshrc$/,
    /\/etc\//,
    /\/System\//,
    /\/Library\/LaunchAgents\//
];
```

---

## 三、配置 Schema 与场景模板（`config/bots.json`）

后续需要开启精细化控制时，只需在 `config/bots.json` 的对应 Bot 对象中添加配置项即可一步到位生效：

### 场景 A：开发全自动无感模式（现网 Headless 默认）
完全信任模型，所有工具自动放行，适合日常全自动执行任务：
```json
{
  "Headless": {
    "permissionMode": "allow-all",
    "loadMcp": true,
    "loadSkills": true,
    "clientMode": "empty"
  }
}
```

不加载任何工具，彻底断绝执行能力，100% 防注入：
```json
{
    "permissionMode": "deny-all",
    "loadMcp": false,
    "loadSkills": false,
    "availableTools": [],
    "clientMode": "empty"
  }
}
```

### 场景 C：智能安全守卫模式（Smart / Hybrid，强烈推荐）⭐
- 只读与安全查询命令**秒级自动放行**；
- 高危指令（`rm -rf` / `git push -f` / 越界写配置）**直接拦截拒批**；
- 正常的代码写入（`write`）、执行未知脚本（`shell`）**向 Telegram 推送 Diff 卡片等主人批准**。
```json
{
  "Headless": {
    "permissionMode": "smart",
    "loadMcp": true,
    "loadSkills": true,
    "clientMode": "empty",
    "permissionPolicy": {
      "autoApproveReads": true,
      "autoApproveSafeShell": true,
      "blockDangerousShell": true,
      "blockSensitiveWrites": true,
      "askFileWrites": true,
      "askUnknownShell": true
    }
  }
}
```

### 场景 D：严格代码审计模式（Read-Only Sandbox）
只能阅读和分析代码，绝对不允许修改任何文件，也不允许运行任何修改命令：
```json
{
  "AuditBot": {
    "permissionMode": "smart",
    "clientMode": "empty",
    "availableTools": [
      "builtin:read_file",
      "builtin:view",
      "builtin:glob",
      "builtin:grep"
    ],
    "excludedTools": [
      "builtin:edit_file",
      "builtin:write_file",
      "builtin:bash"
    ]
  }
}
```

---

## 四、未来落地实施路线图（代码改动极小）

未来主人发出指令落地该功能时，整个项目仅需微调 **3 个核心文件** 即可完整交付：

1. **`lib/bot-profile.mjs`**：
   - 允许读取 `bot.availableTools` 与 `bot.excludedTools` 用户自定义数组；
   - 扩展 `permissionMode` 识别 `"smart"` 模式，解析 `permissionPolicy` 策略对象。
2. **`lib/byok-providers.mjs`**：
   - 将 `excludedTools` 透传至 `buildHeadlessSessionConfig` 并注入 `CopilotClient` 的会话参数中。
3. **`lib/bot-handlers.mjs`**：
   - 在 `createPermissionHandler()` 中增加 `mode === "smart"` 的分支逻辑：
     执行“高危正则拦截 -> 只读白名单放行 -> Telegram 弹卡片”的三段式流转。

所有底层协议均已被当前钉死的 Copilot SDK `1.0.86` 原生支持，零版本升级阻碍，架构高度自洽。
