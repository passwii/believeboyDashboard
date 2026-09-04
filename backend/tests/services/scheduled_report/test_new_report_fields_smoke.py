"""Smoke tests for the new report fields: 广告占比 (ad_ratio_all) & 在途库存 (in_transit).

These tests deliberately avoid the broken SQLite ``db`` fixture (which trips on
the Postgres-only ``JSONB`` column in ``r2_delete_failures``). Instead they:

  * feed fully-built ``report_data`` dicts straight into the renderer functions
    and assert the generated HTML contains the new rows / cards;
  * exercise the new in-transit SQL against a real in-memory SQLite engine
    (only ``shipment_schedules`` + ``shipment_schedule_items`` tables);
  * call the ads-comparison builders with a fake ``db`` to verify the
    ``ad_ratio_all`` math (spend / total-sales * 100).

Covers daily / weekly / monthly renderers and the weekly / monthly
``ad_ratio_all`` computation. The daily ``ad_ratio_all`` is validated via the
daily renderer (the inline math in ``build_report_email_data`` is trivial).
"""

from __future__ import annotations

from datetime import date

import pytest

from unittest.mock import MagicMock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.services.scheduled_report import (
    email_sender_daily,
    email_sender_monthly,
    email_sender_weekly,
    report_builder_monthly,
    report_builder_weekly,
)


@pytest.fixture(autouse=True)
def _restore_ad_upload_file_is_current():
    """_make_fake_db 会把共享模型类 AdUploadFile.is_current 改成 MagicMock；
    测试后必须还原，否则污染后续所有查 is_current 的测试（全量跑时）。"""
    from app.models import AdUploadFile

    original = AdUploadFile.is_current
    yield
    AdUploadFile.is_current = original


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_ads_row(spend: float = 100.0, sales: float = 500.0):
    """A fake SQL row mimicking AdUploadPromotedProductRow aggregate output."""

    class _Row:
        pass

    row = _Row()
    row.spend = spend
    row.sales = sales
    row.clicks = 10
    row.impressions = 100
    row.orders = 5
    return row


def _make_fake_db(row) -> MagicMock:
    """A MagicMock ``db`` whose ``query()...first()`` returns ``row``.

    SQLAlchemy raises if a real Column is compared to ``True`` (``AdUploadFile
    .is_current == True``). We replace only ``is_current`` with a MagicMock so
    that comparison is harmless, while leaving the other columns real (so
    ``period_end_date >= <date>`` and ``country == "US"`` still evaluate fine).
    The query chain (``.join().filter().first()``) short-circuits to ``row``.
    """
    report_builder_weekly.AdUploadFile.is_current = MagicMock()
    report_builder_monthly.AdUploadFile.is_current = MagicMock()
    db = MagicMock()
    chain = db.query.return_value.join.return_value.filter.return_value
    chain.first.return_value = row
    return db


# ---------------------------------------------------------------------------
# Renderer smoke tests (no DB)
# ---------------------------------------------------------------------------


def _daily_report_data() -> dict:
    return {
        "country": "US",
        "date_range": "2026-07-10 ~ 2026-07-16",
        "sales": {
            "yesterday_qty": 120,
            "yesterday_amount": 3400.0,
            "prev_qty": 100,
            "change_pct": 20.0,
        },
        "week_sales": {"week_qty": 800, "week_amount": 22000.0},
        "trend_days": [{"date": "07-10", "qty": 100}, {"date": "07-11", "qty": 120}],
        "top_skus": [{"sku": "SKU-A", "qty": 30, "amount": 900.0}],
        "inventory": {
            "sku_count": 50,
            "oos_skus": [{"sku": "SKU-X", "available_qty": 0}],
            "low_stock_skus": [{"sku": "SKU-Y", "available_qty": 5}],
            "total_available": 1234,
            "in_transit": 567,
        },
        "ads": {
            "spend": 680.0,
            "sales": 3000.0,
            "roas": 4.41,
            "acos": 22.7,
            "ctr": 1.5,
            "ad_ratio_all": 20.0,
        },
        "returns": {"qty": 8, "rate": 1.0, "top_returns": []},
        "alert_rows": [],
        "sku_sales_detail": [],
    }


