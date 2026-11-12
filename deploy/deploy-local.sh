#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DEPLOY_CONFIG_FILE:-$HOME/.config/believeboy-dashboard/deploy.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

# 2026-11-10：Go 后端全量迁移完成前冻结部署，只做本地 Docker 验证。
# 重新启用：DEPLOYMENTS_ENABLED=true（见 deploy/local.env.example）。
if [[ "${DEPLOYMENTS_ENABLED:-false}" != "true" ]]; then
  echo "Deployments are paused. Validate locally with Docker only until the Go backend migration is complete." >&2
  echo "Set DEPLOYMENTS_ENABLED=true to re-enable deployment." >&2
  exit 1
fi

DEPLOY_METHOD="${DEPLOY_METHOD:-actions}"
case "$DEPLOY_METHOD" in
  actions | ssh) ;;
  *)
    echo "DEPLOY_METHOD must be either 'actions' or 'ssh' (current: $DEPLOY_METHOD)." >&2
    exit 1
    ;;
esac

DEPLOY_PATH="${DEPLOY_PATH:-/opt/believeboy-dashboard}"
DOMAIN="${DOMAIN:-https://dash.believeboy.com}"
WEB_IMAGE_NAME="${WEB_IMAGE_NAME:-ghcr.io/passwii/believeboydashboard-web}"
GO_API_IMAGE_NAME="${GO_API_IMAGE_NAME:-ghcr.io/passwii/believeboydashboard-go-api}"
# The Go gateway now implements every OpenAPI operation, so the default is a
# full cutover: Web talks to 8200 and the gateway owns all modules. Unmatched
# paths still proxy to FastAPI and are logged. Set GO_API_OWNED_MODULES to a
# short list (or GO_API_INTERNAL_URL=8100) to fall back to a staged rollout.
GO_API_OWNED_MODULES="${GO_API_OWNED_MODULES:-all}"
GO_API_INTERNAL_URL="${GO_API_INTERNAL_URL:-http://127.0.0.1:8200}"
DEPLOY_FREE_SPACE_MIN_BYTES="${DEPLOY_FREE_SPACE_MIN_BYTES:-1073741824}"
DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES="${DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES:-536870912}"
DEPLOY_FREE_SPACE_PERCENT="${DEPLOY_FREE_SPACE_PERCENT:-0}"
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.org/simple}"
GO_MODULE_PROXY="${GO_MODULE_PROXY:-https://proxy.golang.org,direct}"
INTERNAL_AI_PROVIDER_BASE_URL="${INTERNAL_AI_PROVIDER_BASE_URL:-http://127.0.0.1:3100/v1}"
FRONTEND_ENV_FILE="${FRONTEND_ENV_FILE:-$ROOT/frontend/.env.local}"

if [[ "$DEPLOY_METHOD" == "ssh" ]]; then
  : "${DEPLOY_HOST:?Set DEPLOY_HOST in $CONFIG_FILE or the shell environment}"
fi

REQUIRED_COMMANDS=(git pnpm docker)
if [[ "$DEPLOY_METHOD" == "actions" ]]; then
  REQUIRED_COMMANDS+=(gh)
else
  REQUIRED_COMMANDS+=(ssh scp)
fi

for command in "${REQUIRED_COMMANDS[@]}"; do
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
  echo "Untracked non-ignored files are present in the Docker build context. Commit or remove them before deploying." >&2
  exit 1
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

if [[ "$GO_API_IMAGE_NAME" != "ghcr.io/passwii/believeboydashboard-go-api" ||
  "$WEB_IMAGE_NAME" != "ghcr.io/passwii/believeboydashboard-web" ]]; then
  echo "Deployment requires the fixed GHCR image names used by the VPS deploy script." >&2
  exit 1
fi

if [[ ! "$GO_API_OWNED_MODULES" =~ ^([a-z_]+(,[a-z_]+)*)?$ ]]; then
  echo "GO_API_OWNED_MODULES must be empty or a comma-separated list of lowercase module names." >&2
  exit 1
fi
if [[ "$GO_API_INTERNAL_URL" != "http://127.0.0.1:8100" &&
  "$GO_API_INTERNAL_URL" != "http://127.0.0.1:8200" ]]; then
  echo "GO_API_INTERNAL_URL must be http://127.0.0.1:8100 (FastAPI) or http://127.0.0.1:8200 (Go gateway)." >&2
  exit 1
fi
if [[ -n "$GO_API_OWNED_MODULES" && "$GO_API_INTERNAL_URL" != "http://127.0.0.1:8200" ]]; then
  echo "GO_API_OWNED_MODULES is set but GO_API_INTERNAL_URL does not route Web through the Go gateway (http://127.0.0.1:8200)." >&2
  exit 1
fi

