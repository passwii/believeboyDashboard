"""Targeting-type enrichment for ``ad-search-terms`` endpoints.

The search-term CSV (Amazon 广告 - 搜索词) does NOT carry a "定位类型"
column.  ``AdUploadSearchTermRow.target_text`` is mapped from the CSV
"投放" column, whose meaning is mixed:
  * Auto Campaign rows → one of close-match / loose-match /
    substitutes / complements (targeting type)
  * Manual Campaign rows → the actual target word/ASIN

This module joins each search-term row against ``AdUploadCampaignRow``
within the same window to recover the campaign's ``targeting_type``
(自动投放 / 手动投放), then computes a per-row
``targeting_type`` value:
  * Auto   → ``raw_row.投放`` verbatim
  * Manual → ``LOWER(raw_row.匹配类型)``
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AdUploadCampaignRow, AdUploadFile

_CAMPAIGN_REPORT_TYPE = "ad_campaign_report"


def build_campaign_targeting_cache(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> dict[tuple[str, str], str]:
    """Return ``{(campaign_name, country): targeting_type}`` for the window.

    If a ``campaign_name`` appears in multiple ``AdUploadCampaignRow``
    rows with different ``targeting_type`` (rare — operator error),
    the latest ``report_end_date`` wins.

    Only includes rows from ``is_current=True`` /
    ``ingestion_status='success'`` /
    ``recognition_status='recognized'`` files — mirrors the v1.0
    multi-version contract used by ``ad_rows_query._select_file_ids``.
    """
    file_ids_stmt = (
        select(AdUploadFile.id)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.country == country,
            AdUploadFile.report_type == _CAMPAIGN_REPORT_TYPE,
            AdUploadFile.is_current.is_(True),
            AdUploadFile.ingestion_status == 'success',
            AdUploadFile.recognition_status == 'recognized',
            AdUploadFile.report_date.between(date_from, date_to),
        )
    )
    file_ids = list(db.execute(file_ids_stmt).scalars().all())
    if not file_ids:
        return {}

    latest_subq = (
        select(
            AdUploadCampaignRow.campaign_name.label("campaign_name"),
            AdUploadCampaignRow.targeting_type.label("targeting_type"),
            func.row_number()
            .over(
                partition_by=AdUploadCampaignRow.campaign_name,
                order_by=AdUploadCampaignRow.report_end_date.desc(),
            )
            .label("rn"),
        )
        .where(AdUploadCampaignRow.source_file_id.in_(file_ids))
        .where(AdUploadCampaignRow.targeting_type.is_not(None))
        .subquery()
    )
    stmt = (
        select(
            latest_subq.c.campaign_name,
            latest_subq.c.targeting_type,
        )
        .where(latest_subq.c.rn == 1)
    )

    cache: dict[tuple[str, str], str] = {}
    for row in db.execute(stmt).all():
        campaign_name = row.campaign_name
        targeting_type = row.targeting_type
        if campaign_name is None or targeting_type is None:
            continue
        cache[(campaign_name, country)] = targeting_type
    return cache


def resolve_targeting_type(
    *,
    campaign_name: Optional[str],
    country: str,
    raw_row: dict[str, Any],
    campaign_targeting_map: dict[tuple[str, str], str],
) -> Optional[str]:
    """Compute one row's ``targeting_type`` value.

    Precedence:
      1. If ``(campaign_name, country)`` is not in the cache → ``None``.
      2. Auto  → ``raw_row["投放"]`` if non-empty, else ``None``.
      3. Manual → ``LOWER(raw_row["匹配类型"])`` if non-empty, else ``None``.
    """
    if campaign_name is None:
        return None
    campaign_targeting = campaign_targeting_map.get((campaign_name, country))
    if campaign_targeting is None:
        return None

    if campaign_targeting == "自动投放":
        value = raw_row.get("投放")
        if value is None or value == "":
            return None
        return str(value)
    if campaign_targeting == "手动投放":
        value = raw_row.get("匹配类型")
        if value is None or value == "":
            return None
        return str(value).lower()
    return None
