#!/usr/bin/env bash
# Local-only validation for the Go API runtime (no VPS deploy, no GHCR push).
#
# 2026-11-10 incident guard: the alpine runtime image must ship tzdata, and the
# gateway must be able to resolve PostgreSQL's TimeZone (Asia/Shanghai) during
# pgxpool AfterConnect. Otherwise every DB-backed route returns 500 while
# /health/live stays green.
#
# Default mode runs the freshly built linux binary inside an existing local
# image that has NO /usr/share/zoneinfo, so it proves the embedded time/tzdata
# rather than the host's zoneinfo. This also works offline (Docker Hub metadata
# fetches can time out, as seen on 2026-11-10).
#
# Usage:
#   bash deploy/validate-local-go-api.sh
#   GO_API_VALIDATE_MODE=image bash deploy/validate-local-go-api.sh  # full Dockerfile build
#
# Environment overrides:
#   GO_API_VALIDATE_MODE     binary (default) | image
#   GO_API_VALIDATE_IMAGE    image tag for image mode
#   GO_API_VALIDATE_BASE_IMAGE  base image for binary mode (must lack zoneinfo)
#   GO_API_VALIDATE_PORT     host port (default: 18299)
#   GO_API_VALIDATE_ENV      env file for DB credentials (default: backend/.env.test)
#   DATABASE_URL_VALIDATE    full SQLAlchemy-style DB URL (overrides env file)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${GO_API_VALIDATE_MODE:-binary}"
IMAGE="${GO_API_VALIDATE_IMAGE:-believeboy-dashboard-go-api:local-validate}"
PORT="${GO_API_VALIDATE_PORT:-18299}"
ENV_FILE="${GO_API_VALIDATE_ENV:-$ROOT/backend/.env.test}"
CONTAINER="believeboy-go-api-validate"
TMP_DIR="$(mktemp -d /tmp/go-api-validate.XXXXXX)"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is required."
docker info >/dev/null 2>&1 || die "Docker daemon is not running."

pick_base_image() {
  local candidate
  for candidate in "${GO_API_VALIDATE_BASE_IMAGE:-}" believeboy-go-api:local believeboy-go-api:local-amd64 alpine:3.22 alpine:latest; do
    [[ -n "$candidate" ]] || continue
    docker image inspect "$candidate" >/dev/null 2>&1 || continue
    if docker run --rm --entrypoint sh "$candidate" \
      -c 'test -x /bin/sh && test ! -e /usr/share/zoneinfo/Asia/Shanghai' >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ "$MODE" == "image" ]]; then
  echo "==> Building Go API runtime image: $IMAGE"
  docker build --file "$ROOT/backend-go/Dockerfile" --target runtime --tag "$IMAGE" "$ROOT"
  echo "==> Checking tzdata inside the runtime image"
  docker run --rm --entrypoint sh "$IMAGE" \
    -c 'test -e /usr/share/zoneinfo/Asia/Shanghai' ||
    die "runtime image is missing /usr/share/zoneinfo/Asia/Shanghai"
  BASE_IMAGE="$IMAGE"
  ENTRYPOINT="/usr/local/bin/go-api"
  EXTRA_ARGS=()
  BINARY_TO_COPY=""
elif [[ "$MODE" == "binary" ]]; then
  command -v go >/dev/null 2>&1 || die "go is required for binary mode (or set GO_API_VALIDATE_MODE=image)."
  case "$(uname -m)" in
    arm64 | aarch64) GOARCH=arm64 ;;
    x86_64 | amd64) GOARCH=amd64 ;;
    *) die "unsupported host architecture: $(uname -m)" ;;
  esac
  BASE_IMAGE="$(pick_base_image)" ||
    die "no local image without tzdata found; set GO_API_VALIDATE_BASE_IMAGE or GO_API_VALIDATE_MODE=image."
  echo "==> Building linux/$GOARCH gateway binary (embedded time/tzdata)"
  (cd "$ROOT/backend-go" && CGO_ENABLED=0 GOOS=linux GOARCH="$GOARCH" \
    go build -trimpath -o "$TMP_DIR/go-api" ./cmd/gateway)
  chmod 0755 "$TMP_DIR/go-api"
  echo "==> Running the binary inside $BASE_IMAGE (base image has no zoneinfo; proves embedded tzdata)"
  ENTRYPOINT="/tmp/go-api"
  EXTRA_ARGS=()
  BINARY_TO_COPY="$TMP_DIR/go-api"
