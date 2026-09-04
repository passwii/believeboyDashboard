"""BEL-376: One-shot full-history rebuild for analysis_return_aggregates.

Why this exists
---------------
Before BEL-376's cumulative-sales fix, the snapshot table was systemically
wrong (``sales_quantity`` = "same-day purchases only", ~4% of the real
cumulative value). Rather than migrate the data (no schema change can
express the semantic shift without a column swap), we wipe the table and
re-run the fixed ``_refresh_one_day`` from scratch over the full raw-return
date range.

Idempotent: deletes all rows then writes new ones (data_version=2). Safe
to re-run; each run replaces the prior snapshot wholesale.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.services.infra.cache_decorator import mark_committed

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.celery_tasks.return_analysis_refresh import _refresh_one_day


def _earliest_raw_return_date(db: Session) -> date:
    """Find the earliest return_date across all ``analysis_return_rows``.

    Falls back to 90 days back if the table is empty (defensive default).
    """
    row = db.execute(text("SELECT MIN(return_date) FROM analysis_return_rows")).first()
    if row and row[0]:
        return row[0]
    return date.today() - timedelta(days=90)


def rebuild_full_snapshot(db: Session) -> dict[str, Any]:
    """Wipe + repopulate ``analysis_return_aggregates`` over the full history.

    Args:
        db: SQLAlchemy session — caller manages lifecycle (commit/rollback).

    Returns:
        dict with rows_written, days_processed, days_with_data,
        projects_touched, range_start, range_end.
    """
    range_start = _earliest_raw_return_date(db)
    range_end = date.today() - timedelta(days=1)

    # 1) wipe — one-shot DELETE
    db.execute(text("DELETE FROM analysis_return_aggregates"))

    # 2) loop days, call the (now cumulative) refresh path
    rows_written = 0
    days_with_data = 0
    d = range_start
    while d <= range_end:
        result = _refresh_one_day(db, target_date=d)
        w = result.get("rows_written", 0)
        if w:
            rows_written += w
            days_with_data += 1
        d += timedelta(days=1)

    db.commit()
    mark_committed()  # BLF-669: commit 后必须 mark（装饰器在任务返回时统一失效）

    # 3) summarize
    proj_count = (
        db.execute(
            text("SELECT COUNT(DISTINCT project_id) FROM analysis_return_aggregates")
        ).scalar()
        or 0
    )

    return {
        "rows_written": rows_written,
        "days_processed": (range_end - range_start).days + 1,
        "days_with_data": days_with_data,
        "projects_touched": proj_count,
        "range_start": range_start.isoformat(),
        "range_end": range_end.isoformat(),
    }


__all__ = ["rebuild_full_snapshot"]
