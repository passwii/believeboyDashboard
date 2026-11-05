#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG_FILE:-$HOME/.config/believeboy-dashboard/deploy.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

: "${DEPLOY_HOST:?Set DEPLOY_HOST in $CONFIG_FILE or the shell environment}"

DEPLOY_PATH="${DEPLOY_PATH:-/opt/believeboy-dashboard}"
DOMAIN="${DOMAIN:-https://dash.believeboy.com}"
WEB_IMAGE_NAME="${WEB_IMAGE_NAME:-ghcr.io/passwii/believeboydashboard-web}"
API_IMAGE_NAME="${API_IMAGE_NAME:-ghcr.io/passwii/believeboydashboard-api}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple}"
INTERNAL_AI_PROVIDER_BASE_URL="${INTERNAL_AI_PROVIDER_BASE_URL:-http://127.0.0.1:3100/v1}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-$ROOT/frontend/.env.local}"

for command in git pnpm docker ssh scp curl python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files have uncommitted changes. Commit or stash them before deploying." >&2
  exit 1
fi

if [[ -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]]; then
  echo "Warning: untracked files are present; they are not part of the release commit." >&2
fi

echo "Fetching origin/main..."
fetch_ok=0
for attempt in 1 2 3 4 5; do
  if git -C "$ROOT" -c http.version=HTTP/1.1 fetch --quiet origin main; then
    fetch_ok=1
    break
  fi
  echo "git fetch failed (attempt $attempt/5); retrying..." >&2
  sleep 5
done
if (( fetch_ok == 0 )); then
  echo "Unable to fetch origin/main after 5 attempts." >&2
  exit 1
fi

SHA="$(git -C "$ROOT" rev-parse HEAD)"
MAIN_SHA="$(git -C "$ROOT" rev-parse origin/main)"
if [[ "$SHA" != "$MAIN_SHA" ]]; then
  echo "HEAD ($SHA) is not the latest origin/main ($MAIN_SHA)." >&2
  exit 1
fi

if [[ ! -f "$FRONTEND_ENV_FILE" ]]; then
  echo "Missing frontend environment file: $FRONTEND_ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$FRONTEND_ENV_FILE"
set +a

: "${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required in $FRONTEND_ENV_FILE}"
: "${BACKEND_API_KEY:?BACKEND_API_KEY is required in $FRONTEND_ENV_FILE}"
: "${BACKEND_API_BASE_URL:?BACKEND_API_BASE_URL is required in $FRONTEND_ENV_FILE}"

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

if [[ ! -d "$ROOT/frontend/node_modules" ||
  ! -f "$ROOT/frontend/node_modules/.modules.yaml" ]] ||
  [[ "$ROOT/frontend/pnpm-lock.yaml" -nt "$ROOT/frontend/node_modules/.modules.yaml" ]]; then
  (cd "$ROOT/frontend" && pnpm install --frozen-lockfile)
fi

python3 "$ROOT/backend/scripts/check_alembic.py"
(cd "$ROOT/frontend" && pnpm lint && pnpm test)

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

printf '%s' "$NEXTAUTH_SECRET" > "$TMP_DIR/nextauth_secret"
chmod 600 "$TMP_DIR/nextauth_secret"

printf 'BACKEND_API_BASE_URL=%s\n' "$BACKEND_API_BASE_URL" > "$TMP_DIR/web.env"
printf 'BACKEND_INTERNAL_URL=http://127.0.0.1:8100\n' >> "$TMP_DIR/web.env"
printf 'BACKEND_PUBLIC_API_BASE_URL=%s\n' "$BACKEND_API_BASE_URL" >> "$TMP_DIR/web.env"
printf 'BACKEND_API_KEY=%s\n' "$BACKEND_API_KEY" >> "$TMP_DIR/web.env"
printf 'NEXTAUTH_SECRET=%s\n' "$NEXTAUTH_SECRET" >> "$TMP_DIR/web.env"
printf 'AUTH_SECRET=%s\n' "$NEXTAUTH_SECRET" >> "$TMP_DIR/web.env"
printf 'NEXTAUTH_URL=%s\n' "$DOMAIN" >> "$TMP_DIR/web.env"
printf 'AUTH_URL=%s\n' "$DOMAIN" >> "$TMP_DIR/web.env"
printf 'NEXT_PUBLIC_CRM_API_MODE=http\n' >> "$TMP_DIR/web.env"
chmod 600 "$TMP_DIR/web.env"

IMAGE_TAG="sha-$SHA"

build_with_retry() {
  local label="$1"
  shift
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then
      return 0
    fi
    if (( attempt == 3 )); then
      echo "$label failed after 3 attempts." >&2
      return 1
    fi
    echo "$label failed (attempt $attempt/3); retrying..." >&2
    sleep 5
  done
}

build_api() {
  docker buildx build \
    --platform "$PLATFORM" \
    --push \
    --build-arg "PIP_INDEX_URL=$PIP_INDEX_URL" \
    --tag "$API_IMAGE_NAME:$IMAGE_TAG" \
    --tag "$API_IMAGE_NAME:latest" \
    --label "org.opencontainers.image.revision=$SHA" \
    --metadata-file "$TMP_DIR/api-meta.json" \
    --file "$ROOT/backend/Dockerfile" \
    "$ROOT"
}

