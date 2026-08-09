"""BLF-566: Agent 订单明细 list 模式 —— ``query_orders_summary`` 聚合口径对齐。

历史口径：``total_sales_amount = Σ(item_price × quantity)``（连 shipping 都不含，
且与自身 grouped 模式 / 定时报表不一致——漂移最严重，BLF-563 核查 P1 项）。

修正后（spec §5.2 显式选择，与 ``query_orders_summary_grouped`` 一致）：
逐行 ``sales_amount_value(country, item+shipping(+tax))``，**不乘 quantity**。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project
from app.services.external.orders_summary import query_orders_summary


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
                purchase_date_pt=r.get("day", today),
                order_status=r.get("status", "Shipped"),
                sku=r["sku"],
                asin=r["asin"],
                quantity=r.get("quantity", 1),
                item_price=r["item_price"],
                shipping_price=r.get("shipping_price", Decimal("0")),
                item_tax=r.get("item_tax", Decimal("0")),
                shipping_tax=r.get("shipping_tax", Decimal("0")),
                currency=currency,
                is_counted_sales=r.get("counted", True),
                raw_row={"fulfillment-channel": r.get("channel", "Amazon")},
            )
        )
    db.flush()


@pytest.fixture
def env(db_session: Session) -> dict:
    proj = Project(
        project_name=f"blf566-list-{uuid.uuid4().hex[:8]}",
        project_operator="pytest",
        assistant_operator=None,
        sort_order=0,
        is_active=True,
    )
    db_session.add(proj)
    db_session.flush()
    pid = proj.id

    # US：2 行（qty=2 @10 + shipping 5 / qty=1 @8）。旧口径 = 10×2+8×1=28；
    # 新口径（不乘 qty、含 shipping）= 15 + 8 = 23。
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
                "quantity": 2,
                "item_price": Decimal("10.00"),
                "shipping_price": Decimal("5.00"),
            },
            {
                "order_id": "US-2",
                "sku": "SKU-B",
                "asin": "ASIN-B",
                "quantity": 1,
                "item_price": Decimal("8.00"),
            },
        ],
    )
    # DE：1 行（qty=3 @10 + shipping 2 + tax 3）。旧口径 = 10×3=30；新口径 = 15。
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
                "quantity": 3,
                "item_price": Decimal("10.00"),
                "shipping_price": Decimal("2.00"),
                "item_tax": Decimal("2.50"),
                "shipping_tax": Decimal("0.50"),
            }
        ],
    )
    return {
        "project_id": pid,
        "date_from": date.today() - timedelta(days=1),
        "date_to": date.today(),
    }


def test_us_list_aggregate_net_includes_shipping_no_qty(db_session, env):
    """US：净额含运费、不乘 qty —— 15 + 8 = 23.0（旧口径 28.0）。"""
    rows, agg = query_orders_summary(
        db_session,
        project_id=env["project_id"],
        country="US",
        date_from=env["date_from"],
        date_to=env["date_to"],
    )
    assert len(rows) == 2
    assert agg["total_orders"] == 2
    assert agg["total_quantity"] == 3
    assert agg["total_sales_amount"] == 23.0
    assert agg["currency"] == "USD"


def test_de_list_aggregate_tax_inclusive(db_session, env):
    """DE：含税含运费 —— item+shipping+item_tax+shipping_tax = 15.0（旧口径 30.0）。"""
    rows, agg = query_orders_summary(
        db_session,
        project_id=env["project_id"],
        country="DE",
        date_from=env["date_from"],
        date_to=env["date_to"],
    )
    assert len(rows) == 1
    assert agg["total_orders"] == 1
    assert agg["total_quantity"] == 3
    assert agg["total_sales_amount"] == 15.0
    assert agg["currency"] == "EUR"


def test_cancelled_rows_excluded_from_aggregate(db_session, env):
    """已取消订单不计入 total_sales_amount（既有过滤行为保持）。"""
    us_sf_id = (
        db_session.query(AnalysisSourceFile.id)
        .filter_by(project_id=env["project_id"], country="US")
        .one()[0]
    )
    db_session.add(
        AnalysisSalesOrderRow(
            project_id=env["project_id"],
            country="US",
            source_file_id=us_sf_id,
            source_row_no=99,
            amazon_order_id="US-CANCEL",
            purchase_at_utc=datetime.now(timezone.utc),
            purchase_at_pt=datetime.now(timezone.utc),
            purchase_date_pt=date.today(),
            order_status="Cancelled",
            sku="SKU-X",
            asin="ASIN-X",
            quantity=1,
            item_price=Decimal("999.00"),
            shipping_price=Decimal("0"),
            currency="USD",
            is_counted_sales=True,
            raw_row={"fulfillment-channel": "Amazon"},
        )
    )
    db_session.flush()
    rows, agg = query_orders_summary(
        db_session,
        project_id=env["project_id"],
        country="US",
        date_from=env["date_from"],
        date_to=env["date_to"],
        include_cancelled=False,
    )
    assert len(rows) == 2
    assert agg["total_sales_amount"] == 23.0
