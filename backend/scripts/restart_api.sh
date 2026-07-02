#!/usr/bin/env bash
# Restart the production API with a clean bytecode cache.
#
# Required because uvicorn runs without --reload, and a fresh `git pull`
# leaves stale .pyc files in __pycache__/ which Python prefers over the
# new .py. Until the service is restarted with cleared caches the
# process keeps loading the pre-pull code.
#
# Usage:
#   bash backend/scripts/restart_api.sh
#   # or with sudo if the service is owned by root:
#   sudo bash backend/scripts/restart_api.sh

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-believeboy-api}"

# Auto-detect the repo root if not overridden. Looks for the backend
# directory by walking up from this script's location, then falls back
# to a few common production paths.
if [ -z "${REPO_ROOT:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CANDIDATE="$(cd "$SCRIPT_DIR/../.." && pwd)"
    if [ -d "$CANDIDATE/backend" ]; then
        REPO_ROOT="$CANDIDATE"
    elif [ -d /root/believeboyDashboard/backend ]; then
        REPO_ROOT=/root/believeboyDashboard
    elif [ -d /home/damon/believeboyDashboard/backend ]; then
        REPO_ROOT=/home/damon/believeboyDashboard
    else
        REPO_ROOT="$CANDIDATE"
    fi
fi

USER_NAME="${USER_NAME:-$(stat -c %U "$REPO_ROOT" 2>/dev/null || echo root)}"

cd "$REPO_ROOT"

echo "==> git pull"
sudo -u "$USER_NAME" git pull

echo "==> clearing __pycache__ under $REPO_ROOT"
# Find every __pycache__ dir and remove it. We intentionally don't use
# `find -delete` on individual files because some __pycache__ trees are
# symlinked and we want the directory itself gone.
sudo -u "$USER_NAME" find . -name __pycache__ -type d -prune -exec rm -rf {} +

echo "==> restarting $SERVICE_NAME"
if command -v systemctl >/dev/null 2>&1; then
    systemctl restart "$SERVICE_NAME"
    sleep 2
    systemctl --no-pager status "$SERVICE_NAME" | head -8 || true
else
    # Fallback: pkill + relaunch via the same command line we found.
    pkill -9 -f "uvicorn app.main:app" || true
    sleep 1
    cd "$REPO_ROOT/backend"
    sudo -u "$USER_NAME" nohup .venv/bin/uvicorn app.main:app \
        --host 0.0.0.0 --port 8100 --no-access-log \
        > /tmp/api.log 2>&1 &
    disown || true
    sleep 3
    pgrep -af "uvicorn app.main:app" || echo "WARN: uvicorn not running"
fi

echo "==> done"
