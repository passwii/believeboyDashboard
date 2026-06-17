"""Tests for app.services.scheduled_report.report_builder_weekly._get_inventory_alerts.

These tests pin the BEL-130 fix: the weekly report inventory-alerts query
must use the "latest ``report_date`` snapshot per (project, country)"
口径 (aligned with ``inventory_analysis_service._get_inventory_source``),
and must NOT depend on the ``is_current`` flag. Before the fix, the query
filtered ``is_current=True``, which silently dropped every snapshot whose
``is_current`` was False (BEL-104-era legacy data, 手工回填 rows, etc.),
so the weekly report showed 0 inventory alerts for every project.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models import AnalysisSourceFile, InventorySnapshotRow
from app.models.project import Project
from app.services.scheduled_report import report_builder_weekly


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db():
    """In-memory SQLite session with the schema needed for the test rows.

    We import the relevant models so ``Base.metadata.create_all`` builds
    only the tables this test file touches; we keep the fixture isolated
    to avoid pulling the whole model graph into a sqlite-only schema.
    """
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _make_project(db, project_id: int, name: str = "测试项目") -> Project:
    project = Project(
        id=project_id,
        project_name=f"{name}-{project_id}",
        sort_order=0,
        is_active=True,
    )
    db.add(project)
    db.flush()
    return project


def _make_inventory_source(
    db,
    *,
    source_id: int,
    project_id: int,
    country: str = "US",
    report_date: date,
    version: int = 1,
    is_current: bool = False,
    snapshot_at: datetime | None = None,
) -> AnalysisSourceFile:
    """Insert a minimal ``AnalysisSourceFile`` row that satisfies the table's
    CHECK constraints for ``report_type = 'inventory_report'``.

    NOTE: We bypass the model's defaults because sqlite does not honor the
    PG server_default for the ``is_current`` boolean column. The point of
    the test is to exercise the weekly builder's query, not the
    persistence layer.
    """
    if snapshot_at is None:
        snapshot_at = datetime(
            report_date.year,
            report_date.month,
            report_date.day,
            tzinfo=timezone.utc,
        )
    sf = AnalysisSourceFile(
        id=source_id,
        project_id=project_id,
        report_type="inventory_report",
        country=country,
        report_date=report_date,
        snapshot_at=snapshot_at,
        version=version,
        is_current=is_current,
        upload_file_id=f"upload-{source_id}",
        upload_file_path=f"/tmp/upload-{source_id}.xlsx",
        original_filename=f"inv-{source_id}.xlsx",
        stored_filename=f"inv-{source_id}.xlsx",
        logical_filename=f"inv-{source_id}.xlsx",
        storage_key=f"s3://bucket/inv-{source_id}.xlsx",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _make_snapshot_row(
    db,
    *,
    source_id: int,
    sku: str,
    available_qty: int,
    stock_status: str = "in_stock",
    source_row_no: int = 1,
) -> InventorySnapshotRow:
    row = InventorySnapshotRow(
        source_file_id=source_id,
        source_row_no=source_row_no,
        sku=sku,
        available_qty=available_qty,
        stock_status=stock_status,
        aging_status="fresh",
    )
    db.add(row)
    db.flush()
    return row


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_uses_latest_snapshot_when_is_current_is_false(db) -> None:
    """BEL-130 regression guard.

    Two inventory_report snapshots for the same (project, country):
      * older snapshot, ``is_current=True``   (would be picked by the OLD query)
      * newer snapshot, ``is_current=False``  (this is the one the NEW query must pick)

    The OLD code filtered ``is_current=True`` and would return zero rows.
    The NEW code picks the snapshot with the largest ``report_date`` and
    must surface the newer snapshot's SKU.
    """
    _make_project(db, project_id=1)

    older = _make_inventory_source(
        db,
        source_id=10,
        project_id=1,
        report_date=date(2026, 6, 10),
        version=1,
        is_current=True,
    )
    _make_snapshot_row(db, source_id=older.id, sku="SKU-OLD", available_qty=2)

    newer = _make_inventory_source(
        db,
        source_id=11,
        project_id=1,
        report_date=date(2026, 6, 15),
        version=1,
        is_current=False,
    )
    _make_snapshot_row(db, source_id=newer.id, sku="SKU-NEW", available_qty=3)

    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    assert [a["sku"] for a in alerts] == ["SKU-NEW"]
    assert alerts[0]["available_qty"] == 3
    assert alerts[0]["level"] == "low"


def test_filters_by_project_ids(db) -> None:
    """Multi-project: alerts must only come from the requested project_ids.

    Two projects, each with one snapshot. The caller asks for
    ``project_ids=[1]`` — only SKU-A from project 1 should come back,
    not SKU-B from project 2.
    """
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    sf_a = _make_inventory_source(
        db,
        source_id=20,
        project_id=1,
        report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf_a.id, sku="SKU-A", available_qty=1)

    sf_b = _make_inventory_source(
        db,
        source_id=21,
        project_id=2,
        report_date=date(2026, 6, 14),
    )
    _make_snapshot_row(db, source_id=sf_b.id, sku="SKU-B", available_qty=1)

    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    assert [a["sku"] for a in alerts] == ["SKU-A"]


def test_no_snapshot_returns_empty_and_warns(
    db, caplog: pytest.LogCaptureFixture
) -> None:
    """No inventory_report snapshot at all → ``[]`` + fallback warning log.

    Before the fix, this case was silent — the function returned ``[]``
    without any log, so an outage (no snapshot uploaded for a project)
    was indistinguishable from "no alerts needed". The fallback warning
    log is the new affordance that surfaces this state.
    """
    import logging

    with caplog.at_level(logging.WARNING, logger=report_builder_weekly.logger.name):
        alerts = report_builder_weekly._get_inventory_alerts(
            db, project_ids=[99], country="US"
        )

    assert alerts == []
    assert "BEL-130" in caplog.text
    assert "no inventory alerts found" in caplog.text


def test_threshold_and_limit(db) -> None:
    """Only ``available_qty <= 10`` count as alerts, max 20 entries.

    Insert 25 low-stock rows (qty=5) and 1 healthy row (qty=50). Verify:
      * the healthy row is NOT included,
      * the alert list is capped at 20,
      * all included rows have ``available_qty <= 10``.
    """
    _make_project(db, project_id=1)

    sf = _make_inventory_source(
        db,
        source_id=30,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    for i in range(25):
        _make_snapshot_row(
            db,
            source_id=sf.id,
            sku=f"SKU-LOW-{i:02d}",
            available_qty=5,
            source_row_no=i + 1,
        )
    _make_snapshot_row(
        db,
        source_id=sf.id,
        sku="SKU-HEALTHY",
        available_qty=50,
        source_row_no=999,
    )

    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    assert len(alerts) == 20
    skus = {a["sku"] for a in alerts}
    assert "SKU-HEALTHY" not in skus
    assert all(a["available_qty"] <= 10 for a in alerts)
    # All rows had identical qty=5 so level must be "low".
    assert all(a["level"] == "low" for a in alerts)


def test_oos_vs_low_classification(db) -> None:
    """``available_qty <= 0`` OR ``stock_status='out_of_stock'`` → ``level='oos'``;
    everything else with ``available_qty <= 10`` → ``level='low'``.

    Boundary cases covered:
      * qty = 0,  stock_status='in_stock'       → oos (qty<=0 rule)
      * qty = 10, stock_status='in_stock'       → low
      * qty = 3,  stock_status='out_of_stock'   → oos (status rule)
      * qty = -1, stock_status='out_of_stock'   → oos (both rules agree)
    """
    _make_project(db, project_id=1)
    sf = _make_inventory_source(
        db,
        source_id=40,
        project_id=1,
        report_date=date(2026, 6, 16),
    )
    cases = [
        ("SKU-ZERO-IN", 0, "in_stock"),
        ("SKU-TEN-LOW", 10, "in_stock"),
        ("SKU-OOS-STATUS", 3, "out_of_stock"),
        ("SKU-NEG-OOS", -1, "out_of_stock"),
    ]
    for idx, (sku, qty, status) in enumerate(cases):
        _make_snapshot_row(
            db,
            source_id=sf.id,
            sku=sku,
            available_qty=qty,
            stock_status=status,
            source_row_no=idx + 1,
        )
    db.commit()

    alerts = report_builder_weekly._get_inventory_alerts(
        db, project_ids=[1], country="US"
    )

    by_sku = {a["sku"]: a for a in alerts}
    assert by_sku["SKU-ZERO-IN"]["level"] == "oos"
    assert by_sku["SKU-TEN-LOW"]["level"] == "low"
    assert by_sku["SKU-OOS-STATUS"]["level"] == "oos"
    assert by_sku["SKU-NEG-OOS"]["level"] == "oos"
    # Ordered by available_qty ASC: -1, 0, 3, 10.
    assert [a["sku"] for a in alerts] == [
        "SKU-NEG-OOS",
        "SKU-ZERO-IN",
        "SKU-OOS-STATUS",
        "SKU-TEN-LOW",
    ]
