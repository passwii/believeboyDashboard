# External API (`/api/v1/external/*`)

Whitelisted read-only endpoints for internal BI tools and data analysts.

> **P0 contract**: no authentication, no rate limiting, no audit log. Network
> isolation is enforced at the gateway — see
> [`docs/deployment/external-api-network-isolation.md`](../../docs/deployment/external-api-network-isolation.md).

---

## 1. Endpoint catalog

All endpoints are `GET` and live under `/api/v1/external/`. They return
JSON, with snake_case field names.

### 1.1 Discovery & inventory

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | GET | `/external/projects` | List projects (filterable by `status=active\|archived\|all`) |
| 2 | GET | `/external/projects/{id}/orders/summary` | Deduplicated orders/sales for TACoS |
| 3 | GET | `/external/projects/{id}/business-summary` | Business dashboard (traffic + cost/profit) |
| 4 | GET | `/external/projects/{id}/sku-info` | SKU master data (pricing, dimensions, carton specs) |
| 5 | GET | `/external/projects/{id}/replenishment-analysis` | **NEW** Inventory health + DMS + replenishment (see §6) |

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

## 4. Orders Summary — `GET /external/projects/{id}/orders/summary`

Returns deduplicated real orders/sales data for TACoS calculation.

### 4.1 Query parameters

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `period` | ✅ | — | `7d`, `14d`, `28d`, `30d`, `60d`, `90d`, `this_month`, `last_month`, `ytd`, or `custom` |
| `start_date` | `custom` only | — | `YYYY-MM-DD` (required when `period=custom`) |
| `end_date` | `custom` only | — | `YYYY-MM-DD` (required when `period=custom`) |
| `country` | ✅ | — | ISO-2 code (e.g., `US`, `UK`, `DE`). **Must be supplied** — no default. |
| `include_cancelled` | ❌ | `false` | Include `order_status='Cancelled'` rows |
| `include_pending` | ❌ | `true` | Include pending/unshipped rows |
| `aggregate` | ❌ | `true` | Include top-level `aggregate` object in response |
| `limit` | ❌ | `50000` | Max rows (1–50000) |
| `offset` | ❌ | `0` | Pagination offset |

### 4.2 Core logic

1. Select current `sales_report` files: `AnalysisSourceFile.is_current=true` + `ingestion_status='success'`
2. Join `AnalysisSalesOrderRow` → filter `is_counted_sales=true`
3. Exclude `order_status='Cancelled'` unless `include_cancelled=true`
4. Exclude pending unless `include_pending=true`
5. Deduplication is implicit via `is_current=true` (only latest version per period)

### 4.3 Response shape (200)

```json
{
  "project_id": 1,
  "period": { "type": "relative", "value": "14d", "start_date": "2026-06-01", "end_date": "2026-06-14" },
  "country": "US",
  "data": [
    {
      "amazon_order_id": "111-2222222-3333333",
      "purchase_date_pt": "2026-06-10",
      "order_status": "Shipped",
      "fulfillment_channel": "Amazon",
      "fulfillment_label": "FBA（亚马逊配送）",
      "sku": "SKU-001",
      "asin": "B0000001",
      "product_name": "Product A",
      "quantity": 2,
      "item_price": 29.99,
      "shipping_price": 0.0,
      "currency": "USD",
      "country": "US",
      "is_counted_sales": true
    }
  ],
  "aggregate": {
    "total_orders": 150,
    "total_quantity": 320,
    "total_sales_amount": 8945.20,
    "currency": "USD",
    "fba_orders": 120,
    "fbm_orders": 30
  },
  "summary": { "...": "same as aggregate for backwards compatibility" }
}
```

---

## 5. Business Summary — `GET /external/projects/{id}/business-summary`

Returns business dashboard data: traffic quality (PV, sessions, CVR) aggregated by ASIN from `analysis_business_rows`, plus cost/profit/breakeven from `shop_calculation` snapshot.

