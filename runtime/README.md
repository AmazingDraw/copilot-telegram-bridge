# Vendored Copilot CLI / SDK

Headless 守护 **只读** 本目录，不扫 Copilot.app Caches，也不读 PATH 上的 `copilot`。

```text
runtime/
  VERSION                 # 当前钉死的版本号（进 Git）
  <ver>/cli/copilot       # 宿主二进制（gitignore）
  <ver>/pkg/              # 同版本整包（gitignore）
    copilot-sdk/
    preloads/extension_bootstrap.mjs
    …                     # app.js / builtin / napi / wasm 等
```

`headless-daemon.sh` 实际执行：

```bash
runtime/<ver>/cli/copilot  runtime/<ver>/pkg/preloads/extension_bootstrap.mjs
# COPILOT_SDK_PATH=runtime/<ver>/pkg/copilot-sdk
```

二进制不进 Git；只跟踪 `VERSION` 与本说明。卸掉桌面 App 后 **不要删** `runtime/<VERSION>/`。

## 换版本

日常值班不需要 Copilot.app。要升到新 CLI/SDK，本机最稳的做法是 **临时装回桌面 App**，让它把成对文件解到 Caches，再拷进来：

```bash
# 1. 安装并打开一次 GitHub Copilot.app，等它解包完成
# 2. 拷成对 CLI + pkg，并给 vendored bootstrap 打 parent-pid 补丁
bash scripts/vendor-copilot-runtime.sh
# 3. 重启守护
bash scripts/headless-daemon.sh restart
# 4. 确认 status 里 align=vendored:<新版本>
# 5. 桌面 App 可以再卸掉
```

脚本源是：

```text
~/Library/Caches/github-copilot-sdk/cli/<ver>/copilot
~/Library/Caches/copilot/pkg/darwin-arm64/<ver>/
```

两处版本号必须一致，且 pkg 里要有 `copilot-sdk/` 和 `preloads/extension_bootstrap.mjs`。

没有桌面 App 时，也可以从另一台已解包的 Mac **手工** 把同一套 `cli/` + `pkg/` 放进 `runtime/<ver>/`，再把 `VERSION` 写成该 `<ver>`。

## 为什么 npm / brew CLI 不够

`npm` / `brew` 装的是终端聊天 CLI，一般 **没有** 扩展宿主：

- `extension_bootstrap.mjs`（用来加载 `~/.copilot/extensions/` 里的 Bridge）
- 与该 CLI **同版本** 的整包 `pkg/`（SDK、napi、wasm、builtin…）

PATH 上有 `copilot` 也接不上：守护不读 PATH。单装 `@github/copilot-sdk` 也替代不了 `pkg/copilot-sdk`。
