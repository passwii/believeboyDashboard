#!/bin/bash
# productEnvAgent/deploy.sh — push main + 自动部署 VPS（替代旧 pre-push hook）
#
# 为什么不用 pre-push hook：
#   pre-push 天然跑在 push 之前，要触发"push 后 deploy"就得 hook 自己先
#   `git push --no-verify`，结果原始 push 还会再跑一次 → "remote rejected" 噪音。
#   改用显式 `git deploy` alias：单一 push + deploy，可观察、无竞态。
#
# 触发条件（与旧 hook 对齐）：
#   1. 当前分支必须是 main
#   2. origin/main..HEAD 命中 backend/ 路径才会 deploy；纯前端/docs/配置改动只推不部署
#
# 跳过 deploy：
#   - 直接 `git push origin main` 即可（旧 SKIP_POST_PUSH_DEPLOY 环境变量已废弃）
#   - 或 `git push origin :main` 这种 refspec 不会进此脚本
#
# 安装（在新 clone 的机器上）：
#   git config alias.deploy '!bash productEnvAgent/deploy.sh'
#
# 用法：
#   git deploy                # push + 条件 deploy
#   git push origin main      # 只 push 不 deploy（前端改动走这条）

set -euo pipefail

# 1. 必须从 main 分支触发
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [[ "$current_branch" != "main" ]]; then
    echo "❌ git deploy 必须从 main 分支执行，当前在：${current_branch:-detached}" >&2
    echo "   切到 main 后重试，或直接用 'git push origin main' 只推代码不部署" >&2
    exit 1
fi

# 2. 计算本次 push 会带上的改动文件清单
if git rev-parse origin/main &>/dev/null; then
    changed_files="$(git diff --name-only origin/main..HEAD 2>/dev/null || true)"
else
    # origin/main 不可达（罕见）：保守全文件当改动，后续 deploy 会被触发
    changed_files="$(git ls-tree -r --name-only HEAD)"
fi

# 3. alembic 迁移图检查（backend/ 改动时，fail-fast 防坏链上 main）
if printf '%s\n' "$changed_files" | grep -qE '^backend/'; then
    repo_root="$(git rev-parse --show-toplevel)"
    echo "→ Checking alembic migration graph..."
    if ! python "$repo_root/backend/scripts/check_alembic.py"; then
        echo "❌ Alembic 迁移图检查未通过，已中止 push（修复方法见上方输出）。" >&2
        echo "   多 head 用：alembic merge heads --rev-id <下一序号> -m \"merge xxx\"" >&2
        exit 1
    fi
fi

# 4. push 到 origin（push 失败就中断，不进入 deploy）
echo "→ Pushing main to origin..."
git push origin main

# 5. 判断是否需要 deploy
if ! printf '%s\n' "$changed_files" | grep -qE '^backend/'; then
    echo "→ No backend/ changes in this push; skipping VPS deploy"
    echo "  (前端改动由 Vercel 自动部署，无需后端操作)"
    exit 0
fi

# 6. deploy 到 VPS
repo_root="$(git rev-parse --show-toplevel)"
echo "→ Backend changes detected, deploying to VPS..."
if ! python "$repo_root/productEnvAgent/deploy_vps.py" --auto; then
    echo "" >&2
    echo "⚠️  代码已推送到 origin/main，但 VPS 部署失败。" >&2
    echo "⚠️  请手动补齐部署：python productEnvAgent/deploy_vps.py --auto" >&2
    exit 1
fi