### 5.1 Query parameters

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `period` | ✅ | — | Same aliases as orders/summary |
| `start_date` | `custom` only | — | `YYYY-MM-DD` |
| `end_date` | `custom` only | — | `YYYY-MM-DD` |
| `country` | ✅ | — | ISO-2 code — **must be supplied** |

### 5.2 Core logic

1. Select current `business_report` files (same version selection as ad endpoints)
2. `GROUP BY asin` on `AnalysisBusinessRow` → SUM `page_views`, `sessions`, `units_ordered`, `ordered_sales_amount`
3. Compute `CVR = units / sessions * 100` (percent)
4. Join latest `ShopCalculation` per `(project_id, asin, country)` for cost/profit/breakeven
5. Return detail rows + aggregate totals

### 5.3 Response shape (200)

```json
{
  "project_id": 1,
  "period": { "type": "relative", "value": "14d", "start_date": "2026-06-01", "end_date": "2026-06-14" },
  "country": "US",
  "detail": [
    {
      "asin": "B0000001",
      "page_views": 1250,
      "sessions": 480,
      "units_ordered": 95,
      "ordered_sales_amount": 2849.05,
      "cvr": 19.79,
      "cost_total": 1420.00,
      "profit": 420.50,
      "profit_rate": 14.76,
      "breakeven_units": 72
    }
  ],
  "aggregate": {
    "total_asins": 12,
    "total_page_views": 15000,
    "total_sessions": 5800,
    "total_units_ordered": 1150,
    "total_sales_amount": 34500.0,
    "total_cost": 18200.0,
    "total_profit": 4200.0,
    "overall_cvr": 19.83,
    "overall_profit_rate": 12.17
  },
  "summary": { "...": "alias of aggregate" }
}
```

---

## 6. Replenishment Analysis — `GET /external/projects/{id}/replenishment-analysis`

Returns a per-SKU inventory-health + replenishment analysis with age-bucket
breakdown from the latest FBA inventory snapshot, combined with computed DMS
(sales velocity at 30/14/7/3 day windows), weighted DMS, sellable days,
replenishment timeline, and risk classification.

A single endpoint that external BI tools or agent orchestrators can call to
get a unified inventory signal without re-computing DMS or reconciling
separate stock/sales tables.

### 6.1 Query parameters

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `project_id` | ✅ | — | Path parameter; project ID (≥1) |
| `country` | ❌ | `US` | ISO-2 country code |
| `keyword` | ❌ | — | Filter by SKU or ASIN (substring, case-insensitive) |
| `risk_status` | ❌ | — | Filter: `断货风险` / `短期断货` / `长期断货` / `健康库存` / `滞销` / `严重滞销` / `待补数据` |
| `in_transit_only` | ❌ | `false` | Only SKUs with in-transit qty > 0 |
| `report_date` | ❌ | — | Business date for historical snapshot (`YYYY-MM-DD`). Uses the latest inventory snapshot on or before this date and anchors all calculations to it. Default: today. |
| `page` | ❌ | `1` | Page number (1-based) |
| `page_size` | ❌ | `50` | Items per page (max 200) |

### 6.2 Core logic

1. Load active SKUs from `SkuRecord` (is_active=true) + `InventoryReplenishmentSetting`
2. Query latest `inventory_report` snapshot → `InventorySnapshotRow` → SUM `available_qty` + age buckets by SKU
3. Query `AnalysisSalesOrderRow` → compute DMS at 30/14/7/3 days
4. Compute weighted DMS = base DMS × (1 + safety_factor)
5. Compute:
   - `sellable_days` = available_inventory / weighted_dms
   - `sellout_date` = today + sellable_days
   - `replenishment_order_date` = sellout_date_with_transit − (production_lead_days + shipping_days)
   - `estimated_replenishment_quantity` = (production_lead_days + shipping_days) × weighted_dms
