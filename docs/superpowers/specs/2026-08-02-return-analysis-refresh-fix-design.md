# Return Analysis Refresh Task — Cumulative Sales Semantics Fix

**Date**: 2026-08-02
**Status**: Design (awaiting user approval)
**Parent**: BEL-372 (规划后端 external API) → BEL-373 (SUB-1 数据层 + 内部 endpoint) → BEL-375 (SUB-2 External API 暴露)
**Bug severity**: P0 — snapshot table has systemically wrong `sales_quantity`; external API consumers see inflated return rates

---

## 1. Problem

`backend/app/celery_tasks/return_analysis_refresh.py:_refresh_one_day` (lines 138–151) writes each `(project, country, sku, data_date)` snapshot row with `sales_quantity` computed via:

```python
AnalysisSalesOrderRow.purchase_date_pt == target_date   # strict same-day match
```

This counts **only same-day purchases**, ignoring the fact that returns from any given day can be against purchases made weeks or months earlier. Net effect:

| Project 4 玥涵, US, 21 months | Snapshot says | Raw table says | Δ |
|---|---|---|---|
| Total sales quantity | 345 units | 8,097 units | snapshot ≈ 4% of truth |
| Implied return rate | 51.9% | 2.33% | snapshot ≈ 22× inflated |

**Consumers affected**:
- External API `GET /api/v1/external/projects/{id}/return-analysis` — reads from snapshot, returns garbage
- Internal API `GET /api/v1/return-analysis` (snapshot path) — partially affected: ranking rows from snapshot are wrong, but distribution rows still come from raw table

**Consumers NOT affected** (already use windowed sales query):
- Internal API fallback path (`build_return_analysis()`) — uses `counted_sales_where` with `purchase_date_pt BETWEEN start AND end`

---

## 2. Root Cause

The refresh task writes daily-grain rows, and naively assumed "sales on this date = sales baseline for this date's returns". But return attribution is multi-day: a return on 2026-05-14 is typically against a 2026-04 purchase. The correct baseline for "rate of returns against sales" is **cumulative sales up to and including the return date**, not same-day sales.

A secondary discovery: the internal endpoint's consumer (`build_return_analysis_from_snapshot`, line 1261) was already written to use `max(sales_quantity)` across snapshot rows — which is the **correct** semantic for cumulative data. The producer never matched the consumer's expectation.

---

## 3. Design Decision: Cumulative Semantics (Option A)

Each snapshot row `(project, country, sku, data_date)` stores:

| Column | Semantics (after fix) |
|---|---|
| `return_count` | Per-day (unique order_id + sku on `data_date`) — UNCHANGED |
| `return_quantity` | Per-day (sum of `quantity` on `data_date`) — UNCHANGED |
| **`sales_quantity`** | **Cumulative through `data_date` inclusive** — CHANGED from per-day |
| `return_rate` | `return_quantity / sales_quantity * 100` — auto-correct via above |
| `wilson_lower` | Wilson 95% 下界 on (per-day return, cumulative sales) — auto-correct via above |
| `risk_level` | critical/warning/normal/no_data — auto-correct via above |
| `cycle_*` | UNCHANGED (currently all None due to missing source timestamps) |
| `reason_top1`, `disposition_top1`, `dominant_fc_id` | UNCHANGED (per-day top-1) |

### 3.1 Sales query change

One-line SQL change in `_refresh_one_day`:

```python
# BEFORE (buggy):
AnalysisSalesOrderRow.purchase_date_pt == target_date
# AFTER (fixed):
AnalysisSalesOrderRow.purchase_date_pt <= target_date
```

Add the same `counted_sales_where`-style filters (`is_counted_sales=true`, exclude `Cancelled`/`Pending`) for consistency with the internal endpoint's `_build_sales_aggregates`.

### 3.2 Consumer behavior

Both consumers (`build_return_analysis_from_snapshot` for internal, `_collapse_to_per_sku` for external) already use `max(sales_quantity)` across the window's snapshot rows. Under cumulative semantics, `max()` returns the latest row's value — which is **exactly the total sales through window end**. The external consumer's `sales_quantity += ...` must be updated to `sales_quantity = max(...)` (see §5.1).

`wilson_lower`, `risk_level`, and `return_rate` are **recomputed** at the endpoint from rolled-up totals (`sum(return_quantity), max(sales_quantity)`), not blindly read from snapshot. Internal consumer already does this; external consumer needs the risk_level recompute fix (§5.1).

### 3.3 Edge cases

| Case | Behavior |
|---|---|
| SKU has returns on day D, no sales that day → no prior sales | `sales_quantity=0`, `risk_level=no_data` (existing `MIN_SALES_FOR_RISK_LEVEL=15` gate). Correct behavior — no signal. |
| SKU has sales but **zero returns** for entire window | No snapshot rows in window → SKU invisible in external results. **Pre-existing limitation, not a regression.** Documented for future fix. |
| Old snapshot rows have `sales_quantity=345` (per-day numbers) | Will be replaced by `DELETE + rebuild` in migration step 4. |
| Same-day purchase-and-return (rare but possible) | `sales_quantity` includes the same-day purchase (cumulative); `return_quantity` includes the return. This is **correct** — that unit was sold and returned. |

---

## 4. Migration Strategy: Delete + Rebuild (A1)

User decision (2026-08-02): **A1. 一次性全删 + 全量重跑**.

### 4.1 Plan

