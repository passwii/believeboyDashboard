"""BLF-806 回归：R2 窗口销量分母必须覆盖「无退货的销售日」。

生产常态分布是「销售分散在窗口多日、退货集中在少数几日」，而聚合表
只为「有退货的 SKU×日」写行（``_refresh_one_day`` 跳过无退货的日子，
且只写退货 SKU）。因此任何基于聚合表行的销量求和都无法还原完整窗口
销量，BLF-806 已出现过的两种缺陷形态：

- ``max(cumulative)``：分母变全历史累计（虚增 ~27 倍）；
- ``Σ daily``：分母只剩退货日当天的销量（缩水 ~21 倍，实证覆盖率 4.8%）。

现在分母一律取 raw 销售层同窗口 per-SKU counted sales（与 R1 overview
的 ``_build_sales_aggregates`` 同源）。本文件用「销售分散 d1~d3、退货
仅 d1」的最小反例把该缺陷锁死。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.celery_tasks.return_analysis_refresh import _refresh_one_day
from app.models import (
    AnalysisReturnAggregate,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    Project,
)

D1, D2, D3 = date(2026, 6, 10), date(2026, 6, 11), date(2026, 6, 12)


@pytest.fixture()
def sparse_return_project(db_session):
    """销售分散 3 天、退货仅 1 天的项目；聚合行只刷退货日 d1（生产常态）."""
    project = Project(
        project_name=f"BLF-806 sparse-return {D1.isoformat()}",
        sort_order=0,
        is_active=False,  # 测试项目永远 inactive，防止污染生产下拉
    )
    db_session.add(project)
    db_session.commit()
    db_session.refresh(project)
    pid = project.id

    sf = AnalysisSourceFile(
        report_type="return_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BLF806-ret-{pid}",
        upload_file_path=f"return_report/{pid}/test.csv",
        original_filename="return_report.csv",
        stored_filename="return_report.csv",
        logical_filename="return_report.csv",
        storage_key=f"return_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=D1,
        period_end_date=D1,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db_session.add(sf)
    sf_sales = AnalysisSourceFile(
        report_type="sales_report",
        is_current=True,
        project_id=pid,
        country="US",
        upload_file_id=f"BLF806-sales-{pid}",
        upload_file_path=f"sales_report/{pid}/test.csv",
        original_filename="sales_report.csv",
        stored_filename="sales_report.csv",
        logical_filename="sales_report.csv",
        storage_key=f"sales_report/{pid}/test.csv",
        file_size_bytes=1024,
        file_sha256="deadbeef",
        period_start_date=D1,
        period_end_date=D3,
        snapshot_at=None,
        version=1,
        ingestion_status="success",
    )
    db_session.add(sf_sales)
    db_session.flush()

    _pt = timezone(timedelta(hours=-7))

    def _sale(order_id: str, d: date, qty: int, status: str = "Shipped") -> None:
        _d_utc = datetime(d.year, d.month, d.day, 12, 0, 0, tzinfo=timezone.utc)
        db_session.add(
            AnalysisSalesOrderRow(
                project_id=pid,
                country="US",
                source_file_id=sf_sales.id,
                source_row_no=len(order_id) + d.day,  # 任意唯一即可
                amazon_order_id=order_id,
                purchase_at_utc=_d_utc,
                purchase_at_pt=_d_utc.astimezone(_pt).replace(tzinfo=None),
                purchase_date_pt=d,
                sku="SKU-WIN",
                quantity=qty,
                is_counted_sales=True,
                order_status=status,
            )
        )

    # 销售分散在 d1/d2/d3：10 + 20 + 40 = 70 counted；d3 另有 Cancelled 5 不计入
    _sale("WIN-O1", D1, 10)
    _sale("WIN-O2", D2, 20)
    _sale("WIN-O3", D3, 40)
    _sale("WIN-O4-CXL", D3, 5, status="Cancelled")

    def _ret(row_no: int, order_id: str, sku: str, d: date, qty: int) -> None:
        db_session.add(
            AnalysisReturnRow(
                project_id=pid,
                country="US",
                source_file_id=sf.id,
                source_row_no=row_no,
                return_date=d,
                sku=sku,
                order_id=order_id,
                quantity=qty,
                detailed_disposition="SELLABLE",
                reason="OTHER",
                status="Unit returned to inventory",
                original_return_datetime=f"{d.isoformat()}T00:00:00",
            )
        )

    # 退货只发生在 d1；SKU-ZERO 是「有退货、窗口内零销量」的反例 SKU
    _ret(1, "WIN-O1", "SKU-WIN", D1, 2)
    _ret(2, "WIN-O9", "SKU-ZERO", D1, 1)
    db_session.commit()

    # 模拟生产：每日任务只为「有退货的 SKU×日」写聚合行 → 只有 d1 有行
    result = _refresh_one_day(db_session, target_date=D1)
    assert result["rows_written"] == 2

    try:
        yield pid
    finally:
        db_session.expire_all()
        db_session.execute(
            text("DELETE FROM analysis_return_aggregates WHERE project_id = :pid"),
            {"pid": pid},
        )
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


def _query_all(db_session, pid: int, **kwargs):
    from app.services.external.return_analysis_query import (
        query_return_analysis_aggregate,
    )

    data, total = query_return_analysis_aggregate(
        db_session,
        project_id=pid,
        country="US",
        date_from=D1,
        date_to=D3,
        order_column=lambda r: r["return_quantity"],
        order_dir="desc",
        limit=50,
        offset=0,
        **kwargs,
    )
    return data, total


def test_r2_window_sales_cover_sales_only_days(sparse_return_project, db_session):
    """核心反例：销售分散多日、退货仅 1 日 → R2 销量必须是全窗口 70.

    缺陷形态下这里只会看到退货日 d1 的 10（覆盖率 14%），即 Tia 实证
    「真实 166 vs 新口径 8」的测试化等价物。
    """
    pid = sparse_return_project

    # 前置守卫：聚合表确实只有退货日 d1 的行（生产常态分布）
    agg_dates = {
        r.data_date
        for r in db_session.query(AnalysisReturnAggregate)
        .filter_by(project_id=pid)
        .all()
    }
    assert agg_dates == {D1}, f"fixture 前提被破坏：{agg_dates}"

    data, total = _query_all(db_session, pid)
    assert total == 2
    by_sku = {r["sku"]: r for r in data}

    win = by_sku["SKU-WIN"]
    assert win["sales_quantity"] == 70, (
        f"R2 窗口销量必须含无退货销售日（d2/d3），期望 70，实际 {win['sales_quantity']}"
    )
    assert win["return_quantity"] == 2
    assert win["return_rate"] == round(2 * 100.0 / 70, 3)

    from app.services.external.return_analysis_query import build_aggregate_summary

    summary = build_aggregate_summary(data)
    assert summary["total_sales_quantity"] == 70
    assert summary["total_return_quantity"] == 3


def test_r2_window_sales_match_r1_source(sparse_return_project, db_session):
    """BLF-806 验收：R2 每 SKU 窗口销量 == R1 口径源（raw counted sales）."""
    from app.services.analysis.return_analysis.analysis import _build_sales_aggregates

    pid = sparse_return_project
    data, _ = _query_all(db_session, pid)
    by_sku = {r["sku"]: r for r in data}

    sku_sales, _ = _build_sales_aggregates(
        db_session, pid, "US", D1.isoformat(), D3.isoformat()
    )
    assert sku_sales["SKU-WIN"]["quantity"] == 70
    assert by_sku["SKU-WIN"]["sales_quantity"] == sku_sales["SKU-WIN"]["quantity"], (
        "R1 与 R2 同窗口同 SKU 销量必须逐项一致（BLF-806 验收）"
    )


def test_r2_zero_window_sales_sku_has_zero_rate(sparse_return_project, db_session):
    """有退货但窗口内零销量的 SKU：分母 0 → rate=0.0，不抛错也不虚增."""
    pid = sparse_return_project
    data, _ = _query_all(db_session, pid)
    by_sku = {r["sku"]: r for r in data}
    zero = by_sku["SKU-ZERO"]
    assert zero["sales_quantity"] == 0
    assert zero["return_rate"] == 0.0
    assert zero["return_quantity"] == 1


def test_r2_sku_substring_applies_to_window_sales_denominator(
    sparse_return_project, db_session
):
    """sku_substring 过滤同时作用于退货行与 raw 销售分母，匹配 SKU 拿到完整 70."""
    pid = sparse_return_project
    data, total = _query_all(db_session, pid, sku_substring="win")  # 大小写不敏感
    assert total == 1
    assert data[0]["sku"] == "SKU-WIN"
    assert data[0]["sales_quantity"] == 70