6. Classify risk status per SKU

### 6.3 Response shape (200)

```json
{
  "page": 1,
  "page_size": 50,
  "total": 12,
  "has_next": false,
  "summary": {
    "sku_count": 12,
    "out_of_stock_risk_count": 2,
    "healthy_count": 7,
    "slow_moving_count": 1,
    "pending_data_count": 2,
    "total_available_inventory": 8450,
    "total_in_transit_quantity": 3200
  },
  "items": [
    {
      "project_id": 1,
      "project_name": "MyProject",
      "sku": "SKU-001",
      "country": "US",
      "asin": "B0000001",
      "product_name": "Product A",
      "available_inventory": 500,
      "in_transit_quantity": 200,
      "dms_30": 15.5,
      "dms_14": 16.2,
      "dms_7": 14.8,
      "dms_3": 12.1,
      "base_dms": 15.3,
      "safety_factor": 0.2,
      "weighted_dms": 18.36,
      "sellable_days": 27.23,
      "sellout_date": "2026-08-27",
      "sellout_date_with_transit": "2026-09-17",
      "production_lead_days": 30,
      "shipping_days": 15,
      "replenishment_order_date": "2026-08-03",
      "warehouse_entry_date": "2026-08-10",
      "shipment_order_date": "2026-09-02",
      "estimated_replenishment_quantity": 826,
      "risk_status": "健康库存",
      "risk_anchor_date": "2026-09-17",
      "age_0_90_qty": 300,
      "age_91_180_qty": 150,
      "age_181_270_qty": 50,
      "age_271_365_qty": 0,
      "age_365_plus_qty": 0,
      "recommended_action": null
    }
  ]
}
```

### 6.4 Field reference (`items[]`)

| Field | Type | Nullable | Description |
|---|---|---|---|
| `sku` | string | ❌ | SKU identifier |
| `asin` | string | ✅ | Amazon ASIN |
| `product_name` | string | ✅ | Product display name |
| `available_inventory` | int | ❌ | FBA available quantity (latest snapshot) |
| `in_transit_quantity` | int | ❌ | In-transit quantity from shipment schedules |
| `dms_30` | float | ✅ | Daily sales over last 30 days |
| `dms_14` | float | ✅ | Daily sales over last 14 days |
| `dms_7` | float | ✅ | Daily sales over last 7 days |
| `dms_3` | float | ✅ | Daily sales over last ~3 days (recent, lagged) |
| `base_dms` | float | ✅ | Weighted average of the four DMS windows |
| `weighted_dms` | float | ✅ | `base_dms × (1 + safety_factor)` — the effective sell rate used for replenishment |
| `sellable_days` | float | ✅ | `available_inventory / weighted_dms` |
| `sellout_date` | string | ✅ | Date when stock is predicted to run out (without transit) |
| `sellout_date_with_transit` | string | ✅ | Date when stock + transit is predicted to run out |
| `production_lead_days` | int | ❌ | Manufacturing lead time (from settings or default) |
| `shipping_days` | int | ❌ | Shipping time (from settings or default) |
| `replenishment_order_date` | string | ✅ | Recommended date to place the replenishment order |
| `warehouse_entry_date` | string | ✅ | Estimated warehouse entry date (order + 7 days) |
| `shipment_order_date` | string | ✅ | Estimated shipment departure date |
| `estimated_replenishment_quantity` | int | ✅ | Recommended replenishment qty (≈ lead_demand × weighted_dms) |
| `risk_status` | string | ❌ | One of: `断货风险`, `短期断货`, `长期断货`, `健康库存`, `滞销`, `严重滞销`, `待补数据` |
| `age_0_90_qty` | int | ❌ | Inventory aged 0–90 days (default 0) |
| `age_91_180_qty` | int | ❌ | Inventory aged 91–180 days |
| `age_181_270_qty` | int | ❌ | Inventory aged 181–270 days |
| `age_271_365_qty` | int | ❌ | Inventory aged 271–365 days |
| `age_365_plus_qty` | int | ❌ | Inventory aged >365 days |
| `recommended_action` | string | ✅ | FBA's recommended action (e.g. `Return`, `Liquidate`; null if none) |

