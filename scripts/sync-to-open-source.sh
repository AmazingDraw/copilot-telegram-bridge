#!/usr/bin/env bash
# sync-to-open-source.sh — 本地 telegram-bridge → 开源版单向同步
# 用法: bash scripts/sync-to-open-source.sh ["中文说明"]
#
# 机制:
#   1. 复制本地 git 追踪文件到开源目录（token/密钥文件天然排除，因 .gitignore 忽略）
#   2. 脱敏替换个人路径/账号名/bot 名（本地私有 → 开源通用占位）
#   3. git add/commit/push 到 AmazingDraw/copilot-telegram-bridge
# 以后本地改完，跑本脚本即可同步开源版。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPEN_DIR="/Users/shuaihui/Projects/GitHub Copilot/copilot-telegram-bridge"
COMMIT_MSG="${1:-sync from local telegram-bridge}"

if [[ ! -d "${OPEN_DIR}/.git" ]]; then
  echo "❌ 开源目录未初始化 git: ${OPEN_DIR}"
  echo "   先运行: cd '${OPEN_DIR}' && git init && gh repo create AmazingDraw/copilot-telegram-bridge --public --source=. --push"
  exit 1
fi

echo "==> 1/3 复制本地追踪文件 → 开源目录"
cd "${SRC_DIR}"
# 复制所有 git 追踪的文件（保留相对路径；.gitignore 已排除 token/密钥）
# 排除开源版不需要的文件（内部文档）
EXCLUDE_FILES="doc/README.md doc/prompt-reverse-bot.md"
for f in $(git ls-files); do
  if [[ " ${EXCLUDE_FILES} " == *" ${f} "* ]]; then
    echo "  （跳过）${f}"
    continue
  fi
  mkdir -p "${OPEN_DIR}/$(dirname "$f")"
  cp "$f" "${OPEN_DIR}/$f"
done

echo "==> 2/3 脱敏替换（个人 → 通用占位）"
cd "${OPEN_DIR}"

# doc: GitHub 账号 / bot 名 / 同步脚本路径
sed -i '' \
  -e 's|ShuaiHui/copilot-extensions|AmazingDraw/copilot-telegram-bridge|g' \
  -e 's|@ShuaiCopilotBot|@YourCopilotBot|g' \
  -e 's|@PromptReverseBot|@YourPromptReverseBot|g' \
  -e 's|/Users/shuaihui/.copilot/extensions|~/.copilot/extensions|g' \
  doc/*.md 2>/dev/null || true

# codex-commands: 无绝对路径（已用 ${HOME} 占位），无需额外替换

# models.json: 泛化本机特有路径（amazing-draw → your-plugin 占位），保持开源版通用
sed -i '' \
  -e 's|\${HOME}/.gemini/config/plugins/amazing-draw-plugin/skills/amazing-draw|\${HOME}/.gemini/config/plugins/your-plugin/skills/your-skill|g' \
  config/models.json

echo "==> 3/3 提交并推送"
cd "${OPEN_DIR}"
git add -A
git commit -m "${COMMIT_MSG}" 2>/dev/null || echo "（无改动可提交）"
git push origin main 2>/dev/null || echo "（push 失败或无需 push）"

echo "✅ 同步完成: ${OPEN_DIR}"
