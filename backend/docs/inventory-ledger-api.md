# Inventory Ledger API — `?period=` calling convention

> **The one rule**: every call to an inventory-ledger endpoint MUST supply
> `?period=<value>`. There is exactly one period-input convention. Don't
> invent alternatives (`?report_month=`, `?month=`, etc. — all rejected
> with 400). This is deliberately a small surface so human callers and
> AI agents don't drift into multiple calling patterns.

See [`backend/docs/external-api.md` §2.1](./external-api.md) for the
historical rationale and shared design with the ad-campaign endpoints
(inventory-ledger uses the same `?period=` grammar; the only delta is the
addition of the `YYYY-MM` / `YYYY-MM-DD` month-string aliases documented
below).

---

## 1. Endpoint catalog

### 1.1 Internal (requires auth)

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | GET | `/api/v1/inventory-ledger/months` | List months with ledger data (no `?period=` — returns the source list) |
| 2 | GET | `/api/v1/inventory-ledger/snapshot?project_id=&period=` | SKU EOM + disposition summary + integrity |
| 3 | GET | `/api/v1/inventory-ledger/events?project_id=&period=` | SKU event totals across period |
| 4 | GET | `/api/v1/inventory-ledger/receipt-clusters?project_id=&period=` | Receipts grouped by (date, warehouse) |
| 5 | GET | `/api/v1/inventory-ledger/location-detail?project_id=&period=&msku?=` | SKU × warehouse × disposition EOM |
| 6 | GET | `/api/v1/inventory-ledger/trend?project_id=&months=N` | Multi-month trend (uses `?months=` count, not `?period=`) |
| 7 | GET | `/api/v1/inventory-ledger/detail?project_id=&period=&msku?=&fulfillment_center?=&event_type?=` | Event-level rows from the Detailed view (BEL-428) |
| 8 | GET | `/api/v1/inventory-ledger/batches?project_id=&limit?=` | CSV ingest batch history — 排查数据版本 (BEL-428) |
| 9 | GET | `/api/v1/inventory-ledger/consistency?project_id=&period=` | Cross-table reconciliation detail vs summary (requires full month, BEL-428) |
| 10 | GET | `/api/v1/inventory-ledger/month-analysis?project_id=&period=` | Full selected-month dashboard/export payload (requires full month) |

### 1.1.1 Dashboard full-month analysis / Excel export

`month-analysis` is the Dashboard-only aggregate read used by both the inventory
ledger page and its unified Excel export. It returns **all**
`inventory_ledger_summary` and `inventory_ledger_detail` rows for one complete
calendar month, plus Snapshot, six-month Trend, Consistency and selected-month
ingest batches.

- Partial windows (`7d` / `30d` / `custom` partial month) return 400.
- The endpoint applies no MSKU / warehouse / disposition / event filters.
- The page applies filters only to its rendered analysis; Excel always exports
  the full selected month.
- The existing `/snapshot`, `/summary`, `/detail`, `/batches` endpoints remain
  unchanged for other callers and Agent contracts.

### 1.2 External (no auth, network-isolated)

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/months` | List months |
| 2 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/snapshot?period=` | Snapshot |
| 3 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/events?period=` | Events |
| 4 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/receipt-clusters?period=` | Receipt clusters |
| 5 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/integrity?period=` | Cross-month integrity check (requires full-month period) |
| 6 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/trend?months=N` | Multi-month trend |
| 7 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/detail?period=&msku?=&fulfillment_center?=&event_type?=` | Event-level rows from the Detailed view (BEL-428) |
| 8 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/batches?limit?=` | CSV ingest batch history (BEL-428) |
| 9 | GET | `/api/v1/external/projects/{project_id}/inventory-ledger/consistency?period=` | Cross-table reconciliation detail vs summary (BEL-428) |

---

## 2. The `?period=` grammar (the ONLY period-input convention)

`?period=` accepts the following value shapes. **Every other period-related
query param (`?report_month=`, standalone `?start_date=`, standalone
`?end_date=`) is removed and returns 400.**

### 2.1 Relative-window aliases (T-1 anchored)

| Alias | Window | Example use case |
|---|---|---|
| `7d` | T-6 .. T-1 | "Past week" trend |
| `14d` | T-13 .. T-1 | "Past two weeks" |
| `28d` | T-27 .. T-1 | "Past four weeks" |
| `30d` | T-29 .. T-1 | "Past month" |
| `60d` | T-59 .. T-1 | "Past two months" |
| `90d` | T-89 .. T-1 | "Past quarter" |

### 2.2 Calendar-month aliases

| Alias | Window | Example use case |
|---|---|---|
| `this_month` | 1st of T-1's month .. T-1 (degenerates to full prev month if T-1 fell in prev month) | "Current month so far" |
| `last_month` | 1st of previous calendar month .. last day | **Reconcile last full month** (the most common call) |
| `ytd` | Jan 1 of T-1's year .. T-1 (degenerates to full prev year if T-1 fell in prev year) | "Year-to-date" |

### 2.3 Month-string aliases (the ergonomic shortcut for "give me month X")

