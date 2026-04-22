#!/bin/bash
set -e

echo "=== Phase 1: Pre-stress test setup ==="

# ── Config ────────────────────────────────────────────────────────────────────
BACKEND_URL=${BACKEND_URL:-"http://127.0.0.1:8000"}
API_KEY=${API_KEY:-"<REDACTED-ROTATE-OLD-API-KEY>"}
PROJECT_NAME=${PROJECT_NAME:-"TestProject"}

# ── 1. Verify backend is reachable ────────────────────────────────────────────
echo "Checking backend health at $BACKEND_URL..."

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "X-API-Key: $API_KEY" \
  "$BACKEND_URL/api/v1/health")

if [ "$HTTP_CODE" = "200" ]; then
  echo "✓ Backend is up (HTTP $HTTP_CODE)"
else
  echo "✗ Backend returned HTTP $HTTP_CODE — fix before proceeding"
  exit 1
fi

echo ""
echo "Enhanced health check response:"
curl -s -H "X-API-Key: $API_KEY" "$BACKEND_URL/api/v1/health" | python3 -m json.tool 2>/dev/null || echo "(raw)"

echo ""
echo "Liveness probe:"
curl -s "$BACKEND_URL/api/v1/health/live" | python3 -m json.tool

echo ""
echo "Readiness probe:"
READY_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "X-API-Key: $API_KEY" \
  "$BACKEND_URL/api/v1/health/ready")
echo "HTTP $READY_CODE"

# ── 2. Smoke-test key endpoints ────────────────────────────────────────────────
echo ""
echo "=== Smoke-testing key endpoints ==="

smoke_test() {
  local method=$1
  local path=$2
  local desc=$3
  local code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-API-Key: $API_KEY" \
    "$BACKEND_URL$path")
  if [ "$code" -lt "500" ]; then
    echo "✓ $desc → HTTP $code"
  else
    echo "✗ $desc → HTTP $code (5xx = error)"
  fi
}

smoke_test GET "/api/v1/sku-info?page=1&page_size=10&project_name=${PROJECT_NAME}" "GET /api/v1/sku-info (product costs)"
smoke_test GET "/api/v1/shipment-schedules?page=1&page_size=10&project_name=${PROJECT_NAME}" "GET /api/v1/shipment-schedules"
smoke_test GET "/api/v1/exchange-rates?page=1&page_size=10" "GET /api/v1/exchange-rates"
smoke_test GET "/api/v1/ai/conversations?page=1&page_size=5" "GET /api/v1/ai/conversations"
smoke_test GET "/api/v1/projects?page=1&page_size=5" "GET /api/v1/projects"

# ── 3. Check k6 ───────────────────────────────────────────────────────────────
echo ""
echo "=== Checking k6 ==="
if command -v k6 &> /dev/null; then
  K6_VERSION=$(k6 version 2>&1 | head -1)
  echo "✓ k6 installed: $K6_VERSION"
else
  echo "⚠ k6 not installed — install with: brew install k6"
fi

# ── 4. Check locust ──────────────────────────────────────────────────────────
echo ""
echo "=== Checking locust (alternative) ==="
if command -v locust &> /dev/null; then
  echo "✓ locust: $(locust --version 2>&1 | head -1)"
else
  echo "⚠ locust not installed — pip install locust"
fi

# ── 5. Check PostgreSQL connection pool ────────────────────────────────────────
echo ""
echo "=== DB pool check (via health endpoint) ==="
HEALTH_RESP=$(curl -s -H "X-API-Key: $API_KEY" "$BACKEND_URL/api/v1/health")
DB_STATUS=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('database','unknown'))" 2>/dev/null)
echo "Database status: $DB_STATUS"
if echo "$DB_STATUS" | grep -q "^ok"; then
  echo "✓ Database is healthy"
else
  echo "✗ Database check failed — investigate before running write-heavy tests"
fi

# ── 6. Check Redis ───────────────────────────────────────────────────────────
echo ""
echo "=== Redis check ==="
REDIS_RESP=$(echo "$HEALTH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('redis','unavailable'))" 2>/dev/null)
echo "Redis status: $REDIS_RESP"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Run baseline test (requires k6):"
echo "  cd backend/stress_test"
echo "  k6 run k6_baseline.js \\"
echo "    -e BASE_URL=$BACKEND_URL \\"
echo "    -e API_KEY=\$API_KEY \\"
echo "    -e PROJECT_NAME=$PROJECT_NAME"
echo ""
echo "Or run pytest health checks:"
echo "  BACKEND_URL=$BACKEND_URL API_KEY=$API_KEY pytest backend/stress_test/test_health.py -v"