### 6.5 Example calls

```bash
# All SKUs for project 1 in US (page 1, default page_size=50)
curl 'http://localhost:8100/api/v1/external/projects/1/replenishment-analysis?country=US'

# Filter by SKU
curl 'http://localhost:8100/api/v1/external/projects/1/replenishment-analysis?country=US&keyword=SKU-'

# Only out-of-stock risk SKUs, page 2
curl 'http://localhost:8100/api/v1/external/projects/1/replenishment-analysis?country=US&risk_status=%E6%96%AD%E8%B4%A7%E9%A3%8E%E9%99%A9&page=2'

# Only SKUs with in-transit stock
curl 'http://localhost:8100/api/v1/external/projects/1/replenishment-analysis?country=US&in_transit_only=true'

# Historical snapshot as of July 15, 2026
curl 'http://localhost:8100/api/v1/external/projects/1/replenishment-analysis?report_date=2026-07-15'
```

---

## 7. Error conventions (shared)

| HTTP | Condition |
|------|-----------|
| 400 | `period` missing / invalid / `custom` without dates / alias combined with `start_date`/`end_date` / `country` missing / invalid / `limit` out of range |
| 404 | `project_id` not found |
| 200 | Empty `data` / `detail` when no current file overlaps the requested window |

---

## 7. `order_by` whitelist

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

## 6. Example calls

```bash
# Latest 14 days of campaign rows for project 1 in US
curl 'http://localhost:8100/api/v1/external/projects/1/ad-campaigns?period=14d&country=US'

# Custom range — June 1 to June 14
curl 'http://localhost:8100/api/v1/external/projects/1/ad-campaigns?period=custom&start_date=2026-06-01&end_date=2026-06-14&country=US'

# Top 50 search terms by spend, ascending date order
curl 'http://localhost:8100/api/v1/external/projects/1/ad-search-terms?period=28d&country=US&order_by=spend&order_dir=desc&limit=50'

# List active projects
curl 'http://localhost:8100/api/v1/external/projects'

# Replenishment analysis for project 1 US
curl 'http://localhost:8100/api/v1/external/projects/1/replenishment-analysis'
```

---

## 8. Implementation notes (for backend maintainers)

### 8.1 Version selection

When multiple `AdUploadFile` rows match the (project, country, report_type,
period) tuple, the endpoint picks the one with `max(version)` then
`max(updated_at)`. Older versions are reachable via
`/ad-upload-files?include_history=true` only.

### 8.2 Period overlap formula

```
AdUploadFile.period_start_date <= :date_to
AND AdUploadFile.period_end_date >= :date_from
```

Mirrors the pattern in `backend/app/services/product/sources.py:91-105`.

### 8.3 Only `success` + `recognized` files

Row queries filter on `ingestion_status='success'` and
`recognition_status='recognized'`. Failed / pending files are skipped
silently.

### 8.4 Read replica

Row endpoints use `Depends(get_read_db_session)` — read traffic goes to
the configured replica (`database_read_url`) when available.

### 8.5 No `raw_row` JSON

The row schemas deliberately exclude `raw_row` to keep payloads small
and predictable. P1 may add `?include_raw=true` if BI teams need the
original CSV columns.

---

## 9. Return Analysis — `GET /external/projects/{id}/return-analysis[-raw]`

Two read-only endpoints exposing per-SKU return metrics and raw return events,
served from the `analysis_return_aggregates` snapshot table (refreshed daily at
03:00 UTC by Celery) with fallback to live computation.

### 9.1 Aggregate endpoint

```
GET /api/v1/external/projects/{project_id}/return-analysis
```

