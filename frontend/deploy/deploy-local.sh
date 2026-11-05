#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND="$ROOT/frontend"

CONFIG_FILE="${DEPLOY_CONFIG_FILE:-$HOME/.config/believeboy-dashboard/deploy.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST in $CONFIG_FILE or the shell environment}"

DEPLOY_PATH="${DEPLOY_PATH:-/opt/believeboy-dashboard}"
APP_PORT="${APP_PORT:-3200}"
DOMAIN="${DOMAIN:-https://dash.believeboy.com}"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/passwii/believeboydashboard}"
ENV_FILE="${FRONTEND_ENV_FILE:-$FRONTEND/.env.local}"

for command in git pnpm docker ssh scp curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if [[ ! -f "$FRONTEND/package.json" || ! -f "$FRONTEND/pnpm-lock.yaml" ]]; then
  echo "Run this script from a complete believeboyDashboard checkout." >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files have uncommitted changes. Commit or stash them before deploying." >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]]; then
  echo "Warning: untracked files are present; they are not part of the release commit." >&2
fi

echo "Fetching origin/main..."
git -C "$ROOT" fetch --quiet origin main

SHA="$(git -C "$ROOT" rev-parse HEAD)"
MAIN_SHA="$(git -C "$ROOT" rev-parse origin/main)"

if [[ "$SHA" != "$MAIN_SHA" ]]; then
  echo "HEAD ($SHA) is not the latest origin/main ($MAIN_SHA)." >&2
  echo "Merge and pull the release commit before deploying." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing frontend runtime environment file: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required in $ENV_FILE}"
: "${BACKEND_API_BASE_URL:?BACKEND_API_BASE_URL is required in $ENV_FILE}"
: "${BACKEND_API_KEY:?BACKEND_API_KEY is required in $ENV_FILE}"

SECRET_BYTES="$(printf '%s' "$NEXTAUTH_SECRET" | wc -c | tr -d ' ')"
if (( SECRET_BYTES < 32 )); then
  echo "NEXTAUTH_SECRET must be at least 32 bytes (current: $SECRET_BYTES)." >&2
  exit 1
fi

if [[ -n "${DEPLOY_PLATFORM:-}" ]]; then
  PLATFORM="$DEPLOY_PLATFORM"
else
  REMOTE_ARCH="$(ssh "$DEPLOY_HOST" 'uname -m')"
  case "$REMOTE_ARCH" in
    x86_64 | amd64) PLATFORM="linux/amd64" ;;
    aarch64 | arm64) PLATFORM="linux/arm64" ;;
    *)
      echo "Unsupported VPS architecture: $REMOTE_ARCH" >&2
      exit 1
      ;;
  esac
fi

if [[ ! -d "$FRONTEND/node_modules" ||
  ! -f "$FRONTEND/node_modules/.modules.yaml" ]] ||
  [[ "$FRONTEND/pnpm-lock.yaml" -nt "$FRONTEND/node_modules/.modules.yaml" ]]; then
  (cd "$FRONTEND" && pnpm install --frozen-lockfile)
fi

(cd "$FRONTEND" && pnpm lint && pnpm test)

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

printf '%s' "$NEXTAUTH_SECRET" > "$TMP_DIR/nextauth_secret"
chmod 600 "$TMP_DIR/nextauth_secret"

{
  printf 'BACKEND_API_BASE_URL=%s\n' "$BACKEND_API_BASE_URL"
  printf 'BACKEND_API_KEY=%s\n' "$BACKEND_API_KEY"
  printf 'NEXTAUTH_SECRET=%s\n' "$NEXTAUTH_SECRET"
  printf 'AUTH_SECRET=%s\n' "$NEXTAUTH_SECRET"
  printf 'NEXTAUTH_URL=%s\n' "$DOMAIN"
  printf 'AUTH_URL=%s\n' "$DOMAIN"
  printf 'NEXT_PUBLIC_CRM_API_MODE=http\n'
} > "$TMP_DIR/app.env"
chmod 600 "$TMP_DIR/app.env"

IMAGE_TAG="sha-$SHA"
echo "Building $IMAGE_NAME:$IMAGE_TAG for $PLATFORM..."
build_image() {
  docker buildx build \
    --platform "$PLATFORM" \
    --push \
    --secret id=nextauth_secret,src="$TMP_DIR/nextauth_secret" \
    --tag "$IMAGE_NAME:$IMAGE_TAG" \
    --tag "$IMAGE_NAME:latest" \
    --label "org.opencontainers.image.revision=$SHA" \
    --label "org.opencontainers.image.source=https://github.com/passwii/believeboyDashboard" \
    "$FRONTEND"
}

# GHCR occasionally resets the connection while pushing a secondary tag. The
# immutable SHA tag may already be present, so a retry is cheap: BuildKit reuses
# the completed layers and only retries the registry operation.
for attempt in 1 2 3; do
  if build_image; then
    break
  fi
  if (( attempt == 3 )); then
    echo "Image push failed after 3 attempts." >&2
    exit 1
  fi
  echo "Image push failed (attempt $attempt/3); retrying..." >&2
  sleep 5
done

echo "Syncing Compose and runtime environment to $DEPLOY_HOST:$DEPLOY_PATH..."
ssh "$DEPLOY_HOST" "install -d -m 755 '$DEPLOY_PATH' && umask 077 && cat > '$DEPLOY_PATH/app.env'" \
  < "$TMP_DIR/app.env"
scp "$FRONTEND/deploy/docker-compose.yml" \
  "$DEPLOY_HOST:$DEPLOY_PATH/docker-compose.yml"

echo "Deploying $IMAGE_TAG..."
# The values intentionally expand on the local machine before ssh runs.
# shellcheck disable=SC2029
ssh "$DEPLOY_HOST" \
  "IMAGE_TAG='$IMAGE_TAG' DEPLOY_PATH='$DEPLOY_PATH' APP_PORT='$APP_PORT' bash -s" \
  < "$FRONTEND/deploy/deploy-remote.sh"

for attempt in $(seq 1 10); do
  if curl -fsS --max-time 10 "$DOMAIN/healthz" >/dev/null; then
    echo "Deployed $DOMAIN from $IMAGE_TAG"
    exit 0
  fi
  sleep 2
done

echo "Container is local-healthy, but $DOMAIN/healthz is not reachable yet." >&2
exit 1
