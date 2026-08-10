"""Shared aggregator service — GROUP BY + SUM + "latest value" lookup.

原 external 命名空间的共享查询服务（external 机制已退役删除，BLF-583），
供 agent 原生域复用。

For each of the 10 ad_upload_*_rows tables, ``aggregate_*`` returns a list of
``*AggregateRow`` schemas with:

* Sum metrics: ``impressions, clicks, spend, sales_7d, orders_7d, units_7d``
* Weighted computed fields: ``cpc, ctr, cvr, acos, roas`` — ctr/cvr/acos
  are returned as **percent** values (e.g. ``37.08`` = 37.08%)
* "Latest value" fields (e.g. ``budget, status, bidding_strategy``): the
  value of the most recent ``report_end_date`` row matching the business
  key (Python-side follow-up query, one per group, max ~50 calls).

All money values pass through ``round_money`` (2dp); all percent/ratio
values pass through ``round_ratio`` (4dp).

File selection follows the v1.0 contract:

    SELECT MAX(version) per (project_id, report_type, country, report_date)
    WHERE is_current = true AND ingestion_status = 'success'
      AND recognition_status = 'recognized'
      AND report_date BETWEEN :date_from AND :date_to
      (with a NULL-fallback to ``period_start_date <= :date_to AND
       period_end_date >= :date_from`` for historical backfill rows).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
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
from app.schemas.external.aggregate import (
    AdBudgetAggregateRow,
    AdCampaignAggregateRow,
    AdInvalidTrafficAggregateRow,
    AdPlacementAggregateRow,
    AdPromotedProductAggregateRow,
    AdPurchasedProductAggregateRow,
    AdSearchTermAggregateRow,
    AdSearchTermShareAggregateRow,
    AdTargetAggregateRow,
    AdTimeTrendAggregateRow,
)
from app.services.external import ad_targeting
from app.utils.math_utils import (
    DECIMAL_ZERO,
    round_money,
    round_ratio,
    safe_ratio,
)


# ---------------------------------------------------------------------------
# Helpers (private)
# ---------------------------------------------------------------------------


def _pct(value: Decimal) -> float:
    """Convert a ratio to a percent value and round to 4 decimal places.

    >>> _pct(Decimal('0.3708'))
    37.08
    """
    return round_ratio(value * 100)


def _pct_zero(numer: Decimal, denom) -> float:
    """Safe ``numer / denom * 100`` rounded to percent precision."""
    return _pct(safe_ratio(numer, denom))


def _roas(sales: Decimal, spend: Decimal) -> float:
    return round_ratio(safe_ratio(sales, spend))


def _money(v) -> float:
    return round_money(v)


def _int_sum(*xs) -> int:
    return sum(int(x or 0) for x in xs)


def _decimal_sum(*xs) -> Decimal:
    total = DECIMAL_ZERO
    for x in xs:
        total += Decimal(str(x or 0))
    return total


def _select_file_ids(
    db: Session,
    *,
    project_id: int,
    country: str,
    report_type: str,
    date_from: date,
    date_to: date,
) -> list[int]:
    """Return the list of ``ad_upload_files.id`` values to load rows from.

    Picks MAX(version) per (project_id, report_type, country, report_date)
    inside the requested window, with a NULL-fallback for files where
    ``report_date`` is missing (use ``period_start_date/end_date`` overlap
    instead).
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


# ---------------------------------------------------------------------------
# Latest-value helpers (Python-side follow-up queries)
# ---------------------------------------------------------------------------