| Param | Type | Required | Notes |
|---|---|---|---|
| `period` | string | yes | `7d\|14d\|30d\|60d\|90d\|this_month\|last_month\|ytd\|custom` |
| `country` | string | yes | ISO-2 code (US, DE, UK, JP, …) |
| `start_date` | date | custom only | `YYYY-MM-DD` |
| `end_date` | date | custom only | `YYYY-MM-DD` |
| `sku` | string | no | substring filter |
| `min_return_rate` | float | no | only rows ≥ X% |
| `risk_level` | string | no | `critical\|warning` |
| `limit` | int | no | 1–500, default 50 |
| `offset` | int | no | default 0 |
| `order_by` | string | no | whitelist below |
| `order_dir` | string | no | `asc\|desc`, default `desc` |

**`order_by` whitelist**: `sku`, `return_count`, `return_quantity`,
`sales_quantity`, `return_rate`, `wilson_lower`, `cycle_avg_days`, `risk_level`

**Response shape**:

```json
{
  "project_id": 1,
  "country": "US",
  "period": { "type": "relative", "value": "30d", "start_date": "…", "end_date": "…" },
  "summary": {
    "total_return_count": 287,
    "total_return_quantity": 412,
    "total_sales_quantity": 5840,
    "overall_return_rate": 7.05,
    "overall_risk_level": "warning",
    "unique_skus": 23
  },
  "items": [
    {
      "sku": "SKU-001",
      "asin": "B0000001",
      "product_name": "Product A",
      "return_count": 47,
      "return_quantity": 68,
      "sales_quantity": 520,
      "return_rate": 13.08,
      "wilson_lower": 10.12,
      "cycle_avg_days": 12.4,
      "reason_top1_display": "与描述不符",
      "disposition_top1_display": "可售",
      "dominant_fc_id": "PHX6",
      "risk_level": "critical",
      "risk_trend": "degrading"
    }
  ],
  "pagination": { "limit": 50, "offset": 0, "total": 23 }
}
```

### 9.2 Raw endpoint

```
GET /api/v1/external/projects/{project_id}/return-analysis-raw
```

Same query params (minus `risk_level` / `min_return_rate`). Returns individual
return events.

**`order_by` whitelist**: `return_date`, `sku`, `asin`, `quantity`,
`fulfillment_center_id`, `reason`, `status`

**Never returned** (enforced by Pydantic schema):
- `customer_comments` — PII / free-form complaint text
- `raw_row` — debug-only Amazon CSV blob

### 9.3 Risk level semantics

| Level | Condition |
|---|---|
| `no_data` | `sales_quantity < 15` (insufficient sample) |
| `normal` | Wilson 95% lower bound < 6% |
| `warning` | Wilson 95% lower bound ≥ 6% |
| `critical` | Wilson 95% lower bound ≥ 10% |

Wilson lower bound uses z=1.96 (95% confidence). Pre-computed by Celery into
`analysis_return_aggregates.risk_level`.

### 9.4 Implementation notes

- Snapshot freshness: if `computed_at` > 25h old, endpoint falls back to live
  `build_return_analysis()` computation.
- Read replica: uses `Depends(get_read_db_session)`.
- No application-layer auth (P0, consistent with all external endpoints).
  Network isolation at gateway layer.

---

## 10. Shop / New-Product Calculation (BEL-378 / BEL-416)

Four read-only endpoints exposing the append-only ``shop_calculation``
table (current state + time-series) and the ``new_product_calculations``
table (paginated list), plus the catalog-freeze endpoint for
``pricing_calculation_snapshots``. These complete the BEL-378 Phase A
"externalize the historical time-series" goal so BI tools can pull
pricing history without joining ``shop_calculation`` directly.

### 10.1 Shop Calculation current-state — `GET /external/projects/{id}/shop-calculation-history`

