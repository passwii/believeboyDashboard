"""BLF-565：daily-analysis 销售额口径同步欧洲含税（DE/UK 加回 item_tax + shipping_tax）。

背景：BLF-563 核查发现 daily-analysis 对所有国家统一按净额
（``item_price + shipping_price``）累加，``item_tax`` / ``shipping_tax`` 列根本未被
SELECT；BLF-564（Stage 1）落地公共函数 ``app/utils/sales_amount.sales_amount_value``
后，本文件验证 ``_load_sales_metrics`` 已复用该函数并覆盖 3 条聚合路径共用的公共函数。

覆盖（对齐 BLF-565 验收）：
- ``_load_sales_metrics``（单测）：DE/UK 含税（item+shipping+两税）、US 净额
  （税列存在也忽略），同一 (日期, SKU) 桶多行正确累加；
- ``build_daily_analysis``（服务级，单项目端点路径）：DE 含税、US 净额在输出行生效；
- 3 条聚合路径（``build_daily_analysis`` / ``build_daily_analysis_all_projects`` /
  ``build_daily_analysis_all_countries``）共用同一个 ``_load_sales_metrics``，
  改一处即全部生效（调用链用 CodeGraph callers 确认，BEL-93）。

种子金额（含运费口径，所有站点都含 shipping_price）：
- DE：10.00 + 2.50 运费 + 2.50 商品税 + 0.50 运费税 = 15.50；
      第二行 5.00 + 1.00 运费 + 0.95 商品税 + 0.05 运费税 = 7.00 → 桶合计 22.50。
- UK：20.00 + 3.00 运费 + 4.00 商品税 + 1.00 运费税 = 28.00。
- US：10.00 + 2.50 运费 = 12.50（故意塞非零税列，验证被忽略）。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project


def _seed_sales_row(
    db,
    *,
    project_id: int,
    source_file_id: int,
    country: str,
    day: date,
    sku: str,
    quantity: int = 1,
    item_price: Decimal = Decimal("0"),
    shipping_price: Decimal = Decimal("0"),
    item_tax: Decimal = Decimal("0"),
    shipping_tax: Decimal = Decimal("0"),
    row_no: int = 0,
) -> None:
    db.add(
        AnalysisSalesOrderRow(
            project_id=project_id,
            country=country,
            source_file_id=source_file_id,
            source_row_no=row_no,
            amazon_order_id=f"BLF565-{country}-{uuid.uuid4().hex[:8]}",
            purchase_at_utc=datetime.now(timezone.utc),
            purchase_at_pt=datetime.now(timezone.utc),
            purchase_date_pt=day,
            order_status="Shipped",
            sku=sku,
            asin=f"B{country}{row_no:06d}",
            quantity=quantity,
            item_price=item_price,
            shipping_price=shipping_price,
            item_tax=item_tax,
            shipping_tax=shipping_tax,
            currency="USD"
            if country == "US"
            else ("EUR" if country == "DE" else "GBP"),
            is_counted_sales=True,
            raw_row={"product_name": f"产品-{sku}"},
        )
    )


@pytest.fixture
def daily_vat_env():
    """临时项目 + US/DE/UK 三站点订单行（含税口径种子），测试后清理。"""
    suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf565-{suffix}",
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id

        today = date.today() - timedelta(days=10)
        for country, currency in (("US", "USD"), ("DE", "EUR"), ("UK", "GBP")):
            sf = AnalysisSourceFile(
                project_id=pid,
                country=country,
                report_type="sales_report",
                upload_file_id=f"blf565_sales_{pid}_{country}_{uuid.uuid4().hex[:6]}",
                upload_file_path="/tmp/blf565_sales.csv",
                original_filename="blf565_sales.csv",
                stored_filename="blf565_sales.csv",
                logical_filename="blf565_sales.csv",
                storage_key="blf565_sales.csv",
                period_start_date=today - timedelta(days=1),
                period_end_date=today,
                is_current=True,
                ingestion_status="success",
                created_by="pytest",
            )
            db.add(sf)
            db.flush()

            if country == "DE":
                # 同一 (日期, SKU) 两行 → 验证桶内累加。
                _seed_sales_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country="DE",
                    day=today,
                    sku="SKU-DE",
                    item_price=Decimal("10.00"),
                    shipping_price=Decimal("2.50"),
                    item_tax=Decimal("2.50"),
                    shipping_tax=Decimal("0.50"),
                    row_no=1,
                )
                _seed_sales_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country="DE",
                    day=today,
                    sku="SKU-DE",
                    item_price=Decimal("5.00"),
                    shipping_price=Decimal("1.00"),
                    item_tax=Decimal("0.95"),
                    shipping_tax=Decimal("0.05"),
                    row_no=2,
                )
            elif country == "UK":
                _seed_sales_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country="UK",
                    day=today,
                    sku="SKU-UK",
                    item_price=Decimal("20.00"),
                    shipping_price=Decimal("3.00"),
                    item_tax=Decimal("4.00"),
                    shipping_tax=Decimal("1.00"),
                    row_no=1,
                )
            else:
                # US 故意塞非零税列，验证净额口径忽略税。
                _seed_sales_row(
                    db,
                    project_id=pid,
                    source_file_id=sf.id,
                    country="US",
                    day=today,
                    sku="SKU-US",
                    item_price=Decimal("10.00"),
                    shipping_price=Decimal("2.50"),
                    item_tax=Decimal("1.00"),
                    shipping_tax=Decimal("0.50"),
                    row_no=1,
                )
        db.commit()
    finally:
        db.close()

    yield {"project_id": pid, "day": today}

    db = SessionLocal()
    try:
        db.execute(
            delete(AnalysisSalesOrderRow).where(AnalysisSalesOrderRow.project_id == pid)
        )
        db.execute(
            delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == pid)
        )
        obj = db.get(Project, pid)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


def _load_metrics(db, *, project_id: int, country: str, day: date) -> dict:
    """调用 _load_sales_metrics 并返回 {sku: bucket} 映射（供断言）。"""
    from app.services.daily.sales import _load_sales_metrics

    detail_buckets: dict[tuple[str, str], object] = {}
    _load_sales_metrics(
        db,
        detail_buckets=detail_buckets,
        project_id=project_id,
        country=country,
        start_date=day,
        end_date=day,
    )
    return {sku: bucket for (_date, sku), bucket in detail_buckets.items()}


# ─── _load_sales_metrics：DE/UK 含税、US 净额 ───────────────────────────


def test_load_sales_metrics_de_vat_inclusive(daily_vat_env, db_session) -> None:
    """DE：销售额 = item + shipping + item_tax + shipping_tax，桶内两行累加。"""
    buckets = _load_metrics(
        db_session,
        project_id=daily_vat_env["project_id"],
        country="DE",
        day=daily_vat_env["day"],
    )
    assert set(buckets) == {"SKU-DE"}
    # 10 + 2.5 + 2.5 + 0.5 = 15.5；5 + 1 + 0.95 + 0.05 = 7.0 → 22.5
    assert buckets["SKU-DE"].sales_amount == Decimal("22.50")
    assert buckets["SKU-DE"].order_qty == 2


def test_load_sales_metrics_uk_vat_inclusive(daily_vat_env, db_session) -> None:
    """UK：含税口径与 DE 一致（20 + 3 + 4 + 1 = 28）。"""
    buckets = _load_metrics(
        db_session,
        project_id=daily_vat_env["project_id"],
        country="UK",
        day=daily_vat_env["day"],
    )
    assert set(buckets) == {"SKU-UK"}
    assert buckets["SKU-UK"].sales_amount == Decimal("28.00")


def test_load_sales_metrics_us_net_ignores_taxes(daily_vat_env, db_session) -> None:
    """US：净额口径，税列存在也忽略（10 + 2.5 = 12.5）。"""
    buckets = _load_metrics(
        db_session,
        project_id=daily_vat_env["project_id"],
        country="US",
        day=daily_vat_env["day"],
    )
    assert set(buckets) == {"SKU-US"}
    assert buckets["SKU-US"].sales_amount == Decimal("12.50")


def test_load_sales_metrics_country_isolation(daily_vat_env, db_session) -> None:
    """国家过滤：DE 查询只装载 DE 行，不串入 US/UK。"""
    from app.services.daily.sales import _load_sales_metrics

    detail_buckets: dict[tuple[str, str], object] = {}
    dates, latest = _load_sales_metrics(
        db_session,
        detail_buckets=detail_buckets,
        project_id=daily_vat_env["project_id"],
        country="DE",
        start_date=daily_vat_env["day"],
        end_date=daily_vat_env["day"],
    )
    assert set(detail_buckets) == {(daily_vat_env["day"].isoformat(), "SKU-DE")}
    assert dates == {daily_vat_env["day"].isoformat()}
    assert latest == daily_vat_env["day"].isoformat()


# ─── build_daily_analysis（单项目端点路径）：DE 含税、US 净额 ──────────


def test_build_daily_analysis_de_vat_inclusive(daily_vat_env, db_session) -> None:
    """单项目 build_daily_analysis：DE 输出行销售额含税（22.5）。"""
    from app.services.daily.analysis import build_daily_analysis

    result = build_daily_analysis(
        db_session,
        project_id=daily_vat_env["project_id"],
        country="DE",
        start_date=daily_vat_env["day"].isoformat(),
        end_date=daily_vat_env["day"].isoformat(),
        no_cache=True,
    )
    assert len(result["detail_rows"]) == 1
    assert result["detail_rows"][0]["sku"] == "SKU-DE"
    assert result["detail_rows"][0]["sales_amount"] == 22.5
    assert len(result["summary_rows"]) == 1
    assert result["summary_rows"][0]["sales_amount"] == 22.5


def test_build_daily_analysis_us_net(daily_vat_env, db_session) -> None:
    """单项目 build_daily_analysis：US 输出行销售额保持净额（12.5）。"""
    from app.services.daily.analysis import build_daily_analysis

    result = build_daily_analysis(
        db_session,
        project_id=daily_vat_env["project_id"],
        country="US",
        start_date=daily_vat_env["day"].isoformat(),
        end_date=daily_vat_env["day"].isoformat(),
        no_cache=True,
    )
    assert len(result["detail_rows"]) == 1
    assert result["detail_rows"][0]["sku"] == "SKU-US"
    assert result["detail_rows"][0]["sales_amount"] == 12.5
    assert result["summary_rows"][0]["sales_amount"] == 12.5
