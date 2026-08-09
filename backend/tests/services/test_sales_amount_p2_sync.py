"""BLF-567：P2 销售口径同步测试。

覆盖三处从「仅 item_price」切换为公共函数 ``sales_amount_expr``（BLF-564）
的语义验证：

- 项目目标 ``project_goal_service._query_monthly_sales/_query_annual_sales``：
  月 / 年度销售额 DE/UK 含税（item+shipping+tax）、US 净额（item+shipping）；
- AI 洞察 ``ai_insight_aggregator._aggregate_sales_by_date_sql/_get_top_skus_sql``：
  销售趋势 / Top SKU 的 sales_amount 同样含运费（+DE/UK 含税）；
- 退货分析 ``return_analysis.analysis._build_sales_aggregates``：
  同期销售额 amount 口径变更；并锁定 **退货率分母是件数（quantity）而非金额**，
  金额口径变化不影响 ``overall_return_rate`` 数值（issue 描述需修正的点）。

运行于真实 Postgres 测试库（conftest 的 ``db_session``）。每个用例用唯一
project_id 且 is_active=False，teardown 按 project_id 清理子表。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models import AnalysisReturnRow, AnalysisSalesOrderRow, AnalysisSourceFile
from app.models.project import Project


def _unique_project_name() -> str:
    return f"BLF567-TEST-{uuid.uuid4().hex[:10]}"


@pytest.fixture()
def test_project(db_session):
    """创建 inactive 测试项目，teardown 时按 project_id 清理所有子表。"""
    project = Project(
        project_name=_unique_project_name(),
        sort_order=0,
        # 测试项目在生产库里必须 inactive；泄漏到下拉的兜底防线
        is_active=False,
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id
    try:
        yield pid
    finally:
        # 先 expire_all 再删，避免 ORM 会话残留对象干扰
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM analysis_return_rows WHERE project_id = :pid"),
            {"pid": pid},
        )
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


def _seed_sales_source_file(
    db_session,
    *,
    project_id: int,
    country: str,
    day: date,
    report_type: str = "sales_report",
) -> int:
    """创建 source_file（sales/return），返回 id。"""
    sf = AnalysisSourceFile(
        project_id=project_id,
        country=country,
        report_type=report_type,
        upload_file_id=f"blf567-{uuid.uuid4().hex[:8]}",
        upload_file_path="/tmp/blf567.csv",
        original_filename="blf567.csv",
        stored_filename="blf567.csv",
        logical_filename="blf567.csv",
        storage_key="blf567.csv",
        period_start_date=day,
        period_end_date=day,
        report_date=day,
        is_current=True,
    )
    db_session.add(sf)
    db_session.commit()
    db_session.refresh(sf)
    return sf.id


def _seed_sales_rows(
    db_session,
    *,
    project_id: int,
    country: str,
    day: date,
    rows: list[dict],
) -> None:
    """写入 sales order 行（source_file 一并创建）。"""
    sf_id = _seed_sales_source_file(
        db_session, project_id=project_id, country=country, day=day
    )
    for i, r in enumerate(rows):
        db_session.add(
            AnalysisSalesOrderRow(
                project_id=project_id,
                country=country,
                source_file_id=sf_id,
                source_row_no=i + 1,
                amazon_order_id=r["order_id"],
                purchase_at_utc=datetime(day.year, day.month, day.day, 12, 0, 0),
                purchase_at_pt=datetime(day.year, day.month, day.day, 12, 0, 0),
                purchase_date_pt=day,
                order_status="Shipped",
                sku=r["sku"],
                asin=r.get("asin", f"B{r['order_id']}"),
                quantity=r["quantity"],
                item_price=r["item_price"],
                shipping_price=r["shipping_price"],
                item_tax=r.get("item_tax", 0),
                shipping_tax=r.get("shipping_tax", 0),
                is_counted_sales=True,
            )
        )
    db_session.commit()


def _seed_return_rows(
    db_session,
    *,
    project_id: int,
    country: str,
    day: date,
    rows: list[dict],
) -> None:
    """写入 return 行（source_file 一并创建）。"""
    sf_id = _seed_sales_source_file(
        db_session,
        project_id=project_id,
        country=country,
        day=day,
        report_type="return_report",
    )
    for i, r in enumerate(rows):
        db_session.add(
            AnalysisReturnRow(
                project_id=project_id,
                country=country,
                source_file_id=sf_id,
                source_row_no=i + 1,
                return_date=day,
                order_id=r["order_id"],
                sku=r["sku"],
                asin=r.get("asin", f"B{r['order_id']}"),
                product_name=r.get("product_name"),
                quantity=r["quantity"],
                fulfillment_center_id="FC1",
                detailed_disposition="SELLABLE",
                reason="NOT_AS_DESCRIBED",
                status="PROCESSED",
                license_plate_number=f"LP-{i}",
                original_return_datetime=f"{day.isoformat()}T10:00:00+00:00",
            )
        )
    db_session.commit()


# 口径样例：item 10 + shipping 2；DE/UK 加 item_tax 1.9 + shipping_tax 0.38 → 14.28；
# US 无税列 → 12.00。
_DE_ROW = {
    "item_price": 10,
    "shipping_price": 2,
    "item_tax": 1.9,
    "shipping_tax": 0.38,
}
_US_ROW = {"item_price": 10, "shipping_price": 2}


# ─── 退货分析 _build_sales_aggregates（含 build_return_analysis 集成）──────────


def test_build_sales_aggregates_de_includes_tax(db_session, test_project) -> None:
    """DE：amount = item + shipping + item_tax + shipping_tax。"""
    from app.services.analysis.return_analysis.analysis import _build_sales_aggregates

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[{"order_id": "DE-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW}],
    )
    sku_sales, date_sales = _build_sales_aggregates(
        db_session, test_project, "DE", "2026-07-01", "2026-07-01"
    )
    assert sku_sales["SKU-A"]["quantity"] == 1
    assert sku_sales["SKU-A"]["amount"] == pytest.approx(14.28)
    assert date_sales["2026-07-01"]["amount"] == pytest.approx(14.28)


def test_build_sales_aggregates_uk_includes_tax(db_session, test_project) -> None:
    """UK：同样含税（与 DE 同一口径分支）。"""
    from app.services.analysis.return_analysis.analysis import _build_sales_aggregates

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="UK",
        day=day,
        rows=[{"order_id": "UK-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW}],
    )
    sku_sales, _ = _build_sales_aggregates(
        db_session, test_project, "UK", "2026-07-01", "2026-07-01"
    )
    assert sku_sales["SKU-A"]["amount"] == pytest.approx(14.28)


def test_build_sales_aggregates_us_net_excludes_tax(db_session, test_project) -> None:
    """US：amount = item + shipping（忽略税列）。"""
    from app.services.analysis.return_analysis.analysis import _build_sales_aggregates

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="US",
        day=day,
        rows=[{"order_id": "US-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW}],
    )
    sku_sales, date_sales = _build_sales_aggregates(
        db_session, test_project, "US", "2026-07-01", "2026-07-01"
    )
    # 即便报表带税列，US 口径也只取净额（item + shipping）
    assert sku_sales["SKU-A"]["amount"] == pytest.approx(12.0)
    assert date_sales["2026-07-01"]["amount"] == pytest.approx(12.0)


def test_build_return_analysis_amount_inclusive_but_rate_quantity_based(
    db_session, test_project
) -> None:
    """集成：退货分析金额含税、运费，但退货率分母是件数 → 数值不受金额口径影响。"""
    from app.services.analysis.return_analysis.analysis import build_return_analysis

    day = date(2026, 7, 1)
    # 卖出 2 件（2 行，各 1 件，DE 含税）
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[
            {"order_id": "DE-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
            {"order_id": "DE-2", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
        ],
    )
    # 退货 2 件（2 行，各 1 件）
    _seed_return_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[
            {"order_id": "DE-1", "sku": "SKU-A", "quantity": 1},
            {"order_id": "DE-2", "sku": "SKU-A", "quantity": 1},
        ],
    )
    resp = build_return_analysis(
        db_session,
        project_id=test_project,
        country="DE",
        start_date="2026-07-01",
        end_date="2026-07-01",
    )
    assert resp.summary.total_sales_quantity == 2
    # 金额 = 2 行 × 14.28（含税 + 运费）
    assert resp.summary.total_sales_amount == pytest.approx(28.56)
    # 退货率 = 退货件数 2 / 销售件数 2 = 100%：分母是件数，与金额口径无关
    assert resp.summary.overall_return_rate == pytest.approx(100.0)


# ─── 项目目标 _query_monthly_sales / _query_annual_sales ─────────────────────


def test_query_monthly_sales_de_includes_shipping_and_tax(
    db_session, test_project
) -> None:
    """项目目标月销售额：DE 含税 + 运费。"""
    from app.services.project_goal_service import _query_monthly_sales

    day = date(2026, 7, 15)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[{"order_id": "DE-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW}],
    )
    total = _query_monthly_sales(db_session, test_project, "DE", 2026, 7)
    assert float(total) == pytest.approx(14.28)


def test_query_monthly_sales_us_net(db_session, test_project) -> None:
    """项目目标月销售额：US 净额（item + shipping）。"""
    from app.services.project_goal_service import _query_monthly_sales

    day = date(2026, 7, 15)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="US",
        day=day,
        rows=[{"order_id": "US-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW}],
    )
    total = _query_monthly_sales(db_session, test_project, "US", 2026, 7)
    assert total == pytest.approx(12.0)


def test_query_annual_sales_de_includes_shipping_and_tax(
    db_session, test_project
) -> None:
    """项目目标年销售额：DE 含税 + 运费。"""
    from app.services.project_goal_service import _query_annual_sales

    day = date(2026, 7, 15)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[
            {"order_id": "DE-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
            {"order_id": "DE-2", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
        ],
    )
    total = _query_annual_sales(db_session, test_project, "DE", 2026)
    assert float(total) == pytest.approx(28.56)


def test_query_annual_sales_us_net(db_session, test_project) -> None:
    """项目目标年销售额：US 净额。"""
    from app.services.project_goal_service import _query_annual_sales

    day = date(2026, 7, 15)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="US",
        day=day,
        rows=[
            {"order_id": "US-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
            {"order_id": "US-2", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
        ],
    )
    total = _query_annual_sales(db_session, test_project, "US", 2026)
    assert total == pytest.approx(24.0)


# ─── AI 洞察 _aggregate_sales_by_date_sql / _get_top_skus_sql ────────────────


def test_aggregate_sales_by_date_sql_de_includes_tax(db_session, test_project) -> None:
    """AI 洞察销售趋势：DE 日聚合 sales_amount 含税 + 运费。"""
    from app.services.ai_insight_aggregator import _aggregate_sales_by_date_sql

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[
            {"order_id": "DE-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
            {"order_id": "DE-2", "sku": "SKU-B", "quantity": 2, **_DE_ROW},
        ],
    )
    result, _ = _aggregate_sales_by_date_sql(
        SessionLocal, test_project, "DE", day, day, step="test", progress_cb=None
    )
    assert len(result) == 1
    # 行1 = 14.28，行2 = 14.28（按行表达式，quantity 不计入金额）→ 28.56
    assert result[0]["sales_amount"] == pytest.approx(28.56)
    assert result[0]["order_qty"] == 3


def test_aggregate_sales_by_date_sql_us_net(db_session, test_project) -> None:
    """AI 洞察销售趋势：US 日聚合 sales_amount 为净额。"""
    from app.services.ai_insight_aggregator import _aggregate_sales_by_date_sql

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="US",
        day=day,
        rows=[
            {"order_id": "US-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW},
            {"order_id": "US-2", "sku": "SKU-B", "quantity": 1, **_DE_ROW},
        ],
    )
    result, _ = _aggregate_sales_by_date_sql(
        SessionLocal, test_project, "US", day, day, step="test", progress_cb=None
    )
    assert len(result) == 1
    assert result[0]["sales_amount"] == pytest.approx(24.0)


def test_get_top_skus_sql_de_includes_tax_and_orders_by_inclusive(
    db_session, test_project
) -> None:
    """AI 洞察 Top SKU：DE sales_amount 含税 + 运费，且按含税金额排序。"""
    from app.services.ai_insight_aggregator import _get_top_skus_sql

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="DE",
        day=day,
        rows=[
            {"order_id": "DE-1", "sku": "SKU-BIG", "quantity": 1, **_DE_ROW},
            {"order_id": "DE-2", "sku": "SKU-SMALL", "quantity": 1, **_US_ROW},
        ],
    )
    top = _get_top_skus_sql(
        SessionLocal, test_project, "DE", day, day, step="test", progress_cb=None
    )
    by_sku = {r["sku"]: r for r in top}
    assert by_sku["SKU-BIG"]["sales_amount"] == pytest.approx(14.28)
    assert by_sku["SKU-SMALL"]["sales_amount"] == pytest.approx(12.0)
    # 含税金额更高者排前面
    assert top[0]["sku"] == "SKU-BIG"


def test_get_top_skus_sql_us_net(db_session, test_project) -> None:
    """AI 洞察 Top SKU：US sales_amount 为净额。"""
    from app.services.ai_insight_aggregator import _get_top_skus_sql

    day = date(2026, 7, 1)
    _seed_sales_rows(
        db_session,
        project_id=test_project,
        country="US",
        day=day,
        rows=[{"order_id": "US-1", "sku": "SKU-A", "quantity": 1, **_DE_ROW}],
    )
    top = _get_top_skus_sql(
        SessionLocal, test_project, "US", day, day, step="test", progress_cb=None
    )
    assert len(top) == 1
    assert top[0]["sales_amount"] == pytest.approx(12.0)
