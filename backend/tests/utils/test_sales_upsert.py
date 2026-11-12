"""Unit/integration tests for BEL-348 row-level sales upsert.

Pins the behavior of ``app.utils.persist_helpers.upsert_sales_order_rows``
and ``app.services.sales_query.counted_sales_where``:

- Same (project, order, sku, country, purchase_date) across multiple
  uploads collapses to ONE row; latest mutable fields win; data_version bumps.
- A single order appearing in two adjacent date buckets (e.g. 06-23 and
  06-24) is KEPT as two separate rows — the 5-column unique key
  includes purchase_date_pt, so cross-bucket duplicates are NOT merged
  (this is the fix for the "14->2" data-loss root cause).
- counted_sales_where filters directly on rows, no is_current join.

Runs against real PostgreSQL (schema cloned from DATABASE_URL via
cmd/setuptestdb). The 5-column unique constraint must exist in the
test DB -- ensure ``alembic upgrade head`` has been run on the source
DATABASE_URL before cloning the test DB.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timezone

import pytest
from sqlalchemy import func, select, text

from app.db.session import SessionLocal
from app.models import AnalysisSalesOrderRow, AnalysisSourceFile
from app.models.project import Project
from app.services.sales_query import counted_sales_where
from app.utils.persist_helpers import upsert_sales_order_rows

_TEST_PROJECT_RE = r"^.*-TEST-.+$"


@pytest.fixture(autouse=True)
def _auto_cleanup_test_projects_on_teardown():
    yield
    with SessionLocal() as session:
        try:
            dirty_ids = session.execute(
                text("SELECT id FROM projects WHERE project_name ~* :re"),
                {"re": _TEST_PROJECT_RE},
            ).scalars().all()
            if not dirty_ids:
                return
            session.execute(
                text("DELETE FROM analysis_sales_order_rows WHERE project_id = ANY(:ids)"),
                {"ids": list(dirty_ids)},
            )
            session.execute(
                text("DELETE FROM analysis_source_files WHERE project_id = ANY(:ids)"),
                {"ids": list(dirty_ids)},
            )
            session.execute(
                text("DELETE FROM projects WHERE id = ANY(:ids)"),
                {"ids": list(dirty_ids)},
            )
            session.commit()
        except Exception:
            session.rollback()
            raise


@pytest.fixture()
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture()
def project_id(db_session):
    name = f"PH-TEST-{uuid.uuid4().hex[:10]}"
    project = Project(project_name=name, sort_order=0, is_active=False)
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    try:
        yield pid
    finally:
        db_session.execute(
            text("DELETE FROM analysis_sales_order_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(
            text("DELETE FROM analysis_source_files WHERE project_id = :pid"),
            {"pid": pid},
        )
        db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": pid})
        db_session.commit()


def _make_sales_source(db, *, project_id, country="UK", report_date=date(2026, 7, 15), version=1):
    sf = AnalysisSourceFile(
        project_id=project_id,
        report_type="sales_report",
        country=country,
        report_date=report_date,
        period_start_date=report_date,
        period_end_date=report_date,
        snapshot_at=None,
        version=version,
        is_current=False,
        superseded_at=None,
        upload_file_id=f"upload-sales-{uuid.uuid4().hex[:8]}",
        upload_file_path="/tmp/sales.tsv",
        original_filename="sales.tsv",
        stored_filename="sales.tsv",
        logical_filename="sales.tsv",
        storage_key=f"web_upload/sales/{project_id}/{report_date}",
        ingestion_status="success",
        row_count_total=0,
        row_count_included=0,
    )
    db.add(sf)
    db.flush()
    return sf


def _row_dict(*, project_id, source_file_id, order_id, sku="SKU-A", country="UK",
             purchase_date=date(2026, 7, 15), status="Shipped",
             is_counted=True, qty=1, price="18.99", version=1):
    return {
        "project_id": project_id,
        "source_file_id": source_file_id,
        "source_row_no": 1,
        "amazon_order_id": order_id,
        "purchase_at_utc": datetime.combine(
            purchase_date, time(12, 0), tzinfo=timezone.utc
        ),
        "purchase_at_pt": datetime.combine(
            purchase_date, time(5, 0)
        ),
        "purchase_date_pt": purchase_date,
        "order_status": status,
        "country": country,
        "sku": sku,
        "asin": "ASIN1",
        "quantity": qty,
        "item_price": price,
        "shipping_price": "0.00",
        "item_tax": "0.00",
        "shipping_tax": "0.00",
        "currency": "GBP",
        "is_counted_sales": is_counted,
        "status_rule_version": 1,
        "raw_row": {},
        "carrier": None,
        "tracking_no": None,
        "shipped_at": None,
        "updated_by": None,
        "updated_at": None,
    }


def _count_rows(db, project_id):
    return db.execute(
        select(func.count()).select_from(AnalysisSalesOrderRow).where(
            AnalysisSalesOrderRow.project_id == project_id
        )
    ).scalar_one()


# ---------------------------------------------------------------------------
# upsert_sales_order_rows
# ---------------------------------------------------------------------------


def test_upsert_same_key_collapses_to_one_row(db_session, project_id):
    """Re-uploading the same (project,order,sku,country,pdate) keeps ONE row."""
    src = _make_sales_source(db_session, project_id=project_id)
    db_session.commit()

    r1 = _row_dict(project_id=project_id, source_file_id=src.id,
                    order_id="026-1111111-1111111", status="Pending", qty=1)
    upsert_sales_order_rows(db_session, [r1])
    db_session.commit()
    assert _count_rows(db_session, project_id) == 1

    # second upload (different source_file, same order) — should update, not duplicate
    src2 = _make_sales_source(db_session, project_id=project_id, version=2)
    db_session.commit()
    r2 = _row_dict(project_id=project_id, source_file_id=src2.id,
                    order_id="026-1111111-1111111", status="Shipped", qty=2)
    upsert_sales_order_rows(db_session, [r2])
    db_session.commit()

    assert _count_rows(db_session, project_id) == 1  # collapsed
    row = db_session.execute(
        select(AnalysisSalesOrderRow)
        .where(AnalysisSalesOrderRow.project_id == project_id)
    ).scalar_one()
    assert row.order_status == "Shipped"   # latest wins
    assert row.quantity == 2
    assert row.data_version == 2            # bumped


def test_upsert_cross_bucket_order_kept_as_two_rows(db_session, project_id):
    """A single order appearing in two adjacent date buckets must stay TWO rows.

    This is the core BEL-348 fix: the unique key includes
    purchase_date_pt, so 206-9587340 at 06-23 vs 06-24 are distinct.
    """
    src_a = _make_sales_source(db_session, project_id=project_id,
                                report_date=date(2026, 6, 23))
    src_b = _make_sales_source(db_session, project_id=project_id,
                                report_date=date(2026, 6, 24), version=2)
    db_session.commit()

    r_a = _row_dict(project_id=project_id, source_file_id=src_a.id,
                     order_id="206-9587340-3706739",
                     purchase_date=date(2026, 6, 23), status="Cancelled")
    r_b = _row_dict(project_id=project_id, source_file_id=src_b.id,
                     order_id="206-9587340-3706739",
                     purchase_date=date(2026, 6, 24), status="Cancelled")
    upsert_sales_order_rows(db_session, [r_a, r_b])
    db_session.commit()

    assert _count_rows(db_session, project_id) == 2  # NOT merged


def test_upsert_purchase_date_not_overwritten(db_session, project_id):
    """On conflict, purchase_date_pt (part of the key) must NOT change."""
    src = _make_sales_source(db_session, project_id=project_id)
    db_session.commit()
    r1 = _row_dict(project_id=project_id, source_file_id=src.id,
                    order_id="026-2222222-2222222",
                    purchase_date=date(2026, 7, 15))
    upsert_sales_order_rows(db_session, [r1])
    db_session.commit()

    src2 = _make_sales_source(db_session, project_id=project_id, version=2)
    db_session.commit()
    # same key (project,order,sku,country,pdate) re-uploaded with a *mismatched*
    # purchase_date in the payload — because purchase_date_pt is part of the
    # unique key it lives in index_elements, not the update-set, so the stored
    # 07-15 is preserved (the conflicting payload date is simply ignored).
    r2 = _row_dict(project_id=project_id, source_file_id=src2.id,
                    order_id="026-2222222-2222222",
                    purchase_date=date(2026, 7, 15),
                    status="Shipped")
    upsert_sales_order_rows(db_session, [r2])
    db_session.commit()

    assert _count_rows(db_session, project_id) == 1  # collapsed, not duplicated
    row = db_session.execute(
        select(AnalysisSalesOrderRow)
        .where(AnalysisSalesOrderRow.project_id == project_id)
    ).scalar_one()
    assert row.purchase_date_pt == date(2026, 7, 15)  # unchanged
    assert row.order_status == "Shipped"  # other mutable fields still updated


def test_upsert_returns_row_count(db_session, project_id):
    src = _make_sales_source(db_session, project_id=project_id)
    db_session.commit()
    rows = [
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-3333333-3333333"),
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-4444444-4444444", sku="SKU-B"),
    ]
    n = upsert_sales_order_rows(db_session, rows)
    assert n == 2
    assert _count_rows(db_session, project_id) == 2


# ---------------------------------------------------------------------------
# counted_sales_where
# ---------------------------------------------------------------------------


def test_counted_sales_where_filters_directly(db_session, project_id):
    """counted_sales_where filters on rows only (no is_current join)."""
    src = _make_sales_source(db_session, project_id=project_id)
    db_session.commit()
    rows = [
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-5555555-5555555",
                  purchase_date=date(2026, 7, 15), is_counted=True),
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-6666666-6666666",
                  purchase_date=date(2026, 7, 16), is_counted=True),
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-7777777-7777777",
                  purchase_date=date(2026, 7, 15), is_counted=False),
    ]
    upsert_sales_order_rows(db_session, rows)
    db_session.commit()

    where = counted_sales_where(
        project_id=project_id,
        country="UK",
        date_from=date(2026, 7, 1),
        date_to=date(2026, 7, 31),
    )
    cnt = db_session.execute(
        select(func.count()).select_from(AnalysisSalesOrderRow).where(*where)
    ).scalar_one()
    # only the two is_counted_sales=True rows match
    assert cnt == 2


def test_counted_sales_where_excludes_pending_when_requested(db_session, project_id):
    src = _make_sales_source(db_session, project_id=project_id)
    db_session.commit()
    rows = [
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-8888888-8888888",
                  purchase_date=date(2026, 7, 15), status="Shipped"),
        _row_dict(project_id=project_id, source_file_id=src.id,
                  order_id="026-9999999-9999999",
                  purchase_date=date(2026, 7, 15), status="Pending"),
    ]
    upsert_sales_order_rows(db_session, rows)
    db_session.commit()

    where = counted_sales_where(
        project_id=project_id,
        country="UK",
        date_from=date(2026, 7, 1),
        date_to=date(2026, 7, 31),
        include_pending=False,
    )
    cnt = db_session.execute(
        select(func.count()).select_from(AnalysisSalesOrderRow).where(*where)
    ).scalar_one()
    assert cnt == 1  # pending excluded

