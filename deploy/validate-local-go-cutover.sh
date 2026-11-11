#!/usr/bin/env bash
# Local full-cutover smoke check for the Go gateway (no FastAPI fallback).
#
# Usage:
#   GO_API_BASE=http://127.0.0.1:18200 \\
#   API_KEY=... GO_API_TRUSTED_PROXY_SECRET=... \\
#   GATEWAY_LOG=/tmp/localcutover-state/logs/gateway.log \\
#   bash deploy/validate-local-go-cutover.sh
#
# Requires the Go gateway to be running with GO_API_OWNED=all and FastAPI stopped.
# Fails on any unexpected status or any "request fell back to FastAPI" log line.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="${GO_API_BASE:-http://127.0.0.1:18200}"
API_KEY_VALUE="${API_KEY:?API_KEY is required}"
PROXY_SECRET="${GO_API_TRUSTED_PROXY_SECRET:?GO_API_TRUSTED_PROXY_SECRET is required}"
GATEWAY_LOG="${GATEWAY_LOG:-}"
STATE_DIR="${CUTOVER_STATE_DIR:-/tmp/localcutover-state}"
ENV_FILE="${CUTOVER_ENV_FILE:-$ROOT/backend/.env.test}"
LOG_OFFSET=0
if [[ -n "$GATEWAY_LOG" && -f "$GATEWAY_LOG" ]]; then
  LOG_OFFSET="$(wc -l < "$GATEWAY_LOG" | tr -d ' ')"
fi

failures=0
check() {
  local path="$1" expected="$2"
  local body status
  body="$(mktemp)"
  status="$(curl -sS -o "$body" -w '%{http_code}' \
    -H "X-API-Key: $API_KEY_VALUE" \
    -H "X-Trusted-Proxy-Secret: $PROXY_SECRET" \
    -H "X-Is-Admin: true" \
    -H "X-Operator: cutover-check" \
    -H "X-User-Id: 1" \
    "$BASE$path" || true)"
  if [[ "$status" != "$expected" ]]; then
    echo "FAIL $path -> HTTP $status (expected $expected): $(head -c 160 "$body")" >&2
    failures=$((failures + 1))
  else
    echo "OK   $path -> $status"
  fi
  rm -f "$body"
}

check "/api/v1/health/ready" "200"
check "/api/v1/exchange-rates" "200"
check "/api/v1/projects/manage" "200"
check "/api/v1/inventory-replenishment-analysis?project_id=3748&country=US" "200"
check "/api/v1/sku-info?project_id=3748&country=US" "200"
check "/api/v1/alerts/rules" "200"
check "/api/v1/category-research/datasets" "200"
check "/api/v1/monthly-reports" "200"

if [[ -n "$GATEWAY_LOG" && -f "$GATEWAY_LOG" ]]; then
  fallbacks="$(tail -n +"$((LOG_OFFSET + 1))" "$GATEWAY_LOG" | grep -c "request fell back to FastAPI" || true)"
  if [[ "$fallbacks" != "0" ]]; then
    echo "FAIL gateway log contains $fallbacks fallback warning(s):" >&2
    tail -n +"$((LOG_OFFSET + 1))" "$GATEWAY_LOG" | grep "request fell back to FastAPI" | tail -5 >&2 || true
    failures=$((failures + 1))
  else
    echo "OK   gateway log: 0 fallback warnings"
  fi
fi

if [[ "${CUTOVER_ROUTE_PARITY:-0}" == "1" ]]; then
  echo "running go-only route parity (all OpenAPI GET routes, FastAPI must be stopped)..."
  ( cd "$ROOT/backend-go" && go run ./cmd/routeparity \
    --go-only \
    --go "$BASE" \
    --openapi "$ROOT/frontend/types/api-generated/openapi.json" \
    --env-file "$ENV_FILE" \
    --state-dir "$STATE_DIR" \
    --proxy-secret "$PROXY_SECRET" ) || failures=$((failures + 1))
fi

if [[ "$failures" -ne 0 ]]; then
  echo "CUTOVER CHECK FAILED ($failures failure(s))" >&2
  exit 1
fi
echo "CUTOVER CHECK PASSED"
