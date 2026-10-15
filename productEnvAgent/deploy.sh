#!/bin/bash
# productEnvAgent/deploy.sh — push main（VPS 部署已交给 GitHub Actions）
#
# 为什么不用 pre-push hook：
#   pre-push 天然跑在 push 之前，要触发"push 后 deploy"就得 hook 自己先
#   `git push --no-verify`，结果原始 push 还会再跑一次 → "remote rejected" 噪音。
#   改用显式 `git deploy` alias：单一 push、可观察、无竞态。
#
# 职责（2026-10-15 起）：
#   1. 当前分支必须是 main
#   2. backend/ 改动时先跑迁移图检查（fail-fast，防坏链上 main）
#   3. push 到 origin/main —— 部署由 .github/workflows/deploy-vps.yml 在 push 后自动完成
#      （同样按「命中 backend/ 才部署」判定，runner 从公网 SSH 进 VPS 跑 deploy_vps.py）
#
# 为什么把部署搬走：本机 IP 可能被 fail2ban 拦 / 机器可能不在线，本地 push 后直连
#   SSH 一旦失败，代码已上 main 而 VPS 未更新；CI 部署与 push 解耦，且天然串行
#   （workflow 有 concurrency 锁）。
#
# 跳过部署：
#   - commit message 带 `[skip ci]`（GitHub 内建跳过，workflow 整个不跑）
#   - 单次手动触发/预览：`gh workflow run deploy-vps.yml -f dry_run=true`
#
# 安装（在新 clone 的机器上）：
#   git config alias.deploy '!bash productEnvAgent/deploy.sh'
#
# 用法：
#   git deploy                    # push（+ backend/ 改动的迁移图检查），VPS 部署交给 CI
#   LOCAL_DEPLOY=1 git deploy     # 兜底：恢复旧的本地直连 SSH 部署（CI 不可用时用）
#   CI 状态：gh run list --workflow deploy-vps.yml --limit 3

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

# 5. 是否需要部署（判定与 workflow 的「判定本次 push 是否命中 backend/」对齐）
if ! printf '%s\n' "$changed_files" | grep -qE '^backend/'; then
    echo "→ No backend/ changes in this push; skipping VPS deploy"
    echo "  (前端改动由 Vercel 自动部署，无需后端操作)"
    exit 0
fi

# 6. 默认：部署交给 GitHub Actions（push 后 workflow 自动跑 deploy_vps.py --auto）
if [[ "${LOCAL_DEPLOY:-0}" != "1" ]]; then
    echo ""
    echo "→ Backend changes detected：部署已交给 GitHub Actions（.github/workflows/deploy-vps.yml）"
    echo "  查看进度：gh run list --workflow deploy-vps.yml --limit 3"
    echo "  手动触发：gh workflow run deploy-vps.yml"
    echo "  本地兜底：LOCAL_DEPLOY=1 git deploy"
    exit 0
fi

# 7. 兜底路径：本地直连 SSH 部署（LOCAL_DEPLOY=1）
repo_root="$(git rev-parse --show-toplevel)"
echo "→ LOCAL_DEPLOY=1，使用本地直连 SSH 部署..."
if ! python "$repo_root/productEnvAgent/deploy_vps.py" --auto; then
    echo "" >&2
    echo "⚠️  代码已推送到 origin/main，但 VPS 部署失败。" >&2
    echo "⚠️  可让 CI 补齐：gh workflow run deploy-vps.yml（或本地重跑 deploy_vps.py --auto）" >&2
    exit 1
fi