def test_daily_content_sections_has_new_fields():
    html = email_sender_daily._render_daily_content_sections(_daily_report_data())
    assert "广告占比" in html
    assert "20.0%" in html
    assert "在途库存" in html
    assert "567" in html  # in_transit, formatted without thousands sep here


def test_daily_section_inventory_ads_has_new_fields():
    html = email_sender_daily._section_inventory_ads(_daily_report_data(), "US")
    assert "广告占比" in html
    assert "20.0%" in html
    assert "在途库存" in html
    assert "567" in html


def test_weekly_content_sections_has_new_fields():
    data = {
        "country": "US",
        "date_range": "2026-07-06 ~ 2026-07-12",
        "prev_week_range": "2026-06-29 ~ 2026-07-05",
        "current_week": {"qty": 800, "amount": 22000.0, "avg_price": 27.5},
        "prev_week": {"qty": 750, "amount": 20000.0, "avg_price": 26.7},
        "changes": {
            "qty_change": 6.7,
            "amount_change": 10.0,
            "orders_change": 6.7,
            "avg_price_change": 3.0,
        },
        "daily_trend": [{"date": "07-06", "qty": 100, "weekday": "周一"}],
        "top_skus_comparison": [],
        "ads_comparison": {
            "spend": {"current": 680.0, "prev": 600.0, "change": 13.3},
            "roas": {"current": 4.4, "prev": 4.0, "change": 10.0},
            "acos": {"current": 22.7, "prev": 25.0, "change": -9.2},
            "ctr": {"current": 1.5, "prev": 1.4, "change": 7.1},
            "ad_ratio_all": {"current": 20.0, "prev": 18.0, "change": 11.1},
        },
        "returns_data": {"qty": 8, "rate": 1.0, "top_returns": []},
        "inventory_summary": {
            "total_available": 1234,
            "sku_count": 50,
            "low_stock_count": 3,
            "oos_count": 2,
            "in_transit": 567,
        },
        "sku_sales_detail": [],
    }
    html = email_sender_weekly._render_weekly_content_sections(data)
    assert "广告占比" in html
    assert "20.00" in html  # card renders .2f
    assert "在途库存" in html
    assert "567" in html


def test_monthly_ads_and_returns_has_new_fields():
    ads_data = {
        "country": "US",
        "ads_comparison": {
            "spend": {"current": 3000.0, "prev": 2800.0, "yoy": 2500.0,
                      "mom_change": 7.1, "yoy_change": 20.0},
            "roas": {"current": 4.4, "prev": 4.0, "yoy": 3.8,
                     "mom_change": 10.0, "yoy_change": 15.8},
            "acos": {"current": 22.7, "prev": 25.0, "yoy": 26.0,
                     "mom_change": -9.2, "yoy_change": -12.7},
            "ctr": {"current": 1.5, "prev": 1.4, "yoy": 1.3,
                    "mom_change": 7.1, "yoy_change": 15.4},
            "ad_ratio_all": {"current": 18.0, "prev": 17.0, "yoy": 15.0,
                             "mom_change": 5.9, "yoy_change": 20.0},
        },
    }
    returns_data = {
        "country": "US",
        "returns_data": {"qty": 30, "rate": 1.2, "top_returns": []},
        "inventory_summary": {
            "total_available": 1234,
            "sku_count": 50,
            "low_stock_count": 3,
            "oos_count": 2,
            "in_transit": 567,
        },
    }
    ads_html = email_sender_monthly._section_month_ads(ads_data, "US")
    returns_html = email_sender_monthly._section_month_returns(returns_data, "US")
    assert "广告占比" in ads_html
    assert "18.00" in ads_html
    assert "在途库存" in returns_html
    assert "567" in returns_html


