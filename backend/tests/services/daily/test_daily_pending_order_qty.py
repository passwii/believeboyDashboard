"""BLF-811：daily-analysis 响应补 pending_order_qty（窗口内待发货订单量）。

口径：``analysis_sales_order_rows`` 中 ``purchase_date_pt`` 在窗口内、
``is_counted_sales=True`` 且 ``order_status ∈ {Pending, Unshipped}`` 的行
``quantity`` 合计（Amazon 原始状态文本大小写不敏感）；是 ``order_qty``
（含 Shipped 已计数行）的子集。

覆盖：
- ``_load_sales_metrics``（单测）：同桶 Pending/Unshipped/Shipped 混合行，
  待发货只计前两者、状态匹配大小写不敏感；
- ``build_daily_analysis``：detail_rows / summary_rows 均带该字段；
- ``build_daily_analysis_all_projects``：跨项目全局合并与 project_breakdown；
- ``build_daily_analysis_all_countries``：USD 折算不吞非金额字段
  （country_breakdown 与全局行均保留）；
- schema 默认值：缺字段时 ``pending_order_qty=0``（兼容 Redis 旧缓存）。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
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
    order_status: str,
    quantity: int = 1,
    row_no: int = 0,
) -> None:
    db.add(
        AnalysisSalesOrderRow(
            project_id=project_id,
            country=country,
            source_file_id=source_file_id,
            source_row_no=row_no,
            amazon_order_id=f"BLF811-{country}-{uuid.uuid4().hex[:8]}",
            purchase_at_utc=datetime.now(timezone.utc),
            purchase_at_pt=datetime.now(timezone.utc),
            purchase_date_pt=day,
            order_status=order_status,
            sku=sku,
            asin=f"B{country}{row_no:06d}",
            quantity=quantity,
            item_price=Decimal("10.00"),
            shipping_price=Decimal("0"),
            item_tax=Decimal("0"),
            shipping_tax=Decimal("0"),
            currency="USD"
            if country == "US"
            else ("EUR" if country == "DE" else "GBP"),
            is_counted_sales=True,
            raw_row={"product_name": f"产品-{sku}"},
        )
    )


@pytest.fixture
def pending_env():
    """两个临时项目 + 混合状态订单行 + 当月 EUR/GBP 汇率，测试后清理。"""
    suffix = uuid.uuid4().hex[:8]
    day = date.today() - timedelta(days=10)
    year_month = f"{day.year:04d}-{day.month:02d}"
    db = SessionLocal()
    state: dict[str, object] = {"day": day}
    created_rate_ids: list[int] = []
    try:
        pids: list[int] = []
        for idx in (1, 2):
            project = Project(
                project_name=f"blf811-{suffix}-{idx}",
                project_operator="pytest",
                assistant_operator=None,
                sort_order=0,
                is_active=True,
            )
            db.add(project)
            db.commit()
            db.refresh(project)
            pids.append(project.id)

            sf = AnalysisSourceFile(
                project_id=project.id,
                country="US",
                report_type="sales_report",
                upload_file_id=(
                    f"blf811_sales_{project.id}_{uuid.uuid4().hex[:6]}"
                ),
                upload_file_path="/tmp/blf811_sales.csv",
                original_filename="blf811_sales.csv",
                stored_filename="blf811_sales.csv",
                logical_filename="blf811_sales.csv",
                storage_key="blf811_sales.csv",
                period_start_date=day - timedelta(days=1),
                period_end_date=day,
                is_current=True,
                ingestion_status="success",
                created_by="pytest",
            )
            db.add(sf)
            db.flush()
            state[f"sf_{idx}"] = sf.id

        pid1, pid2 = pids
        state["pids"] = pids

        # P1 / US / SKU-A：待发货 3+1（小写 pending 验证大小写不敏感）+2，
        # 已发货 5 只进 order_qty 不进 pending_order_qty。
        for row_no, (status, qty) in enumerate(
            [("Pending", 3), ("pending", 1), ("Unshipped", 2), ("Shipped", 5)],
            start=1,
        ):
            _seed_sales_row(
                db,
                project_id=pid1,
                source_file_id=state["sf_1"],
                country="US",
                day=day,
                sku="SKU-A",
                order_status=status,
                quantity=qty,
                row_no=row_no,
            )
        # P2 / US / SKU-D：跨项目合并用。
        _seed_sales_row(
            db,
            project_id=pid2,
            source_file_id=state["sf_2"],
            country="US",
            day=day,
            sku="SKU-D",
            order_status="Pending",
            quantity=7,
            row_no=1,
        )

        # all-countries 路径对 DE(EUR)/UK(GBP) 也要求当月汇率（无数据也要因子），
        # 且非 USD 折算需要同月 USD 行做分母；任一缺失即 422。
        # 已存在则复用、只清理自己新建的行。
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


# ─── _load_sales_metrics：桶级待发货拆分 ────────────────────────────────


def test_load_sales_metrics_pending_subset(pending_env, db_session) -> None:
    """pending_order_qty 只计 Pending/Unshipped（3+1+2=6），order_qty 含 Shipped（11）。"""
    from app.services.daily.sales import _load_sales_metrics

    detail_buckets: dict[tuple[str, str], object] = {}
    _load_sales_metrics(
        db_session,
        detail_buckets=detail_buckets,
        project_id=pending_env["pids"][0],
        country="US",
        start_date=pending_env["day"],
        end_date=pending_env["day"],
    )
    assert set(detail_buckets) == {(pending_env["day"].isoformat(), "SKU-A")}
    bucket = next(iter(detail_buckets.values()))
    assert bucket.order_qty == 11
    assert bucket.pending_order_qty == 6


# ─── build_daily_analysis：单项目端点路径 ───────────────────────────────


def test_build_daily_analysis_rows_carry_pending(pending_env, db_session) -> None:
    from app.services.daily.analysis import build_daily_analysis

    day_text = pending_env["day"].isoformat()
    result = build_daily_analysis(
        db_session,
        project_id=pending_env["pids"][0],
        country="US",
        start_date=day_text,
        end_date=day_text,
        no_cache=True,
    )
    assert len(result["detail_rows"]) == 1
    assert result["detail_rows"][0]["pending_order_qty"] == 6
    assert result["summary_rows"][0]["pending_order_qty"] == 6
    assert result["summary_rows"][0]["order_qty"] == 11


# ─── build_daily_analysis_all_projects：跨项目合并 ──────────────────────


def test_all_projects_merges_pending_across_projects(
    pending_env, db_session
) -> None:
    from app.services.daily.analysis import build_daily_analysis_all_projects

    day_text = pending_env["day"].isoformat()
    result = build_daily_analysis_all_projects(
        db_session,
        project_ids=list(pending_env["pids"]),
        country="US",
        start_date=day_text,
        end_date=day_text,
    )
    # 全局每日汇总：P1(6) + P2(7)
    assert result["summary_rows"][0]["pending_order_qty"] == 13
    by_sku = {row["sku"]: row for row in result["detail_rows"]}
    assert by_sku["SKU-A"]["pending_order_qty"] == 6
    assert by_sku["SKU-D"]["pending_order_qty"] == 7
    # 项目分桶同样携带（summary_rows 无 sku 键，按行首取）
    breakdown = {
        pid: block["summary_rows"][0]["pending_order_qty"]
        for pid, block in result["project_breakdown"].items()
    }
    assert breakdown[pending_env["pids"][0]] == 6
    assert breakdown[pending_env["pids"][1]] == 7


# ─── build_daily_analysis_all_countries：USD 折算不吞非金额字段 ──────────


def test_all_countries_keeps_pending_through_usd_conversion(
    pending_env, db_session
) -> None:
    from app.services.daily.analysis import build_daily_analysis_all_countries

    day_text = pending_env["day"].isoformat()
    result = build_daily_analysis_all_countries(
        db_session,
        project_id=pending_env["pids"][0],
        start_date=day_text,
        end_date=day_text,
    )
    assert result["currency"] == "USD"
    assert result["summary_rows"][0]["pending_order_qty"] == 6
    assert result["detail_rows"][0]["pending_order_qty"] == 6
    us_block = result["country_breakdown"]["US"]
    assert us_block["summary_rows"][0]["pending_order_qty"] == 6
    assert us_block["detail_rows"][0]["pending_order_qty"] == 6


# ─── schema 默认值：旧缓存载荷缺字段不炸 ────────────────────────────────


def test_summary_row_defaults_pending_to_zero() -> None:
    from app.schemas.daily_analysis import (
        DailyAnalysisDetailRow,
        DailyAnalysisSummaryRow,
    )

    summary = DailyAnalysisSummaryRow(
        date="2026-08-01",
        order_qty=3,
        sales_amount=12.5,
        impressions=0,
        clicks=0,
        cpc=0.0,
        ad_spend=0.0,
        ad_orders=0,
        available_qty=0,
    )
    detail = DailyAnalysisDetailRow(
        date="2026-08-01",
        sku="S",
        asin=None,
        order_qty=3,
        sales_amount=12.5,
        impressions=0,
        clicks=0,
        cpc=0.0,
        ad_spend=0.0,
        ad_orders=0,
        available_qty=0,
    )
    assert summary.pending_order_qty == 0
    assert detail.pending_order_qty == 0
