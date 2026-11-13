#!/usr/bin/env bash
# One-time Alembic checkpoint before the Goose migration cutover.
#
# Run this ONCE on a database that still has an alembic_version table and is
# behind the frozen head (revision 285). It:
#   1. checks whether the database still has an alembic_version table;
#   2. if yes, runs Alembic up to the frozen head (285);
#   3. if no (fresh database), does nothing and lets Goose run the baseline.
#
# The FastAPI image is no longer built, so this script needs a PINNED legacy
# image reference (the last published ghcr.io/passwii/believeboydashboard-api
# digest, or any locally built image containing backend/alembic + requirements).
# Databases already stamped by Goose (`go-migrate status` shows version 1) do
# not need this step at all.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy"
cd "$DEPLOY_DIR"

LEGACY_API_IMAGE="${LEGACY_API_IMAGE:-}"
if [[ -z "$LEGACY_API_IMAGE" ]]; then
  cat >&2 <<'EOF'
prepare-goose-cutover: LEGACY_API_IMAGE is required.

  FastAPI 镜像已停止发布。若目标库还没有被 Goose stamp（`go-migrate status`
  看不到 version 1），需要提供一个仍包含 backend/alembic 与 Python 依赖的镜像：

    LEGACY_API_IMAGE=ghcr.io/passwii/believeboydashboard-api@sha256:<digest> \
      bash deploy/prepare-goose-cutover.sh

  已经 stamp 的库直接跑 `go run ./cmd/migrate up` 即可，不需要本脚本。
EOF
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if [[ ! -f backend.env ]]; then
  echo "deploy/backend.env is missing" >&2
  exit 1
fi

# The Compose stack no longer has an `api` service; run the legacy image
# directly on the host network so it can reach loopback PostgreSQL.
legacy_run() {
  docker run --rm --network host --env-file backend.env \
    --entrypoint "$1" "$LEGACY_API_IMAGE" "${@:2}"
}

echo "Checking for alembic_version..."
has_alembic="$(legacy_run python - <<'PY' 2>/dev/null
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
    legacy_run alembic upgrade head
    current="$(legacy_run alembic current 2>/dev/null | tr -d '[:space:]')"
    if [[ "$current" != *285* ]]; then
      echo "Alembic upgrade did not reach revision 285 (current: $current)" >&2
      exit 1
    fi
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
