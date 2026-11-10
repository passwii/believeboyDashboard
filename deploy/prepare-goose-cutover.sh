#!/usr/bin/env bash
# One-time Alembic checkpoint before the Goose migration cutover.
#
# Run this ONCE on the VPS (or any environment with an existing database and
# the deployment compose files) before deploying the release whose migrate
# service runs go-migrate. It:
#   1. checks whether the database still has an alembic_version table;
#   2. if yes, runs Alembic up to the frozen head (285);
#   3. if no (fresh database), does nothing and lets Goose run the baseline.
#
# Requires API_IMAGE, GO_API_IMAGE/WEB_IMAGE and deploy/backend.env to be present
# (the same environment used by deploy/docker-compose.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy"
cd "$DEPLOY_DIR"

: "${API_IMAGE:?API_IMAGE must be set}"
: "${GO_API_IMAGE:?GO_API_IMAGE must be set}"
: "${WEB_IMAGE:?WEB_IMAGE must be set}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if [[ ! -f backend.env ]]; then
  echo "deploy/backend.env is missing" >&2
  exit 1
fi

echo "Checking for alembic_version..."
has_alembic="$(
  docker compose run --rm -T --no-deps --entrypoint python api - 2>/dev/null <<'PY'
import os
from sqlalchemy import create_engine, text

url = os.environ.get("DATABASE_URL", "")
if not url:
    print("missing-database-url")
    raise SystemExit(0)
engine = create_engine(url)
with engine.connect() as conn:
    exists = conn.execute(text("select to_regclass('public.alembic_version')")).scalar()
print("yes" if exists else "no")
PY
)"
has_alembic="$(printf '%s' "$has_alembic" | tr -d '[:space:]')"

case "$has_alembic" in
  yes)
    echo "Applying frozen Alembic head (285) once before Goose cutover..."
    docker compose run --rm -T --no-deps --entrypoint alembic api upgrade head
    ;;
  no)
    echo "No alembic_version; fresh database. Skipping Alembic; Goose baseline will create the schema."
    ;;
  missing-database-url)
    echo "DATABASE_URL is missing from deploy/backend.env" >&2
    exit 1
    ;;
  *)
    echo "Unexpected alembic detection result: $has_alembic" >&2
    exit 1
    ;;
esac

echo "Cutover precondition ready. Now run the normal deployment (go-migrate up)."
