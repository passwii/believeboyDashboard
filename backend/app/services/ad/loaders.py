"""Data loader functions for ad analysis.

Extracted from ad_analysis_service.py (stage 3 refactor).
All functions query the database and return lists of model rows.
"""
from __future__ import annotations

from sqlalchemy import select
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


def _apply_report_date_filters(stmt, *, date_from=None, date_to=None):
    """Apply date range filters to a query statement."""
    if date_from is not None:
        stmt = stmt.where(AdUploadFile.report_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(AdUploadFile.report_date <= date_to)
    return stmt


def _apply_campaign_name_filter(stmt, campaign_field, *, campaign=None):
    """Apply campaign name exact-match filter to a query statement."""
    normalized = (campaign or '').strip()
    if normalized:
        stmt = stmt.where(campaign_field == normalized)
    return stmt


def _load_campaign_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[AdUploadCampaignRow]:
    """Load campaign-level ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadCampaignRow)
        .join(AdUploadFile, AdUploadCampaignRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_campaign_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    return list(db.execute(stmt).scalars().all())


def _load_budget_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadBudgetRow]:
    """Load budget ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadBudgetRow)
        .join(AdUploadFile, AdUploadBudgetRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_budget_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadBudgetRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_product_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadPromotedProductRow]:
    """Load product (promoted SKU) ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadPromotedProductRow)
        .join(AdUploadFile, AdUploadPromotedProductRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_promoted_product_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadPromotedProductRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_placement_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadPlacementRow]:
    """Load placement ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadPlacementRow)
        .join(AdUploadFile, AdUploadPlacementRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_placement_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadPlacementRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_search_term_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadSearchTermRow]:
    """Load search term ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadSearchTermRow)
        .join(AdUploadFile, AdUploadSearchTermRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_search_term_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadSearchTermRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_search_term_share_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadSearchTermShareRow]:
    """Load search term share rows for a project/country within a date range."""
    stmt = (
        select(AdUploadSearchTermShareRow)
        .join(AdUploadFile, AdUploadSearchTermShareRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_search_term_share_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadSearchTermShareRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_invalid_traffic_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadInvalidTrafficRow]:
    """Load invalid traffic rows for a project/country within a date range."""
    stmt = (
        select(AdUploadInvalidTrafficRow)
        .join(AdUploadFile, AdUploadInvalidTrafficRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_invalid_traffic_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadInvalidTrafficRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_target_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadTargetRow]:
    """Load target (投放对象) ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadTargetRow)
        .join(AdUploadFile, AdUploadTargetRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_target_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadTargetRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())


def _load_time_trend_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
) -> list[AdUploadTimeTrendRow]:
    """Load time trend ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadTimeTrendRow)
        .join(AdUploadFile, AdUploadTimeTrendRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_time_trend_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    return list(db.execute(stmt).scalars().all())


def _load_purchased_product_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: str | None = None,
    date_to: str | None = None,
    campaign: str | None = None,
) -> list[AdUploadPurchasedProductRow]:
    """Load purchased product (已购买商品) ad rows for a project/country within a date range."""
    stmt = (
        select(AdUploadPurchasedProductRow)
        .join(AdUploadFile, AdUploadPurchasedProductRow.source_file_id == AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == 'ad_purchased_product_report',
            AdUploadFile.is_current.is_(True),
        )
    )
    stmt = _apply_report_date_filters(stmt, date_from=date_from, date_to=date_to)
    stmt = _apply_campaign_name_filter(stmt, AdUploadPurchasedProductRow.campaign_name, campaign=campaign)
    return list(db.execute(stmt).scalars().all())