else
  die "GO_API_VALIDATE_MODE must be 'binary' or 'image' (current: $MODE)"
fi

DB_URL="${DATABASE_URL_VALIDATE:-}"
if [[ -z "$DB_URL" ]]; then
  [[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE (or set DATABASE_URL_VALIDATE)"
  DB_URL="$(cd "$ROOT/backend" && .venv/bin/python - "$ENV_FILE" <<'PY'
import sys, urllib.parse
from pathlib import Path

env = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    key, value = line.split('=', 1)
    env[key.strip()] = value.strip().strip('"').strip("'")

user = urllib.parse.quote(env.get('PGUSER') or 'damon', safe='')
password = env.get('PGPASSWORD') or ''
auth = user + (':' + urllib.parse.quote(password, safe='') if password else '')
host = env.get('PGHOST') or '127.0.0.1'
port = env.get('PGPORT') or '5432'
database = env.get('PGDATABASE') or 'BLF_test'
print(f'postgresql+psycopg://{auth}@{host}:{port}/{database}')
PY
)"
fi
# Containers reach the host Postgres via the Docker host gateway.
DB_URL="$(printf '%s' "$DB_URL" | sed -E 's#@(localhost|127\.0\.0\.1):#@host.docker.internal:#')"
API_KEY="local-validate-key"
PROXY_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"

remove_container() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
cleanup() {
  remove_container
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

DB_DISPLAY="$(printf '%s' "$DB_URL" | sed -E 's#://[^@/]+@#://***@#')"
echo "==> Starting gateway (health + exchange_rates owned, DB: $DB_DISPLAY)"
remove_container
docker create --name "$CONTAINER" \
  -p "127.0.0.1:$PORT:18299" \
  "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
  -e "GO_API_ADDR=0.0.0.0:18299" \
  -e "FASTAPI_ORIGIN=http://127.0.0.1:8100" \
  -e "GO_API_OWNED=health,exchange_rates" \
  -e "API_KEY=$API_KEY" \
  -e "GO_API_TRUSTED_PROXY_SECRET=$PROXY_SECRET" \
  -e "DATABASE_URL=$DB_URL" \
  --entrypoint "$ENTRYPOINT" \
  "$BASE_IMAGE" >/dev/null
if [[ -n "$BINARY_TO_COPY" ]]; then
  docker cp "$BINARY_TO_COPY" "$CONTAINER:/tmp/go-api" >/dev/null
fi
docker start "$CONTAINER" >/dev/null

echo "==> Waiting for DB-aware readiness"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  docker logs "$CONTAINER" >&2 || true
  die "gateway never became DB-ready"
fi

echo "==> Health (DB-aware)"
health="$(curl -fsS --max-time 5 \
  -H "X-API-Key: $API_KEY" \
  -H "X-Trusted-Proxy-Secret: $PROXY_SECRET" \
  "http://127.0.0.1:$PORT/api/v1/health")"
echo "$health"
case "$health" in
  *'"status":"ok"'*'"database":"ok"'*) ;;
  *) die "health is not ok (expect status/database ok): $health" ;;
esac

echo "==> Owned route smoke: /api/v1/exchange-rates"
rates_status="$(curl -sS --max-time 5 -o "$TMP_DIR/rates.json" -w '%{http_code}' \
  -H "X-API-Key: $API_KEY" \
  -H "X-Trusted-Proxy-Secret: $PROXY_SECRET" \
  "http://127.0.0.1:$PORT/api/v1/exchange-rates?page=1&page_size=1")"
case "$rates_status" in
  200) ;;
  *) docker logs "$CONTAINER" >&2 || true; die "exchange-rates returned HTTP $rates_status" ;;
esac
head -c 200 "$TMP_DIR/rates.json"; echo

echo "LOCAL VALIDATION PASSED: embedded tzdata, gateway DB-ready, owned route 200."
