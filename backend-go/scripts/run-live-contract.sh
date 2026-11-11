#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_GO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_GO_DIR/.." && pwd)"

BACKEND_DIR="${BELIEVEBOY_BACKEND_DIR:-$REPO_ROOT/backend}"
PORT="${LIVE_FASTAPI_PORT:-18100}"

if [[ ! -d "$BACKEND_DIR" ]]; then
  echo "live contract: backend directory not found: $BACKEND_DIR" >&2
  echo "set BELIEVEBOY_BACKEND_DIR to a backend checkout with .venv and .env.test" >&2
  exit 2
fi
BACKEND_DIR="$(cd "$BACKEND_DIR" && pwd -P)"

ENV_FILE="${BELIEVEBOY_ENV_FILE:-$BACKEND_DIR/.env.test}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "live contract: env file not found: $ENV_FILE" >&2
  echo "set BELIEVEBOY_ENV_FILE to the BLF_test environment file" >&2
  exit 2
fi
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd -P)/$(basename "$ENV_FILE")"

PYTHON="${BELIEVEBOY_PYTHON:-$BACKEND_DIR/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  echo "live contract: Python executable not found: $PYTHON" >&2
  echo "set BELIEVEBOY_PYTHON to the backend virtualenv Python" >&2
  exit 2
fi
PYTHON="$(cd "$(dirname "$PYTHON")" && pwd -P)/$(basename "$PYTHON")"

# Load .env.test without echoing values. Both primary URL names are accepted,
# but the target database must be explicitly disposable.
SELECTED_DATABASE_URL="$("$PYTHON" - "$ENV_FILE" <<'PY'
import sys
from urllib.parse import urlparse

from dotenv import dotenv_values

values = dotenv_values(sys.argv[1])
database_url = values.get("DATABASE_URL") or values.get("TEST_DATABASE_URL") or ""
parsed = urlparse(database_url)
if parsed.path.lower() not in {"/blf_test", "/blf_ci"}:
    raise SystemExit(
        "live contract refused: DATABASE_URL/TEST_DATABASE_URL must target "
        "BLF_test or BLF_ci"
    )
if not values.get("API_KEY"):
    raise SystemExit("live contract refused: API_KEY is empty")
print(database_url)
PY
)"

eval "$("$PYTHON" - "$ENV_FILE" <<'PY'
import shlex
import sys

from dotenv import dotenv_values

values = dotenv_values(sys.argv[1])
for key, value in values.items():
    if value is not None:
        print(f"export {key}={shlex.quote(value)}")
PY
)"

# The env file may define either or both URL names. Pin FastAPI, the seeder,
# and the Go test to the exact URL validated above.
export DATABASE_URL="$SELECTED_DATABASE_URL"
export TEST_DATABASE_URL="$SELECTED_DATABASE_URL"

echo "live contract: seeding deterministic fixtures..."
(
  cd "$BACKEND_GO_DIR"
  LIVE_CONTRACT_DATABASE_URL="$SELECTED_DATABASE_URL" \
    go run ./cmd/seedlivecontract --database-url "$SELECTED_DATABASE_URL"
)

LOG_FILE="$(mktemp -t live-contract.XXXXXX)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

redact_log() {
  sed -E \
    -e 's#(postgres(ql)?([+][a-z0-9]+)?://)[^[:space:]]+#<redacted-db-url>#g' \
    -e 's/(API_KEY[=:][[:space:]]*)[^[:space:]]+/\1<redacted>/g' \
    -e 's/(Bearer )[A-Za-z0-9._-]+/\1<redacted>/g' \
    "$LOG_FILE" | tail -n 40
}

(
  cd "$BACKEND_DIR"
  exec "$PYTHON" -m uvicorn app.main:app \
    --host 127.0.0.1 \
    --port "$PORT" \
    --no-access-log
) >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

FASTAPI_ORIGIN="http://127.0.0.1:$PORT"
for _ in $(seq 1 120); do
  if curl -fsS "$FASTAPI_ORIGIN/api/v1/health/live" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "live contract: FastAPI exited during startup" >&2
    redact_log >&2
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS "$FASTAPI_ORIGIN/api/v1/health/live" >/dev/null 2>&1; then
  echo "live contract: FastAPI did not become ready at $FASTAPI_ORIGIN" >&2
  redact_log >&2
  exit 1
fi

cd "$BACKEND_GO_DIR"
FASTAPI_ORIGIN="$FASTAPI_ORIGIN" \
GO_API_TEST_DATABASE_URL="$DATABASE_URL" \
LIVE_CONTRACT_API_KEY="$API_KEY" \
LIVE_CONTRACT_REQUIRED=1 \
  go test ./tests/contract -run TestWeek1LiveContractFastAPIAgainstGo -count=1 -v
