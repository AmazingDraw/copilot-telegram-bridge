# Copilot Telegram Bridge

双向 Telegram 桥接：在手机 Telegram 里控制 **GitHub Copilot CLI / 桌面会话**。

## ✨ 功能

- **Telegram ↔ Copilot**：手机发指令，Copilot 执行并回复到 Telegram
- **多 Bot 支持**：Editor（桌面会话）/ Headless（独立守护）/ 自定义角色
- **无头守护**：LaunchAgent 托管，崩溃自愈、开机自启，不依赖桌面窗口
- **会话切换**：`/session` 列出历史会话，数字按钮快速切换
- **模型管理**：`/model` 列出并切换本地 BYOK 模型，配置全部在 `config/models.json`
- **Codex 子命令**：`/codex` 控制 OpenAI Codex CLI（新建/续接/排队/停止/取消）
- **富格式渲染**：表格 / 定义列表 / 引用 / 代码块等 Markdown → Telegram HTML

## 📦 安装

这是一个 **GitHub Copilot CLI 扩展**，需克隆到扩展加载目录 `~/.copilot/extensions` 才能被 Copilot 宿主加载。

```bash
# 1. 克隆到扩展目录（Copilot 宿主扫描此目录加载扩展）
mkdir -p ~/.copilot/extensions
git clone https://github.com/AmazingDraw/copilot-telegram-bridge.git ~/.copilot/extensions/copilot-telegram-bridge
cd ~/.copilot/extensions/copilot-telegram-bridge

# 2. 配置 config/bots.json（BotFather 创建 bot，填 token）
# 3. 配置 config/access.json（允许的 Telegram user id）
# 4. 复制 models.example → models.json 并按需改
# 5. 安装无头守护（LaunchAgent + 启动）
bash scripts/headless-daemon.sh install
```

> 之后重启 Copilot CLI / 桌面 App 让扩展加载。
> 详细文档见 [`doc/`](./doc/)：安装、配置、模型管理、无头守护、排障。

## 🚀 快速开始

1. **BotFather** 创建 bot，拿到 token → 填进 `config/bots.json`
2. **配对**：给 bot 发任意消息 → 生成配对码 → 回填 `config/access.json`
3. **启动**：`bash scripts/headless-daemon.sh start`
4. **验证**：Telegram 发 `/status` 看连接状态

## ⚙️ 配置

| 文件 | 作用 |
| :--- | :--- |
| `config/bots.json` | Bot token / 用户名 / 角色 / 权限 |
| `config/access.json` | 允许的 Telegram 用户 |
| `config/models.json` | 模型 / provider / 上下文窗口 / 显示规则 |
| `config/bots.example.json` | Bot 配置示例（复制为 bots.json） |
| `config/access.example.json` | 授权示例（复制为 access.json） |
| `config/models.example.json` | 模型配置示例（复制为 models.json） |

所有敏感信息（token / 用户 id）**不提交**到仓库（`.gitignore` 忽略）。

### 🔧 首次使用（复制示例 → 填真实值）

```bash
cp config/bots.example.json config/bots.json      # 填 BotFather token
cp config/access.example.json config/access.json  # 填你的 Telegram user id
cp config/models.example.json config/models.json  # 按需改模型
bash scripts/headless-daemon.sh install           # 装 LaunchAgent + 启动
```

`bots/` 目录会在首次连接时自动生成，无需手动创建。

## 🧩 架构

```text
Telegram ──► Long Poll ──► bot-runtime（消息路由/工具气泡/权限）
                 │
                 ├── Copilot SDK（Editor joinSession / Headless createSession）
                 ├── Codex CLI（/codex 子命令，独立执行）
                 └── Markdown → HTML 渲染管线
```

## 📄 License

MIT — see [LICENSE](./LICENSE)
