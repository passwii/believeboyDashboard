#!/usr/bin/env bash
# Run the Week 1 live contract without a Python runtime.
#
# The comparison target is the recorded FastAPI golden file
# (backend-go/tests/contract/testdata/week1_live_golden.json), so this script
# only needs Go, Postgres and Redis. Re-recording the golden file is the one
# remaining operation that needs FastAPI; see tests/contract/README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_GO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_GO_DIR/.." && pwd)"

ENV_FILE="${BELIEVEBOY_ENV_FILE:-$REPO_ROOT/backend/.env.test}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "live contract: env file not found: $ENV_FILE" >&2
  echo "set BELIEVEBOY_ENV_FILE to an environment file with DATABASE_URL/API_KEY" >&2
  exit 2
fi

# The env file is read by a Go helper instead of "source": real values contain
# spaces and parentheses that break shell sourcing.
cd "$BACKEND_GO_DIR"
env_dump="$(go run ./cmd/liveenv --env-file "$ENV_FILE")" || exit 2
eval "$env_dump"

DATABASE="${TEST_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE" ]]; then
  echo "live contract: env file has neither TEST_DATABASE_URL nor DATABASE_URL" >&2
  exit 2
fi
if [[ -z "${API_KEY:-}" ]]; then
  echo "live contract: env file has no API_KEY" >&2
  exit 2
fi

echo "live contract: seeding deterministic fixtures..."
LIVE_CONTRACT_DATABASE_URL="$DATABASE" \
  go run ./cmd/seedlivecontract --database-url "$DATABASE"

echo "live contract: comparing Go gateway against the golden recording..."
TEST_DATABASE_URL="$DATABASE" \
DATABASE_URL="$DATABASE" \
GO_API_TEST_DATABASE_URL="$DATABASE" \
LIVE_CONTRACT_API_KEY="$API_KEY" \
LIVE_CONTRACT_REQUIRED=1 \
  go test ./tests/contract -run TestWeek1LiveContractAgainstGolden -count=1 -v
