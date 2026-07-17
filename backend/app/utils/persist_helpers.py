"""Shared persistence helpers for analysis_source_files and report_upload_logs.

These functions operate on the shared ``AnalysisSourceFile`` model
(``app.shared.models``) and the backend's ``ReportUploadLog`` model.  Both
the backend service and autoReportUpload import from here so versioning,
current-pointer management, and upload-log writing stay in sync.
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import func, select, update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile

from app.utils.constants import PERIODIC_REPORT_TYPES


def next_version(
    db: Session,
    *,
    project_id: int,
    report_type: str,
    country: str,
    period_start_date: date | None,
    period_end_date: date | None,
) -> int:
    """Return the next version number for a given (project, type, country, period)."""
    stmt = select(func.max(AnalysisSourceFile.version)).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == report_type,
        AnalysisSourceFile.country == country,
    )
    if report_type in PERIODIC_REPORT_TYPES:
        stmt = stmt.where(
            AnalysisSourceFile.period_start_date == period_start_date,
            AnalysisSourceFile.period_end_date == period_end_date,
        )
    value = db.execute(stmt).scalar_one_or_none()
    return int(value or 0) + 1


def replace_current_pointer(db: Session, source: AnalysisSourceFile) -> None:
    """Mark all older versions of the same report as superseded.

    For periodic reports the match is scoped to (project, type, country, period).
    For inventory reports the match is scoped to (project, type, country).
    """
    conditions = [
        AnalysisSourceFile.project_id == source.project_id,
        AnalysisSourceFile.report_type == source.report_type,
        AnalysisSourceFile.country == source.country,
        AnalysisSourceFile.id != source.id,
        AnalysisSourceFile.is_current.is_(True),
    ]
    if source.report_type in PERIODIC_REPORT_TYPES:
        conditions.extend([
            AnalysisSourceFile.period_start_date == source.period_start_date,
            AnalysisSourceFile.period_end_date == source.period_end_date,
        ])
    db.execute(
        sa_update(AnalysisSourceFile)
        .where(*conditions)
        .values(is_current=False, superseded_at=datetime.now(UTC))
    )


# 行级 upsert 时随冲突更新的可变字段。
# 注意：唯一键为 (project_id, amazon_order_id, sku, country, purchase_date_pt)，
# 因此这五个键字段 + 派生时间 (purchase_at_utc / purchase_at_pt) 均不在此列，
# 避免 on_conflict 时覆盖桶内稳定的购买日期（同一桶内 purchase_date 实测 0 漂移）。
_SALES_UPSERT_UPDATE_COLS = (
    'source_file_id',
    'order_status',
    'asin',
    'quantity',
    'item_price',
    'shipping_price',
    'currency',
    'is_counted_sales',
    'status_rule_version',
    'raw_row',
    'carrier',
    'tracking_no',
    'shipped_at',
    'updated_by',
    'updated_at',
)


def upsert_sales_order_rows(db: Session, rows: list[dict[str, Any]]) -> int:
    """行级 upsert 销售订单行（BEL-348）。

    按唯一键 ``(project_id, amazon_order_id, sku, country, purchase_date_pt)`` 合并：
    同一订单明细多次上报（不同 source_file / version、甚至不同报告日期桶）只保留一行，
    更新最新状态、计数标记、价格等，并自增 ``data_version``。返回被 upsert 的行数。

    唯一键含 ``purchase_date_pt``：Amazon 可能把同一订单归到相邻日期桶（如 06-23 与
    06-24 各一行），这两行视为不同组、各保留一条，避免误合并/误删。
    各 ``row`` 必须包含 ``project_id``（由调用方从所属 source_file 填入）。
    """
    if not rows:
        return 0
    stmt = pg_insert(AnalysisSalesOrderRow).values(rows)
    update_set = {
        col: getattr(stmt.excluded, col) for col in _SALES_UPSERT_UPDATE_COLS
    }
    # data_version 自增（引用已有行），仅作审计/幂等参考。
    update_set['data_version'] = AnalysisSalesOrderRow.data_version + 1
    stmt = stmt.on_conflict_do_update(
        index_elements=['project_id', 'amazon_order_id', 'sku', 'country', 'purchase_date_pt'],
        set_=update_set,
    )
    db.execute(stmt)
    return len(rows)


def write_report_upload_log(
    db: Session,
    project_id: int,
    country: str,
    report_type: str,
    *,
    upload_date: date | None = None,
    source_file_id: int | None = None,
    has_real_data: bool = True,
    row_count: int = 0,
    original_filename: str | None = None,
) -> None:
    """Write a single row to ``report_upload_logs``.

    Imported lazily to avoid circular imports — ``ReportUploadLog`` lives in
    the backend's ORM layer, not the shared models.
    """
    from app.models.report_upload_log import ReportUploadLog

    log = ReportUploadLog(
        project_id=project_id,
        report_type=report_type,
        country=country,
        upload_date=upload_date or date.today(),
        has_real_data=has_real_data,
        row_count=row_count,
        source_file_id=source_file_id,
        original_filename=original_filename,
    )
    db.add(log)
