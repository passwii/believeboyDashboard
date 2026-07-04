#!/bin/bash
# Git pre-push hook template: push main 时自动部署到 VPS
#
# 实现细节:
#   git 没有原生 post-push hook(client-side,git 原生 push 相关 hook
#   只有 pre-push / post-update / post-receive),所以这里用 pre-push
#   反向:hook 在 git push 之前触发,先 GIT_SKIP_HOOKS=1 git push 实际
#   推送(绕过自身防递归),然后调 productEnvAgent/deploy_vps.py --auto
#   在 VPS 上 git pull → alembic upgrade head → systemctl restart。
#
# 关闭:
#   - SKIP_POST_PUSH_DEPLOY=1(临时)
#   - 或 chmod -x .git/hooks/pre-push(长期)
#
# 安装:
#   cp productEnvAgent/pre-push.sh .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#
# 或全局(对新 clone 生效):
#   mkdir -p ~/.git-templates/hooks
#   cp productEnvAgent/pre-push.sh ~/.git-templates/hooks/pre-push
#   chmod +x ~/.git-templates/hooks/pre-push
#   git config --global init.templateDir ~/.git-templates

set -euo pipefail

if [[ "${SKIP_POST_PUSH_DEPLOY:-0}" == "1" ]]; then
    exit 0
fi

remote="${1:-}"

deploy_main=false
push_refspecs=()
while read -r local_ref local_sha remote_ref remote_sha; do
    push_refspecs+=("$local_ref:$remote_ref")
    if [[ "$remote_ref" == "refs/heads/main" ]]; then
        deploy_main=true
    fi
done

if [[ "$deploy_main" != "true" ]]; then
    exit 0
fi

echo "→ Auto-deploying to VPS after push to main..."

# 1. 实际推送(绕过自身防递归)
GIT_SKIP_HOOKS=1 git push "$remote" "${push_refspecs[@]}"

# 2. VPS 部署:VPS 上 git pull → alembic → restart
repo_root="$(git rev-parse --show-toplevel)"
python "$repo_root/productEnvAgent/deploy_vps.py" --auto