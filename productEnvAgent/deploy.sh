#!/usr/bin/env bash
# Push main, then use GitHub Actions for the complete default release path.
#
# VPS systemd application units are no longer the production runtime. The
# production Go API and Web images run from deploy/docker-compose.yml.
#
# Usage:
#   git deploy                  # push main, then Actions checks/builds/deploys
#   DEPLOY_METHOD=ssh git deploy # local checks/build with direct SSH fallback
#   PUSH_ONLY=1 git deploy      # push main only; do not dispatch a deployment
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [[ "$current_branch" != "main" ]]; then
  echo "git deploy must run from main; current branch: ${current_branch:-detached}" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files have uncommitted changes. Commit or stash them before deploying." >&2
  exit 1
fi

deploy_method="${DEPLOY_METHOD:-actions}"
case "$deploy_method" in
  actions | ssh) ;;
  *)
    echo "DEPLOY_METHOD must be either 'actions' or 'ssh' (current: $deploy_method)." >&2
    exit 1
    ;;
esac
if [[ "${PUSH_ONLY:-0}" != "1" && "$deploy_method" == "ssh" && \
  -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Untracked non-ignored files are present in the local Docker build context. Commit or remove them before deploying." >&2
  exit 1
fi

if [[ "${PUSH_ONLY:-0}" != "1" && "$deploy_method" == "ssh" ]]; then
  changed_files="$(git diff --name-only origin/main..HEAD 2>/dev/null || true)"
  if printf '%s\n' "$changed_files" | grep -qE '^(backend|backend-go)/'; then
    echo "Checking Goose migrations (Alembic is frozen at 285)..."
    (cd "$repo_root/backend-go" && go run ./cmd/checkmigrations)
  fi
fi

echo "Pushing main to origin..."
git push origin main

if [[ "${PUSH_ONLY:-0}" == "1" ]]; then
  echo "PUSH_ONLY=1; skipping image build and VPS deployment."
  exit 0
fi

if [[ "$deploy_method" == "actions" ]]; then
  echo "Dispatching GitHub Actions to check, build, and deploy the Dashboard stack..."
else
  echo "Using the local SSH fallback to check, build, and deploy the Dashboard stack..."
fi
export DEPLOY_METHOD="$deploy_method"
exec "$repo_root/deploy/deploy-local.sh"
