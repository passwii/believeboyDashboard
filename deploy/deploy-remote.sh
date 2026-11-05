#!/usr/bin/env bash
set -euo pipefail

: "${API_IMAGE:?API_IMAGE is required}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"

CONTAINER_API="believeboy-dashboard-api"
CONTAINER_WEB="believeboy-dashboard-web"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"

cd "$DEPLOY_PATH"

for file in backend.env web.env docker-compose.yml; do
  if [[ ! -f "$file" ]]; then
    echo "Missing $DEPLOY_PATH/$file. Run the local cutover once." >&2
    exit 1
  fi
done

previous_api_image="$(
  docker inspect --format '{{.Config.Image}}' "$CONTAINER_API" 2>/dev/null || true
)"
previous_web_image="$(
  docker inspect --format '{{.Config.Image}}' "$CONTAINER_WEB" 2>/dev/null || true
)"

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
    return 1
  fi
  echo "Rolling back to previous API/Web image pair..."
  API_IMAGE="$previous_api_image" WEB_IMAGE="$previous_web_image" \
    docker compose up -d --no-build --remove-orphans
  wait_for_url "API" "http://127.0.0.1:8100/api/v1/health/live"
  wait_for_url "Web" "http://127.0.0.1:3200/healthz"
}

echo "Pulling API and Web images..."
docker compose pull migrate api celery celery-scheduled beat web

echo "Running database migrations..."
docker compose run --rm -T migrate < /dev/null

if ! docker compose up -d --no-build --remove-orphans; then
  docker compose ps
  docker compose logs --tail=150
  rollback || true
  exit 1
fi

if ! wait_for_url "API" "http://127.0.0.1:8100/api/v1/health/live"; then
  docker compose ps
  docker compose logs --tail=150
  rollback || true
  exit 1
fi

if ! wait_for_url "Web" "http://127.0.0.1:3200/healthz"; then
  docker compose ps
  docker compose logs --tail=150
  rollback || true
  exit 1
fi

echo "Checking Celery workers..."
docker compose exec -T celery sh -c \
  'celery -A app.tasks.celery_app inspect ping -d "celery@$(hostname)" --timeout=10'
docker compose exec -T celery-scheduled sh -c \
  'celery -A app.tasks.celery_app inspect ping -d "celery@$(hostname)" --timeout=10'

echo "Checking Celery beat..."
test "$(docker inspect --format '{{.State.Running}}' believeboy-dashboard-beat)" = "true"

docker compose ps
