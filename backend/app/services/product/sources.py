"""Product analysis - source file queries and serialization.

拆分自 product_analysis_source_service.py。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AdUploadPromotedProductRow, InventorySnapshotRow
from app.models.product_analysis_source import AnalysisSourceFile

from app.services.product._internal import (
    _get_project_by_name,
    _serialize_row_func,
    _normalize_country,
)
from app.services.report_type_service import normalize_report_type
from app.services.product.persistence import ALL_REPORT_TYPES, ensure_tables


def list_sources(
    db: Session,
    *,
    project_id: int | None = None,
    report_type: str | None = None,
    period_start_date: 'date | None' = None,
    period_end_date: 'date | None' = None,
    current_only: bool = True,
) -> list[AnalysisSourceFile]:
    from datetime import datetime, timezone as Tz
    from sqlalchemy import or_ as _or
    from app.utils.parsers import normalize_report_type as _normalize

    ensure_tables(db)
    stmt = select(AnalysisSourceFile).order_by(
        AnalysisSourceFile.created_at.desc(),
        AnalysisSourceFile.id.desc(),
    )
    if current_only:
        stmt = stmt.where(AnalysisSourceFile.is_current.is_(True))
    if project_id is not None:
        stmt = stmt.where(AnalysisSourceFile.project_id == project_id)
    if report_type:
        normalized = _normalize(report_type)
        if normalized not in ALL_REPORT_TYPES:
            raise ValueError(f'Unsupported report_type: {report_type}')
        stmt = stmt.where(AnalysisSourceFile.report_type == normalized)
    if period_start_date is not None:
        stmt = stmt.where(
            (
                (AnalysisSourceFile.period_end_date.is_not(None))
                & (AnalysisSourceFile.period_end_date >= period_start_date)
            )
            | (
                (AnalysisSourceFile.snapshot_at.is_not(None))
                & (AnalysisSourceFile.snapshot_at >= datetime.combine(
                    period_start_date, datetime.min.time(), tzinfo=Tz.utc,
                ))
            )
        )
    if period_end_date is not None:
        stmt = stmt.where(
            (
                (AnalysisSourceFile.period_start_date.is_not(None))
                & (AnalysisSourceFile.period_start_date <= period_end_date)
            )
            | (
                (AnalysisSourceFile.snapshot_at.is_not(None))
                & (AnalysisSourceFile.snapshot_at <= datetime.combine(
                    period_end_date, datetime.max.time(), tzinfo=Tz.utc,
                ))
            )
        )
    return list(db.execute(stmt).scalars().all())


def get_source_or_none(db: Session, source_id: int) -> AnalysisSourceFile | None:
    ensure_tables(db)
    return db.get(AnalysisSourceFile, source_id)


def get_source_rows(
    db: Session,
    *,
    source_id: int,
    page: int,
    page_size: int,
    include_excluded: bool = False,
):
    ensure_tables(db)
    source = db.get(AnalysisSourceFile, source_id)
    if source is None:
        raise ValueError('Source file not found')
    if page < 1 or page_size < 1:
        raise ValueError('page and page_size must be >= 1')

    # ad_product_report 已切到 C 表 (ad_upload_promoted_product_rows)
    # 把 A 表 source_id 通过 (project, country, period, version, is_current) 映射到 C 表 source_id
    if source.report_type == 'ad_product_report':
        c_source = db.execute(
            select(AdUploadFile)
            .where(
                AdUploadFile.project_id == source.project_id,
                AdUploadFile.country == source.country,
                AdUploadFile.period_start_date == source.period_start_date,
                AdUploadFile.period_end_date == source.period_end_date,
                AdUploadFile.version == source.version,
                AdUploadFile.is_current == source.is_current,
                AdUploadFile.report_type == 'ad_promoted_product_report',
            )
        ).scalar_one_or_none()
        if c_source is None:
            raise ValueError(
                f'No C table source for A id={source_id} '
                f'(project={source.project_id} country={source.country} period={source.period_start_date}..{source.period_end_date} version={source.version})'
            )
        model = AdUploadPromotedProductRow
        actual_source_id = c_source.id
    else:
        from app.services.product._internal import _get_row_model
        model = _get_row_model(source.report_type)
        actual_source_id = source_id

    stmt = select(model).where(model.source_file_id == actual_source_id).order_by(
        model.source_row_no.asc(),
    )
    # NOTE: scope_status 过滤暂时拿掉 (Step 7 Alembic 给 C 表加列后再加回)
    # payment_report 仍按 scope 过滤
    if source.report_type == 'payment_report' and not include_excluded:
        from app.utils.parsers import SCOPE_INCLUDED
        stmt = stmt.where(model.scope_status == SCOPE_INCLUDED)

    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size + 1)).scalars().all()
    has_next = len(rows) > page_size
    rows = rows[:page_size]
    payload = [_serialize_row_func(source.report_type, row) for row in rows]
    return source, payload, has_next


def get_current_inventory_snapshot(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    period_start_date: 'date | None' = None,
    period_end_date: 'date | None' = None,
):
    from datetime import datetime as Dt, timezone as Tz
    from sqlalchemy import or_ as _or

    ensure_tables(db)
    normalized_country = _normalize_country(country)
    stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == 'inventory_report',
        AnalysisSourceFile.country == normalized_country,
    )
    if period_start_date is None and period_end_date is None:
        stmt = stmt.where(AnalysisSourceFile.is_current.is_(True))
    else:
        if period_start_date is not None:
            stmt = stmt.where(
                (
                    (AnalysisSourceFile.report_date.is_not(None))
                    & (AnalysisSourceFile.report_date >= period_start_date)
                )
                | (
                    (AnalysisSourceFile.report_date.is_(None))
                    & (AnalysisSourceFile.snapshot_at.is_not(None))
                    & (
                        AnalysisSourceFile.snapshot_at
                        >= Dt.combine(period_start_date, Dt.min.time(), tzinfo=Tz.utc)
                    )
                )
            )
        if period_end_date is not None:
            stmt = stmt.where(
                (
                    (AnalysisSourceFile.report_date.is_not(None))
                    & (AnalysisSourceFile.report_date <= period_end_date)
                )
                | (
                    (AnalysisSourceFile.report_date.is_(None))
                    & (AnalysisSourceFile.snapshot_at.is_not(None))
                    & (
                        AnalysisSourceFile.snapshot_at
                        <= Dt.combine(period_end_date, Dt.max.time(), tzinfo=Tz.utc)
                    )
                )
            )
    source = db.execute(
        stmt.order_by(
            AnalysisSourceFile.report_date.desc(),
            AnalysisSourceFile.snapshot_at.desc(),
            AnalysisSourceFile.version.desc(),
            AnalysisSourceFile.id.desc(),
        ).limit(1)
    ).scalars().first()
    if source is None:
        return None
    rows = db.execute(
        select(InventorySnapshotRow)
        .where(InventorySnapshotRow.source_file_id == source.id)
        .order_by(InventorySnapshotRow.source_row_no.asc())
    ).scalars().all()
    return source, [_serialize_row_func('inventory_report', row) for row in rows]


def _ensure_tables():
    from app.services.product.persistence import ensure_tables as _ensure
    _ensure(db=None)  # Will use the existing db session context