#!/usr/bin/env bash
set -euo pipefail

: "${API_IMAGE:?API_IMAGE is required}"
: "${GO_API_IMAGE:?GO_API_IMAGE is required}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"
: "${PUBLIC_WEB_HEALTH_URL:?PUBLIC_WEB_HEALTH_URL is required}"
: "${PUBLIC_API_HEALTH_URL:?PUBLIC_API_HEALTH_URL is required}"

CONTAINER_API="believeboy-dashboard-api"
CONTAINER_GO_API="believeboy-dashboard-go-api"
CONTAINER_WEB="believeboy-dashboard-web"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"

cd "$DEPLOY_PATH"

for file in backend.env web.env.next go.env.next docker-compose.yml.next; do
  if [[ ! -f "$file" ]]; then
    echo "Missing $DEPLOY_PATH/$file. Run deploy-local.sh to stage all runtime files." >&2
    exit 1
  fi
done

saved_image() {
  local key="$1"
  [[ -f .deploy-images ]] || return 0
  sed -n "s/^${key}=//p" .deploy-images 2>/dev/null | head -n 1
}

previous_api_image="$(saved_image API_IMAGE)"
previous_go_api_image="$(saved_image GO_API_IMAGE)"
previous_web_image="$(saved_image WEB_IMAGE)"
previous_api_image="${previous_api_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_API" 2>/dev/null || true)}"
previous_go_api_image="${previous_go_api_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_GO_API" 2>/dev/null || true)}"
previous_web_image="${previous_web_image:-$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_WEB" 2>/dev/null || true)}"
backup_dir="$(mktemp -d "$DEPLOY_PATH/.deploy-rollback.XXXXXX")"
for file in docker-compose.yml web.env go.env .deploy-images; do
  if [[ -f "$file" ]]; then
    cp -p "$file" "$backup_dir/$file"
  fi
done

cleanup_backup() {
  rm -f "$backup_dir/docker-compose.yml" "$backup_dir/web.env" "$backup_dir/go.env" "$backup_dir/.deploy-images"
  rmdir "$backup_dir"
}

restore_config() {
  for file in docker-compose.yml web.env go.env .deploy-images; do
    if [[ -f "$backup_dir/$file" ]]; then
      cp -p "$backup_dir/$file" "$file"
    else
      rm -f "$file"
    fi
  done
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local attempt
  for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS --max-time 5 "$url" >/dev/null; then
      echo "$label healthy after $attempt attempt(s)."
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  if [[ -z "$previous_api_image" || -z "$previous_web_image" ]]; then
    echo "No previous FastAPI/Go/Web image set is available for automatic rollback." >&2
    API_IMAGE="$API_IMAGE" GO_API_IMAGE="$GO_API_IMAGE" WEB_IMAGE="$WEB_IMAGE" \
      docker compose down --remove-orphans || true
    restore_config
    return 1
  fi

  if [[ -f "$backup_dir/docker-compose.yml" ]] &&
    grep -Eq '^[[:space:]]+go-api:' "$backup_dir/docker-compose.yml" &&
    [[ -z "$previous_go_api_image" ]]; then
    echo "Previous Compose includes Go API, but its image reference is unavailable; refusing an incomplete rollback." >&2
    docker stop "$CONTAINER_GO_API" 2>/dev/null || true
    restore_config
    return 1
  fi

  echo "Restoring previous Compose and runtime config..."
  restore_config
  local rollback_go_api_image="${previous_go_api_image:-$GO_API_IMAGE}"
  if ! API_IMAGE="$previous_api_image" GO_API_IMAGE="$rollback_go_api_image" WEB_IMAGE="$previous_web_image" \
    docker compose up -d --no-build --remove-orphans; then
    echo "Previous application image set could not be restarted." >&2
    return 1
  fi

  wait_for_url "API rollback" "http://127.0.0.1:8100/api/v1/health/live" || return 1
  if [[ -n "$previous_go_api_image" ]]; then
    wait_for_url "Go API rollback" "http://127.0.0.1:8200/api/v1/health/live" || return 1
  fi
  wait_for_url "Web rollback" "http://127.0.0.1:3200/healthz"
}

fail_deployment() {
  trap - ERR
  docker compose ps || true
  docker compose logs --tail=150 || true
  if ! rollback; then
    echo "Automatic rollback was incomplete; inspect Compose state and restore the saved files in $backup_dir." >&2
    exit 1
  fi
  cleanup_backup
  exit 1
}

handle_unexpected_error() {
  trap - ERR
  echo "Unexpected deployment command failure; attempting rollback." >&2
  fail_deployment
}

trap 'handle_unexpected_error' ERR

mv docker-compose.yml.next docker-compose.yml
mv web.env.next web.env
mv go.env.next go.env

echo "Pulling FastAPI, Go API, and Web images..."
if ! docker compose pull migrate api go-api celery celery-scheduled beat web; then
  fail_deployment
fi

echo "Running database migrations..."
if ! docker compose run --rm -T migrate < /dev/null; then
  fail_deployment
fi

if ! docker compose up -d --no-build --remove-orphans; then
  fail_deployment
fi

if ! wait_for_url "FastAPI fallback" "http://127.0.0.1:8100/api/v1/health/live"; then
  fail_deployment
fi
if ! wait_for_url "Go API gateway" "http://127.0.0.1:8200/api/v1/health/live"; then
  fail_deployment
fi
if ! wait_for_url "Web" "http://127.0.0.1:3200/healthz"; then
  fail_deployment
fi

echo "Checking Celery workers..."
if ! docker compose exec -T celery sh -c \
  'celery -A app.tasks.celery_app inspect ping -d "celery@$(hostname)" --timeout=10'; then
  fail_deployment
fi
if ! docker compose exec -T celery-scheduled sh -c \
  'celery -A app.tasks.celery_app inspect ping -d "celery@$(hostname)" --timeout=10'; then
  fail_deployment
fi

echo "Checking Celery beat..."
if [[ "$(docker inspect --format '{{.State.Running}}' believeboy-dashboard-beat)" != "true" ]]; then
  fail_deployment
fi

if ! wait_for_url "Public Web" "$PUBLIC_WEB_HEALTH_URL"; then
  fail_deployment
fi
if ! wait_for_url "Public API" "$PUBLIC_API_HEALTH_URL"; then
  fail_deployment
fi

manifest_tmp="$(mktemp "$DEPLOY_PATH/.deploy-images.next.XXXXXX")"
printf 'API_IMAGE=%s\nGO_API_IMAGE=%s\nWEB_IMAGE=%s\n' \
  "$API_IMAGE" "$GO_API_IMAGE" "$WEB_IMAGE" > "$manifest_tmp"
chmod 600 "$manifest_tmp"
mv "$manifest_tmp" "$DEPLOY_PATH/.deploy-images"

trap - ERR
cleanup_backup
docker compose ps
