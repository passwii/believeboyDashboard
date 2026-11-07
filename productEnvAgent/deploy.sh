#!/usr/bin/env bash
# Push main, then deploy the unified Dashboard image stack locally.
#
# VPS systemd application units are no longer the production runtime. All four
# backend processes plus Web now run from the API/Web GHCR image pair managed by
# deploy/docker-compose.yml.
#
# Usage:
#   git deploy                  # push main, build/push images, deploy through Actions
#   DEPLOY_METHOD=ssh git deploy # emergency direct deployment over SSH
#   PUSH_ONLY=1 git deploy      # push main only; skip image build and deployment
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [[ "$current_branch" != "main" ]]; then
  echo "git deploy must run from main; current branch: ${current_branch:-detached}" >&2
  exit 1
fi

changed_files="$(git diff --name-only origin/main..HEAD 2>/dev/null || true)"
if printf '%s\n' "$changed_files" | grep -qE '^backend/'; then
  echo "Checking Alembic migration graph..."
  python "$repo_root/backend/scripts/check_alembic.py"
fi

echo "Pushing main to origin..."
git push origin main

if [[ "${PUSH_ONLY:-0}" == "1" ]]; then
  echo "PUSH_ONLY=1; skipping image build and VPS deployment."
  exit 0
fi

echo "Building and deploying the Dashboard stack..."
exec "$repo_root/deploy/deploy-local.sh"