# ---------------------------------------------------------------------------
# In-transit SQL (real SQLite, shipment tables only)
# ---------------------------------------------------------------------------


def test_query_in_transit_qty_real_db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine, tables=[ShipmentSchedule.__table__, ShipmentScheduleItem.__table__])
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    db = SessionLocal()

    # 在途单 #1：2 个明细，数量 10 + 20 = 30
    s1 = ShipmentSchedule(
        project_id=1, country="US", project_name_snapshot="P1",
        shipment_no="SHIP-1", shipping_method="sea", shipment_status="in_transit",
    )
    db.add(s1)
    db.flush()
    db.add_all([
        ShipmentScheduleItem(shipment_schedule_id=s1.id, project_id=1, shipment_no="SHIP-1", sku="SKU-A", quantity=10),
        ShipmentScheduleItem(shipment_schedule_id=s1.id, project_id=1, shipment_no="SHIP-1", sku="SKU-B", quantity=20),
    ])
    # 在途单 #2：数量 5
    s2 = ShipmentSchedule(
        project_id=1, country="US", project_name_snapshot="P1",
        shipment_no="SHIP-2", shipping_method="sea", shipment_status="in_transit",
    )
    db.add(s2)
    db.flush()
    db.add(ShipmentScheduleItem(shipment_schedule_id=s2.id, project_id=1, shipment_no="SHIP-2", sku="SKU-C", quantity=5))
    # 非在途单（completed）：不应计入
    s3 = ShipmentSchedule(
        project_id=1, country="US", project_name_snapshot="P1",
        shipment_no="SHIP-3", shipping_method="sea", shipment_status="completed",
    )
    db.add(s3)
    db.flush()
    db.add(ShipmentScheduleItem(shipment_schedule_id=s3.id, project_id=1, shipment_no="SHIP-3", sku="SKU-D", quantity=999))
    db.commit()

    qty = report_builder_weekly._query_in_transit_qty(db, project_ids=[1], country="US")
    assert qty == 35  # 30 + 5, completed 不计入

    # 不同 country 不应被计入
    other = report_builder_weekly._query_in_transit_qty(db, project_ids=[1], country="DE")
    assert other == 0

    db.close()


# ---------------------------------------------------------------------------
# ad_ratio_all math (fake db)
# ---------------------------------------------------------------------------


def test_weekly_ads_comparison_ad_ratio_all():
    fake_db = _make_fake_db(_fake_ads_row(spend=100.0, sales=500.0))
    result = report_builder_weekly._get_ads_comparison(
        fake_db,
        project_ids=None,
        country="US",
        curr_start=date(2026, 7, 6), curr_end=date(2026, 7, 12),
        prev_start=date(2026, 6, 29), prev_end=date(2026, 7, 5),
        curr_sales_total=500.0,
        prev_sales_total=500.0,
    )
    ratio = result["ad_ratio_all"]
    assert ratio["current"] == 20.0  # 100 / 500 * 100
    assert ratio["prev"] == 20.0
    assert ratio["change"] == 0.0


def test_monthly_ads_comparison_ad_ratio_all():
    fake_db = _make_fake_db(_fake_ads_row(spend=100.0, sales=500.0))
    result = report_builder_monthly._get_ads_monthly_comparison(
        fake_db,
        project_ids=None,
        country="US",
        curr_start=date(2026, 7, 1), curr_end=date(2026, 7, 31),
        prev_start=date(2026, 6, 1), prev_end=date(2026, 6, 30),
        yoy_start=date(2025, 7, 1), yoy_end=date(2025, 7, 31),
        curr_sales_total=500.0,
        prev_sales_total=400.0,
        yoy_sales_total=250.0,
    )
    ratio = result["ad_ratio_all"]
    assert ratio["current"] == 20.0   # 100 / 500 * 100
    assert ratio["prev"] == 25.0     # 100 / 400 * 100
    assert ratio["yoy"] == 40.0      # 100 / 250 * 100