def _latest_campaign(
    db: Session,
    *,
    file_ids: Sequence[int],
    campaign_name: str | None,
) -> dict:
    """Pick the most recent row matching ``campaign_name`` and return its
    "latest value" fields as a dict.
    """
    stmt = (
        select(AdUploadCampaignRow)
        .where(
            AdUploadCampaignRow.source_file_id.in_(file_ids),
            AdUploadCampaignRow.campaign_name == campaign_name,
        )
        .order_by(AdUploadCampaignRow.report_end_date.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        return {}
    return {
        "budget": float(row.budget or 0),
        "status": row.status,
        "bidding_strategy": row.bidding_strategy,
        "campaign_type": row.campaign_type,
        "targeting_type": row.targeting_type,
        "portfolio_name": row.portfolio_name,
    }


def _latest_budget(
    db: Session,
    *,
    file_ids: Sequence[int],
    campaign_name: str | None,
) -> dict:
    stmt = (
        select(AdUploadBudgetRow)
        .where(
            AdUploadBudgetRow.source_file_id.in_(file_ids),
            AdUploadBudgetRow.campaign_name == campaign_name,
        )
        .order_by(AdUploadBudgetRow.report_end_date.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        return {}
    return {
        "budget": float(row.budget or 0),
        "suggested_budget": float(row.suggested_budget or 0),
        "status": row.status,
        "budget_utilization_rate": float(row.budget_utilization_rate or 0),
    }


def _latest_invalid_traffic(
    db: Session,
    *,
    file_ids: Sequence[int],
    campaign_name: str | None,
) -> dict:
    stmt = (
        select(AdUploadInvalidTrafficRow)
        .where(
            AdUploadInvalidTrafficRow.source_file_id.in_(file_ids),
            AdUploadInvalidTrafficRow.campaign_name == campaign_name,
        )
        .order_by(AdUploadInvalidTrafficRow.report_end_date.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        return {}
    return {"status": row.status}


def _latest_placement(
    db: Session,
    *,
    file_ids: Sequence[int],
    placement: str | None,
) -> dict:
    """Pick the most recent row matching ``placement`` and return its
    "latest value" fields as a dict (used for bidding_strategy etc.)."""
    stmt = (
        select(AdUploadPlacementRow)
        .where(
            AdUploadPlacementRow.source_file_id.in_(file_ids),
            AdUploadPlacementRow.placement == placement,
        )
        .order_by(AdUploadPlacementRow.report_end_date.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        return {}
    return {"bidding_strategy": row.bidding_strategy}


# ---------------------------------------------------------------------------
# Aggregators
# ---------------------------------------------------------------------------


def aggregate_campaigns(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdCampaignAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_campaign_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadCampaignRow.campaign_name,
            func.coalesce(func.sum(AdUploadCampaignRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadCampaignRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadCampaignRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadCampaignRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadCampaignRow.orders_7d), 0).label("orders_7d"),
        )
        .where(AdUploadCampaignRow.source_file_id.in_(file_ids))
        .group_by(AdUploadCampaignRow.campaign_name)
    )

    rows: list[AdCampaignAggregateRow] = []
    for r in db.execute(stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)
        latest = _latest_campaign(db, file_ids=file_ids, campaign_name=r.campaign_name)
        rows.append(AdCampaignAggregateRow(
            campaign_name=r.campaign_name,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
            budget=latest.get("budget"),
            status=latest.get("status"),
            bidding_strategy=latest.get("bidding_strategy"),
            campaign_type=latest.get("campaign_type"),
            targeting_type=latest.get("targeting_type"),
            portfolio_name=latest.get("portfolio_name"),
        ))
    return rows


def aggregate_budgets(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdBudgetAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_budget_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadBudgetRow.campaign_name,
            func.coalesce(func.sum(AdUploadBudgetRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadBudgetRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadBudgetRow.orders_7d), 0).label("orders_7d"),
            # Missed-impression / click / sales metrics — period-level
            # MIN over _min columns, MAX over _max columns (per spec).
            func.coalesce(func.min(AdUploadBudgetRow.missed_impressions_min), 0).label("missed_impressions_min"),
            func.coalesce(func.max(AdUploadBudgetRow.missed_impressions_max), 0).label("missed_impressions_max"),
            func.coalesce(func.min(AdUploadBudgetRow.missed_clicks_min), 0).label("missed_clicks_min"),
            func.coalesce(func.max(AdUploadBudgetRow.missed_clicks_max), 0).label("missed_clicks_max"),
            func.coalesce(func.min(AdUploadBudgetRow.missed_sales_min), 0).label("missed_sales_min"),
            func.coalesce(func.max(AdUploadBudgetRow.missed_sales_max), 0).label("missed_sales_max"),
        )
        .where(AdUploadBudgetRow.source_file_id.in_(file_ids))
        .group_by(AdUploadBudgetRow.campaign_name)
    )

    rows: list[AdBudgetAggregateRow] = []
    for r in db.execute(stmt).all():
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        latest = _latest_budget(db, file_ids=file_ids, campaign_name=r.campaign_name)
        rows.append(AdBudgetAggregateRow(
            campaign_name=r.campaign_name,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=int(r.orders_7d or 0),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
            budget=latest.get("budget"),
            suggested_budget=latest.get("suggested_budget"),
            status=latest.get("status"),
            budget_utilization_rate=latest.get("budget_utilization_rate") or 0.0,
            missed_impressions_min=int(r.missed_impressions_min or 0),
            missed_impressions_max=int(r.missed_impressions_max or 0),
            missed_clicks_min=int(r.missed_clicks_min or 0),
            missed_clicks_max=int(r.missed_clicks_max or 0),
            missed_sales_min=_money(Decimal(str(r.missed_sales_min or 0))),
            missed_sales_max=_money(Decimal(str(r.missed_sales_max or 0))),
        ))
    return rows


def aggregate_targets(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdTargetAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_target_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadTargetRow.campaign_name,
            AdUploadTargetRow.ad_group_name,
            AdUploadTargetRow.target_text,
            AdUploadTargetRow.match_type,
            func.coalesce(func.sum(AdUploadTargetRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadTargetRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadTargetRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadTargetRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadTargetRow.orders_7d), 0).label("orders_7d"),
            func.coalesce(func.sum(AdUploadTargetRow.units_7d), 0).label("units_7d"),
            # Period-level AVG of top-of-search impression share (per spec).
            func.coalesce(func.avg(AdUploadTargetRow.top_of_search_impression_share), 0).label("tos_share"),
        )
        .where(AdUploadTargetRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadTargetRow.campaign_name,
            AdUploadTargetRow.ad_group_name,
            AdUploadTargetRow.target_text,
            AdUploadTargetRow.match_type,
        )
    )

    rows: list[AdTargetAggregateRow] = []
    for r in db.execute(stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)
        rows.append(AdTargetAggregateRow(
            campaign_name=r.campaign_name,
            ad_group_name=r.ad_group_name,
            target_text=r.target_text,
            match_type=r.match_type,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            units_7d=int(r.units_7d or 0),
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
            # AVG ratio (0..1) -> percent (0..100), 4dp
            top_of_search_impression_share=_pct(Decimal(str(r.tos_share or 0))),
        ))
    return rows


def aggregate_placements(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdPlacementAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_placement_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadPlacementRow.placement,
            func.coalesce(func.sum(AdUploadPlacementRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadPlacementRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadPlacementRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadPlacementRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadPlacementRow.orders_7d), 0).label("orders_7d"),
            func.coalesce(func.sum(AdUploadPlacementRow.units_7d), 0).label("units_7d"),
        )
        .where(AdUploadPlacementRow.source_file_id.in_(file_ids))
        .group_by(AdUploadPlacementRow.placement)
    )

    rows: list[AdPlacementAggregateRow] = []
    for r in db.execute(stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)
        latest = _latest_placement(db, file_ids=file_ids, placement=r.placement)
        rows.append(AdPlacementAggregateRow(
            campaign_name=None,
            placement=r.placement,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            units_7d=int(r.units_7d or 0),
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
            bidding_strategy=latest.get("bidding_strategy"),
        ))
    return rows


def aggregate_search_terms(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdSearchTermAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_search_term_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    # Window-scoped (campaign_name -> campaign targeting_type) cache.
    # Used to compute per-row targeting_type: Auto -> raw_row['投放'],
    # Manual -> LOWER(raw_row['匹配类型']).
    campaign_targeting_map = ad_targeting.build_campaign_targeting_cache(
        db, project_id=project_id, country=country,
        date_from=date_from, date_to=date_to,
    )

    # Two-pass aggregation: Postgres `json` columns have no equality
    # operator and no MIN/MAX, so we cannot GROUP BY raw_row and cannot
    # select raw_row without GROUP BY.  We split the query:
    #   1. Aggregate metrics by (campaign_name, search_term, match_type).
    #   2. Pick one representative raw_row per group key (most recent
    #      report_end_date) for Python-side targeting_type resolution.
    agg_stmt = (
        select(
            AdUploadSearchTermRow.campaign_name,
            AdUploadSearchTermRow.search_term,
            AdUploadSearchTermRow.match_type,
            func.max(AdUploadSearchTermRow.report_end_date).label("max_end_date"),
            func.coalesce(func.sum(AdUploadSearchTermRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadSearchTermRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadSearchTermRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadSearchTermRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadSearchTermRow.orders_7d), 0).label("orders_7d"),
        )
        .where(AdUploadSearchTermRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadSearchTermRow.campaign_name,
            AdUploadSearchTermRow.search_term,
            AdUploadSearchTermRow.match_type,
        )
    )

    rows: list[AdSearchTermAggregateRow] = []
    for r in db.execute(agg_stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)

        # Representative raw_row for this group: any row whose
        # (campaign_name, search_term, match_type, report_end_date) matches
        # the group key + the bucket's max_end_date.  Within a single
        # ingest raw_row.投放 / raw_row.匹配类型 are stable per group,
        # so any representative is fine.
        rep = db.execute(
            select(AdUploadSearchTermRow.raw_row)
            .where(
                AdUploadSearchTermRow.source_file_id.in_(file_ids),
                AdUploadSearchTermRow.campaign_name == r.campaign_name,
                AdUploadSearchTermRow.search_term == r.search_term,
                AdUploadSearchTermRow.match_type == r.match_type,
                AdUploadSearchTermRow.report_end_date == r.max_end_date,
            )
            .limit(1)
        ).scalar_one_or_none()

        targeting_type = ad_targeting.resolve_targeting_type(
            campaign_name=r.campaign_name,
            country=country,
            raw_row=rep if isinstance(rep, dict) else {},
            campaign_targeting_map=campaign_targeting_map,
        )

        rows.append(AdSearchTermAggregateRow(
            campaign_name=r.campaign_name,
            ad_group_name=None,
            match_type=r.match_type,
            search_term=r.search_term,
            targeting_type=targeting_type,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
        ))
    return rows


def aggregate_search_term_shares(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdSearchTermShareAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_search_term_share_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadSearchTermShareRow.search_term,
            AdUploadSearchTermShareRow.match_type,
            func.coalesce(func.sum(AdUploadSearchTermShareRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadSearchTermShareRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadSearchTermShareRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadSearchTermShareRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadSearchTermShareRow.orders_7d), 0).label("orders_7d"),
            func.coalesce(func.sum(AdUploadSearchTermShareRow.impression_share), 0).label("impression_share"),
        )
        .where(AdUploadSearchTermShareRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadSearchTermShareRow.search_term,
            AdUploadSearchTermShareRow.match_type,
        )
    )

    rows: list[AdSearchTermShareAggregateRow] = []
    for r in db.execute(stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)
        # Latest target_text / ad_group_name within the window
        latest = db.execute(
            select(AdUploadSearchTermShareRow)
            .where(
                AdUploadSearchTermShareRow.source_file_id.in_(file_ids),
                AdUploadSearchTermShareRow.search_term == r.search_term,
                AdUploadSearchTermShareRow.match_type == r.match_type,
            )
            .order_by(AdUploadSearchTermShareRow.report_end_date.desc())
            .limit(1)
        ).scalar_one_or_none()
        rows.append(AdSearchTermShareAggregateRow(
            search_term=r.search_term,
            impression_rank=0,
            campaign_name=None,
            target_text=latest.target_text if latest else None,
            ad_group_name=latest.ad_group_name if latest else None,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
            impression_share=_pct(Decimal(str(r.impression_share or 0))),
        ))
    return rows


def aggregate_promoted_products(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdPromotedProductAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_promoted_product_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadPromotedProductRow.campaign_name,
            AdUploadPromotedProductRow.ad_sku,
            AdUploadPromotedProductRow.ad_asin,
            func.coalesce(func.sum(AdUploadPromotedProductRow.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.sales_7d), 0).label("sales_7d"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.orders_7d), 0).label("orders_7d"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.units_7d), 0).label("units_7d"),
            # SKU-attribution columns (per spec)
            func.coalesce(func.sum(AdUploadPromotedProductRow.ad_sku_units_7d), 0).label("ad_sku_units_7d"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.ad_sku_sales_7d), 0).label("ad_sku_sales_7d"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.other_sku_units_7d), 0).label("other_sku_units_7d"),
            func.coalesce(func.sum(AdUploadPromotedProductRow.other_sku_sales_7d), 0).label("other_sku_sales_7d"),
        )
        .where(AdUploadPromotedProductRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadPromotedProductRow.campaign_name,
            AdUploadPromotedProductRow.ad_sku,
            AdUploadPromotedProductRow.ad_asin,
        )
    )

    rows: list[AdPromotedProductAggregateRow] = []
    for r in db.execute(stmt).all():
        impressions = int(r.impressions or 0)
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        sales_d = Decimal(str(r.sales_7d or 0))
        orders = int(r.orders_7d or 0)
        # Latest scope_status within the window
        latest = db.execute(
            select(AdUploadPromotedProductRow)
            .where(
                AdUploadPromotedProductRow.source_file_id.in_(file_ids),
                AdUploadPromotedProductRow.campaign_name == r.campaign_name,
                AdUploadPromotedProductRow.ad_sku == r.ad_sku,
                AdUploadPromotedProductRow.ad_asin == r.ad_asin,
            )
            .order_by(AdUploadPromotedProductRow.report_end_date.desc())
            .limit(1)
        ).scalar_one_or_none()
        rows.append(AdPromotedProductAggregateRow(
            campaign_name=r.campaign_name,
            ad_sku=r.ad_sku,
            ad_asin=r.ad_asin,
            impressions=impressions,
            clicks=clicks,
            spend=_money(spend_d),
            sales_7d=_money(sales_d),
            orders_7d=orders,
            units_7d=int(r.units_7d or 0),
            cpc=_money(safe_ratio(spend_d, clicks)),
            ctr=_pct_zero(Decimal(clicks), impressions),
            cvr=_pct_zero(Decimal(orders), clicks),
            acos=_pct_zero(spend_d, sales_d),
            roas=_roas(sales_d, spend_d),
            ad_sku_units_7d=int(r.ad_sku_units_7d or 0),
            ad_sku_sales_7d=_money(Decimal(str(r.ad_sku_sales_7d or 0))),
            other_sku_units_7d=int(r.other_sku_units_7d or 0),
            other_sku_sales_7d=_money(Decimal(str(r.other_sku_sales_7d or 0))),
            scope_status=latest.scope_status if latest else None,
        ))
    return rows


