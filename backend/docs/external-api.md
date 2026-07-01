# External API (`/api/v1/external/*`)

Whitelisted read-only endpoints for internal BI tools and data analysts.

> **P0 contract**: no authentication, no rate limiting, no audit log. Network
> isolation is enforced at the gateway — see
> [`docs/deployment/external-api-network-isolation.md`](../../docs/deployment/external-api-network-isolation.md).

---

## 1. Endpoint catalog

All endpoints are `GET` and live under `/api/v1/external/`. They return
JSON, with snake_case field names.

### 1.1 Discovery

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | GET | `/external/projects` | List projects (filterable by `status=active\|archived\|all`) |
| 2 | GET | `/external/projects/{id}/ad-upload-files` | List `AdUploadFile` metadata for a project |

### 1.2 Row data (10 report types)

Each accepts the same query parameters (`period`, `country`, `limit`,
`offset`, `order_by`, `order_dir`) and returns the matching rows of the
underlying `ad_upload_*_rows` table (excluding the `raw_row` JSON blob).

| # | Method | Path | Report type |
|---|---|---|---|
| 3 | GET | `/external/projects/{id}/ad-campaigns` | `ad_campaign_report` |
| 4 | GET | `/external/projects/{id}/ad-search-terms` | `ad_search_term_report` |
| 5 | GET | `/external/projects/{id}/ad-budgets` | `ad_budget_report` |
| 6 | GET | `/external/projects/{id}/ad-targets` | `ad_target_report` |
| 7 | GET | `/external/projects/{id}/ad-placements` | `ad_placement_report` |
| 8 | GET | `/external/projects/{id}/ad-promoted-products` | `ad_promoted_product_report` |
| 9 | GET | `/external/projects/{id}/ad-time-trends` | `ad_time_trend_report` |
| 10 | GET | `/external/projects/{id}/ad-search-term-shares` | `ad_search_term_share_report` |
| 11 | GET | `/external/projects/{id}/ad-invalid-traffic` | `ad_invalid_traffic_report` |
| 12 | GET | `/external/projects/{id}/ad-purchased-products` | `ad_purchased_product_report` |

---

## 2. Query parameters

### 2.1 `?period=` — dual format

**Convenience aliases** (anchor: yesterday, T-1):

| Alias | Window |
|---|---|
| `7d` | T-6 .. T-1 |
| `14d` | T-13 .. T-1 |
| `28d` | T-27 .. T-1 |
| `30d` | T-29 .. T-1 |
| `60d` | T-59 .. T-1 |
| `90d` | T-89 .. T-1 |
| `this_month` | 1st of T-1's month .. T-1 (degenerate to full prev month if T-1 fell in prev month) |
| `last_month` | 1st of previous calendar month .. last day |
| `ytd` | Jan 1 of T-1's year .. T-1 (degenerate to full prev year if T-1 fell in prev year) |

**Custom range** (no anchor logic — caller controls the window):

```
period=custom&start_date=2026-06-15&end_date=2026-06-28
```

### 2.2 `?country=` (row endpoints)

ISO-2 code (`US`, `DE`, `UK`) or alias (`USA`, `德国`, `美国站`, etc. via
`app.utils.country`). **Required** — empty/missing returns `400`.

### 2.3 `?limit=`, `?offset=`

| Param | Default | Range |
|---|---|---|
| `limit` | 10000 | 1 .. 50000 |
| `offset` | 0 | ≥ 0 |

### 2.4 `?order_by=`, `?order_dir=`