build_web() {
  docker buildx build \
    --platform "$PLATFORM" \
    --push \
    --secret id=nextauth_secret,src="$TMP_DIR/nextauth_secret" \
    --tag "$WEB_IMAGE_NAME:$IMAGE_TAG" \
    --tag "$WEB_IMAGE_NAME:latest" \
    --label "org.opencontainers.image.revision=$SHA" \
    --metadata-file "$TMP_DIR/web-meta.json" \
    "$ROOT/frontend"
}

echo "Building API image for $PLATFORM..."
build_with_retry "API image build" build_api
echo "Building Web image for $PLATFORM..."
build_with_retry "Web image build" build_web

api_digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' "$TMP_DIR/api-meta.json")"
web_digest="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["containerimage.digest"])' "$TMP_DIR/web-meta.json")"
API_IMAGE="$API_IMAGE_NAME@$api_digest"
WEB_IMAGE="$WEB_IMAGE_NAME@$web_digest"

echo "Preparing VPS directories and legacy fallback..."
ssh "$DEPLOY_HOST" "
  set -euo pipefail
  install -d -m 755 '$DEPLOY_PATH'
  install -d -m 755 '$DEPLOY_PATH/legacy'
  if [ -f '$DEPLOY_PATH/docker-compose.yml' ] && [ ! -f '$DEPLOY_PATH/legacy/docker-compose.yml' ]; then
    cp '$DEPLOY_PATH/docker-compose.yml' '$DEPLOY_PATH/legacy/docker-compose.yml'
  fi
  if [ -f '$DEPLOY_PATH/app.env' ] && [ ! -f '$DEPLOY_PATH/legacy/app.env' ]; then
    cp '$DEPLOY_PATH/app.env' '$DEPLOY_PATH/legacy/app.env'
  fi
  if [ ! -f '$DEPLOY_PATH/backend.env' ] && [ -f '/root/believeboyDashboard/backend/.env' ]; then
    install -m 600 '/root/believeboyDashboard/backend/.env' '$DEPLOY_PATH/backend.env'
  fi
  if grep -q '^AI_CHAT_PROVIDER_BASE_URL=' '$DEPLOY_PATH/backend.env'; then
    sed -i 's#^AI_CHAT_PROVIDER_BASE_URL=.*#AI_CHAT_PROVIDER_BASE_URL=$INTERNAL_AI_PROVIDER_BASE_URL#' '$DEPLOY_PATH/backend.env'
  fi
  install -d -m 755 '$DEPLOY_PATH/backend-storage' '$DEPLOY_PATH/celerybeat'
  if [ -d '/root/believeboyDashboard/backend/storage' ] && [ ! -f '$DEPLOY_PATH/.storage-migrated' ]; then
    cp -a '/root/believeboyDashboard/backend/storage/.' '$DEPLOY_PATH/backend-storage/'
    touch '$DEPLOY_PATH/.storage-migrated'
  fi
  if [ -d '/var/lib/believeboy' ] && [ ! -f '$DEPLOY_PATH/.celerybeat-migrated' ]; then
    cp -a '/var/lib/believeboy/.' '$DEPLOY_PATH/celerybeat/'
    touch '$DEPLOY_PATH/.celerybeat-migrated'
  fi
  chown -R 10001:10001 '$DEPLOY_PATH/backend-storage' '$DEPLOY_PATH/celerybeat'
  chmod 600 '$DEPLOY_PATH/backend.env'
"

ssh "$DEPLOY_HOST" "
  set -euo pipefail
  systemctl stop believeboy-beat.service 2>/dev/null || true
  systemctl stop believeboy-celery.service believeboy-celery-scheduled.service 2>/dev/null || true
  systemctl stop believeboy-api.service 2>/dev/null || true
  docker stop believeboy-dashboard 2>/dev/null || true
  docker rm believeboy-dashboard 2>/dev/null || true
"

ssh "$DEPLOY_HOST" "umask 077 && cat > '$DEPLOY_PATH/web.env'" < "$TMP_DIR/web.env"
scp "$ROOT/deploy/docker-compose.yml" "$DEPLOY_HOST:$DEPLOY_PATH/docker-compose.yml"

echo "Deploying API and Web..."
if ! ssh "$DEPLOY_HOST" \
  "API_IMAGE='$API_IMAGE' WEB_IMAGE='$WEB_IMAGE' DEPLOY_PATH='$DEPLOY_PATH' bash -s" \
  < "$ROOT/deploy/deploy-remote.sh"; then
  echo "Compose deployment failed; legacy services will not be restored automatically." >&2
  exit 1
fi

for attempt in $(seq 1 15); do
  if curl -fsS --max-time 10 "$DOMAIN/healthz" >/dev/null; then
    ssh "$DEPLOY_HOST" "
      systemctl disable believeboy-api.service believeboy-celery.service \
        believeboy-celery-scheduled.service believeboy-beat.service \
        >/dev/null 2>&1 || true
    "
    echo "Deployed $DOMAIN from $WEB_IMAGE"
    echo "Deployed API from $API_IMAGE"
    exit 0
  fi
  sleep 2
done

echo "Containers are locally healthy, but $DOMAIN/healthz is not reachable." >&2
exit 1