def aggregate_time_trends(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdTimeTrendAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_time_trend_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadTimeTrendRow.report_end_date,
            AdUploadTimeTrendRow.country,
            AdUploadTimeTrendRow.currency,
            func.coalesce(func.sum(AdUploadTimeTrendRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdUploadTimeTrendRow.spend), 0).label("spend"),
        )
        .where(AdUploadTimeTrendRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadTimeTrendRow.report_end_date,
            AdUploadTimeTrendRow.country,
            AdUploadTimeTrendRow.currency,
        )
    )

    rows: list[AdTimeTrendAggregateRow] = []
    for r in db.execute(stmt).all():
        clicks = int(r.clicks or 0)
        spend_d = Decimal(str(r.spend or 0))
        rows.append(AdTimeTrendAggregateRow(
            report_end_date=r.report_end_date.isoformat(),
            country=r.country,
            currency=r.currency,
            clicks=clicks,
            cpc=_money(safe_ratio(spend_d, clicks)),
            spend=_money(spend_d),
        ))
    return rows


def aggregate_purchased_products(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdPurchasedProductAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_purchased_product_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadPurchasedProductRow.campaign_name,
            AdUploadPurchasedProductRow.ad_group_name,
            AdUploadPurchasedProductRow.ad_sku,
            AdUploadPurchasedProductRow.ad_asin,
            AdUploadPurchasedProductRow.purchased_asin,
            AdUploadPurchasedProductRow.target_text,
            AdUploadPurchasedProductRow.match_type,
            func.coalesce(func.sum(AdUploadPurchasedProductRow.other_sku_units_7d), 0).label("other_sku_units_7d"),
            func.coalesce(func.sum(AdUploadPurchasedProductRow.other_sku_orders_7d), 0).label("other_sku_orders_7d"),
            func.coalesce(func.sum(AdUploadPurchasedProductRow.other_sku_sales_7d), 0).label("other_sku_sales_7d"),
        )
        .where(AdUploadPurchasedProductRow.source_file_id.in_(file_ids))
        .group_by(
            AdUploadPurchasedProductRow.campaign_name,
            AdUploadPurchasedProductRow.ad_group_name,
            AdUploadPurchasedProductRow.ad_sku,
            AdUploadPurchasedProductRow.ad_asin,
            AdUploadPurchasedProductRow.purchased_asin,
            AdUploadPurchasedProductRow.target_text,
            AdUploadPurchasedProductRow.match_type,
        )
    )

    rows: list[AdPurchasedProductAggregateRow] = []
    for r in db.execute(stmt).all():
        rows.append(AdPurchasedProductAggregateRow(
            campaign_name=r.campaign_name,
            ad_group_name=r.ad_group_name,
            ad_sku=r.ad_sku,
            ad_asin=r.ad_asin,
            purchased_asin=r.purchased_asin,
            target_text=r.target_text,
            match_type=r.match_type,
            other_sku_units_7d=int(r.other_sku_units_7d or 0),
            other_sku_orders_7d=int(r.other_sku_orders_7d or 0),
            other_sku_sales_7d=_money(Decimal(str(r.other_sku_sales_7d or 0))),
        ))
    return rows


