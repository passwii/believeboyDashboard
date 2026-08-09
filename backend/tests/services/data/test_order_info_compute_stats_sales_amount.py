"""BLF-566: 订单统计 ``compute_stats.total_amount`` 口径 —— ``sales_amount_expr_by_row``。

多国家筛选（``countries`` 列表）下按行 country 决定含税与否：
DE/UK 含税（item+shipping+item_tax+shipping_tax），其余站点净额（item+shipping），
均含运费。与定时报表 / 数字大屏 / Agent 订单统一（公共函数 sales_amount.py）。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project
from app.services.data import order_info_service as svc


def _seed_sales_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    currency: str,
    rows: list[dict],
) -> None:
    sf = AnalysisSourceFile(
        project_id=project_id,
        country=country,
        report_type="sales_report",
        upload_file_id=f"blf566_{country}_{uuid.uuid4().hex[:6]}",
        upload_file_path="/tmp/blf566.csv",
        original_filename="blf566.csv",
        stored_filename="blf566.csv",
        logical_filename="blf566.csv",
        storage_key="blf566.csv",
        period_start_date=date.today() - timedelta(days=30),
        period_end_date=date.today(),
        is_current=True,
        ingestion_status="success",
        created_by="pytest",
    )
    db.add(sf)
    db.flush()
    today = date.today()
    for i, r in enumerate(rows, start=1):
        db.add(
            AnalysisSalesOrderRow(
                project_id=project_id,
                country=country,
                source_file_id=sf.id,
                source_row_no=i,
                amazon_order_id=r["order_id"],
                purchase_at_utc=datetime.now(timezone.utc),
                purchase_at_pt=datetime.now(timezone.utc),
                purchase_date_pt=today,
                order_status="Shipped",
                sku=r["sku"],
                asin=r["asin"],
                quantity=r.get("quantity", 1),
                item_price=r["item_price"],
                shipping_price=r.get("shipping_price", Decimal("0")),
                item_tax=r.get("item_tax", Decimal("0")),
                shipping_tax=r.get("shipping_tax", Decimal("0")),
                currency=currency,
                is_counted_sales=True,
                raw_row={"fulfillment-channel": r.get("channel", "Amazon")},
            )
        )
    db.flush()


@pytest.fixture
def env(db_session: Session) -> dict:
    proj = Project(
        project_name=f"blf566-stats-{uuid.uuid4().hex[:8]}",
        project_operator="pytest",
        assistant_operator=None,
        sort_order=0,
        is_active=True,
    )
    db_session.add(proj)
    db_session.flush()
    pid = proj.id

    # US：105 + 50 = 155（净额含运费）。
    _seed_sales_rows(
        db_session,
        project_id=pid,
        country="US",
        currency="USD",
        rows=[
            {
                "order_id": "US-1",
                "sku": "SKU-A",
                "asin": "ASIN-A",
                "item_price": Decimal("100.00"),
                "shipping_price": Decimal("5.00"),
            },
            {
                "order_id": "US-2",
                "sku": "SKU-B",
                "asin": "ASIN-B",
                "item_price": Decimal("50.00"),
            },
        ],
    )
    # DE：100+5+19+0.5 = 124.5（含税含运费）。
    _seed_sales_rows(
        db_session,
        project_id=pid,
        country="DE",
        currency="EUR",
        rows=[
            {
                "order_id": "DE-1",
                "sku": "SKU-A",
                "asin": "ASIN-A",
                "item_price": Decimal("100.00"),
                "shipping_price": Decimal("5.00"),
                "item_tax": Decimal("19.00"),
                "shipping_tax": Decimal("0.50"),
            }
        ],
    )
    return {"project_id": pid}


def test_stats_us_filter_net(db_session, env):
    """US 筛选：净额含运费 —— 155.0。"""
    result = svc.compute_stats(
        db_session,
        project_ids=[env["project_id"]],
        countries=["US"],
        operator="pytest",
        is_admin=True,
    )
    assert result.total_amount == 155.0


def test_stats_de_filter_tax_inclusive(db_session, env):
    """DE 筛选：含税含运费 —— 124.5。"""
    result = svc.compute_stats(
        db_session,
        project_ids=[env["project_id"]],
        countries=["DE"],
        operator="pytest",
        is_admin=True,
    )
    assert result.total_amount == 124.5


def test_stats_multi_country_by_row_case(db_session, env):
    """多国家筛选：按行 CASE —— US 净额 + DE 含税 = 279.5（不混口径）。"""
    result = svc.compute_stats(
        db_session,
        project_ids=[env["project_id"]],
        countries=["US", "DE"],
        operator="pytest",
        is_admin=True,
    )
    assert result.total_amount == 279.5
