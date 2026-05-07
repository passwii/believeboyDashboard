
#!/bin/bash
# Git post-push hook for automated deployment
# Install: cp post-push.sh ~/.git-templates/hooks/post-push
# Then: git init --template ~/.git-templates in existing repos

# Only deploy on pushes to main branch
# $1 = local branch name, $2 = remote branch URL
if [[ "$1" == "main" ]]; then
    echo "→ Auto-deploying to VPS after push to main..."
    cd /Users/damon/DamonProjects/believeboyDashboard/productEnvAgent
    python deploy_vps.py --auto
fi