Latest non-deleted ``shop_calculation`` row per ``(project_id, sku,
country)`` group. The current-state view mirrors the internal
``/api/v1/shop-calculation`` endpoint (same `MAX(id)` dedup logic) but
flattens the nested ``dimensions`` / ``weights`` / ``fees`` / ``profit``
objects into top-level columns for BI consumption.

| Param | Type | Required | Notes |
|---|---|---|---|
| `country` | string | no | ISO-2 code (US, DE, UK). Empty returns all countries. |
| `page` | int | no | 1-based, default 1 |
| `page_size` | int | no | default 200, max 500 |
| `order_by` | string | no | 16 whitelisted columns (see below); default `observed_at` |
| `order_dir` | string | no | `asc` / `desc`, default `desc` |

**`order_by` whitelist**: `id`, `project_id`, `project_name`, `sku`,
`asin`, `country`, `accounting_type`, `observed_at`, `source`,
`sale_price_usd`, `profit_usd`, `profit_rate`, `payout_usd`,
`total_fee_usd`, `created_at`, `updated_at`.

**Response shape**:

```json
{
  "project_id": 1,
  "country": "US",
  "total": 12,
  "data": [
    {
      "id": 42,
      "project_id": 1,
      "project_name": "MyProject",
      "sku": "SKU-001",
      "asin": "B0000001",
      "country": "US",
      "accounting_type": "profit_calc",
      "observed_at": "2026-08-01T12:34:56Z",
      "source": "manual",
      "sale_price_usd": 29.99,
      "profit_usd": 5.0,
      "profit_rate": 0.10,
      "payout_usd": 14.19,
      "total_fee_usd": 15.8,
      "created_at": "2026-08-01T12:34:56Z",
      "updated_at": "2026-08-01T12:34:56Z"
    }
  ]
}
```

### 10.2 Shop Calculation time-series — `GET /external/projects/{id}/shop-calculation/snapshots`

Append-only history filtered by date window, SKU, and country. Same
16-column shape as §10.1, but rows are not deduped — the same SKU can
appear multiple times across different `observed_at` snapshots.

| Param | Type | Required | Notes |
|---|---|---|---|
| `from_date` | date | no | Inclusive lower bound (`YYYY-MM-DD`). |
| `to_date` | date | no | Inclusive upper bound (`YYYY-MM-DD`). |
| `sku` | string | no | Exact-match SKU filter. |
| `country` | string | no | ISO-2 code. |

### 10.3 Pricing catalog freeze — `GET /external/projects/{id}/pricing-snapshots?as_of=YYYY-MM-DD`

Returns the latest `pricing_calculation_snapshots` row whose
`snapshot_date` is on or before `as_of`. When `as_of` is omitted the
endpoint returns the most recent snapshot.

| Param | Type | Required | Notes |
|---|---|---|---|
| `as_of` | date | no | `YYYY-MM-DD`. Defaults to no upper bound (newest snapshot). |
| `country` | string | yes | ISO-2 code (US, DE, UK). |

Returns 404 when no snapshot exists for the `(project, country, as_of)`
tuple. The 16-column shape is identical to §10.1 (synthetic ids =
`snapshot_id * 1_000_000 + source_row_no`; `source="manual"`).

### 10.4 New Product Calculation list — `GET /external/projects/{id}/new-product-calculations`

Paginated list of `new_product_calculations` rows (the canonical table
for profit-calc / profit-reverse snapshots; the legacy
`store_sku_pricing_snapshots` table was renamed in 2026-08, migration
230).

