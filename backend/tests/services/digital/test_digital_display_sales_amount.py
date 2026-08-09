"""BLF-566: 数字大屏销售额口径 —— ``_build_sales_snapshot`` 复用 ``sales_amount_expr``。

口径（与定时报表/daily-analysis 统一）：DE/UK 含税（item+shipping+item_tax+
shipping_tax），其余站点净额（item+shipping），所有站点含运费。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project
from app.services.digital_display_service import _build_sales_snapshot


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
                raw_row={"fulfillment-channel": "Amazon"},
            )
        )
    db.flush()


@pytest.fixture
def project_with_rows(db_session: Session) -> dict:
    """US + DE 双站点订单行：US 净额、DE 含税（行值与口径锚定在断言里）。"""
    proj = Project(
        project_name=f"blf566-digital-{uuid.uuid4().hex[:8]}",
        project_operator="pytest",
        assistant_operator=None,
        sort_order=0,
        is_active=True,
    )
    db_session.add(proj)
    db_session.flush()
    pid = proj.id

    _seed_sales_rows(
        db_session,
        project_id=pid,
        country="US",
        currency="USD",
        rows=[
            {
                "order_id": "US-1",
                "sku": "SKU-US",
                "asin": "ASIN-US",
                "item_price": Decimal("100.00"),
                "shipping_price": Decimal("5.00"),
            }
        ],
    )
    _seed_sales_rows(
        db_session,
        project_id=pid,
        country="DE",
        currency="EUR",
        rows=[
            {
                "order_id": "DE-1",
                "sku": "SKU-DE",
                "asin": "ASIN-DE",
                "item_price": Decimal("100.00"),
                "shipping_price": Decimal("5.00"),
                "item_tax": Decimal("19.00"),
                "shipping_tax": Decimal("0.50"),
            }
        ],
    )
    return {"project_id": pid}


def test_us_sales_amount_is_net_with_shipping(db_session, project_with_rows):
    """US：净额含运费 —— item+shipping = 105.00（不含税）。"""
    snap = _build_sales_snapshot(
        db_session, project_with_rows["project_id"], "US", date.today(), 7
    )
    assert snap["today_sales_amount"] == 105.0
    assert snap["today_order_qty"] == 1
    # 7 日趋势最后一天即今日，金额同口径。
    assert snap["trend"][-1]["sales_amount"] == 105.0


def test_de_sales_amount_is_tax_inclusive(db_session, project_with_rows):
    """DE：含税含运费 —— item+shipping+item_tax+shipping_tax = 124.50。"""
    snap = _build_sales_snapshot(
        db_session, project_with_rows["project_id"], "DE", date.today(), 7
    )
    assert snap["today_sales_amount"] == 124.5
    assert snap["trend"][-1]["sales_amount"] == 124.5


def test_cancelled_rows_excluded(db_session, project_with_rows):
    """已取消订单不计入销售额（counted_sales_where 过滤，口径不变）。"""
    db_session.add(
        AnalysisSalesOrderRow(
            project_id=project_with_rows["project_id"],
            country="US",
            source_file_id=db_session.query(AnalysisSourceFile)
            .filter_by(project_id=project_with_rows["project_id"], country="US")
            .one()
            .id,
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
    snap = _build_sales_snapshot(
        db_session, project_with_rows["project_id"], "US", date.today(), 7
    )
    assert snap["today_sales_amount"] == 105.0