: "${NEXTAUTH_SECRET:?NEXTAUTH_SECRET is required in $FRONTEND_ENV_FILE}"
if [[ "$DEPLOY_METHOD" == "ssh" ]]; then
  : "${BACKEND_API_KEY:?BACKEND_API_KEY is required in $FRONTEND_ENV_FILE}"
  : "${BACKEND_API_BASE_URL:?BACKEND_API_BASE_URL is required in $FRONTEND_ENV_FILE}"
  : "${GO_API_TRUSTED_PROXY_SECRET:?GO_API_TRUSTED_PROXY_SECRET is required in $CONFIG_FILE}"
  if [[ ! "$GO_API_TRUSTED_PROXY_SECRET" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "GO_API_TRUSTED_PROXY_SECRET must be 64 hexadecimal characters (openssl rand -hex 32)." >&2
    exit 1
  fi
fi

SECRET_BYTES="$(printf '%s' "$NEXTAUTH_SECRET" | wc -c | tr -d ' ')"
if (( SECRET_BYTES < 32 )); then
  echo "NEXTAUTH_SECRET must be at least 32 bytes (current: $SECRET_BYTES)." >&2
  exit 1
fi

PLATFORM="${DEPLOY_PLATFORM:-linux/amd64}"

if [[ ! -d "$ROOT/frontend/node_modules" ||
  ! -f "$ROOT/frontend/node_modules/.modules.yaml" ]] ||
  [[ "$ROOT/frontend/pnpm-lock.yaml" -nt "$ROOT/frontend/node_modules/.modules.yaml" ]]; then
  (cd "$ROOT/frontend" && pnpm install --frozen-lockfile)
fi

(cd "$ROOT/backend-go" && go run ./cmd/checkmigrations)
(cd "$ROOT/frontend" && pnpm lint && pnpm test)

TMP_DIR="$(mktemp -d)"
REMOTE_STAGING_DIR=""
cleanup() {
  local quoted_stage_dir
  local quoted_deploy_path
  rm -rf "$TMP_DIR" || true
  if [[ -n "$REMOTE_STAGING_DIR" ]]; then
    printf -v quoted_stage_dir '%q' "$REMOTE_STAGING_DIR"
    printf -v quoted_deploy_path '%q' "$DEPLOY_PATH"
    if ! ssh "$DEPLOY_HOST" "
      set -euo pipefail
      exec 9>$quoted_deploy_path/.deploy.lock
      if ! flock -n 9; then
        echo 'Skipping remote staging cleanup because another deployment holds the lock.' >&2
        exit 1
      fi
      rm -rf -- $quoted_stage_dir
    "; then
      echo "Warning: remote staging cleanup was deferred; the remote deployment owns its staging directory until its lock is released." >&2
    fi
  fi
}
trap cleanup EXIT

printf '%s' "$NEXTAUTH_SECRET" > "$TMP_DIR/nextauth_secret"
chmod 600 "$TMP_DIR/nextauth_secret"

if [[ "$DEPLOY_METHOD" == "ssh" ]]; then
  printf 'BACKEND_API_BASE_URL=%s\n' "$BACKEND_API_BASE_URL" > "$TMP_DIR/web.env"
  printf 'BACKEND_INTERNAL_URL=%s\n' "$GO_API_INTERNAL_URL" >> "$TMP_DIR/web.env"
  printf 'BACKEND_PUBLIC_API_BASE_URL=%s\n' "$BACKEND_API_BASE_URL" >> "$TMP_DIR/web.env"
  printf 'BACKEND_API_KEY=%s\n' "$BACKEND_API_KEY" >> "$TMP_DIR/web.env"
  printf 'GO_API_TRUSTED_PROXY_SECRET=%s\n' "$GO_API_TRUSTED_PROXY_SECRET" >> "$TMP_DIR/web.env"
  printf 'NEXTAUTH_SECRET=%s\n' "$NEXTAUTH_SECRET" >> "$TMP_DIR/web.env"
  printf 'AUTH_SECRET=%s\n' "$NEXTAUTH_SECRET" >> "$TMP_DIR/web.env"
  printf 'NEXTAUTH_URL=%s\n' "$DOMAIN" >> "$TMP_DIR/web.env"
  printf 'AUTH_URL=%s\n' "$DOMAIN" >> "$TMP_DIR/web.env"
  printf 'NEXT_PUBLIC_CRM_API_MODE=http\n' >> "$TMP_DIR/web.env"
  chmod 600 "$TMP_DIR/web.env"

  {
    printf 'GO_API_ADDR=127.0.0.1:8200\n'
    printf 'FASTAPI_ORIGIN=http://127.0.0.1:8100\n'
    printf 'GO_API_OWNED=%s\n' "$GO_API_OWNED_MODULES"
    printf 'GO_API_TRUSTED_PROXY_SECRET=%s\n' "$GO_API_TRUSTED_PROXY_SECRET"
  } > "$TMP_DIR/go.env"
  chmod 600 "$TMP_DIR/go.env"
fi

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

build_go_api() {
  docker buildx build \
    --platform "$PLATFORM" \
    --push \
    --build-arg "GOPROXY=$GO_MODULE_PROXY" \
    --tag "$GO_API_IMAGE_NAME:$IMAGE_TAG" \
    --label "org.opencontainers.image.revision=$SHA" \
    --metadata-file "$TMP_DIR/go-api-meta.json" \
    --file "$ROOT/backend-go/Dockerfile" \
    "$ROOT"
}

build_web() {
  docker buildx build \
    --platform "$PLATFORM" \
    --push \
    --secret id=nextauth_secret,src="$TMP_DIR/nextauth_secret" \
    --tag "$WEB_IMAGE_NAME:$IMAGE_TAG" \
    --label "org.opencontainers.image.revision=$SHA" \
    --metadata-file "$TMP_DIR/web-meta.json" \
    "$ROOT/frontend"
}

IMAGE_BUILD_STARTED_AT=$SECONDS
GO_API_BUILD_STARTED_AT=$SECONDS
echo "Building Go API image for $PLATFORM..."
build_with_retry "Go API image build" build_go_api
GO_API_BUILD_SECONDS=$((SECONDS - GO_API_BUILD_STARTED_AT))
WEB_BUILD_STARTED_AT=$SECONDS
echo "Building Web image for $PLATFORM..."
build_with_retry "Web image build" build_web
WEB_BUILD_SECONDS=$((SECONDS - WEB_BUILD_STARTED_AT))
IMAGE_BUILD_SECONDS=$((SECONDS - IMAGE_BUILD_STARTED_AT))
echo "Image build times: Go API ${GO_API_BUILD_SECONDS}s, Web ${WEB_BUILD_SECONDS}s, total ${IMAGE_BUILD_SECONDS}s."

# Digests come from the buildx metadata file. Extraction is pure shell so the
# deploy path needs no Python interpreter.
image_digest() {
  sed -n 's/.*"containerimage\.digest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1"
}

go_api_digest="$(image_digest "$TMP_DIR/go-api-meta.json")"
web_digest="$(image_digest "$TMP_DIR/web-meta.json")"
GO_API_IMAGE="$GO_API_IMAGE_NAME${go_api_digest}"
WEB_IMAGE="$WEB_IMAGE_NAME${web_digest}"

if [[ "$DEPLOY_METHOD" == "actions" ]]; then
  dispatch_id="$(openssl rand -hex 16)"
  echo "Dispatching prebuilt deployment to GitHub Actions..."
  dispatch_args=(
    --ref main
    -f "deploy_mode=prebuilt"
    -f "dispatch_id=$dispatch_id"
    -f "source_sha=$SHA"
    -f "go_api_digest=$go_api_digest"
    -f "web_digest=$web_digest"
  )
  if [[ -n "$GO_API_OWNED_MODULES" ]]; then
    dispatch_args+=(-f "go_api_owned=$GO_API_OWNED_MODULES")
  fi
  if [[ "$GO_API_INTERNAL_URL" != "http://127.0.0.1:8100" ]]; then
    dispatch_args+=(-f "go_api_internal_url=$GO_API_INTERNAL_URL")
  fi
  if dispatch_output="$(gh workflow run deploy-dashboard.yml "${dispatch_args[@]}" 2>&1)"; then
    :
  else
    dispatch_status=$?
    printf '%s\n' "$dispatch_output" >&2
    echo "Unable to dispatch the GitHub Actions deployment." >&2
    exit "$dispatch_status"
  fi

  if [[ -n "$dispatch_output" ]]; then
    printf '%s\n' "$dispatch_output"
  fi

  run_id=""
  run_url=""
  while IFS= read -r output_line; do
    if [[ "$output_line" =~ https://github\.com/([^/[:space:]]+)/([^/[:space:]]+)/actions/runs/([0-9]+) ]]; then
      run_id="${BASH_REMATCH[3]}"
      run_url="https://github.com/${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/actions/runs/$run_id"
    fi
  done <<< "$dispatch_output"

  if [[ -z "$run_id" ]]; then
    echo "Dispatch returned no Actions URL; waiting for this run to appear..."
    for ((attempt = 1; attempt <= 15; attempt++)); do
if run_record="$(gh run list \
          --workflow deploy-dashboard.yml \
          --commit "$SHA" \
          --event workflow_dispatch \
          --limit 20 \
          --json databaseId,url,displayTitle \
          --jq '.[] | select(.displayTitle == "Deploy Dashboard ('"$dispatch_id"')") | "\(.databaseId)\t\(.url)"' \
          | head -n 1)"; then
        if [[ -n "$run_record" ]]; then
          IFS=$'	' read -r run_id run_url <<< "$run_record"
          break
        fi
      fi

      if (( attempt < 15 )); then
        echo "New Actions run not visible yet (attempt $attempt/15); retrying in 2 seconds..."
        sleep 2
      fi
    done

    if [[ -z "$run_id" || -z "$run_url" ]]; then
      echo "No Actions run titled 'Deploy Dashboard ($dispatch_id)' for commit $SHA appeared within 15 polls." >&2
      exit 1
    fi
  fi

  if [[ -z "$run_id" || -z "$run_url" ]]; then
    echo "Unable to identify the GitHub Actions run for commit $SHA." >&2
    exit 1
  fi

  echo "GitHub Actions run: $run_url"
  echo "Waiting for the deployment run to finish..."
  if gh run watch "$run_id" --compact --exit-status; then
    echo "GitHub Actions deployment completed successfully: $run_url"
  else
    watch_status=$?
    echo "GitHub Actions deployment finished unsuccessfully (exit $watch_status): $run_url" >&2
    exit "$watch_status"
  fi
  exit 0
fi

PUBLIC_WEB_HEALTH_URL="${PUBLIC_WEB_HEALTH_URL:-${DOMAIN%/}/healthz}"
PUBLIC_API_HEALTH_URL="${PUBLIC_API_HEALTH_URL:-${BACKEND_API_BASE_URL%/}/api/v1/health/ready}"
printf -v remote_public_web_url '%q' "$PUBLIC_WEB_HEALTH_URL"
printf -v remote_public_api_url '%q' "$PUBLIC_API_HEALTH_URL"
printf -v remote_deploy_path '%q' "$DEPLOY_PATH"

echo "Creating VPS deployment root and unique staging directory..."
REMOTE_STAGING_DIR="$(ssh "$DEPLOY_HOST" "
  set -euo pipefail
  install -d -m 755 $remote_deploy_path
  umask 077
  mktemp -d $remote_deploy_path/.deploy-staging.XXXXXXXX
")"
printf -v remote_staging_dir '%q' "$REMOTE_STAGING_DIR"
printf -v remote_script_path '%q' "$REMOTE_STAGING_DIR/deploy-remote.sh"
scp "$TMP_DIR/web.env" "$DEPLOY_HOST:$REMOTE_STAGING_DIR/web.env"
scp "$TMP_DIR/go.env" "$DEPLOY_HOST:$REMOTE_STAGING_DIR/go.env"
scp "$ROOT/deploy/docker-compose.yml" "$DEPLOY_HOST:$REMOTE_STAGING_DIR/docker-compose.yml"
scp "$ROOT/deploy/deploy-remote.sh" "$DEPLOY_HOST:$REMOTE_STAGING_DIR/deploy-remote.sh"
printf -v remote_source_sha '%q' "$SHA"
printf -v remote_go_api_image '%q' "$GO_API_IMAGE"
printf -v remote_web_image '%q' "$WEB_IMAGE"
printf -v remote_ai_provider_base_url '%q' "$INTERNAL_AI_PROVIDER_BASE_URL"
printf -v remote_go_owned '%q' "$GO_API_OWNED_MODULES"
printf -v remote_go_internal_url '%q' "$GO_API_INTERNAL_URL"
printf -v remote_space_min '%q' "$DEPLOY_FREE_SPACE_MIN_BYTES"
printf -v remote_space_post_pull '%q' "$DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES"
printf -v remote_space_percent '%q' "$DEPLOY_FREE_SPACE_PERCENT"

echo "Deploying FastAPI, Go API, and Web..."
if ! ssh "$DEPLOY_HOST" \
  "PUBLIC_WEB_HEALTH_URL=$remote_public_web_url PUBLIC_API_HEALTH_URL=$remote_public_api_url \
    SOURCE_SHA=$remote_source_sha STAGING_DIR=$remote_staging_dir \
    INTERNAL_AI_PROVIDER_BASE_URL=$remote_ai_provider_base_url \
    GO_API_OWNED_MODULES=$remote_go_owned GO_API_INTERNAL_URL=$remote_go_internal_url \
    DEPLOY_FREE_SPACE_MIN_BYTES=$remote_space_min \
    DEPLOY_FREE_SPACE_POST_PULL_MIN_BYTES=$remote_space_post_pull \
    DEPLOY_FREE_SPACE_PERCENT=$remote_space_percent \
    GO_API_IMAGE=$remote_go_api_image WEB_IMAGE=$remote_web_image DEPLOY_PATH=$remote_deploy_path \
      bash $remote_script_path"; then
  echo "Compose deployment failed; remote deploy script attempted config and image rollback." >&2
  exit 1
fi

echo "Deployed $DOMAIN from $WEB_IMAGE"
echo "Deployed Go API gateway from $GO_API_IMAGE"
