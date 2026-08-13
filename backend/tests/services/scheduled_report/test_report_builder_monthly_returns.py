"""Tests for ``report_builder_monthly._get_monthly_returns`` and
``_get_inventory_summary`` project-scoping.

These tests pin the BLF-663 fix: the monthly builder's return/inventory
queries must scope rows by project through the **joined** table
(``AnalysisSourceFile.project_id``). Before the fix both queries filtered
``AnalysisSalesOrderRow.project_id`` — a model that is NOT part of either
query — which SQLAlchemy resolves by adding ``analysis_sales_order_rows`` to
the FROM clause as a cartesian product (no ON clause). Consequences:

* ``_get_monthly_returns`` leaked **every project's** returns into each
  project's monthly report (the project filter only constrained the
  cartesian side, never the return rows).
* ``_get_inventory_summary`` multiplied every inventory row by the number of
  sales-order rows — e.g. project 4 showed 1,229,074 SKU rows / 39,475,414
  available instead of 9 rows / 354 (measured on BLF local DB).

Daily and weekly builders already filter ``AnalysisSourceFile.project_id``;
this aligns the monthly builder with them (BLF-663: 统一日报/周报/月报口径).
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models import (
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
)
from app.models.project import Project
from app.services.scheduled_report.report_builder_monthly import (
    _get_inventory_summary,
    _get_monthly_returns,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db():
    """In-memory SQLite session with the schema needed for the test rows.

    只建本测试文件实际用到的表，避免 ``Base.metadata.create_all`` 在 SQLite
    上编译无关的 ``r2_delete_failures``（JSONB，仅 Postgres）等表而报错。
    """
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(
        engine,
        tables=[
            Project.__table__,
            AnalysisSourceFile.__table__,
            AnalysisReturnRow.__table__,
            InventorySnapshotRow.__table__,
            AnalysisSalesOrderRow.__table__,
        ],
    )
    SessionLocal = sessionmaker(
        bind=engine, autoflush=False, autocommit=False, future=True
    )
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


def _make_source(
    db,
    *,
    source_id: int,
    project_id: int,
    report_type: str,
    country: str = "US",
    is_current: bool = True,
    period_start: date | None = None,
    period_end: date | None = None,
    snapshot_at: datetime | None = None,
) -> AnalysisSourceFile:
    """Insert a minimal ``AnalysisSourceFile`` row that satisfies the table's
    CHECK constraints: periodic reports need ``period_start/end_date``,
    inventory reports need ``snapshot_at``.

    NOTE: We bypass the model's defaults because sqlite does not honor the
    PG server_default for the ``is_current`` boolean column. The point of
    the test is to exercise the builder's query, not the persistence layer.
    """
    sf = AnalysisSourceFile(
        id=source_id,
        project_id=project_id,
        report_type=report_type,
        country=country,
        report_date=period_start,
        period_start_date=period_start,
        period_end_date=period_end,
        snapshot_at=snapshot_at,
        version=1,
        is_current=is_current,
        upload_file_id=f"upload-{source_id}",
        upload_file_path=f"/tmp/upload-{source_id}.xlsx",
        original_filename=f"f-{source_id}.xlsx",
        stored_filename=f"f-{source_id}.xlsx",
        logical_filename=f"f-{source_id}.xlsx",
        storage_key=f"s3://bucket/f-{source_id}.xlsx",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _make_return_row(
    db,
    *,
    source_id: int,
    project_id: int,
    order_id: str,
    sku: str,
    return_date: date,
    quantity: int,
    reason: str = "退货",
    source_row_no: int = 1,
) -> AnalysisReturnRow:
    row = AnalysisReturnRow(
        project_id=project_id,
        country="US",
        source_file_id=source_id,
        source_row_no=source_row_no,
        return_date=return_date,
        order_id=order_id,
        sku=sku,
        quantity=quantity,
        detailed_disposition="SELLABLE",
        reason=reason,
        status="received",
        license_plate_number="",
        original_return_datetime="",
    )
    db.add(row)
    db.flush()
    return row


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


def _make_sales_row(
    db,
    *,
    source_id: int,
    project_id: int,
    amazon_order_id: str,
    purchase_date_pt: date,
    quantity: int = 1,
    source_row_no: int = 1,
) -> AnalysisSalesOrderRow:
    dt = datetime(purchase_date_pt.year, purchase_date_pt.month, purchase_date_pt.day)
    row = AnalysisSalesOrderRow(
        source_file_id=source_id,
        source_row_no=source_row_no,
        project_id=project_id,
        country="US",
        amazon_order_id=amazon_order_id,
        purchase_at_utc=dt.replace(tzinfo=timezone.utc),
        purchase_at_pt=dt,
        purchase_date_pt=purchase_date_pt,
        order_status="Shipped",
        sku="SKU-SALES",
        quantity=quantity,
        is_counted_sales=True,
    )
    db.add(row)
    db.flush()
    return row


# ---------------------------------------------------------------------------
# Tests — _get_monthly_returns
# ---------------------------------------------------------------------------


def test_monthly_returns_project_scoped_no_leakage(db) -> None:
    """BLF-663 regression guard.

    Project 1 has 2 return rows (qty 2+3=5), project 2 has 1 return row
    (qty 10). A project-scoped report for [1] must return exactly 5.

    The OLD code filtered ``AnalysisSalesOrderRow.project_id`` on a query
    that never joins sales rows: SQLAlchemy turned it into a cartesian
    product and project 2's return rows leaked into project 1's report
    (qty 15). The dedup step then silently collapsed the cartesian copies,
    so the leak was the only visible symptom.
    """
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    # Project 1: 2 return rows
    src1 = _make_source(
        db,
        source_id=100,
        project_id=1,
        report_type="return_report",
        period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    _make_return_row(
        db,
        source_id=src1.id,
        project_id=1,
        order_id="ORD-A",
        sku="SKU-A",
        return_date=date(2026, 7, 5),
        quantity=2,
        source_row_no=1,
    )
    _make_return_row(
        db,
        source_id=src1.id,
        project_id=1,
        order_id="ORD-B",
        sku="SKU-B",
        return_date=date(2026, 7, 12),
        quantity=3,
        source_row_no=2,
    )

    # Project 2: 1 return row (must NOT appear in project 1's report)
    src2 = _make_source(
        db,
        source_id=200,
        project_id=2,
        report_type="return_report",
        period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    _make_return_row(
        db,
        source_id=src2.id,
        project_id=2,
        order_id="ORD-C",
        sku="SKU-C",
        return_date=date(2026, 7, 20),
        quantity=10,
        source_row_no=1,
    )

    # Some sales rows for project 1 — under the OLD buggy query these made
    # the FROM clause a cartesian product (analysis_sales_order_rows).
    sales_src = _make_source(
        db,
        source_id=300,
        project_id=1,
        report_type="sales_report",
        period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    _make_sales_row(
        db,
        source_id=sales_src.id,
        project_id=1,
        amazon_order_id="S-1",
        purchase_date_pt=date(2026, 7, 3),
        source_row_no=1,
    )
    _make_sales_row(
        db,
        source_id=sales_src.id,
        project_id=1,
        amazon_order_id="S-2",
        purchase_date_pt=date(2026, 7, 15),
        source_row_no=2,
    )

    result = _get_monthly_returns(
        db,
        [1],
        "US",
        date(2026, 7, 1),
        date(2026, 7, 31),
        month_total_qty=100,
    )
    assert result["qty"] == 5, f"expected project-1-only qty=5, got {result['qty']}"
    assert result["rate"] == 5.0, f"expected rate=5.0, got {result['rate']}"

    # TOP reasons only from project 1's rows
    reasons = {r["reason"]: r["qty"] for r in result["top_returns"]}
    assert reasons == {"退货": 5}, f"top reasons leaked across projects: {reasons}"


def test_monthly_returns_all_projects(db) -> None:
    """project_ids=None (全部项目) still returns every project's returns."""
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    # One source file per project; distinct rows via source_row_no
    src1 = _make_source(
        db,
        source_id=100,
        project_id=1,
        report_type="return_report",
        period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    _make_return_row(
        db,
        source_id=src1.id,
        project_id=1,
        order_id="ORD-A",
        sku="SKU-A",
        return_date=date(2026, 7, 10),
        quantity=2,
        source_row_no=1,
    )
    _make_return_row(
        db,
        source_id=src1.id,
        project_id=1,
        order_id="ORD-B",
        sku="SKU-B",
        return_date=date(2026, 7, 11),
        quantity=3,
        source_row_no=2,
    )
    src2 = _make_source(
        db,
        source_id=200,
        project_id=2,
        report_type="return_report",
        period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    _make_return_row(
        db,
        source_id=src2.id,
        project_id=2,
        order_id="ORD-C",
        sku="SKU-C",
        return_date=date(2026, 7, 12),
        quantity=10,
        source_row_no=1,
    )

    result = _get_monthly_returns(
        db,
        None,
        "US",
        date(2026, 7, 1),
        date(2026, 7, 31),
        month_total_qty=100,
    )
    assert result["qty"] == 15, f"expected all-projects qty=15, got {result['qty']}"


# ---------------------------------------------------------------------------
# Tests — _get_inventory_summary
# ---------------------------------------------------------------------------


def test_inventory_summary_project_scoped_no_cartesian(db) -> None:
    """BLF-663 regression guard.

    Project 1 has 2 snapshot rows (10+20=30 available), project 2 has 1
    snapshot row (500). A project-scoped report for [1] must return
    sku_count=2 / total_available=30.

    The OLD code filtered ``AnalysisSalesOrderRow.project_id`` on an
    inventory query that never joins sales rows: SQLAlchemy turned it into
    a cartesian product with every sales-order row, exploding sku_count and
    available_qty by the number of sales rows (and leaking project 2's rows).
    """
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    # Project 1: 2 inventory rows (10 + 20)
    inv1 = _make_source(
        db,
        source_id=400,
        project_id=1,
        report_type="inventory_report",
        snapshot_at=datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc),
    )
    _make_snapshot_row(
        db, source_id=inv1.id, sku="SKU-1", available_qty=10, source_row_no=1
    )
    _make_snapshot_row(
        db, source_id=inv1.id, sku="SKU-2", available_qty=20, source_row_no=2
    )

    # Project 2: 1 inventory row (500) — must NOT leak into project 1
    inv2 = _make_source(
        db,
        source_id=500,
        project_id=2,
        report_type="inventory_report",
        snapshot_at=datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc),
    )
    _make_snapshot_row(
        db, source_id=inv2.id, sku="SKU-3", available_qty=500, source_row_no=1
    )

    # Sales rows for project 1 — under the OLD buggy query these made the
    # FROM clause a cartesian product (analysis_sales_order_rows).
    sales_src = _make_source(
        db,
        source_id=600,
        project_id=1,
        report_type="sales_report",
        period_start=date(2026, 7, 1),
        period_end=date(2026, 7, 31),
    )
    _make_sales_row(
        db,
        source_id=sales_src.id,
        project_id=1,
        amazon_order_id="S-1",
        purchase_date_pt=date(2026, 7, 3),
        source_row_no=1,
    )
    _make_sales_row(
        db,
        source_id=sales_src.id,
        project_id=1,
        amazon_order_id="S-2",
        purchase_date_pt=date(2026, 7, 15),
        source_row_no=2,
    )

    summary = _get_inventory_summary(db, [1], "US")
    assert summary["sku_count"] == 2, (
        f"expected sku_count=2, got {summary['sku_count']}"
    )
    assert summary["total_available"] == 30, (
        f"expected total_available=30, got {summary['total_available']}"
    )
    # low=2 (both 0<qty<=20), oos=0
    assert summary["low_stock_count"] == 2, (
        f"expected low_stock_count=2, got {summary['low_stock_count']}"
    )
    assert summary["oos_count"] == 0, (
        f"expected oos_count=0, got {summary['oos_count']}"
    )


def test_inventory_summary_all_projects(db) -> None:
    """project_ids=None (全部项目) still returns every project's inventory."""
    _make_project(db, project_id=1)
    _make_project(db, project_id=2)

    for pid, sid, sku, qty in [
        (1, 400, "SKU-1", 10),
        (1, 401, "SKU-2", 20),
        (2, 500, "SKU-3", 500),
    ]:
        src = _make_source(
            db,
            source_id=sid,
            project_id=pid,
            report_type="inventory_report",
            snapshot_at=datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc),
        )
        _make_snapshot_row(
            db, source_id=src.id, sku=sku, available_qty=qty, source_row_no=1
        )

    summary = _get_inventory_summary(db, None, "US")
    assert summary["sku_count"] == 3, (
        f"expected sku_count=3, got {summary['sku_count']}"
    )
    assert summary["total_available"] == 530, (
        f"expected total_available=530, got {summary['total_available']}"
    )
