# Return Analysis Refresh Task Cumulative-Sales Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `analysis_return_aggregates.sales_quantity` bug — change from "same-day purchases" to "cumulative purchases through `data_date`" so external API consumers see realistic return rates (project 4 玥涵: 2.33% instead of 51.9%).

**Architecture:** Single one-line SQL change in refresh task (`==` → `<=`) + 2-line consumer fix in external endpoint + new `rebuild_full` Celery task for one-time backfill. Schema unchanged. No Alembic migration needed (per spec §4.2).

**Tech Stack:** Python, FastAPI, SQLAlchemy, Celery, pytest, Alembic (read-only here).

---

## Global Constraints

- Spec source: `docs/superpowers/specs/2026-08-02-return-analysis-refresh-fix-design.md` (commit `b852ea82`)
- All Chinese commit messages per `chinese-commit-conventions` skill
- Git author email: `jr.way123@gmail.com` (BEL-153)
- Test stack: pytest + venv at `backend/.venv/bin/python`
- Deploy via `git deploy` (BEL-373 convention)
- DO NOT touch unrelated files in backend working tree (report_reconciliation / category / inventory / report / product_analysis etc. are other agents' work)
- DO NOT query prod DB (145.79.143.98) for testing — use local BLF DB only
- Existing 80 tests must stay green; add ~5 new tests

---

## File Map

| File | Role |
|---|---|
| `backend/app/celery_tasks/return_analysis_refresh.py` | Producer: writes snapshot rows. Fix SQL filter `==` → `<=` |
| `backend/app/celery_tasks/return_analysis_rebuild.py` (NEW) | One-shot full-history rebuild task |
| `backend/app/services/external/return_analysis_query.py` | External consumer. Fix `sales_quantity +=` → `max`, `risk_level` recompute |
| `backend/app/models/analysis_return_aggregate.py` | Update docstring (sales_quantity = cumulative) |
| `backend/app/api/v1/endpoints/external/return_analysis.py` | Update endpoint docstring |
| `backend/app/api/v1/endpoints/internal_jobs.py` | Add new admin endpoint to trigger full rebuild |
| `backend/docs/external-api.md` | Update §9 with cumulative semantic note |
| `backend/tests/celery_tasks/test_return_analysis_refresh.py` | Add cumulative sales test |
| `backend/tests/celery_tasks/test_return_analysis_rebuild.py` (NEW) | Test new rebuild task |
| `backend/tests/api/test_external_return_analysis_aggregate.py` | Add realistic-rates test |
| `backend/tests/api/test_internal_return_analysis_rebuild.py` (NEW) | Test admin endpoint |

---

## Task 1: Fix refresh task SQL — cumulative sales

**Files:**
- Modify: `backend/app/celery_tasks/return_analysis_refresh.py:138-151` (sales query filter)
- Modify: `backend/app/celery_tasks/return_analysis_refresh.py:236` (data_version 1 → 2)

**Interfaces:**
- Consumes: `AnalysisSalesOrderRow` model with `purchase_date_pt`, `is_counted_sales`, `order_status`, `quantity`
- Produces: aggregate rows with `sales_quantity = sum of sales with purchase_date_pt <= target_date`

- [ ] **Step 1.1: Write failing test for cumulative sales**

Add test to `backend/tests/celery_tasks/test_return_analysis_refresh.py`:

```python
def test_refresh_one_day_writes_cumulative_sales(notifiable_project, db_session):
    """sales_quantity 应为 target_date 之前（含当日）所有销量的累计，而不是仅当日销量。"""
    from datetime import date
    from app.models import (
        AnalysisSalesOrderRow, AnalysisReturnRow, AnalysisSourceFile, Project,
    )
    from app.celery_tasks.return_analysis_refresh import _refresh_one_day

    pid = notifiable_project  # helper creating unique project
    # 5 days of sales before target_date: 100 units total
    # 1 day of sales on target_date: 50 units
    # → cumulative through target_date = 150
    # 1 return on target_date: 5 units

    target = date(2026, 6, 1)
    project = Project(project_name=f"BEL-376 cum test {target}", sort_order=0, is_active=False)
    db_session.add(project)
    db_session.flush()
    pid = project.id

    sf = AnalysisSourceFile(report_type="return_report", is_current=True, project_id=pid, country="US")
    db_session.add(sf)
    db_session.flush()

    for i in range(1, 6):
        db_session.add(AnalysisSalesOrderRow(
            project_id=pid, country="US",
            purchase_date_pt=target.replace(day=i),
            quantity=20, is_counted_sales=True,
            order_status="Shipped",
        ))
    db_session.add(AnalysisSalesOrderRow(
        project_id=pid, country="US",
        purchase_date_pt=target,
        quantity=50, is_counted_sales=True,
        order_status="Shipped",
    ))
    db_session.add(AnalysisReturnRow(
        project_id=pid, country="US",
        return_date=target, sku="SKU-CUM",
        order_id="ORDER-CUM", quantity=5,
        detailed_disposition="SELLABLE", reason="OTHER",
        status="Unit returned to inventory",
        source_file_id=sf.id,
    ))
    db_session.commit()

    _refresh_one_day(db_session, target_date=target)

    from app.models import AnalysisReturnAggregate
    row = db_session.query(AnalysisReturnAggregate).filter_by(
        project_id=pid, sku="SKU-CUM", data_date=target
    ).first()
    assert row is not None, "snapshot row should exist"
    assert row.sales_quantity == 150, f"expected cumulative 150, got {row.sales_quantity}"
    assert row.return_quantity == 5
    assert row.data_version == 2, f"expected data_version=2, got {row.data_version}"
```

- [ ] **Step 1.2: Run test, confirm RED**

Run: `cd backend && .venv/bin/python -m pytest tests/celery_tasks/test_return_analysis_refresh.py::test_refresh_one_day_writes_cumulative_sales -v`
Expected: FAIL (current `==` returns 50, not 150; data_version is 1)

- [ ] **Step 1.3: Fix SQL filter — `==` → `<=`, add status filter**

In `backend/app/celery_tasks/return_analysis_refresh.py` around line 147, change:

```python
# OLD:
sales_rows = (
    db.query(
        AnalysisSalesOrderRow.sku,
        AnalysisSalesOrderRow.purchase_date_pt,
        AnalysisSalesOrderRow.quantity,
    )
    .filter(
        AnalysisSalesOrderRow.project_id == project_id,
        AnalysisSalesOrderRow.country == country,
        AnalysisSalesOrderRow.purchase_date_pt == target_date,
        AnalysisSalesOrderRow.is_counted_sales == True,
    )
    .all()
)

# NEW:
sales_rows = (
    db.query(
        AnalysisSalesOrderRow.sku,
        AnalysisSalesOrderRow.quantity,
    )
    .filter(
        AnalysisSalesOrderRow.project_id == project_id,
        AnalysisSalesOrderRow.country == country,
        AnalysisSalesOrderRow.purchase_date_pt <= target_date,
        AnalysisSalesOrderRow.is_counted_sales == True,
        AnalysisSalesOrderRow.order_status != "Cancelled",
        AnalysisSalesOrderRow.order_status != "Pending",
    )
    .all()
)
```

Notes: `purchase_date_pt` column dropped from SELECT (not needed downstream); use `.is_(True)` per BEL-348; add `!=` filters for parity with `counted_sales_where` in `app/services/sales_query.py`.

- [ ] **Step 1.4: Bump data_version 1 → 2**

In the aggregate_rows dict construction (around line 234), change:

```python
# OLD:
"data_version": 1,

# NEW:
"data_version": 2,  # BEL-376: cumulative sales semantics (was 1 = same-day)
```

- [ ] **Step 1.5: Update module docstring**

Replace lines 5-6 of file docstring (the "每日 03:00 UTC 跑近 90 天增量" block) with:

```
- 每日 03:00 UTC 跑近 90 天增量
- BEL-376: sales_quantity 改为"截至 data_date 累计销量"（原 = 当日销量，bug）
```

- [ ] **Step 1.6: Run test, confirm GREEN**

Run: `cd backend && .venv/bin/python -m pytest tests/celery_tasks/test_return_analysis_refresh.py -v`
Expected: PASS for `test_refresh_one_day_writes_cumulative_sales`; all pre-existing tests still pass

- [ ] **Step 1.7: Commit**

```bash
git add backend/app/celery_tasks/return_analysis_refresh.py backend/tests/celery_tasks/test_return_analysis_refresh.py
git commit -m "fix(后端): refresh task sales_quantity 改累计语义 (BEL-376)"
```

---

## Task 2: Fix external consumer — cumulative rollup

**Files:**
- Modify: `backend/app/services/external/return_analysis_query.py:202-205` (`sales_quantity +=` → `max`)
- Modify: `backend/app/services/external/return_analysis_query.py:268` (`risk_level` recompute from rolled totals)
- Modify: `backend/app/services/external/return_analysis_query.py:1-50` (docstring update)

**Interfaces:**
- Consumes: list of per-(sku, data_date) dicts from snapshot
- Produces: per-SKU rollup dict with `sales_quantity = max across rows`, `risk_level = compute_risk_level(sum_rq, max_sq)`

- [ ] **Step 2.1: Write failing test for cumulative consumer**

Add test to `backend/tests/api/test_external_return_analysis_aggregate.py`:

```python
def test_external_aggregate_uses_max_for_cumulative_sales(client, seeded_project):
    """snapshot 行 sales_quantity 是累计的；消费者应取 max 而非 sum。"""
    # seeded_project fixture provides 3 SKUs (BEL-374-A, -B, -C), 5 daily rows each
    # with sales_quantity=100 (BEL-374-A and -B) or 5 (BEL-374-C)
    # Total sales across 2 days for SKU-A: NOT 200 (sum), but 100 (max — already cumulative)
    resp = client.get(
        _aggregate_url(seeded_project, period="7d", country="US", sku="BEL-374-A")
    )
    body = resp.json()
    sku_a = next(r for r in body["data"] if r["sku"] == "BEL-374-A")
    assert sku_a["sales_quantity"] == 100, (
        f"sales_quantity must be max across rows (cumulative), got {sku_a['sales_quantity']}"
    )
```

- [ ] **Step 2.2: Run test, confirm RED**

Run: `cd backend && .venv/bin/python -m pytest tests/api/test_external_return_analysis_aggregate.py::test_external_aggregate_uses_max_for_cumulative_sales -v`
Expected: FAIL (current `+=` gives 200, not 100)

- [ ] **Step 2.3: Fix `_collapse_to_per_sku` aggregation**

In `backend/app/services/external/return_analysis_query.py`:
- Line 205 (`agg["sales_quantity"] += r["sales_quantity"]`): change `+=` to `= max(agg["sales_quantity"], r["sales_quantity"])`
- Line 268 (`"risk_level": agg["_risk_worst"]`): replace with `"risk_level": compute_risk_level(agg["return_quantity"], agg["sales_quantity"])[0]` and remove the `_risk_worst` tracking (lines 70, 200, 241-242)

Imports needed at top of file: `from app.utils.stats import compute_risk_level`

- [ ] **Step 2.4: Update file docstring**

Replace lines 1-15 docstring with:

```python
"""External service layer for Return Analysis (BEL-375 + BEL-376 fix).

BEL-376 fix (2026-08-02): snapshot rows store CUMULATIVE sales through
``data_date``. Consumers must use ``max()`` (latest row's value) not ``sum()``
when collapsing to per-SKU rollups. Wilson / risk_level are recomputed from
rolled-up totals (``sum(return_quantity), max(sales_quantity)``) — do not
read them blindly from snapshot rows.
"""
```

- [ ] **Step 2.5: Run external endpoint tests, confirm GREEN**

Run: `cd backend && .venv/bin/python -m pytest tests/api/test_external_return_analysis_aggregate.py tests/api/test_external_return_analysis_raw.py -v`
Expected: All PASS (including pre-existing 12-field shape tests)

- [ ] **Step 2.6: Commit**

```bash
git add backend/app/services/external/return_analysis_query.py backend/tests/api/test_external_return_analysis_aggregate.py
git commit -m "fix(后端): 外部端点 sales 累计 max + risk_level 重算 (BEL-376)"
```

---

## Task 3: Update docstrings + external API docs

**Files:**
- Modify: `backend/app/models/analysis_return_aggregate.py:12` (sales_quantity comment)
- Modify: `backend/app/api/v1/endpoints/external/return_analysis.py:1-15` (endpoint docstring)
- Modify: `backend/docs/external-api.md` §9 (cumulative semantic note)

- [ ] **Step 3.1: Update model docstring**

In `backend/app/models/analysis_return_aggregate.py`, change line 12:

```python
# OLD:
- sales_quantity: 同日同期销售件数（join）
# NEW:
- sales_quantity: 截至 data_date 累计销量（BEL-376 修复；旧版=当日销量有 bug）
```

- [ ] **Step 3.2: Update external endpoint docstring**

In `backend/app/api/v1/endpoints/external/return_analysis.py` lines 1-15, add to the docstring:

```python
"""External Return Analysis endpoints — BEL-375.

BEL-376 fix: snapshot rows store cumulative sales through ``data_date``
(not same-day). The endpoint collapses per-(sku, data_date) rows to
per-SKU rollups by ``max()``-ing ``sales_quantity`` and ``sum()``-ing
``return_quantity`` / ``return_count``. ``wilson_lower`` / ``risk_level``
are recomputed from rolled-up totals (not blindly read from rows).
"""
```

- [ ] **Step 3.3: Update external API docs**

In `backend/docs/external-api.md` §9, find the section starting with "## 9. Return Analysis" and add a note near the top:

```markdown
> **BEL-376 fix (2026-08-02)**: snapshot rows now store **cumulative** sales through `data_date` (previously: same-day only, which produced wildly inflated return rates). Consumers must use `max(sales_quantity)` when collapsing per-day rows to per-SKU rollups, NOT `sum`.
```

- [ ] **Step 3.4: Commit**

```bash
git add backend/app/models/analysis_return_aggregate.py backend/app/api/v1/endpoints/external/return_analysis.py backend/docs/external-api.md
git commit -m "docs(后端): refresh task 累计语义 docstring + external-api.md 标注 (BEL-376)"
```

---

## Task 4: Add full-history rebuild Celery task

**Files:**
- Create: `backend/app/celery_tasks/return_analysis_rebuild.py` (~80 LOC)
- Modify: `backend/app/api/v1/endpoints/internal_jobs.py` (add admin endpoint)
- Create: `backend/tests/celery_tasks/test_return_analysis_rebuild.py` (basic smoke test)

**Interfaces:**
- `rebuild_full_snapshot(db) -> dict` (sync, callable from Celery or admin endpoint)
- POST `/api/v1/internal/jobs/return-analysis-rebuild` (admin/X-Operator auth)

- [ ] **Step 4.1: Write the rebuild function (TDD: test first)**

Create `backend/tests/celery_tasks/test_return_analysis_rebuild.py`:

```python
"""BEL-376: One-shot full-history rebuild of analysis_return_aggregates."""
from datetime import date, timedelta
from app.db.session import SessionLocal
from app.celery_tasks.return_analysis_rebuild import rebuild_full_snapshot
from app.models import AnalysisReturnAggregate, Project
from sqlalchemy import text


def test_rebuild_clears_existing_then_repopulates(db_session):
    """Should DELETE all rows then write fresh cumulative-semantic rows."""
    # insert a stale row
    db_session.add(AnalysisReturnAggregate(
        project_id=99999, country="XX", sku="STALE",
        data_date=date(2020,1,1), sales_quantity=0,
        return_quantity=0, return_count=0, return_rate=0,
        risk_level="no_data", data_version=1,
    ))
    db_session.commit()
    assert db_session.query(AnalysisReturnAggregate).count() >= 1

    rebuild_full_snapshot(db_session)

    # stale row gone
    assert db_session.query(AnalysisReturnAggregate).filter_by(sku="STALE").first() is None
    # new rows have data_version=2
    for row in db_session.query(AnalysisReturnAggregate).limit(10).all():
        assert row.data_version == 2
```

- [ ] **Step 4.2: Run test, confirm RED**

Run: `cd backend && .venv/bin/python -m pytest tests/celery_tasks/test_return_analysis_rebuild.py -v`
Expected: FAIL (module doesn't exist)

- [ ] **Step 4.3: Create the rebuild module**

Create `backend/app/celery_tasks/return_analysis_rebuild.py`:

```python
"""BEL-376: One-shot full-history rebuild for analysis_return_aggregates.

Why this exists:
    Before the cumulative-sales fix, the snapshot table was systemically wrong
    (sales_quantity was "same-day purchases only", ~4% of true value).
    Rather than migrate the data (no schema change is possible without a
    column meaning swap), we wipe the table and re-run refresh from scratch
    over the full raw-return date range.

Idempotent: deletes all rows then writes new ones. Safe to re-run.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.celery_tasks.return_analysis_refresh import _refresh_one_day


def _earliest_raw_return_date(db: Session) -> date:
    """Find the earliest return_date across all analysis_return_rows."""
    row = db.execute(text("SELECT MIN(return_date) FROM analysis_return_rows")).first()
    if row and row[0]:
        return row[0]
    return date.today() - timedelta(days=90)  # fallback: 90 days back


def rebuild_full_snapshot(db: Session) -> dict[str, Any]:
    """Wipe + repopulate analysis_return_aggregates over the full history.

    Args:
        db: SQLAlchemy session (caller manages lifecycle)

    Returns:
        dict with rows_written, days_processed, projects_touched, range_start, range_end
    """
    range_start = _earliest_raw_return_date(db)
    range_end = date.today() - timedelta(days=1)

    # 1) wipe
    db.execute(text("DELETE FROM analysis_return_aggregates"))

    # 2) loop days
    rows_written = 0
    days_with_data = 0
    d = range_start
    while d <= range_end:
        try:
            r = _refresh_one_day(db, target_date=d)
            w = r.get("rows_written", 0)
            if w:
                rows_written += w
                days_with_data += 1
        except Exception:
            db.rollback()
            raise
        d += timedelta(days=1)

    db.commit()

    # 3) summarize
    proj_count = db.execute(
        text("SELECT COUNT(DISTINCT project_id) FROM analysis_return_aggregates")
    ).scalar() or 0

    return {
        "rows_written": rows_written,
        "days_processed": (range_end - range_start).days + 1,
        "days_with_data": days_with_data,
        "projects_touched": proj_count,
        "range_start": range_start.isoformat(),
        "range_end": range_end.isoformat(),
    }
```

- [ ] **Step 4.4: Run test, confirm GREEN**

Run: `cd backend && .venv/bin/python -m pytest tests/celery_tasks/test_return_analysis_rebuild.py -v`
Expected: PASS

- [ ] **Step 4.5: Add admin endpoint**

In `backend/app/api/v1/endpoints/internal_jobs.py`, find the existing `return-analysis-refresh` endpoint and add a sibling. Read the file first to match its style/imports. Add:

```python
@router.post("/return-analysis-rebuild")
def trigger_return_analysis_rebuild(
    db: Session = Depends(get_db),
) -> dict:
    """BEL-376: Full-history rebuild of analysis_return_aggregates.
    
    Use this ONCE after deploying the cumulative-sales fix. Wipes the
    table then re-runs _refresh_one_day for every day from the earliest
    raw return to yesterday. Takes ~3-5 minutes for 90 days × 14 projects.
    
    Auth: admin only (X-Operator header required, enforced at router level).
    """
    from app.celery_tasks.return_analysis_rebuild import rebuild_full_snapshot
    return rebuild_full_snapshot(db)
```

- [ ] **Step 4.6: Smoke test the admin endpoint**

Run uvicorn locally on port 8101 + curl with X-Operator header to test:

```bash
cd backend && .venv/bin/uvicorn app.main:app --port 8101 &
sleep 5
curl -s -X POST -H "X-Operator: admin" http://localhost:8101/api/v1/internal/jobs/return-analysis-rebuild | jq .
```

Verify response shows `rows_written` > 0 and `range_start` = `2024-10-17`.

- [ ] **Step 4.7: Commit**

```bash
git add backend/app/celery_tasks/return_analysis_rebuild.py backend/tests/celery_tasks/test_return_analysis_rebuild.py backend/app/api/v1/endpoints/internal_jobs.py
git commit -m "feat(后端): 全量重算 snapshot 的 Celery 任务 + 手动触发端点 (BEL-376)"
```

---

## Task 5: Local end-to-end verification

**Files:** none (read-only validation)

- [ ] **Step 5.1: Run full test suite**

```bash
cd backend && .venv/bin/python -m pytest tests/celery_tasks/test_return_analysis_refresh.py tests/celery_tasks/test_return_analysis_rebuild.py tests/api/test_external_return_analysis_aggregate.py tests/api/test_external_return_analysis_raw.py tests/services/analysis/return_analysis/ -q
```

Expected: All 80+ tests PASS

- [ ] **Step 5.2: Verify project 4 return rate via actual external endpoint path**

Use uvicorn + curl, or call the service functions directly:

```bash
cd backend && .venv/bin/python -c "
from datetime import date
from app.db.session import SessionLocal
from app.services.external.return_analysis_query import query_return_analysis_aggregate, build_aggregate_summary
from app.api.v1.endpoints.external._whitelist import parse_aggregate_order_by
from app.models import AnalysisReturnAggregate

db = SessionLocal()
sk, dr = parse_aggregate_order_by('return_quantity', 'desc', model=AnalysisReturnAggregate)
rows, total = query_return_analysis_aggregate(
    db, project_id=4, country='US',
    date_from=date(2024,10,1), date_to=date(2026,8,1),
    order_column=sk, order_dir=dr, limit=50, offset=0,
)
s = build_aggregate_summary(rows)
print(f\"project 4 (玥涵), 21mo, US:\")
print(f\"  SKUs: {total}\")
print(f\"  total_return_quantity: {s['total_return_quantity']}\")
print(f\"  total_sales_quantity: {s['total_sales_quantity']}\")
print(f\"  overall_return_rate: {s['overall_return_rate']:.2f}%  (expected ~2.33%, NOT 51.9%)\")
db.close()
"
```

Expected: `overall_return_rate ≈ 2.33%`, NOT `51.9%`

- [ ] **Step 5.3: Smoke test admin endpoint rebuild + verify aggregate**

First: DELETE local snapshot + run rebuild

```bash
cd backend && .venv/bin/python -c "
from app.db.session import SessionLocal
from sqlalchemy import text
from app.celery_tasks.return_analysis_rebuild import rebuild_full_snapshot
db = SessionLocal()
result = rebuild_full_snapshot(db)
print(result)
"
```

Expected: rows_written > 1000, range_start = 2024-10-17, range_end = yesterday

Then re-run Step 5.2 — should still show ~2.33%.

- [ ] **Step 5.4: Commit any verification artifacts**

If you wrote a test/script that needs to be saved, commit it. Otherwise no commit.

---

## Task 6: Deploy to prod

**Files:** none (operational)

- [ ] **Step 6.1: Verify git author email**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard && git config --get user.email
```

Expected: `jr.way123@gmail.com` (per BEL-153). If not, set it before committing.

- [ ] **Step 6.2: Verify clean working tree (no unrelated changes)**

```bash
git status --short
```

Expected: only the 4 commits from Tasks 1-4. If other files modified, STOP and ask user.

- [ ] **Step 6.3: Deploy via git deploy**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard && git deploy
```

Watch for: alembic upgrade (no-op since no schema change), systemctl restart, health check.

- [ ] **Step 6.4: Trigger prod rebuild via admin endpoint**

```bash
ssh root@145.79.143.98 "curl -s -X POST -H 'X-Operator: admin' http://localhost:8100/api/v1/internal/jobs/return-analysis-rebuild"
```

Wait ~3-5 minutes. Verify response shows rows_written > 0.

- [ ] **Step 6.5: Smoke test prod external endpoint**

```bash
ssh root@145.79.143.98 "curl -s 'http://localhost:8100/api/v1/external/projects/4/return-analysis?period=90d&country=US&limit=5' | .venv/bin/python -c 'import sys,json; d=json.load(sys.stdin); print(\"n_rows:\", len(d[\"data\"])); print(\"summary:\", json.dumps(d[\"summary\"], indent=2))'"
```

Expected: `overall_return_rate ≈ 2-5%` (realistic), NOT 50%+

- [ ] **Step 6.6: Update parent issue metadata**

```bash
cd /Users/damon/DamonProjects/believeboyDashboard
multica issue metadata set aa0e7aa3-d1ab-401e-8674-7ba9af55672c --key sub_issue_3 --value "BEL-376 Refresh Task cumulative-sales fix (commits: <list>, status: in_review, prod: realistic rates ~2.33%)"
```

- [ ] **Step 6.7: Post result comment to issue**

Reply to the BEL-373 thread with:
- Commit hashes
- Local test verification (~2.33%)
- Prod smoke test result
- Any caveats

---

## Task 7: Cleanup + handoff

- [ ] **Step 7.1: Move this plan to completed subdirectory**

```bash
mkdir -p docs/superpowers/plans/2026-08-02-return-analysis-refresh-fix
mv docs/superpowers/plans/2026-08-02-return-analysis-refresh-fix.md docs/superpowers/plans/2026-08-02-return-analysis-refresh-fix/
```

- [ ] **Step 7.2: Save retro to wiki**

Use `wiki_retro` to save a durable insight: "Always sanity-check snapshot aggregate numbers against raw tables — same query, same window — before reporting any derived rate. The bug was sitting in prod for days and only caught by user pushback."

- [ ] **Step 7.3: Update BEL-373 status**

After user accepts the fix, transition BEL-373 → `done` (it was the parent that the bug lived in).

---

## Self-Review Checklist (run after writing this plan)

- [x] **Spec coverage**: §3 (cumulative sales) → Task 1; §3.2 (consumer behavior) → Task 2; §4 (DELETE + rebuild) → Task 4; §5.1 (file list) → all tasks; §5.2 (test invariants) → Tasks 1.1, 2.1, 5.1; §7 (success criteria) → Task 5 + 6.
- [x] **No placeholders**: Searched for "TBD"/"TODO"/"implement later" — none.
- [x] **Type consistency**: `_collapse_to_per_sku` signature unchanged; `rebuild_full_snapshot(db) -> dict[str, Any]` defined once and consumed once.
- [x] **Migration safety**: No new Alembic migration per spec §4.2. DELETE happens in Celery task (idempotent + retryable).
- [x] **Worktree concern noted**: Global constraints remind not to touch unrelated backend files.
- [x] **Execution mode**: Inline (no subagent tool available); checkpoints at Task 5 + Task 6.