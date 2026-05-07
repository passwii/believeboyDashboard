
#!/bin/bash
# Git post-push hook for automated deployment
# Install: cp post-push.sh ~/.git-templates/hooks/post-push
# Then: git init --template ~/.git-templates in existing repos

# Only deploy on pushes to origin/main
if echo "$1" | grep -q "origin/main"; then
    echo "→ Auto-deploying to VPS after push to origin/main..."
    cd /Users/damon/DamonProjects/believeboyDashboard/productEnvAgent
    python deploy_vps.py --auto
fi
