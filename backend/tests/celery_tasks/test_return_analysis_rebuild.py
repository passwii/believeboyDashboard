"""BEL-376: One-shot full-history rebuild of analysis_return_aggregates.

Smoke test: verifies ``rebuild_full_snapshot`` runs end-to-end and
returns sane output (idempotent on re-run).
"""

from __future__ import annotations


def test_rebuild_full_snapshot_runs_and_returns_shape(db_session):
    """Wipe + repopulate over full history. Result should have expected keys
    and idempotent behavior (running twice produces same row count)."""
    from app.celery_tasks.return_analysis_rebuild import rebuild_full_snapshot

    # First run
    r1 = rebuild_full_snapshot(db_session)
    cnt1 = db_session.execute(
        __import__("sqlalchemy").text("SELECT COUNT(*) FROM analysis_return_aggregates")
    ).scalar()

    # Function returns expected shape
    assert isinstance(r1, dict)
    for key in (
        "rows_written",
        "days_processed",
        "days_with_data",
        "projects_touched",
        "range_start",
        "range_end",
    ):
        assert key in r1, f"missing key: {key}"
    assert r1["range_start"] <= r1["range_end"]

    # New rows have data_version=3 (BLF-806 mark; was 2 = BEL-376 cumulative-only)
    from app.models import AnalysisReturnAggregate

    sample = db_session.query(AnalysisReturnAggregate).limit(5).all()
    for row in sample:
        assert row.data_version == 3, (
            f"expected data_version=3, got {row.data_version} for {row.sku}"
        )
        # BLF-806: 新写入行必须带当日销量（非 NULL）
        assert row.daily_sales_quantity is not None, (
            f"expected non-null daily_sales_quantity for {row.sku}"
        )

    # Second run — should produce same row count (idempotent)
    r2 = rebuild_full_snapshot(db_session)
    cnt2 = db_session.execute(
        __import__("sqlalchemy").text("SELECT COUNT(*) FROM analysis_return_aggregates")
    ).scalar()
    assert cnt1 == cnt2, f"rebuild not idempotent: first={cnt1} second={cnt2}"