| Param | Type | Required | Notes |
|---|---|---|---|
| `calculation_type` | string | no | `profit_calc` / `profit_reverse` / `eu_accounting` |
| `country` | string | no | ISO-2 code |
| `page` | int | no | default 1 |
| `page_size` | int | no | default 200, max 500 |
| `order_by` | string | no | 15 whitelisted columns (mirror of §10.1 + `target_profit_rate`, minus `observed_at`/`source` which NPC doesn't track) |
| `order_dir` | string | no | `asc` / `desc`, default `desc` |

### 10.5 Field reference (shared across §10.1–§10.3)

| Field | Type | Description |
|---|---|---|
| `id` | int | Row PK. For §10.3 this is a synthetic id (`snapshot_id × 1M + source_row_no`). |
| `project_id`, `project_name` | int / str | Project reference. |
| `sku`, `asin` | str / str? | SKU identifier; Amazon ASIN (nullable). |
| `country` | str | ISO-2 code. |
| `accounting_type` | str | `profit_calc` / `eu_accounting` (NPC uses `calculation_type` instead). |
| `observed_at` | datetime | BEL-378 append-only timestamp (when the observation was recorded). |
| `source` | str | `manual` / `agent_listing_pull` / `external_api`. |
| `sale_price_usd` | float | Catalog sale price. |
| `profit_usd` | float | Profit per unit. |
| `profit_rate` | float | Ratio (0..1, NOT percent). |
| `payout_usd` | float | Net payout to seller. |
| `total_fee_usd` | float | Total Amazon fees. |
| `created_at`, `updated_at` | datetime | DB-level timestamps. |
| `target_profit_rate` | float? | NPC only. Set for `profit_reverse` snapshots. |

### 10.6 Sensitive / excluded fields (defense-in-depth)

These fields are **never** returned by any §10 endpoint, enforced by
both the whitelist and the Pydantic schema:

- `created_by` — internal operator
- `deleted_at` — soft-delete marker (callers should never see deleted rows; the service layer filters them out)
- `warnings` / `warnings_json` — debug blob
- `notes` — free-form internal text
- Fee-rule labels (`fulfillment_fee_rule_label`, `inbound_config_fee_rule_label`, `storage_fee_rule_label`) — long internal strings, low BI value

### 10.7 Example calls

```bash
# Current-state list for project 1 US, sorted by profit
curl 'http://localhost:8100/api/v1/external/projects/1/shop-calculation-history?country=US&order_by=profit_usd&order_dir=desc'

# History for one SKU over July 2026
curl 'http://localhost:8100/api/v1/external/projects/1/shop-calculation/snapshots?from_date=2026-07-01&to_date=2026-07-31&sku=SKU-001&country=US'

# Catalog freeze as of Aug 1, 2026 (US)
curl 'http://localhost:8100/api/v1/external/projects/1/pricing-snapshots?as_of=2026-08-01&country=US'

# Profit-reverse NPC rows
curl 'http://localhost:8100/api/v1/external/projects/1/new-product-calculations?calculation_type=profit_reverse'
```

### 10.8 Implementation notes

- All four endpoints use `Depends(get_read_db_session)` — read traffic
  goes to the configured replica when available.
- `shop_calculation_service.latest_stmt()` powers the current-state
  endpoint; `list_history()` powers the time-series endpoint (both
  apply soft-delete filtering unless explicitly bypassed).
- `pricing_calculation_snapshot_service.list_snapshots()` (already
  DESC-sorted by `snapshot_date`) is walked in Python to find the
  first row with `snapshot_date <= as_of`.
- No application-layer auth (P0, consistent with all external endpoints).

---

## 11. Roadmap (P1+)

- ~~**API key authentication** — `X-API-Key` header + `external_api_keys`
  table with `scope`/`expires_at`.~~ ✅ Done (BEL-377) — see §12.
- ~~**Rate limiting** — `slowapi` per-key limits (default 60/min).~~
  ✅ Done (BEL-377) — see §12.
- ~~**Audit log** — every call written to `external_api_audit_log`
  (middleware, 90-day Celery retention).~~ ✅ Done (BEL-377) — see §12.
- **`?include_raw=true`** — opt-in raw JSON passthrough. (P2)
- **CSV / Parquet streaming** for large result sets. (P2)
- **Per-key scope restrictions** — currently every key has full read
  access (`scope="read"`). (P2)
- **Billing / metering** on top of the audit log. (P2)

---

## 12. Authentication & Rate Limiting (BEL-377)

P0 relied on gateway-level network isolation only. P1 adds application-layer
security on the `/api/v1/external/*` namespace. Both enforcement switches
default to **off** so deploying the code never breaks existing consumers;
flip them once every consumer holds a key.

### 11.1 Feature flags (env vars)

| Env var | Default | Effect |
|---|---|---|
| `EXTERNAL_API_REQUIRE_AUTH` | `false` | Require a valid API key on every external route. |
| `EXTERNAL_API_ALLOW_SKIP_AUTH` | `true` | While enforcing, honour `?skip_auth=true` (transition bypass — remove after rollout). |
| `EXTERNAL_API_RATE_LIMIT_ENABLED` | `false` | Enable per-key rate limiting. |
| `EXTERNAL_API_RATE_LIMIT` | `60/minute` | slowapi limit expression. |
| `EXTERNAL_API_AUDIT_ENABLED` | `true` | Write one audit row per external request. |
| `EXTERNAL_API_AUDIT_RETENTION_DAYS` | `90` | Celery cleanup horizon. |

### 11.2 Credentials

Keys are created by an admin and the plaintext is returned **once**:

```bash
# Create (admin only — requires X-Is-Admin: true behind the dashboard proxy)
curl -X POST "$API/api/v1/internal/api-keys" \
  -H 'Content-Type: application/json' \
  -H 'X-Is-Admin: true' \
  -d '{"label": "agent-prod"}'
# → {"id": 1, "key_prefix": "bbx_ab12cd34", "plaintext_key": "bbx_...", ...}

# List (no secrets returned)
curl "$API/api/v1/internal/api-keys" -H 'X-Is-Admin: true'

# Revoke
curl -X POST "$API/api/v1/internal/api-keys/1/revoke" -H 'X-Is-Admin: true'
```

Only the SHA-256 hash is stored (`external_api_keys`); the plaintext cannot
be retrieved later.

### 11.3 Calling the external API

Three equivalent ways to present a key (same precedence as the internal
`require_api_key`):

```bash
# 1) X-API-Key header (preferred)
curl "$API/api/v1/external/projects" -H 'X-API-Key: bbx_...'

# 2) Authorization: Bearer
curl "$API/api/v1/external/projects" -H 'Authorization: Bearer bbx_...'

# 3) Query fallback (Vercel/edge strips auth headers but keeps query params)
curl "$API/api/v1/external/projects?api_key=bbx_..."
```

The legacy master secret (`API_KEY` / `settings.api_key`) keeps working for
backward compatibility. Responses when enforcing:

| Condition | Status | `detail` |
|---|---|---|
| No key supplied | 401 | `Missing API key` |
| Key not found / revoked | 401 | `Invalid API key` |
| Key past `expires_at` | 401 | `API key expired` |
| Over rate limit | 429 | `请求过于频繁，请稍后再试（…）` |

### 11.4 Rate limiting

Implemented with `slowapi` (in-memory storage, fails open — the gateway IP
allowlist is the backstop). The limiter key is the validated DB key id
(`apikey:<id>`), falling back to client IP for master-key / `?skip_auth` /
anonymous traffic during the transition. Limits are per key, so one consumer
cannot exhaust another's bucket.

### 11.5 Audit log

Every external request writes one row to `external_api_audit_log`
(`method`, `path`, `api_key_id`, `status_code`, `latency_ms`, `ip_address`,
`created_at`). `api_key_id` is null for master-key / skip / anonymous
calls. The write is best-effort — an audit failure never breaks the request.
A daily Celery task (`external_audit_cleanup`, 04:00) deletes rows older
than `EXTERNAL_API_AUDIT_RETENTION_DAYS`.
- **SQL endpoint** (low priority — only if BI team strongly requests).