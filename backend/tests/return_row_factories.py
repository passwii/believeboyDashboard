"""退货分析测试的共享种子工厂（服务层 / HTTP 层共用）。

为什么抽出来：``test_shared_return_rows_query.py``（服务层）与
``test_return_analysis_raw_rows.py``（HTTP 层）此前各自复制了一份完全相同的
seed / teardown 逻辑，两边一旦漂移就会出现「同一口径两套造数」的假绿。

这里的函数全部是**接收 SQLAlchemy Session 的普通函数**：不依赖 pytest
fixture，也不自己开 ``SessionLocal()``，会话生命周期与清理由调用方负责。
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import AnalysisReturnRow, AnalysisSourceFile


def default_return_window() -> tuple[str, str]:
    """两个测试文件共用的近 7 天窗口（右端点为昨天），返回 ISO 日期字符串。"""
    d = date.today() - timedelta(days=1)
    return (d - timedelta(days=6)).isoformat(), d.isoformat()


def seed_return_source(
    db: Session,
    project_id: int,
    *,
    tag: str,
    country: str = "US",
    is_current: bool = True,
    version: int = 1,
    period_start: date | None = None,
    period_end: date | None = None,
) -> AnalysisSourceFile:
    """建一张 ``return_report`` 源文件（commit + refresh）并返回该对象。

    唯一键是 ``(project_id, report_type, country, period_start_date,
    period_end_date, version)`` —— 同一项目 + 同一国家 + 同一周期要建第二张
    源文件必须递增 ``version``，否则撞 ``analysis_sources_period_version_key``。

    ``tag`` 只用于区分调用方（文件名 / ``upload_file_id`` / ``storage_key``），
    真实唯一性由 ``project_id`` 保证。
    """
    source = AnalysisSourceFile(
        project_id=project_id,
        country=country,
        report_type="return_report",
        upload_file_id=f"retrow_{tag}_{project_id}",
        upload_file_path=f"/tmp/retrow_{tag}.csv",
        original_filename=f"retrow_{tag}.csv",
        stored_filename=f"retrow_{tag}.csv",
        logical_filename=f"retrow_{tag}.csv",
        storage_key=f"retrow/{tag}.csv",
        period_start_date=period_start or (date.today() - timedelta(days=30)),
        period_end_date=period_end or date.today(),
        is_current=is_current,
        version=version,
        ingestion_status="success",
    )
    db.add(source)
    db.commit()
    db.refresh(source)
    return source


def seed_return_row(
    db: Session,
    *,
    source_file_id: int,
    project_id: int,
    order_id: str,
    sku: str,
    return_date: date,
    license_plate: str,
    row_no: int,
    country: str = "US",
    quantity: int = 1,
    customer_comments: str | None = None,
    asin: str | None = None,
    fnsku: str | None = None,
    product_name: str | None = None,
    fulfillment_center_id: str | None = None,
    detailed_disposition: str = "SELLABLE",
    reason: str = "NOT_AS_DESCRIBED",
    status: str = "Unit returned to inventory",
) -> AnalysisReturnRow:
    """插一条退货原始行（commit + refresh）并返回该对象。

    ``original_return_datetime`` 默认取 ``return_date`` 当天 10:00 UTC；
    ``raw_row`` 默认空 dict（本组测试不校验原样存档）。
    """
    row = AnalysisReturnRow(
        project_id=project_id,
        country=country,
        source_file_id=source_file_id,
        source_row_no=row_no,
        return_date=return_date,
        order_id=order_id,
        sku=sku,
        asin=asin,
        fnsku=fnsku,
        product_name=product_name,
        quantity=quantity,
        fulfillment_center_id=fulfillment_center_id,
        detailed_disposition=detailed_disposition,
        reason=reason,
        status=status,
        license_plate_number=license_plate,
        original_return_datetime=f"{return_date.isoformat()}T10:00:00+00:00",
        customer_comments=customer_comments,
        raw_row={},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def purge_project_return_data(db: Session, project_id: int) -> None:
    """teardown：删掉该项目的分析数据 + 项目本身，最后 commit。

    ``expire_all()`` 是必要的：调用方可能持有被就地改写过的 ORM 对象
    （``build_return_analysis`` 会把 ``return_date`` 改成 str），不先丢脏状态
    的话这里的 DELETE 会触发 autoflush 把坏值写回列。
    """
    db.expire_all()
    for table in (
        "analysis_return_rows",
        "analysis_sales_order_rows",
        "analysis_source_files",
        "analysis_return_aggregates",
    ):
        db.execute(
            text(f"DELETE FROM {table} WHERE project_id = :pid"), {"pid": project_id}
        )
    db.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": project_id})
    db.commit()
