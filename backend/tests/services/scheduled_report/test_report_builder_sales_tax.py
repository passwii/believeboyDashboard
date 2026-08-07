"""BLF-475：定时报告销售额含税口径回归测试。

财务月报对 DE/UK 采用含税 gross 口径；定时报告（日/周/月）聚合订单销售额时
同样需要加回 VAT（订单报表的 item-tax / shipping-tax 列），US 站点保持净额。

本测试针对 daily ``_query_sales_snapshot`` / weekly / monthly 三个聚合函数，
在真实 Postgres（BLF_test，schema 已迁移到 241）上验证：
- DE/UK：amount 含 item_tax + shipping_tax（净额 + VAT）
- US：即使行内带 item_tax，amount 也保持净额（与财务侧 VAT_INCLUSIVE_COUNTRIES 一致）
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timezone

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models import AnalysisSourceFile
from app.models.project import Project
from app.services.scheduled_report import (
    report_builder_daily,
    report_builder_monthly,
    report_builder_weekly,
)
from app.utils.persist_helpers import upsert_sales_order_rows

_TEST_PROJECT_RE = r"^.*-TEST-.+$"


@pytest.fixture(autouse=True)
def _auto_cleanup(db_session):
    yield
    with SessionLocal() as session:
        try:
            dirty = session.execute(
                text("SELECT id FROM projects WHERE project_name ~* :re"),
                {"re": _TEST_PROJECT_RE},
            ).scalars().all()
            if not dirty:
                return
            session.execute(
                text("DELETE FROM analysis_sales_order_rows WHERE project_id = ANY(:ids)"),
                {"ids": list(dirty)},
            )
            session.execute(
                text("DELETE FROM analysis_source_files WHERE project_id = ANY(:ids)"),
                {"ids": list(dirty)},
            )
            session.execute(
                text("DELETE FROM projects WHERE id = ANY(:ids)"),
                {"ids": list(dirty)},
            )
            session.commit()
        except Exception:
            session.rollback()
            raise


@pytest.fixture()
def db_session():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture()
def project_id(db_session):
    name = f"PH-TEST-{uuid.uuid4().hex[:10]}"
    p = Project(project_name=name, sort_order=0, is_active=False)
    db_session.add(p)
    db_session.commit()
    db_session.refresh(p)
    pid = p.id
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


def _make_source(db, *, project_id, report_date=date(2026, 7, 15)):
    sf = AnalysisSourceFile(
        project_id=project_id,
        report_type="sales_report",
        country="DE",
        report_date=report_date,
        period_start_date=report_date,
        period_end_date=report_date,
        snapshot_at=None,
        version=1,
        is_current=True,
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


def _row_dict(
    *,
    project_id,
    source_file_id,
    order_id,
    country="DE",
    purchase_date=date(2026, 7, 15),
    qty=1,
    item_price="100.00",
    shipping_price="10.00",
    item_tax="19.00",
    shipping_tax="1.90",
):
    return {
        "project_id": project_id,
        "source_file_id": source_file_id,
        "source_row_no": 1,
        "amazon_order_id": order_id,
        "purchase_at_utc": datetime.combine(purchase_date, time(12, 0), tzinfo=timezone.utc),
        "purchase_at_pt": datetime.combine(purchase_date, time(5, 0)),
        "purchase_date_pt": purchase_date,
        "order_status": "Shipped",
        "country": country,
        "sku": "SKU-A",
        "asin": "ASIN1",
        "quantity": qty,
        "item_price": item_price,
        "shipping_price": shipping_price,
        "item_tax": item_tax,
        "shipping_tax": shipping_tax,
        "currency": "EUR",
        "is_counted_sales": True,
        "status_rule_version": 1,
        "raw_row": {},
        "carrier": None,
        "tracking_no": None,
        "shipped_at": None,
        "updated_by": None,
        "updated_at": None,
    }


def _insert_rows(db_session, project_id, row_specs):
    """Insert rows via the production upsert path, wiring a real source_file_id."""
    src = _make_source(db_session, project_id=project_id)
    db_session.commit()
    rows = []
    for spec in row_specs:
        row = dict(spec)
        row["source_file_id"] = src.id
        rows.append(row)
    upsert_sales_order_rows(db_session, rows)
    db_session.commit()


# ---------------------------------------------------------------------------
# daily _query_sales_snapshot
# ---------------------------------------------------------------------------


def test_daily_de_amount_includes_vat(db_session, project_id):
    """DE：销售额 = item + shipping + item_tax + shipping_tax。"""
    _insert_rows(db_session, project_id, [
        _row_dict(
            project_id=project_id,
            source_file_id=999,  # filled by upsert; value unused for aggregation
            order_id="026-AAAAAA-AAAAAA",
            item_price="100.00",
            shipping_price="10.00",
            item_tax="19.00",
            shipping_tax="1.90",
        ),
    ])

    snap, trend, _ = report_builder_daily._query_sales_snapshot(
        db_session, [project_id], "DE", date(2026, 7, 9), date(2026, 7, 15)
    )
    # 100.00 + 10.00 + 19.00 + 1.90 = 130.90
    assert snap["today_sales_amount"] == pytest.approx(130.90)
    assert trend[-1]["sales_amount"] == pytest.approx(130.90)


def test_daily_us_amount_keeps_net_even_with_tax(db_session, project_id):
    """US：即使行内带了 item_tax，销售额也保持净额（与财务口径一致）。"""
    _insert_rows(db_session, project_id, [
        _row_dict(
            project_id=project_id,
            source_file_id=999,
            order_id="026-BBBBBB-BBBBBB",
            country="US",
            item_price="100.00",
            shipping_price="10.00",
            item_tax="7.00",
            shipping_tax="0.70",
        ),
    ])

    snap, trend, _ = report_builder_daily._query_sales_snapshot(
        db_session, [project_id], "US", date(2026, 7, 9), date(2026, 7, 15)
    )
    # 100.00 + 10.00 = 110.00（税不算入）
    assert snap["today_sales_amount"] == pytest.approx(110.00)
    assert trend[-1]["sales_amount"] == pytest.approx(110.00)


# ---------------------------------------------------------------------------
# weekly _aggregate_weekly_sales
# ---------------------------------------------------------------------------


def test_weekly_de_amount_includes_vat(db_session, project_id):
    _insert_rows(db_session, project_id, [
        _row_dict(
            project_id=project_id,
            source_file_id=999,
            order_id="026-CCCCCC-CCCCCC",
            item_price="100.00",
            shipping_price="10.00",
            item_tax="19.00",
            shipping_tax="1.90",
        ),
    ])

    agg = report_builder_weekly._aggregate_weekly_sales(
        db_session, [project_id], "DE", date(2026, 7, 13), date(2026, 7, 19)
    )
    assert agg["amount"] == pytest.approx(130.90)


def test_weekly_us_amount_keeps_net(db_session, project_id):
    _insert_rows(db_session, project_id, [
        _row_dict(
            project_id=project_id,
            source_file_id=999,
            order_id="026-DDDDDD-DDDDDD",
            country="US",
            item_price="100.00",
            shipping_price="10.00",
            item_tax="7.00",
            shipping_tax="0.70",
        ),
    ])

    agg = report_builder_weekly._aggregate_weekly_sales(
        db_session, [project_id], "US", date(2026, 7, 13), date(2026, 7, 19)
    )
    assert agg["amount"] == pytest.approx(110.00)


# ---------------------------------------------------------------------------
# monthly _aggregate_monthly_sales
# ---------------------------------------------------------------------------


def test_monthly_de_amount_includes_vat(db_session, project_id):
    _insert_rows(db_session, project_id, [
        _row_dict(
            project_id=project_id,
            source_file_id=999,
            order_id="026-EEEEEE-EEEEEE",
            item_price="100.00",
            shipping_price="10.00",
            item_tax="19.00",
            shipping_tax="1.90",
        ),
    ])

    agg = report_builder_monthly._aggregate_monthly_sales(
        db_session, [project_id], "DE", date(2026, 7, 1), date(2026, 7, 31)
    )
    assert agg["amount"] == pytest.approx(130.90)


def test_monthly_us_amount_keeps_net(db_session, project_id):
    _insert_rows(db_session, project_id, [
        _row_dict(
            project_id=project_id,
            source_file_id=999,
            order_id="026-FFFFFF-FFFFFF",
            country="US",
            item_price="100.00",
            shipping_price="10.00",
            item_tax="7.00",
            shipping_tax="0.70",
        ),
    ])

    agg = report_builder_monthly._aggregate_monthly_sales(
        db_session, [project_id], "US", date(2026, 7, 1), date(2026, 7, 31)
    )
    assert agg["amount"] == pytest.approx(110.00)
