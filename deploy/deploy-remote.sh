#!/usr/bin/env bash
set -euo pipefail

: "${API_IMAGE:?API_IMAGE is required}"
: "${GO_API_IMAGE:?GO_API_IMAGE is required}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"

CONTAINER_API="believeboy-dashboard-api"
CONTAINER_GO_API="believeboy-dashboard-go-api"
CONTAINER_WEB="believeboy-dashboard-web"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"

cd "$DEPLOY_PATH"

for file in backend.env web.env docker-compose.yml web.env.next go.env.next docker-compose.yml.next; do
  if [[ ! -f "$file" ]]; then
    echo "Missing $DEPLOY_PATH/$file. Run deploy-local.sh to stage all runtime files." >&2
    exit 1
  fi
done

previous_api_image="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_API" 2>/dev/null || true)"
previous_go_api_image="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_GO_API" 2>/dev/null || true)"
previous_web_image="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_WEB" 2>/dev/null || true)"
backup_dir="$(mktemp -d "$DEPLOY_PATH/.deploy-rollback.XXXXXX")"
cp -p docker-compose.yml "$backup_dir/docker-compose.yml"
cp -p web.env "$backup_dir/web.env"
if [[ -f go.env ]]; then
  cp -p go.env "$backup_dir/go.env"
fi

cleanup_backup() {
  rm -f "$backup_dir/docker-compose.yml" "$backup_dir/web.env" "$backup_dir/go.env"
  rmdir "$backup_dir"
}

restore_config() {
  cp -p "$backup_dir/docker-compose.yml" docker-compose.yml
  cp -p "$backup_dir/web.env" web.env
  if [[ -f "$backup_dir/go.env" ]]; then
    cp -p "$backup_dir/go.env" go.env
  else
    rm -f go.env
  fi
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
  docker compose ps || true
  docker compose logs --tail=150 || true
  if ! rollback; then
    echo "Automatic rollback was incomplete; inspect Compose state and restore the saved files in $backup_dir." >&2
    exit 1
  fi
  cleanup_backup
  exit 1
}

trap 'if [[ -d "$backup_dir" ]]; then restore_config || true; fi' ERR

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

trap - ERR
cleanup_backup
docker compose ps
