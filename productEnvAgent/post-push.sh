#!/bin/bash
# ⚠️ 弃用说明：git 没有内置的 post-push hook，把本文件装成 .git/hooks/post-push
#    也不会被 git 自动调用。自动部署请改用仓库已安装的 .git/hooks/pre-push
#    （仅 backend/ 改动触发，且用 --no-verify 避免递归）。本文件仅供手动执行参考。
#
# Git post-push hook for automated deployment.
#
# Behavior:
#   - On every `git push`, if the local ref being pushed is `main`, run
#     `productEnvAgent/deploy_vps.py --auto` against the configured VPS.
#   - Uses a path resolved relative to the repo root (via `git rev-parse
#     --show-toplevel`), so the hook works no matter where the worktree
#     is checked out (e.g. the user's `~/DamonProjects/...` and the
#     Multica agent's `~/multica_workspaces_.../.../workdir/...`).
#
# ⚠️ 注意：git 不会自动调用 post-push。下面只是手动执行 / 参考用，
#    不要指望装成 .git/hooks/post-push 后自动部署。
# Install (manual reference only):
#   1. Copy to .git/hooks/post-push and `chmod +x` it (NOT auto-invoked by git)
#   2. Or just run `python productEnvAgent/deploy_vps.py --auto` directly
#
# Disable temporarily by passing `SKIP_POST_PUSH_DEPLOY=1` in the env.

set -euo pipefail

# Skip in CI / when explicitly disabled.
if [[ "${SKIP_POST_PUSH_DEPLOY:-0}" == "1" ]]; then
    exit 0
fi

# $1 = local ref name, $2 = remote URL. Both are passed by git.
local_ref="${1:-}"
remote_url="${2:-}"

# Only deploy on pushes to main. `refs/heads/main` is the canonical form
# git passes; `main` is accepted as a convenience for manual invocation.
case "$local_ref" in
    "main"|"refs/heads/main") ;;
    *) exit 0 ;;
esac

# Resolve repo root from inside a worktree or a regular checkout.
repo_root="$(git rev-parse --show-toplevel)"
deploy_script="$repo_root/productEnvAgent/deploy_vps.py"

if [[ ! -f "$deploy_script" ]]; then
    echo "post-push: deploy script not found at $deploy_script — skipping" >&2
    exit 0
fi

echo "→ Auto-deploying to VPS after push to main..."
echo "  ref:        $local_ref"
echo "  remote:     $remote_url"
echo "  deploy cmd: python deploy_vps.py --auto"

cd "$repo_root/productEnvAgent"
python deploy_vps.py --auto