| Format | Resolves to | Notes |
|---|---|---|
| `YYYY-MM` | `(YYYY-MM-01, last day of YYYY-MM)` | e.g. `period=2026-01` → January 2026 |
| `YYYY-MM-DD` | `(YYYY-MM-01, last day of YYYY-MM)` | Day component is ignored — the window is always the full month (matches the `report_month` partition convention) |

This is the value you'll get back from `/months` (which returns YYYY-MM-DD
strings like `"2026-01-01"`). You can feed those straight into `?period=`:

```bash
# Find available months, then query one
curl '/api/v1/inventory-ledger/months?project_id=1'
# → {"project_id":1,"months":["2026-01-01","2025-12-01",...]}

# Use one of those values as period
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=2026-01-01'
```

### 2.4 Custom range (the escape hatch)

```
?period=custom&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

- Both `start_date` and `end_date` are REQUIRED companions of `period=custom`
- `start_date <= end_date` (reversed range → 400)
- `start_date` / `end_date` are **only valid with `period=custom`** —
  providing them with any other period value returns 400

---

## 3. Integrity-check behaviour

The cross-month integrity check (`check_ledger_integrity`) only makes sense
when the resolved period is a single complete ledger partition. It runs
**automatically** when the period resolves to a full calendar month, and is
**skipped** for partial windows.

| Period value | Integrity runs? | Why |
|---|---|---|
| `last_month` | ✓ yes | Full previous calendar month |
| `this_month` | ✓ yes (when T-1 is in same month) | Full month |
| `ytd` | ✓ yes (within-year) | The integrity check sees the current month partition |
| `2026-01` / `2026-01-01` | ✓ yes | Full calendar month |
| `7d` / `14d` / `28d` / `30d` / `60d` / `90d` | ✗ no | Partial window — meaningless comparison |
| `custom` (spans multiple months or partial) | ✗ no | Cross-partition / partial |
| `/integrity` endpoint with partial-window `period` | 400 | Integrity endpoint refuses partial windows outright |

The external `/integrity` endpoint enforces this strictly (returns 400 if
the period doesn't resolve to a full month) because partial-month integrity
checks have no meaningful output. Other endpoints silently skip the check.

---

## 4. Examples

### 4.1 Common flows

```bash
# "Reconcile last full month" — the most common call
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=last_month'

# "Show me January 2026"
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=2026-01'

# "Past 30 days of events"
curl '/api/v1/inventory-ledger/events?project_id=1&period=30d'

# "Q1 2026 custom range"
curl '/api/v1/inventory-ledger/events?project_id=1&period=custom&start_date=2026-01-01&end_date=2026-03-31'

# "Integrity check for last full month" (external only)
curl '/api/v1/external/projects/1/inventory-ledger/integrity?period=last_month'

# "Location detail for one SKU in January 2026"
curl '/api/v1/inventory-ledger/location-detail?project_id=1&period=2026-01&msku=ABC-123'

# "Receipt clusters for the past 7 days"
curl '/api/v1/inventory-ledger/receipt-clusters?project_id=1&period=7d'
```

### 4.2 What NOT to do (all 400)

```bash
# ❌ Missing period entirely
curl '/api/v1/inventory-ledger/snapshot?project_id=1'
# → 400: "period is required (...)"

# ❌ Legacy ?report_month= (removed)
curl '/api/v1/inventory-ledger/snapshot?project_id=1&report_month=2026-01-01'
# → 400 (FastAPI reports "unexpected field 'report_month'")

# ❌ Standalone start_date without period=custom
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=last_month&start_date=2026-01-01'
# → 400: "period cannot be combined with start_date / end_date"

# ❌ Unknown alias
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=foo'
# → 400: "period must be one of {...} or a YYYY-MM[-DD] month string, got 'foo'"

# ❌ custom without companions
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=custom'
# → 400: "start_date and end_date are required when period=custom"

# ❌ Reversed custom range
curl '/api/v1/inventory-ledger/snapshot?project_id=1&period=custom&start_date=2026-03-31&end_date=2026-01-01'
# → 400: "start_date must be <= end_date"
```

---

## 5. Response shape (unchanged)

All responses keep the pre-existing schema. **Only the input changed.**

Key response fields you'll encounter:

| Field | Where | Meaning |
|---|---|---|
| `report_month: date` | Top level (`snapshot` / `events` / `receipt-clusters` / `location-detail`) | The first day of the resolved period (always month-start for full-month periods) |
| `integrity: IntegrityCheckResult \| null` | `snapshot` only | Set IFF period resolved to a full month; otherwise `null` |
| `IntegrityCheckResult.status` | Inside `integrity` | `"OK"` / `"MISMATCH"` / `"PENDING"` |
| `IntegrityCheckResult.mismatches[]` | Inside `integrity` | Per-(msku, location, disposition) continuity mismatches |

---

## 6. Discoverability

Every inventory-ledger endpoint carries FastAPI `summary=` + `description=`
metadata, so the canonical source of truth for AI agents is
`/openapi.json` (or `/docs`):

```bash
curl 'https://api.example.com/openapi.json' \
  | jq '.paths | keys | map(select(contains("inventory-ledger")))'
```

The `description` of each endpoint points back to this document for the
full grammar.
