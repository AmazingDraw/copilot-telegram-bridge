# Vendored Copilot CLI / SDK

Headless 守护**只用本目录**（CLI 二进制 + 整包 `pkg/`），不扫 Copilot.app Caches，也不读 PATH 上的 `copilot`。（CLI 会在 `pkg/` 里写 `inuse.<pid>.lock` 占用标记、vendor 时会清掉，属正常。）

```text
runtime/
  VERSION                 # 当前钉死的版本号（进 Git）
  <ver>/cli/copilot       # 宿主二进制（gitignore）
  <ver>/pkg/              # 同版本整包（gitignore）——它**就是** CLI 的 JS 运行时
    copilot-sdk/
    preloads/extension_bootstrap.mjs
    …                     # app.js / builtin / assets / wasm 等，完整整包
```

`headless-daemon.sh` 实际执行：

```bash
COPILOT_CLI_DIST_DIR=runtime/<ver>/pkg     # ← CLI 的 JS 运行时也钉在这里
COPILOT_AUTO_UPDATE=false                  # 禁掉自动下载/自动换版本
runtime/<ver>/cli/copilot  runtime/<ver>/pkg/preloads/extension_bootstrap.mjs
# COPILOT_SDK_PATH=runtime/<ver>/pkg/copilot-sdk
```

**为什么需要 `COPILOT_CLI_DIST_DIR`**：宿主 CLI 是 SEA，默认会把自己内嵌的 `copilot.tgz` **自解包**到 `~/Library/Caches/copilot/pkg/<plat>/<ver>/`，并从那里 `import index.js`；而 `index.js` 的 `resolveBootstrapPath()` 又**优先**用该目录的 `preloads/extension_bootstrap.mjs`，argv 传进去的路径会被丢弃。于是「只软化 vendored 副本」= 打给永不执行的文件，原版父进程门闩会静默 `exit(0)` → launchd 崩循环（2026-09-13 升级 1.0.83 就是这么炸的）。
`COPILOT_CLI_DIST_DIR` 把 `__dir` 钉回 `runtime/<ver>/pkg`，argv 那份**就是**生效文件，**全程不读 Caches**。
⚠️ 一旦带上它，就**不能**再传 `--prefer-version`（那个 flag 会让 DIST_DIR 直接被忽略）。

二进制不进 Git；只跟踪 `VERSION` 与本说明。

## 换版本（两阶段）

```bash
# ① 只看不升：上游 changelog + 6 个关键 API 面 diff（不下载整包、不碰运行中的守护）
bash scripts/preflight-sdk-diff.sh [版本]

# ② 确认后才升级（脚本自己会先跑 ①；关键面有变化要**完整输入 yes**；非 TTY 环境须显式 --yes）
bash scripts/vendor-copilot-runtime.sh [版本] [--yes] [--no-preflight]
#    脚本还会：拉 npm 平台包 → sha1 校验 → 停守护 → 换 runtime → 软化 bootstrap → 写 VERSION → 自动拉起 → 打 status
```

- 镜像用 `NPM_REGISTRY`（默认 `https://registry.npmjs.org`）；包大约 300MB+。
- 规程（六个核对面 / 退出码 0-1-2-3 / 场景表）：[`../doc/sdk-upgrade.md`](../doc/sdk-upgrade.md)。

**换完先跑隔离烟测**（临时 `COPILOT_HOME` + 独立 spawn，**完全不碰生产**）：

```bash
node scripts/probe-isolated-session.mjs --send            # 生产式（保留身份）
node scripts/probe-isolated-session.mjs --no-auth --send   # 真·无身份
# 五步：start / getAuthStatus / listModels / createSession / send；退出码 0 = 通过
```

**验证换版是否生效**：`status` 里 `dist=runtime/<ver>/pkg` 且 `align=vendored:<新版本>`；
`daemon.log` 里应出现 `resolveBootstrapPath: __dir=…/runtime/<ver>/pkg`（而不是 Caches）。

