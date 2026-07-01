"""External API raw row query service (v1.0 contract).

Returns the original rows of the underlying ``ad_upload_*_rows`` table,
filtered by the latest-version ``ad_upload_files`` in the requested window.
Used by ``/ad-*-raw`` endpoints.

File selection logic is shared with ``aggregator._select_file_ids`` — see
that function for details on the v1.0 multi-version contract.
"""
from __future__ import annotations

from datetime import date
from typing import Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    AdUploadBudgetRow,
    AdUploadCampaignRow,
    AdUploadFile,
    AdUploadInvalidTrafficRow,
    AdUploadPlacementRow,
    AdUploadPromotedProductRow,
    AdUploadPurchasedProductRow,
    AdUploadSearchTermShareRow,
    AdUploadSearchTermRow,
    AdUploadTargetRow,
    AdUploadTimeTrendRow,
)


def _select_file_ids(
    db: Session,
    *,
    project_id: int,
    country: str,
    report_type: str,
    date_from: date,
    date_to: date,
) -> list[int]:
    """Reuse the same multi-version file selection as aggregator.py.

    Picks MAX(version) per (project_id, report_type, country, report_date)
    inside the requested window.  NULL ``report_date`` falls back to the
    ``period_start_date/end_date`` overlap.
    """
    latest_versions = (
        select(
            AdUploadFile.project_id.label("project_id"),
            AdUploadFile.report_type.label("report_type"),
            AdUploadFile.country.label("country"),
            AdUploadFile.report_date.label("report_date"),
            func.max(AdUploadFile.version).label("max_version"),
        )
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == report_type,
            AdUploadFile.is_current.is_(True),
            AdUploadFile.ingestion_status == 'success',
            AdUploadFile.recognition_status == 'recognized',
            or_(
                AdUploadFile.report_date.between(date_from, date_to),
                and_(
                    AdUploadFile.report_date.is_(None),
                    AdUploadFile.period_start_date <= date_to,
                    AdUploadFile.period_end_date >= date_from,
                ),
            ),
        )
        .group_by(
            AdUploadFile.project_id,
            AdUploadFile.report_type,
            AdUploadFile.country,
            AdUploadFile.report_date,
        )
        .subquery()
    )

    stmt = (
        select(AdUploadFile.id)
        .join(
            latest_versions,
            and_(
                AdUploadFile.project_id == latest_versions.c.project_id,
                AdUploadFile.report_type == latest_versions.c.report_type,
                AdUploadFile.country == latest_versions.c.country,
                AdUploadFile.report_date == latest_versions.c.report_date,
                AdUploadFile.version == latest_versions.c.max_version,
            ),
        )
    )
    return list(db.execute(stmt).scalars().all())


def _run_raw_query(
    db: Session,
    *,
    row_model: type,
    project_id: int,
    country: str,
    report_type: str,
    date_from: date,
    date_to: date,
    order_column,
    order_dir: str = 'desc',
    limit: int = 10000,
    offset: int = 0,
) -> Sequence:
    if limit < 1 or limit > 50000:
        raise ValueError(f"limit must be 1..50000, got {limit}")
    if offset < 0:
        raise ValueError(f"offset must be >= 0, got {offset}")
    if order_dir not in ('asc', 'desc'):
        raise ValueError(f"order_dir must be 'asc' or 'desc', got {order_dir!r}")

    file_ids = _select_file_ids(
        db,
        project_id=project_id,
        country=country,
        report_type=report_type,
        date_from=date_from,
        date_to=date_to,
    )
    if not file_ids:
        return []

    ordering = order_column.desc() if order_dir == 'desc' else order_column.asc()
    stmt = (
        select(row_model)
        .where(row_model.source_file_id.in_(file_ids))
        .order_by(ordering)
        .limit(limit)
        .offset(offset)
    )
    return list(db.execute(stmt).scalars().all())


# ---------------------------------------------------------------------------
# Per-table raw query helpers
# ---------------------------------------------------------------------------


def query_campaign_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadCampaignRow]:
    return _run_raw_query(
        db, row_model=AdUploadCampaignRow, project_id=project_id, country=country,
        report_type='ad_campaign_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_budget_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadBudgetRow]:
    return _run_raw_query(
        db, row_model=AdUploadBudgetRow, project_id=project_id, country=country,
        report_type='ad_budget_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_target_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadTargetRow]:
    return _run_raw_query(
        db, row_model=AdUploadTargetRow, project_id=project_id, country=country,
        report_type='ad_target_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_placement_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadPlacementRow]:
    return _run_raw_query(
        db, row_model=AdUploadPlacementRow, project_id=project_id, country=country,
        report_type='ad_placement_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_search_term_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadSearchTermRow]:
    return _run_raw_query(
        db, row_model=AdUploadSearchTermRow, project_id=project_id, country=country,
        report_type='ad_search_term_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_search_term_share_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadSearchTermShareRow]:
    return _run_raw_query(
        db, row_model=AdUploadSearchTermShareRow, project_id=project_id, country=country,
        report_type='ad_search_term_share_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_promoted_product_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadPromotedProductRow]:
    return _run_raw_query(
        db, row_model=AdUploadPromotedProductRow, project_id=project_id, country=country,
        report_type='ad_promoted_product_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_time_trend_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadTimeTrendRow]:
    return _run_raw_query(
        db, row_model=AdUploadTimeTrendRow, project_id=project_id, country=country,
        report_type='ad_time_trend_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_purchased_product_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadPurchasedProductRow]:
    return _run_raw_query(
        db, row_model=AdUploadPurchasedProductRow, project_id=project_id, country=country,
        report_type='ad_purchased_product_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )


def query_invalid_traffic_raw(
    db: Session, *, project_id, country, date_from, date_to,
    order_column, order_dir='desc', limit=10000, offset=0,
) -> Sequence[AdUploadInvalidTrafficRow]:
    return _run_raw_query(
        db, row_model=AdUploadInvalidTrafficRow, project_id=project_id, country=country,
        report_type='ad_invalid_traffic_report', date_from=date_from, date_to=date_to,
        order_column=order_column, order_dir=order_dir, limit=limit, offset=offset,
    )

# ---------------------------------------------------------------------------
# AdUploadFile listing (used by /external/projects/{id}/ad-upload-files)
# ---------------------------------------------------------------------------


def list_ad_upload_files(
    db: Session,
    *,
    project_id: int,
    report_type: str | None = None,
    country: str | None = None,
    include_history: bool = False,
    limit: int = 100,
    offset: int = 0,
):
    """List ``AdUploadFile`` rows for a project, optionally filtered by
    report_type / country.  ``include_history=False`` (default) restricts to
    ``is_current=True``; ``True`` returns all versions, newest first."""
    if limit < 1 or limit > 500:
        raise ValueError(f"limit must be 1..500, got {limit}")
    if offset < 0:
        raise ValueError(f"offset must be >= 0, got {offset}")

    from app.models import AdUploadFile  # local to avoid cycle at import
    stmt = select(AdUploadFile).where(AdUploadFile.project_id == project_id)
    if report_type is not None:
        stmt = stmt.where(AdUploadFile.report_type == report_type)
    if country is not None:
        stmt = stmt.where(AdUploadFile.country == country)
    if not include_history:
        stmt = stmt.where(AdUploadFile.is_current.is_(True))

    stmt = stmt.order_by(
        AdUploadFile.updated_at.desc(),
        AdUploadFile.id.desc(),
    ).limit(limit).offset(offset)

    return list(db.execute(stmt).scalars().all())
