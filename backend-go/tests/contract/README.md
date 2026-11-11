# FastAPI <-> Go live contract

`live_contract_test.go` starts the Go gateway in-process against a running
FastAPI instance and the same disposable Postgres database. Every case checks
both the HTTP status and the parsed JSON response. The suite covers all 14
Week 1 GET routes and adds a non-admin global `/alerts/stats` regression case.

CI is a hard gate:

- `backend-go/**` changes run `go test ./...`, `go vet ./...`, and
  `go test -race ./...`.
- `backend/**` or `backend-go/**` changes run the live contract job with
  Postgres and Redis services.
- Missing environment, an unavailable service, a missing fixture, or any
  status/JSON difference fails the dedicated job. Outside that job the test
  skips only when the live environment is entirely absent.

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

## Local reproduction

The local runner reads a test environment file, seeds the fixtures, starts
FastAPI on `127.0.0.1:18100`, runs the contract, and always stops FastAPI.
It validates one disposable database URL, exports it as both
`DATABASE_URL` and `TEST_DATABASE_URL`, and passes it to the fixture seeder
with `--database-url`. A custom `BELIEVEBOY_ENV_FILE` is authoritative;
`backend/.env.test` cannot redirect the fixture to a different database.

```bash
cd backend-go
BELIEVEBOY_PYTHON=../backend/.venv/bin/python \
BELIEVEBOY_ENV_FILE=../backend/.env.test \
./scripts/run-live-contract.sh
```

To run only the Go side later, set the complete environment:

```bash
cd backend-go
FASTAPI_ORIGIN=http://127.0.0.1:18100 \
GO_API_TEST_DATABASE_URL="$TEST_DATABASE_URL" \
LIVE_CONTRACT_API_KEY="$API_KEY" \
LIVE_CONTRACT_REQUIRED=1 \
go test ./tests/contract -run TestWeek1LiveContractFastAPIAgainstGo -count=1 -v
```

`go test ./...` skips the live test when all three required variables are
absent. Partial configuration or `LIVE_CONTRACT_REQUIRED=1` turns that skip
into a failure.

## Semantic normalization

The comparison is otherwise exact, including object keys and array lengths.
Only inherently run-specific values are normalized:

- health `timestamp` values are compared as present, not equal instants;
- successful Redis latency (`ok (1.2ms)`) is compared as `ok`;
- `redis_memory` is compared for presence/nullability, not byte drift;
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

## Failure triage

1. `FastAPI unavailable` / `test database unavailable`: inspect the
   `live-contract` job services and the FastAPI log printed on failure.
2. `live contract requires ...`: restore `FASTAPI_ORIGIN`,
   `GO_API_TEST_DATABASE_URL`, and `LIVE_CONTRACT_API_KEY`.
3. `load live ... fixture`: rerun `go run ./cmd/seedlivecontract --database-url ...`; the test admin
   must already exist via `seed_test_accounts.py`.
4. `DATABASE_URL and TEST_DATABASE_URL ... different databases`: keep only one
   URL in the custom env file, or make both entries identical.
5. `status mismatch` or `JSON ... mismatch`: compare the two response bodies in
   the failure output, then update FastAPI/Go behavior. Do not weaken the
   assertion unless the difference is genuinely runtime-only and documented
   above.
