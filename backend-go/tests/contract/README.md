# FastAPI golden ↔ Go live contract

`live_contract_test.go` starts the Go gateway in-process against a disposable
Postgres database and asserts it against **a recording of the real FastAPI
responses** (`testdata/week1_live_golden.json`). Every case checks both the
HTTP status and the parsed JSON response. The suite covers all 14 Week 1 GET
routes and adds a non-admin global `/alerts/stats` regression case.

The recording replaces the old "start FastAPI and diff the two services"
setup: after the migration the CI gate must not depend on a Python runtime.
The golden file is produced by `backend-go/cmd/livegolden`.

CI is a hard gate:

- `backend-go/**` changes run `go test ./...`, `go vet ./...`, and
  `go test -race ./...`.
- `backend/**` or `backend-go/**` changes run the live-contract job with
  Postgres and Redis services (no Python steps).
- Missing environment, an unavailable service, a missing fixture, or any
  status/JSON difference fails the dedicated job. Outside that job the test
  skips only when the environment is entirely absent.

## Re-recording the golden file

Only do this when the FastAPI behaviour intentionally changes, and review the
diff: it is the reference the Go side is held to.

```bash
# 1. seed the deterministic fixtures into a disposable DB
cd backend-go
go run ./cmd/migrate up
go run ./cmd/seedtestreference
go run ./cmd/seedtestaccounts
go run ./cmd/seedlivecontract --database-url "$GO_API_TEST_DATABASE_URL"

# 2. start FastAPI against the same DB (last Python step; not needed in CI)
cd ../backend && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18100

# 3. record
cd ../backend-go
go run ./cmd/livegolden \
  --fastapi http://127.0.0.1:18100 \
  --database-url "$GO_API_TEST_DATABASE_URL" \
  --api-key "$LIVE_CONTRACT_API_KEY" \
  --out tests/contract/testdata/week1_live_golden.json
```

Database identifiers are replaced with `__PROJECT_ID__`-style placeholders, so
the recording survives a re-seeded database. Handlers that echo ids resolve the
placeholders back at test time.

## Covered routes

| Route | Fixture / identity |
| --- | --- |
| `GET /api/v1/health` | CI Postgres + Redis |
| `GET /api/v1/health/live` | none |
| `GET /api/v1/health/ready` | CI Postgres |
| `GET /api/v1/exchange-rates` | `LVC` / `2026-10` |
| `GET /api/v1/exchange-rates/resolve` | `LVC` / `2026-10` |
| `GET /api/v1/exchange-rates/options` | seeded exchange rates |
| `GET /api/v1/exchange-rates/{exchange_rate_id}` | seeded `LVC` row |
| `GET /api/v1/notifications` | user `424242`, unread alert |
| `GET /api/v1/notifications/unread-count` | user `424242` |
| `GET /api/v1/alerts/metrics` | static payload |
| `GET /api/v1/alerts/rules` | live contract project, admin |
| `GET /api/v1/alerts/events` | live contract project, admin |
| `GET /api/v1/alerts/stats` | live contract project, admin |
| `GET /api/v1/alerts/stats` | no project, non-admin regression |
| `GET /api/v1/system-management/profile` | seeded test admin |

`backend-go/cmd/seedlivecontract` creates these deterministic rows.
It refuses any database whose name is not `BLF_test` or `BLF_ci`.

## Running the contract locally

```bash
cd backend-go
GO_API_TEST_DATABASE_URL="$TEST_DATABASE_URL" \
LIVE_CONTRACT_API_KEY="$API_KEY" \
LIVE_CONTRACT_REQUIRED=1 \
REDIS_URL=redis://localhost:6379/0 \
go test ./tests/contract -run TestWeek1LiveContractAgainstGolden -count=1 -v
```

`go test ./...` skips the live test when the required variables are absent.
Partial configuration or `LIVE_CONTRACT_REQUIRED=1` turns that skip into a
failure.

## Semantic normalization

The comparison is otherwise exact, including object keys and array lengths.
Only inherently run-specific values are normalized:

- health `timestamp` values are compared as present, not equal instants;
- successful Redis latency (`ok (1.2ms)`) is compared as `ok`;
- `redis_memory` is compared for presence/nullability, not byte drift;
- `version` reflects `APP_ENV` and is not a contract property;
- JSON numbers allow `max(1e-9, 1e-9 * value)` tolerance;
- parseable ISO-8601 strings allow a one-second clock skew.

Field names, status codes, nullability, enum values, array order, and all
non-runtime values remain strict.

## Known difference ledger

| Difference | State |
| --- | --- |
| `/api/v1/alerts/stats` without `project_id`: FastAPI allowed non-admin, Go returned 403 | Fixed in `internal/api/alerts/handler.go`; guarded by unit and live cases |

Any new expected difference must be added here with an issue reference and an
explicit comparison rule. Do not add a blanket skip or key filter: a new field
or status difference must turn CI red.
