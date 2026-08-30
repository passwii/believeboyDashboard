"""BLF-913：全部项目 × 全部国家站点聚合（USD 基准）。

后端此前只有两条聚合路径：
- /daily-analysis/all           —— 全部项目 × 单一国家
- /daily-analysis/all-countries —— 单项目 × 全部国家（USD 折算）

「全部项目 × 全部站点」矩阵缺失，前端只能硬报错。本文件覆盖新补齐的
``build_daily_analysis_all_projects_countries``：
- 金额字段按当月 CNY 中转折算 USD（复用 _load_usd_factors_for_countries）
- project_breakdown（项目跨国家合并）与 country_breakdown（国家跨项目合并）
  两条分桶口径与既有端点一致
- 非金额字段（order_qty / pending_order_qty 等）跨项目跨国家直接相加
- 汇率缺失（连回退都没有）时整个请求 422
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import (
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    ExchangeRate,
    Project,
)

def _seed_sales_row(
    db,
    *,
    project_id: int,
    source_file_id: int,
    country: str,
    day: date,
    sku: str,
    quantity: int = 1,
    item_price: Decimal = Decimal(0),
    shipping_price: Decimal = Decimal(0),
    item_tax: Decimal = Decimal(0),
    shipping_tax: Decimal = Decimal(0),
    order_status: str = "Shipped",
    row_no: int = 0,
) -> None:
    db.add(
        AnalysisSalesOrderRow(
            project_id=project_id,
            country=country,
            source_file_id=source_file_id,
            source_row_no=row_no,
            amazon_order_id=f"BLF913-{country}-{uuid.uuid4().hex[:8]}",
            purchase_at_utc=datetime.now(UTC),
            purchase_at_pt=datetime.now(UTC),
            purchase_date_pt=day,
            order_status=order_status,
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
def matrix_env():
    """两个临时项目 × US/DE/UK 订单行 + 当月汇率，测试后清理。

    金额种子（与 test_daily_sales_vat 同口径：DE/UK 含税、US 净额）：
    - P1 US  SKU-913-US : 10 + 2.50 = 12.50 USD（税列故意非零，验证净额忽略）
    - P1 DE  SKU-913-DE : (10+2.5+2.5+0.5) + (5+1+0.95+0.05) = 15.5 + 7 = 22.5 EUR
    - P1 UK  SKU-913-UK : 20 + 3 + 4 + 1 = 28 GBP
    - P2 US  SKU-913-US : 10 + 2.50 = 12.50 USD（与 P1 同 SKU，验证跨项目求和）
    汇率：USD 7.2 / EUR 7.8 / GBP 9.1 → EUR→USD = 7.8/7.2, GBP→USD = 9.1/7.2
    """
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(UTC).date() - timedelta(days=10)
    year_month = f"{day.year:04d}-{day.month:02d}"
    db = SessionLocal()
    created_rate_ids: list[int] = []
    pids: list[int] = []
    try:
        for idx in (1, 2):
            project = Project(
                project_name=f"blf913-{suffix}-{idx}",
                project_operator="pytest",
                assistant_operator=None,
                sort_order=0,
                is_active=True,
            )
            db.add(project)
            db.commit()
            db.refresh(project)
            pids.append(project.id)

            # P1 三个国家都有数据；P2 只有 US。
            countries = ("US", "DE", "UK") if idx == 1 else ("US",)
            for country in countries:
                sf = AnalysisSourceFile(
                    project_id=project.id,
                    country=country,
                    report_type="sales_report",
                    upload_file_id=(
                        f"blf913_sales_{project.id}_{country}_{uuid.uuid4().hex[:6]}"
                    ),
                    upload_file_path="/tmp/blf913_sales.csv",
                    original_filename="blf913_sales.csv",
                    stored_filename="blf913_sales.csv",
                    logical_filename="blf913_sales.csv",
                    storage_key="blf913_sales.csv",
                    period_start_date=day - timedelta(days=1),
                    period_end_date=day,
                    is_current=True,
                    ingestion_status="success",
                    created_by="pytest",
                )
                db.add(sf)
                db.flush()

                if country == "US":
                    _seed_sales_row(
                        db,
                        project_id=project.id,
                        source_file_id=sf.id,
                        country="US",
                        day=day,
                        sku="SKU-913-US",
                        item_price=Decimal("10.00"),
                        shipping_price=Decimal("2.50"),
                        item_tax=Decimal("1.00"),
                        shipping_tax=Decimal("0.50"),
                        row_no=1,
                    )
                elif country == "DE":
                    _seed_sales_row(
                        db,
                        project_id=project.id,
                        source_file_id=sf.id,
                        country="DE",
                        day=day,
                        sku="SKU-913-DE",
                        item_price=Decimal("10.00"),
                        shipping_price=Decimal("2.50"),
                        item_tax=Decimal("2.50"),
                        shipping_tax=Decimal("0.50"),
                        row_no=1,
                    )
                    _seed_sales_row(
                        db,
                        project_id=project.id,
                        source_file_id=sf.id,
                        country="DE",
                        day=day,
                        sku="SKU-913-DE",
                        item_price=Decimal("5.00"),
                        shipping_price=Decimal("1.00"),
                        item_tax=Decimal("0.95"),
                        shipping_tax=Decimal("0.05"),
                        row_no=2,
                    )
                else:
                    _seed_sales_row(
                        db,
                        project_id=project.id,
                        source_file_id=sf.id,
                        country="UK",
                        day=day,
                        sku="SKU-913-UK",
                        item_price=Decimal("20.00"),
                        shipping_price=Decimal("3.00"),
                        item_tax=Decimal("4.00"),
                        shipping_tax=Decimal("1.00"),
                        order_status="Pending",
                        row_no=1,
                    )
        db.commit()
    finally:
        db.close()

    # 汇率单独一趟：已存在则复用、只清理自己新建的行。
    db = SessionLocal()
    try:
        for currency, rate in (
            ("USD", Decimal("7.2")),
            ("EUR", Decimal("7.8")),
            ("GBP", Decimal("9.1")),
        ):
            exists = db.execute(
                select(ExchangeRate.id).where(
                    ExchangeRate.currency == currency,
                    ExchangeRate.year_month == year_month,
                )
            ).scalar_one_or_none()
            if exists is None:
                row = ExchangeRate(
                    currency=currency,
                    year_month=year_month,
                    rate=rate,
                )
                db.add(row)
                db.flush()
                created_rate_ids.append(row.id)
        db.commit()
    finally:
        db.close()

    yield {"pids": pids, "day": day}

    db = SessionLocal()
    try:
        for pid in pids:
            db.execute(
                delete(AnalysisSalesOrderRow).where(
                    AnalysisSalesOrderRow.project_id == pid
                )
            )
            db.execute(
                delete(AnalysisSourceFile).where(
                    AnalysisSourceFile.project_id == pid
                )
            )
            obj = db.get(Project, pid)
            if obj is not None:
                db.delete(obj)
        for rate_id in created_rate_ids:
            obj = db.get(ExchangeRate, rate_id)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()
def test_all_projects_countries_usd_aggregation(matrix_env, db_session) -> None:
    """全局汇总 = P1(US 12.5 + DE 24.37 + UK 35.39) + P2 US 12.5 = 84.76。

    折算口径与 /all-countries 相同：DE/UK 金额按当月 source→CNY→USD 因子
    逐行（本测试里即每桶每行）折算后求和——
    DE 两行：15.5×(7.8/7.2)=16.79、7×(7.8/7.2)=7.58 → 24.37
    UK 单行：28×(9.1/7.2)=35.39
    全局 sales_amount = 12.5 + 24.37 + 35.39 + 12.5 = 84.76
    """
    from app.services.daily.analysis import build_daily_analysis_all_projects_countries

    day_text = matrix_env["day"].isoformat()
    result = build_daily_analysis_all_projects_countries(
        db_session,
        project_ids=list(matrix_env["pids"]),
        start_date=day_text,
        end_date=day_text,
    )

    assert result["currency"] == "USD"
    assert len(result["summary_rows"]) == 1
    assert result["summary_rows"][0]["sales_amount"] == pytest.approx(84.76)
    # 非金额字段：P1 US 1 + DE 2（两行同桶累加）+ UK 1（Pending 也进 order_qty）+ P2 US 1 = 5
    assert result["summary_rows"][0]["order_qty"] == 5
    # 只有 P1 UK 行是 Pending → pending_order_qty 跨项目跨国求和仍为 1
    assert result["summary_rows"][0]["pending_order_qty"] == 1


def test_all_projects_countries_project_breakdown(matrix_env, db_session) -> None:
    """project_breakdown：P1 = 三国合并（12.5+24.37+35.39=72.26），P2 = 仅 US 12.5。"""
    from app.services.daily.analysis import build_daily_analysis_all_projects_countries

    day_text = matrix_env["day"].isoformat()
    result = build_daily_analysis_all_projects_countries(
        db_session,
        project_ids=list(matrix_env["pids"]),
        start_date=day_text,
        end_date=day_text,
    )

    p1, p2 = matrix_env["pids"]
    assert set(result["project_breakdown"]) == {p1, p2}
    p1_block = result["project_breakdown"][p1]
    assert p1_block["project_name"].startswith("blf913-")
    assert p1_block["summary_rows"][0]["sales_amount"] == pytest.approx(72.26)
    p2_block = result["project_breakdown"][p2]
    assert p2_block["summary_rows"][0]["sales_amount"] == pytest.approx(12.5)


def test_all_projects_countries_country_breakdown(matrix_env, db_session) -> None:
    """country_breakdown：US = P1 12.5 + P2 12.5 = 25；DE = 24.37；UK = 35.39。

    US 分桶带 source_currency='USD'，DE='EUR'，UK='GBP'（原始币种对照）。
    """
    from app.services.daily.analysis import build_daily_analysis_all_projects_countries

    day_text = matrix_env["day"].isoformat()
    result = build_daily_analysis_all_projects_countries(
        db_session,
        project_ids=list(matrix_env["pids"]),
        start_date=day_text,
        end_date=day_text,
    )

    us_block = result["country_breakdown"]["US"]
    assert us_block["summary_rows"][0]["sales_amount"] == pytest.approx(25.0)
    assert us_block["currency"] == "USD"
    assert us_block["source_currency"] == "USD"

    de_block = result["country_breakdown"]["DE"]
    assert de_block["summary_rows"][0]["sales_amount"] == pytest.approx(24.37)
    assert de_block["currency"] == "USD"
    assert de_block["source_currency"] == "EUR"

    uk_block = result["country_breakdown"]["UK"]
    assert uk_block["summary_rows"][0]["sales_amount"] == pytest.approx(35.39)
    assert uk_block["source_currency"] == "GBP"

    # detail 行带 country 标记（与 all-countries 端点口径一致）
    assert us_block["detail_rows"][0]["country"] == "US"
    # UK 的 Pending 行跨国保留
    assert uk_block["detail_rows"][0]["pending_order_qty"] == 1


def test_all_projects_countries_breakdown_sums_match_global(
    matrix_env, db_session
) -> None:
    """一致性：project_breakdown 之和 == country_breakdown 之和 == 全局。"""
    from app.services.daily.analysis import build_daily_analysis_all_projects_countries

    day_text = matrix_env["day"].isoformat()
    result = build_daily_analysis_all_projects_countries(
        db_session,
        project_ids=list(matrix_env["pids"]),
        start_date=day_text,
        end_date=day_text,
    )

    project_total = sum(
        block["summary_rows"][0]["sales_amount"]
        for block in result["project_breakdown"].values()
    )
    country_total = sum(
        block["summary_rows"][0]["sales_amount"]
        for block in result["country_breakdown"].values()
    )
    global_total = result["summary_rows"][0]["sales_amount"]
    assert project_total == pytest.approx(global_total)
    assert country_total == pytest.approx(global_total)


def test_all_projects_countries_rejects_invalid_range(matrix_env, db_session) -> None:
    """start > end → 422（与既有两条聚合路径同款校验）。"""
    from app.services.daily.analysis import build_daily_analysis_all_projects_countries

    day_text = matrix_env["day"].isoformat()
    with pytest.raises(HTTPException) as exc_info:
        build_daily_analysis_all_projects_countries(
            db_session,
            project_ids=list(matrix_env["pids"]),
            start_date=day_text,
            end_date="2020-01-01",
        )
    assert exc_info.value.status_code == 422
