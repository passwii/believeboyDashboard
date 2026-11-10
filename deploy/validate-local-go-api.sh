#!/usr/bin/env bash
# Local-only validation for the Go API runtime (no VPS deploy, no GHCR push).
#
# 2026-11-10 incident guard: the alpine runtime image must ship tzdata, and the
# gateway must be able to resolve PostgreSQL's TimeZone (Asia/Shanghai) during
# pgxpool AfterConnect. Otherwise every DB-backed route returns 500 while
# /health/live stays green.
#
# Usage:
#   bash deploy/validate-local-go-api.sh
#
# Environment overrides:
#   GO_API_VALIDATE_IMAGE   image tag (default: believeboy-dashboard-go-api:local-validate)
#   GO_API_VALIDATE_PORT    host port (default: 18299)
#   GO_API_VALIDATE_ENV     env file for DB credentials (default: backend/.env.test)
#   DATABASE_URL_VALIDATE   full SQLAlchemy-style DB URL (overrides env file)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${GO_API_VALIDATE_IMAGE:-believeboy-dashboard-go-api:local-validate}"
PORT="${GO_API_VALIDATE_PORT:-18299}"
ENV_FILE="${GO_API_VALIDATE_ENV:-$ROOT/backend/.env.test}"
CONTAINER="believeboy-go-api-validate"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is required."
docker info >/dev/null 2>&1 || die "Docker daemon is not running."

echo "==> Building Go API runtime image: $IMAGE"
docker build --file "$ROOT/backend-go/Dockerfile" --target runtime --tag "$IMAGE" "$ROOT"

echo "==> Checking tzdata inside the runtime image"
docker run --rm --entrypoint sh "$IMAGE" \
  -c 'test -e /usr/share/zoneinfo/Asia/Shanghai' ||
  die "runtime image is missing /usr/share/zoneinfo/Asia/Shanghai"

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

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Starting gateway (health + exchange_rates owned, DB: $DB_URL)"
cleanup
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:$PORT:18299" \
  -e "GO_API_ADDR=0.0.0.0:18299" \
  -e "FASTAPI_ORIGIN=http://127.0.0.1:8100" \
  -e "GO_API_OWNED=health,exchange_rates" \
  -e "API_KEY=$API_KEY" \
  -e "GO_API_TRUSTED_PROXY_SECRET=$PROXY_SECRET" \
  -e "DATABASE_URL=$DB_URL" \
  "$IMAGE" >/dev/null

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
rates_status="$(curl -sS --max-time 5 -o /tmp/go-api-validate-rates.json -w '%{http_code}' \
  -H "X-API-Key: $API_KEY" \
  -H "X-Trusted-Proxy-Secret: $PROXY_SECRET" \
  "http://127.0.0.1:$PORT/api/v1/exchange-rates?page=1&page_size=1")"
case "$rates_status" in
  200) ;;
  *) docker logs "$CONTAINER" >&2 || true; die "exchange-rates returned HTTP $rates_status" ;;
esac
head -c 200 /tmp/go-api-validate-rates.json; echo

echo "LOCAL VALIDATION PASSED: tzdata present, gateway DB-ready, owned route 200."
