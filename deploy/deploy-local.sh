#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUESTED_DEPLOY_METHOD="${DEPLOY_METHOD:-}"
CONFIG_FILE="${DEPLOY_CONFIG_FILE:-$HOME/.config/believeboy-dashboard/deploy.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

# 命令行选择优先于 deploy.env；git deploy 显式传入默认值 actions。
DEPLOY_METHOD="${REQUESTED_DEPLOY_METHOD:-${DEPLOY_METHOD:-actions}}"
unset REQUESTED_DEPLOY_METHOD

# 2026-11-13：Actions 工作流的仓库变量 DEPLOYMENTS_ENABLED=true 是发布闸门。
# 本机 SSH 备用路径额外检查本地配置里的同名值，避免绕过 Actions 的停发闸门。
if [[ "$DEPLOY_METHOD" == "ssh" && "${DEPLOYMENTS_ENABLED:-false}" != "true" ]]; then
  echo "Local SSH deployment is disabled. Set DEPLOYMENTS_ENABLED=true to enable the fallback." >&2
  exit 1
fi
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
# The Go gateway implements every OpenAPI operation, so Web always talks to
# 8200. GO_API_OWNED_MODULES is kept for staged rollouts (short list); the
# default "all" means every module is served by Go. FastAPI is retired, so
# there is no 8100 fallback any more.
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

REQUIRED_COMMANDS=(git)
if [[ "$DEPLOY_METHOD" == "actions" ]]; then
  REQUIRED_COMMANDS+=(gh openssl)
else
  REQUIRED_COMMANDS+=(pnpm docker go openssl ssh scp)
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

if [[ "$DEPLOY_METHOD" == "ssh" && -n "$(git -C "$ROOT" ls-files --others --exclude-standard)" ]]; then
  echo "Untracked non-ignored files are present in the local Docker build context. Commit or remove them before deploying." >&2
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

if [[ "$DEPLOY_METHOD" == "actions" ]]; then
  dispatch_id="$(openssl rand -hex 16)"
  echo "Dispatching full build, checks, and deployment to GitHub Actions..."
  dispatch_args=(
    --ref main
    -f "deploy_mode=build_and_deploy"
    -f "dispatch_id=$dispatch_id"
  )
  if [[ "$GO_API_OWNED_MODULES" != "all" ]]; then
    dispatch_args+=(-f "go_api_owned=$GO_API_OWNED_MODULES")
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
          IFS=$'\t' read -r run_id run_url <<< "$run_record"
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

  echo "GitHub Actions run: $run_url"
  echo "Waiting for the deployment run to finish..."

  # 2026-11-20：`gh run watch` 的可用参数随 gh 版本变化（2.46 没有 --compact），
  # 参数解析失败会返回非零码，脚本会把参数错误误判成「部署失败」。这里不再依赖
  # watch，改为轮询 `gh run view` 的 status/conclusion，只按 run 的真实结论判定成败。
  # 读取状态失败（网络/权限）与 run 真正失败分别报错，避免把「查不到状态」说成「部署失败」。
  RUN_STATUS_ERROR_FILE="$(mktemp)"
  trap 'rm -f "$RUN_STATUS_ERROR_FILE"' EXIT
  RUN_STATUS_POLL_INTERVAL=10
  RUN_STATUS_MAX_ATTEMPTS=5

  run_status=""
  run_status_attempts=0
  run_status_error=""
  while true; do
    if run_status="$(gh run view "$run_id" --json status --jq '.status' 2>"$RUN_STATUS_ERROR_FILE")"; then
      run_status_attempts=0
    else
      run_status_attempts=$((run_status_attempts + 1))
      run_status_error="$(cat "$RUN_STATUS_ERROR_FILE")"
      if (( run_status_attempts >= RUN_STATUS_MAX_ATTEMPTS )); then
        echo "Unable to read the status of the GitHub Actions run after $RUN_STATUS_MAX_ATTEMPTS attempts: $run_status_error" >&2
        echo "The deployment run may still be running; check it manually: $run_url" >&2
        exit 1
      fi
      echo "Unable to read the status of the GitHub Actions run (attempt $run_status_attempts/$RUN_STATUS_MAX_ATTEMPTS): $run_status_error" >&2
      sleep "$RUN_STATUS_POLL_INTERVAL"
      continue
    fi

    if [[ "$run_status" != "completed" ]]; then
      echo "GitHub Actions run status: $run_status; checking again in ${RUN_STATUS_POLL_INTERVAL}s..."
      sleep "$RUN_STATUS_POLL_INTERVAL"
      continue
    fi
    break
  done

  run_conclusion=""
  if ! run_conclusion="$(gh run view "$run_id" --json conclusion --jq '.conclusion' 2>"$RUN_STATUS_ERROR_FILE")"; then
    run_conclusion="unknown"
    echo "Unable to read the conclusion of the GitHub Actions run: $(cat "$RUN_STATUS_ERROR_FILE")" >&2
  fi
  if [[ -z "$run_conclusion" || "$run_conclusion" == "null" ]]; then
    run_conclusion="unknown"
  fi
  if [[ "$run_conclusion" != "success" ]]; then
    echo "GitHub Actions deployment finished unsuccessfully ($run_conclusion): $run_url" >&2
    exit 1
  fi
  echo "GitHub Actions deployment completed successfully: $run_url"
  exit 0
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
if [[ "$GO_API_INTERNAL_URL" != "http://127.0.0.1:8200" ]]; then
  echo "GO_API_INTERNAL_URL must be http://127.0.0.1:8200 (Go gateway); FastAPI is retired." >&2
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
    # 保留以满足网关配置校验；FastAPI 已下线，没有服务监听 8100。
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

echo "Deploying Go API and Web..."
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
