# Vendored Copilot CLI / SDK

Headless 守护 **只读** 本目录，不扫 Copilot.app Caches，也不读 PATH 上的 `copilot`。

```text
runtime/
  VERSION                 # 当前钉死的版本号（进 Git）
  <ver>/cli/copilot       # 宿主二进制（gitignore）
  <ver>/pkg/              # 同版本整包（gitignore）
    copilot-sdk/
    preloads/extension_bootstrap.mjs
    …                     # app.js / napi / wasm 等（不包含 builtin / builtin-skills）
```

`headless-daemon.sh` 实际执行：

```bash
runtime/<ver>/cli/copilot  runtime/<ver>/pkg/preloads/extension_bootstrap.mjs
# COPILOT_SDK_PATH=runtime/<ver>/pkg/copilot-sdk
```

二进制不进 Git；只跟踪 `VERSION` 与本说明。

## 换版本

从 npm **平台包**拉成对 CLI+pkg（含 `extension_bootstrap.mjs`），不需要 Copilot.app：

```bash
# 当前平台 latest（macOS arm64 → @github/copilot-darwin-arm64）
bash scripts/vendor-copilot-runtime.sh

# 钉死版本
bash scripts/vendor-copilot-runtime.sh 1.0.80

# 重启守护
bash scripts/headless-daemon.sh restart
# 确认 status 里 align=vendored:<新版本>
```

镜像可用 `NPM_REGISTRY`（默认 `https://registry.npmjs.org`）。包大约 300MB+。拷完会删掉 `pkg/builtin`、`pkg/builtin-skills` 以及 `.DS_Store` / `._*` / `.extraction-complete`。

`npm i -g @github/copilot` / brew 装到 PATH 的仍不够：守护不读 PATH，要的是 `runtime/<ver>/cli` + 整包 `pkg/`。vendor 脚本拉的是 `@github/copilot-<plat>`，不是那个薄包装。

离线备选：

- `bash scripts/vendor-copilot-runtime.sh --from-cache`：若本机还有 App 解过的 Caches
- 或从另一台已 vendor 的机器拷 `runtime/<ver>/`，把 `VERSION` 写成该 `<ver>`

## GitHub 登录

`runtime/` 只解决 **有没有成对 CLI+pkg**。进程要起来，宿主仍要一份 GitHub Copilot 身份（OAuth / 带 Copilot 权限的 token）。日常推理可以全走 cliproxy，登录门禁还在 CLI 上。

用**本目录**的 `cli/copilot login`，不要用 PATH 上另一份。步骤见 [`../doc/headless-daemon.md`](../doc/headless-daemon.md)「登录与鉴权」。