1. **Pre-deploy**: snapshot table has ~1,522 wrong rows. External API consumers are currently reading these.
2. **Deploy**:
   - Apply code change (refresh query + 1-line comment in endpoint)
   - Run Alembic migration (no schema change, just `DELETE FROM analysis_return_aggregates`)
   - Trigger immediate Celery backfill for all (project, country) × last 90 days
3. **During backfill** (~3-5 minutes for 90 days × 14 projects):
   - External API endpoints that hit snapshot return **empty data arrays** (not errors)
   - Internal API: snapshot path unavailable, falls back to `build_return_analysis()` (raw query path) — users see correct data
   - No frontend changes needed (contract unchanged)
4. **Post-backfill**: external API returns correct cumulative-based rates

### 4.2 No schema migration required

`sales_quantity` column type/semantics already support cumulative values (just an `Integer`). The existing `data_version` column (currently defaults to 1) will be bumped to 2 on writes from the fixed code, providing a clear marker for "rows written by post-fix logic".

### 4.3 Rollback

If fix has bugs, rolling back the code reverts to buggy behavior — no clean rollback path for the deleted rows. Mitigations:
- Backfill runs **before** deleting (write-then-delete in a single Celery task)
- Keep a 24h manual snapshot in `analysis_return_aggregates_archive_2026_08_02` for emergency restore
- Or: copy to `tmp_snapshot_backup` before delete via migration

---

## 5. Implementation Outline

### 5.1 Files to touch

| File | Change |
|---|---|
| `backend/app/celery_tasks/return_analysis_refresh.py:138-151` | Change `==` to `<=`, add `is_counted_sales` + status filters |
| `backend/app/celery_tasks/return_analysis_refresh.py` | Increment `data_version` from 1 → 2 in aggregate_rows dict |
| `backend/app/services/external/return_analysis_query.py:_collapse_to_per_sku:202-205` | Change `sales_quantity += ...` to `sales_quantity = max(...)` (parity with internal consumer) |
| `backend/app/services/external/return_analysis_query.py:_collapse_to_per_sku:268` | Replace "worst across rows" logic with **`compute_risk_level(sum_return_qty, max_sales_qty)`** (parity with internal consumer at line 1280) |
| `backend/app/api/v1/endpoints/external/return_analysis.py` | Update docstring: "snapshot stores cumulative sales through `data_date`" |
| `backend/docs/external-api.md §9` | Document the cumulative semantic for external API consumers |
| `backend/app/models/analysis_return_aggregate.py:12` | Update docstring: `sales_quantity` = cumulative through `data_date` |
| `backend/alembic/versions/<date>_228_rebuild_return_aggregates.py` | New migration: `DELETE FROM analysis_return_aggregates` (revision 228, down_revision 227 → no new schema, just data wipe + version bump) |
| `backend/tests/celery_tasks/test_return_analysis_refresh.py` | Add test: `_refresh_one_day` writes cumulative `sales_quantity` |
| `backend/tests/api/test_external_return_analysis_aggregate.py` | Add test: external endpoint returns realistic return rates (~2-5%, not ~50%) |

### 5.2 Behavioral invariants to test

1. **`_refresh_one_day`** for `target_date=D`, SKU X:
   - Old: `sales_quantity = sales ON D`
   - New: `sales_quantity = sum of sales on dates ≤ D for that SKU`
2. **External endpoint** with `period=7d, country=US` on project 4:
   - Old: `return_rate ≈ 50%+` (wrong)
   - New: `return_rate ≈ 2-5%` (matches internal endpoint)
3. **Internal endpoint snapshot path** matches internal endpoint fallback path within 0.1% for any window.
4. **`is_snapshot_fresh_for_range()`** still works (data_version + computed_at unchanged).
5. **Wilson clamp** still active (regression test from commit `ca428190` still passes).

---

## 6. Out of Scope (Explicit Non-Goals)

- ❌ Add explicit "lookback window" semantics (e.g., 30-day rolling). The cumulative semantic is simpler and matches internal endpoint.
- ❌ Migrate the `cycle_*` columns (currently all None due to missing source data). Documented as future work.
- ❌ Fix "SKU with sales but zero returns invisible" — pre-existing limitation.
- ❌ Add auth/rate-limit on external endpoints — that's P1 infra work (separate issue).
- ❌ Rewrite `build_return_analysis_from_snapshot` distribution logic — it already queries raw correctly.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Backfill takes too long during deploy window | Run as Celery task (not migration); parallelize across (project, country); monitor via existing scheduler logs |
| External API sees empty data during backfill | Documented in release notes; internal endpoint unaffected (uses fallback) |
| Cumulative semantics break someone's external API integration | Update `backend/docs/external-api.md §9` before deploy |
| Existing snapshot rows mixed with new rows | Migration deletes all rows before backfill; data_version=2 marks new rows |
| Wilson/risk_level recompute at endpoint diverges from snapshot values | Both consumers already recompute; verified in test plan §5.2 |

---

## 8. Success Criteria

- [ ] Local DB backfill: external endpoint on project 4 returns `return_rate ≈ 2-5%` for any window
- [ ] Local DB: internal endpoint snapshot path matches fallback path within 0.1%
- [ ] All 80+ existing tests pass
- [ ] 5+ new tests added (refresh task cumulative semantics, external endpoint realistic rates)
- [ ] `docs/external-api.md §9` updated with cumulative semantic note
- [ ] Deployed to prod via `git deploy`
- [ ] Smoke test on prod project 4 (or any active project) shows realistic rates
- [ ] CELERY runs daily 03:00 UTC without crashing