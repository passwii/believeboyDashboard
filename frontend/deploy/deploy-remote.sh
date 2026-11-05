#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_TAG:?IMAGE_TAG is required}"
: "${DEPLOY_PATH:?DEPLOY_PATH is required}"

APP_PORT="${APP_PORT:-3200}"
CONTAINER_NAME="${CONTAINER_NAME:-believeboy-dashboard}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-20}"

cd "$DEPLOY_PATH"

if [[ ! -f app.env ]]; then
  echo "Missing $DEPLOY_PATH/app.env. Run the local first deployment once." >&2
  exit 1
fi

PREVIOUS_IMAGE="$(
  docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME" 2>/dev/null || true
)"
PREVIOUS_TAG=""
if [[ "$PREVIOUS_IMAGE" == *":sha-"* ]]; then
  PREVIOUS_TAG="${PREVIOUS_IMAGE##*:}"
fi

wait_for_health() {
  local attempt
  for attempt in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${APP_PORT}/healthz" >/dev/null; then
      echo "Deployment healthy after ${attempt} attempt(s)."
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  if [[ -z "$PREVIOUS_TAG" || "$PREVIOUS_TAG" == "$IMAGE_TAG" ]]; then
    return 1
  fi

  echo "Rolling back to $PREVIOUS_TAG..."
  IMAGE_TAG="$PREVIOUS_TAG" docker compose up -d --no-build web
  wait_for_health
}

echo "Pulling $IMAGE_TAG..."
docker compose pull web

if ! docker compose up -d --no-build web; then
  docker compose ps
  docker compose logs --tail=100 web
  rollback || true
  exit 1
fi

if wait_for_health; then
  exit 0
fi

docker compose ps
docker compose logs --tail=100 web
rollback || true
exit 1