`order_dir` must be `asc` or `desc` (default `desc`). `order_by` must be
in the per-table whitelist — see [§4](#4-order_by-whitelist). Default
`order_by` is `report_end_date`.

### 2.5 `?include_history=` (file listing only)

`false` (default) — only `is_current=true` files.
`true` — every version, newest first.

### 2.6 `?status=` (projects only)

`active` (default) / `archived` / `all`.

---

## 3. Error conventions

Standard FastAPI `{"detail": ...}` envelope. Status codes:

| Code | When |
|---|---|
| 200 | Success (empty list `[]` if no rows match) |
| 400 | Missing / invalid `period` / `country` / `order_by` / `order_dir` / `limit` |
| 404 | `project_id` does not exist |
| 422 | `project_id < 1`, `limit > 50000`, or other schema-level validation |

Examples:

```bash
# 400 — missing period
GET /external/projects/1/ad-campaigns?country=US
→ {"detail": "period is required"}

# 400 — country missing
GET /external/projects/1/ad-campaigns?period=7d
→ {"detail": "country is required"}

# 400 — invalid order_by
GET /external/projects/1/ad-campaigns?period=7d&country=US&order_by=secret
→ {"detail": "order_by must be one of [...], got 'secret'"}

# 404 — missing project
GET /external/projects/99999/ad-campaigns?period=7d&country=US
→ {"detail": "project 99999 not found"}

# 200 — empty result
GET /external/projects/1/ad-campaigns?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US
→ []
```

---

## 4. `order_by` whitelist

`order_by` is **strictly whitelisted per table**. Unknown columns return 400.
This protects against slow queries on un-indexed fields and prevents
sorting on JSON blobs (`raw_row`).

### 4.1 Common columns (every row table)

```
id
source_file_id
report_start_date
report_end_date
```

### 4.2 Per-table additions

**Campaign / Target / Placement / Search Term / Search Term Share /
Promoted Product / Invalid Traffic**:
```
campaign_name, spend, impressions, clicks, sales_7d, orders_7d, roas, acos
```
**Search Term / Search Term Share / Target**: also `target_text`, `search_term`
**Promoted Product**: also `ad_sku`
**Placement**: also `placement`
**Search Term Share**: also `impression_rank`, `impression_share`

**Budget** (diagnostic-only fields):
```
campaign_name, budget, suggested_budget, budget_utilization_rate,
missed_impressions_max, missed_sales_max
```

**Time Trend**:
```
country, spend, clicks, cpc
```

**Purchased Product**:
```
campaign_name, ad_sku, purchased_asin,
other_sku_units_7d, other_sku_orders_7d, other_sku_sales_7d
```

---

## 5. Example calls

```bash
# Latest 14 days of campaign rows for project 1 in US
curl 'http://localhost:8100/api/v1/external/projects/1/ad-campaigns?period=14d&country=US'

# Custom range — June 1 to June 14
curl 'http://localhost:8100/api/v1/external/projects/1/ad-campaigns?period=custom&start_date=2026-06-01&end_date=2026-06-14&country=US'

# Top 50 search terms by spend, ascending date order
curl 'http://localhost:8100/api/v1/external/projects/1/ad-search-terms?period=28d&country=US&order_by=spend&order_dir=desc&limit=50'

# List all uploaded files for a project (current version only)
curl 'http://localhost:8100/api/v1/external/projects/1/ad-upload-files?country=US'

# Include file version history
curl 'http://localhost:8100/api/v1/external/projects/1/ad-upload-files?include_history=true'

# List active projects
curl 'http://localhost:8100/api/v1/external/projects'
```

---

## 6. Implementation notes (for backend maintainers)

### 6.1 Version selection

When multiple `AdUploadFile` rows match the (project, country, report_type,
period) tuple, the endpoint picks the one with `max(version)` then
`max(updated_at)`. Older versions are reachable via
`/ad-upload-files?include_history=true` only.

### 6.2 Period overlap formula

```
AdUploadFile.period_start_date <= :date_to
AND AdUploadFile.period_end_date >= :date_from
```

Mirrors the pattern in `backend/app/services/product/sources.py:91-105`.

### 6.3 Only `success` + `recognized` files

Row queries filter on `ingestion_status='success'` and
`recognition_status='recognized'`. Failed / pending files are skipped
silently.

### 6.4 Read replica

Row endpoints use `Depends(get_read_db_session)` — read traffic goes to
the configured replica (`database_read_url`) when available.

### 6.5 No `raw_row` JSON

The 9 row schemas deliberately exclude `raw_row` to keep payloads small
and predictable. P1 may add `?include_raw=true` if BI teams need the
original CSV columns.

---

## 7. Roadmap (P1+)

- **API key authentication** — `X-API-Key` header + `external_api_keys`
  table with `scope`/`expires_at`.
- **Rate limiting** — `slowapi` per-key limits (default 60/min).
- **Audit log** — async Celery task writes every call to
  `external_api_audit`.
- **`?include_raw=true`** — opt-in raw JSON passthrough.
- **CSV / Parquet streaming** for large result sets.
- **SQL endpoint** (low priority — only if BI team strongly requests).