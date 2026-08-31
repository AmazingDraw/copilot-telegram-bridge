# Vendored Copilot CLI / SDK

Headless daemon **only** reads this directory. It does not scan Copilot.app caches.

```bash
bash scripts/vendor-copilot-runtime.sh
```

That copies a matched CLI + pkg pair from `~/Library/Caches/...` into `runtime/<VERSION>/` and patches `extension_bootstrap.mjs`. Binaries are gitignored; `VERSION` is tracked.

After Copilot.app is uninstalled, do **not** delete `runtime/<VERSION>/`.