def aggregate_invalid_traffic(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> list[AdInvalidTrafficAggregateRow]:
    file_ids = _select_file_ids(
        db, project_id=project_id, country=country,
        report_type='ad_invalid_traffic_report',
        date_from=date_from, date_to=date_to,
    )
    if not file_ids:
        return []

    stmt = (
        select(
            AdUploadInvalidTrafficRow.campaign_name,
            func.coalesce(func.sum(AdUploadInvalidTrafficRow.total_impressions), 0).label("total_impressions"),
            func.coalesce(func.sum(AdUploadInvalidTrafficRow.valid_impressions), 0).label("valid_impressions"),
            func.coalesce(func.sum(AdUploadInvalidTrafficRow.invalid_impressions), 0).label("invalid_impressions"),
            func.coalesce(func.sum(AdUploadInvalidTrafficRow.total_clicks), 0).label("total_clicks"),
            func.coalesce(func.sum(AdUploadInvalidTrafficRow.valid_clicks), 0).label("valid_clicks"),
            func.coalesce(func.sum(AdUploadInvalidTrafficRow.invalid_clicks), 0).label("invalid_clicks"),
        )
        .where(AdUploadInvalidTrafficRow.source_file_id.in_(file_ids))
        .group_by(AdUploadInvalidTrafficRow.campaign_name)
    )

    rows: list[AdInvalidTrafficAggregateRow] = []
    for r in db.execute(stmt).all():
        total_i = int(r.total_impressions or 0)
        valid_i = int(r.valid_impressions or 0)
        invalid_i = int(r.invalid_impressions or 0)
        total_c = int(r.total_clicks or 0)
        valid_c = int(r.valid_clicks or 0)
        invalid_c = int(r.invalid_clicks or 0)
        latest = _latest_invalid_traffic(db, file_ids=file_ids, campaign_name=r.campaign_name)
        rows.append(AdInvalidTrafficAggregateRow(
            campaign_name=r.campaign_name,
            total_impressions=total_i,
            valid_impressions=valid_i,
            invalid_impressions=invalid_i,
            invalid_impression_rate=_pct_zero(Decimal(invalid_i), total_i),
            total_clicks=total_c,
            valid_clicks=valid_c,
            invalid_clicks=invalid_c,
            invalid_click_rate=_pct_zero(Decimal(invalid_c), total_c),
            status=latest.get("status"),
        ))
    return rows


# ---------------------------------------------------------------------------
# Summary helpers
# ---------------------------------------------------------------------------


def build_aggregate_summary(
    rows,
) -> dict:
    """Compute the standard AggregateSummary block from a list of aggregate
    rows.  Works for any row class that exposes ``spend``, ``sales_7d`` and
    ``orders_7d`` (the three fields every aggregate row carries).
    """
    total_spend = sum(Decimal(str(r.spend or 0)) for r in rows)
    total_sales = sum(Decimal(str(r.sales_7d or 0)) for r in rows)
    total_orders = sum(int(r.orders_7d or 0) for r in rows)
    return {
        "total_rows": len(rows),
        "total_spend": _money(total_spend),
        "total_sales": _money(total_sales),
        "total_orders": total_orders,
        "overall_acos": _pct_zero(total_spend, total_sales),
        "overall_roas": _roas(total_sales, total_spend),
    }


def build_aggregate_summary_for_time_trends(rows) -> dict:
    """Time-trend has no orders/sales — only spend and clicks."""
    total_spend = sum(Decimal(str(r.spend or 0)) for r in rows)
    return {
        "total_rows": len(rows),
        "total_spend": _money(total_spend),
        "total_sales": 0.0,
        "total_orders": 0,
        "overall_acos": 0.0,
        "overall_roas": 0.0,
    }


def build_aggregate_summary_for_budgets(rows) -> dict:
    """Budget rows have spend/sales/orders too — same as standard."""
    return build_aggregate_summary(rows)


def build_aggregate_summary_for_purchased_products(rows) -> dict:
    """Purchased-product rows have only other_sku_* metrics — summary is
    simplified (no overall_acos / roas derivable from these columns)."""
    total_sales = sum(Decimal(str(r.other_sku_sales_7d or 0)) for r in rows)
    total_orders = sum(int(r.other_sku_orders_7d or 0) for r in rows)
    return {
        "total_rows": len(rows),
        "total_spend": 0.0,
        "total_sales": _money(total_sales),
        "total_orders": total_orders,
        "overall_acos": 0.0,
        "overall_roas": 0.0,
    }


def build_aggregate_summary_for_invalid_traffic(rows) -> dict:
    """Invalid-traffic rows track impressions + invalid %, not spend/sales.
    Summary therefore only carries row counts (spend/sales/orders = 0)."""
    return {
        "total_rows": len(rows),
        "total_spend": 0.0,
        "total_sales": 0.0,
        "total_orders": 0,
        "overall_acos": 0.0,
        "overall_roas": 0.0,
    }