**`pkg/` 的正文取自 CLI 二进制内嵌的 `copilot.tgz`**：脚本会临时跑一次 `cli/copilot --version`，让 CLI 自己解包到 `COPILOT_PKG_CACHE_HOME` 指定的临时目录，再 rsync 过来。原因：npm 平台包里的 JS 与二进制内嵌那份只差 `package.json`（`@github/copilot-<plat>` vs `@github/copilot`），而 `app.js` 会读它 —— 既然整个 `pkg/` 就是运行时，就必须与 CLI 自解包的版本逐字节一致。
只清真正的垃圾：`.DS_Store` / `._*` / 残留 `inuse.*.lock` / 旧 `preloads/*.bak-compat-*`；`builtin/`、`builtin-skills/`、`assets/`、`changelog.json`、`.extraction-complete` **全部保留**（合计仅 ~1.4MB，剥掉会变成难查的静默失败）。

`npm i -g @github/copilot` / brew 装到 PATH 的仍不够：守护不读 PATH，要的是 `runtime/<ver>/cli` + 整包 `pkg/`。vendor 脚本拉的是 `@github/copilot-<plat>`，不是那个薄包装。

离线备选（日常升级不需要，`~/Library/Caches/copilot/pkg` 已清空）：

- `bash scripts/vendor-copilot-runtime.sh --from-cache`：仅当本机还有 App 解过的 Caches 时才可用（`pkg/` 正文同样取自自解包，不用那份缓存）
- 或从另一台已 vendor 的机器拷 `runtime/<ver>/`，把 `VERSION` 写成该 `<ver>`

## GitHub 身份：默认**不登录**（byok-only）

`runtime/` 只解决「有没有成对 CLI+pkg」；**身份是另一件事，而现在默认故意不要身份**：

| 配置 | 行为 |
| :--- | :--- |
| **`config/models.json → auth.login: false`（当前）** | **不登录**：启动时清掉身份 env（`COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_API_KEY`）＋ SDK 给 runtime 传 **`--no-auto-login`**（CLI 原话：*Disable automatic login detection (stored OAuth tokens and gh CLI)*）。官方模型面自动视为关闭。 |
| `auth.login: true` | 保留 GitHub 身份、可用官方模型（另需 `display.officialModels.enabled: true`） |

**实测（2026-09-13 隔离 + 生产）**：无身份时 `start` / `createSession` / **BYOK 回合**全通，只有官方模型面不可用（`listModels` → `Not authenticated`）—— 而它已被自动跳过。自证日志（每次连接都打）：

```text
telegram-bridge: GitHub 登录已关闭（auth.login=false）→ 清除身份 env: COPILOT_API_KEY；runtime 将以无身份启动（SDK 传 --no-auto-login）
telegram-bridge: [Headless] auth: isAuthenticated=false (Not authenticated)
```

**要切回官方模型**：`auth.login: true` + `display.officialModels.enabled: true` → `restart`，并用**本目录**的 CLI 重登（不要用 PATH 上另一份）：

```bash
cd ~/.copilot/extensions/copilot-telegram-bridge
VER=$(tr -d '[:space:]' < runtime/VERSION)
# ⚠️ 必须带 COPILOT_CLI_DIST_DIR，否则 CLI 会自解包重建 ~/Library/Caches/copilot/pkg（该缓存已删）
COPILOT_CLI_DIST_DIR="$PWD/runtime/$VER/pkg" COPILOT_AUTO_UPDATE=false "runtime/$VER/cli/copilot" login
bash scripts/headless-daemon.sh restart
```

**排查 401 的先验知识**：身份来源顺序 `COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN` → `gh` CLI → keychain；
CLI 只认 fine-grained PAT（需 **`Copilot Requests`** 权限）/ OAuth，**不认经典 `ghp_`**。
⚠️ 另注：`CopilotClient({ mode: "empty" })`（无头在用）会让 SDK 给 runtime 注入 **`COPILOT_DISABLE_KEYTAR=1`**（关掉 keychain）
⇒ 遇到 401 **优先查 env token**。细节见 [`../doc/headless-daemon.md`](../doc/headless-daemon.md) §6 与 [`../doc/models-config.md`](../doc/models-config.md) §1.1。
