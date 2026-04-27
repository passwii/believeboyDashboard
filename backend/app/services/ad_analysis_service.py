from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
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
    AdUploadTimeTrendRow,
    AdUploadTargetRow,
)
import app.services.project_service as project_service
from app.utils.country import _normalize_country

DECIMAL_ZERO = Decimal('0')


def _normalize_dimension(value: str | None) -> str | None:
    normalized = (value or '').strip().lower()
    return normalized or None


def _round_money(value: Decimal) -> float:
    return float(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def _round_ratio(value: Decimal) -> float:
    return float(value.quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP))


def _safe_ratio(numerator: Decimal, denominator: Decimal | int) -> Decimal:
    if isinstance(denominator, int):
        if denominator <= 0:
            return DECIMAL_ZERO
        denominator = Decimal(denominator)
    if denominator <= 0:
        return DECIMAL_ZERO
    return numerator / denominator


def _serialize_decimal(value: Decimal) -> float:
    return float(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))


def _date_range_days(*, date_from: date | None, date_to: date | None) -> int | None:
    if date_from is None or date_to is None or date_to < date_from:
        return None
    return (date_to - date_from).days + 1


def _build_previous_period(*, date_from: date | None, date_to: date | None) -> tuple[date | None, date | None]:
    days = _date_range_days(date_from=date_from, date_to=date_to)
    if days is None or date_from is None:
        return None, None
    previous_end = date.fromordinal(date_from.toordinal() - 1)
    previous_start = date.fromordinal(previous_end.toordinal() - days + 1)
    return previous_start, previous_end


def _build_period_comparison(
    *,
    current_start: date | None,
    current_end: date | None,
    previous_start: date | None,
    previous_end: date | None,
    current_spend: Decimal,
    previous_spend: Decimal,
    current_clicks: int,
    previous_clicks: int,
    current_sales: Decimal,
    previous_sales: Decimal,
    current_orders: int,
    previous_orders: int,
) -> dict[str, object] | None:
    if current_start is None or current_end is None or previous_start is None or previous_end is None:
        return None
    current_cpc = _safe_ratio(current_spend, current_clicks)
    previous_cpc = _safe_ratio(previous_spend, previous_clicks)
    current_acos = _safe_ratio(current_spend, current_sales)
    previous_acos = _safe_ratio(previous_spend, previous_sales)
    spend_change_ratio = _round_ratio(_safe_ratio(current_spend - previous_spend, previous_spend)) if previous_spend > 0 else None
    clicks_change_ratio = _round_ratio(_safe_ratio(Decimal(current_clicks - previous_clicks), previous_clicks)) if previous_clicks > 0 else None
    sales_change_ratio = _round_ratio(_safe_ratio(current_sales - previous_sales, previous_sales)) if previous_sales > 0 else None
    orders_change_ratio = _round_ratio(_safe_ratio(Decimal(current_orders - previous_orders), previous_orders)) if previous_orders > 0 else None
    cpc_change_ratio = _round_ratio(_safe_ratio(current_cpc - previous_cpc, previous_cpc)) if previous_cpc > 0 else None
    acos_change_ratio = _round_ratio(_safe_ratio(current_acos - previous_acos, previous_acos)) if previous_acos > 0 else None

    if spend_change_ratio is None:
        summary = '上一周期没有足够数据，当前周期先作为基准观察。'
    elif spend_change_ratio > 0 and (sales_change_ratio is None or (sales_change_ratio < spend_change_ratio)):
        summary = '当前周期投放规模放大，但产出增长弱于花费增长，效率承压。'
    elif spend_change_ratio > 0:
        summary = '当前周期花费和产出同步增长，整体属于扩量阶段。'
    elif sales_change_ratio is not None and sales_change_ratio >= 0:
        summary = '当前周期在收缩花费的同时保持了产出，偏向收缩提效。'
    else:
        summary = '当前周期规模和产出同步走弱，需要优先回看管理层与来源层。'

    return {
        'current_start': current_start.isoformat(),
        'current_end': current_end.isoformat(),
        'previous_start': previous_start.isoformat(),
        'previous_end': previous_end.isoformat(),
        'spend_change_ratio': spend_change_ratio,
        'clicks_change_ratio': clicks_change_ratio,
        'sales_change_ratio': sales_change_ratio,
        'orders_change_ratio': orders_change_ratio,
        'cpc_change_ratio': cpc_change_ratio,
        'acos_change_ratio': acos_change_ratio,
        'summary': summary,
    }


def _matches_dimension(value: str | None, expected: str | None) -> bool:
    if expected is None:
        return True
    return _normalize_dimension(value) == expected


def _pick_latest_row(rows: list[object], *, date_attr: str = 'report_end_date') -> object | None:
    latest_row = None
    latest_key: tuple[date, int] | None = None
    for row in rows:
        row_date = getattr(row, date_attr, None) or date.min
        row_id = int(getattr(row, 'id', 0) or 0)
        row_key = (row_date, row_id)
        if latest_key is None or row_key > latest_key:
            latest_key = row_key
            latest_row = row
    return latest_row


def _apply_report_date_filters(stmt, *, date_from: date | None, date_to: date | None):
    if date_from is not None:
        stmt = stmt.where(AdUploadFile.report_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(AdUploadFile.report_date <= date_to)
    return stmt


def _apply_campaign_name_filter(stmt, campaign_field, *, campaign: str | None):
    normalized = (campaign or '').strip()
    if normalized:
        stmt = stmt.where(campaign_field == normalized)
    return stmt


def _filter_rows_by_campaigns(rows: list[object], campaign_names: set[str] | None) -> list[object]:
    if campaign_names is None:
        return rows
    return [row for row in rows if ((getattr(row, 'campaign_name', None) or '').strip() or '-') in campaign_names]


def _load_campaign_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[AdUploadCampaignRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadBudgetRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadPromotedProductRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadPlacementRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadSearchTermRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadSearchTermShareRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadInvalidTrafficRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadTargetRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[AdUploadTimeTrendRow]:
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
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
) -> list[AdUploadPurchasedProductRow]:
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


def _resolve_related_campaigns(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    search_term: str | None = None,
    placement: str | None = None,
) -> set[str] | None:
    normalized_campaign = (campaign or '').strip()
    if normalized_campaign:
        campaign_names = {normalized_campaign}
    else:
        campaign_names: set[str] | None = None

    normalized_sku = _normalize_dimension(sku)
    if normalized_sku is not None:
        product_rows = _load_product_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        purchased_rows = _load_purchased_product_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        sku_campaigns = {
            ((row.campaign_name or '').strip() or '-')
            for row in [*product_rows, *purchased_rows]
            if _matches_dimension(getattr(row, 'ad_sku', None), normalized_sku)
        }
        campaign_names = sku_campaigns if campaign_names is None else campaign_names & sku_campaigns

    normalized_search_term = _normalize_dimension(search_term)
    if normalized_search_term is not None:
        search_rows = _load_search_term_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        term_campaigns = {
            ((row.campaign_name or '').strip() or '-')
            for row in search_rows
            if _matches_dimension(row.search_term, normalized_search_term)
        }
        campaign_names = term_campaigns if campaign_names is None else campaign_names & term_campaigns

    normalized_placement = _normalize_dimension(placement)
    if normalized_placement is not None:
        placement_rows = _load_placement_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        placement_campaigns = {
            ((row.campaign_name or '').strip() or '-')
            for row in placement_rows
            if _matches_dimension(row.placement, normalized_placement)
        }
        campaign_names = placement_campaigns if campaign_names is None else campaign_names & placement_campaigns

    return campaign_names


def _grade_campaign(*, orders: int, acos: Decimal, clicks: int, spend: Decimal) -> str:
    if orders >= 2 and (acos <= Decimal('0.25') or acos == DECIMAL_ZERO):
        return 'A'
    if orders >= 1 and acos <= Decimal('0.35'):
        return 'B'
    if clicks >= 5 and orders == 0 and spend >= Decimal('5'):
        return 'D'
    if acos > Decimal('0.45'):
        return 'C'
    return 'Observe'


def _grade_product(*, orders: int, acos: Decimal, ctr: Decimal, clicks: int) -> str:
    if orders >= 2 and (acos <= Decimal('0.25') or acos == DECIMAL_ZERO):
        return '主推'
    if orders >= 1 and acos <= Decimal('0.35'):
        return '潜力'
    if clicks >= 5 and orders == 0:
        return '止损'
    if ctr < Decimal('0.005'):
        return '低点击'
    return '观察'


def _build_issue_card(
    *,
    title: str,
    level: str,
    summary: str,
    drill_to: str,
    next_step: str,
) -> dict[str, str]:
    return {
        'title': title,
        'level': level,
        'summary': summary,
        'drill_to': drill_to,
        'next_step': next_step,
    }


def _build_narrative_section(
    *,
    title: str,
    summary: str,
    evidence: list[str],
    action: str | None = None,
    drill_to: str | None = None,
) -> dict[str, object]:
    return {
        'title': title,
        'summary': summary,
        'evidence': evidence,
        'action': action,
        'drill_to': drill_to,
    }


def _classify_campaign_next_action(
    *,
    grade: str,
    budget_gap: Decimal,
    cross_sell_sales: Decimal,
    orders: int,
    spend: Decimal,
) -> str:
    if grade == 'A' and budget_gap > DECIMAL_ZERO:
        return '加预算放量'
    if grade in {'A', 'B'} and (orders > 0 or cross_sell_sales > DECIMAL_ZERO):
        return '稳定放量'
    if grade == 'D' or (orders == 0 and spend >= Decimal('10')):
        return '暂停排查'
    if grade == 'C':
        return '优化控量'
    return '继续观察'


def _classify_search_term_action(
    *,
    orders: int,
    impression_share: Decimal,
    acos: Decimal,
    clicks: int,
) -> str:
    if orders >= 1 and impression_share > DECIMAL_ZERO and impression_share < Decimal('0.08'):
        return '提竞价争份额'
    if orders >= 1 and (acos <= Decimal('0.35') or acos == DECIMAL_ZERO):
        return '加词放量'
    if clicks >= 5 and orders == 0:
        return '否词/降价'
    return '继续观察'


def _classify_target_action(
    *,
    orders: int,
    acos: Decimal,
    clicks: int,
    ctr: Decimal,
    top_share: Decimal,
) -> str:
    if orders >= 1 and (acos <= Decimal('0.35') or acos == DECIMAL_ZERO):
        return '保留放量'
    if clicks >= 5 and orders == 0:
        return '降价/隔离'
    if ctr >= Decimal('0.01') and top_share < Decimal('0.01'):
        return '提高首页系数'
    return '持续观察'


def _classify_budget_action(
    *,
    utilization: Decimal,
    orders: int,
    acos: Decimal,
    spend: Decimal,
) -> str:
    if utilization < Decimal('0.95'):
        if orders > 0 and (acos <= Decimal('0.35') or acos == DECIMAL_ZERO):
            return '优先加预算'
        if spend >= Decimal('10') and orders == 0:
            return '先优化再加预算'
        return '观察预算'
    return '预算充足'


def _classify_budget_next_step(action: str) -> str:
    if action == '优先加预算':
        return '今天补预算，优先保障在线时长。'
    if action == '先优化再加预算':
        return '先回到活动和搜索词控浪费，再决定是否补预算。'
    if action == '观察预算':
        return '先保留当前预算，继续观察转化承接。'
    return '当前不用调整预算。'


def _classify_placement_action(
    *,
    orders: int,
    cvr: Decimal,
    acos: Decimal,
    clicks: int,
    ctr: Decimal,
) -> str:
    if orders >= 1 and cvr >= Decimal('0.08') and (acos <= Decimal('0.35') or acos == DECIMAL_ZERO):
        return '可提高系数'
    if clicks >= 5 and orders == 0:
        return '谨慎降价'
    if ctr < Decimal('0.005'):
        return '流量偏弱'
    return '持续观察'


def _classify_placement_next_step(action: str) -> str:
    if action == '可提高系数':
        return '可以提高该广告位系数，优先争取更多高质量曝光。'
    if action == '谨慎降价':
        return '先下调系数，避免继续在低效位置消耗。'
    if action == '流量偏弱':
        return '先不要抬价，回看素材和入口质量。'
    return '维持当前系数，继续看量和转化。'


def _classify_traffic_risk(
    *,
    invalid_click_rate: Decimal,
    invalid_impression_rate: Decimal,
) -> str:
    if invalid_click_rate >= Decimal('0.25') or invalid_impression_rate >= Decimal('0.4'):
        return '高风险'
    if invalid_click_rate >= Decimal('0.15') or invalid_impression_rate >= Decimal('0.25'):
        return '中风险'
    return '正常'


def _classify_traffic_next_action(risk_level: str) -> str:
    if risk_level == '高风险':
        return '先暂停排查，优先检查异常入口和异常广告位。'
    if risk_level == '中风险':
        return '继续监控，并回看投放入口是否集中在低质流量。'
    return '当前无需处理，保持监控。'


def _ensure_project_access(db: Session, *, project_id: int, operator: str | None, is_admin: bool) -> None:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=is_admin,
    )


def _build_time_trend_summary(rows: list[AdUploadTimeTrendRow]) -> list[dict[str, object]]:
    grouped: dict[str, dict[str, Decimal | int]] = {}
    for row in rows:
        key = row.report_start_date.isoformat()
        bucket = grouped.setdefault(
            key,
            {
                'clicks': 0,
                'spend': DECIMAL_ZERO,
            },
        )
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)

    summary: list[dict[str, object]] = []
    running_spend = DECIMAL_ZERO
    previous_spend = DECIMAL_ZERO
    for report_date in sorted(grouped):
        bucket = grouped[report_date]
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        running_spend += spend
        cpc = _safe_ratio(spend, clicks)
        spend_change_ratio = _safe_ratio(spend - previous_spend, previous_spend) if previous_spend > 0 else DECIMAL_ZERO
        summary.append(
            {
                'report_date': report_date,
                'clicks': clicks,
                'spend': _serialize_decimal(spend),
                'cpc': _serialize_decimal(cpc),
                'running_spend': _serialize_decimal(running_spend),
                'spend_change_ratio': _round_ratio(spend_change_ratio),
            }
        )
        previous_spend = spend

    return summary


def _classify_cross_sell_action(*, sales: Decimal, orders: int) -> str:
    if orders >= 2 or sales >= Decimal('100'):
        return '放大关联'
    if orders >= 1:
        return '继续观察'
    return '暂无关联转化'


def _classify_product_next_action(*, grade: str, ctr: Decimal, clicks: int, orders: int, cross_sell_action: str) -> str:
    if grade == '主推' and cross_sell_action == '放大关联':
        return '优先放量并强化关联承接'
    if grade in {'主推', '潜力'}:
        return '保持放量并继续抢高质量流量'
    if clicks >= 5 and orders == 0:
        return '先查转化承接，再决定是否控量'
    if ctr < Decimal('0.005'):
        return '先优化点击承接，再追加预算'
    return '继续观察'


def _build_purchased_product_items(rows: list[AdUploadPurchasedProductRow]) -> list[dict[str, object]]:
    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        purchased_asin = (row.purchased_asin or '').strip() or '-'
        ad_sku = (row.ad_sku or '').strip() or '-'
        key = (purchased_asin, ad_sku)
        bucket = grouped.setdefault(
            key,
            {
                'purchased_asin': purchased_asin,
                'ad_sku': ad_sku,
                'campaigns': set(),
                'other_sku_units_7d': 0,
                'other_sku_orders_7d': 0,
                'other_sku_sales_7d': DECIMAL_ZERO,
            },
        )
        campaigns = bucket['campaigns']
        if isinstance(campaigns, set):
            campaigns.add((row.campaign_name or '').strip() or '-')
        bucket['other_sku_units_7d'] = int(bucket['other_sku_units_7d']) + int(row.other_sku_units_7d or 0)
        bucket['other_sku_orders_7d'] = int(bucket['other_sku_orders_7d']) + int(row.other_sku_orders_7d or 0)
        bucket['other_sku_sales_7d'] = Decimal(bucket['other_sku_sales_7d']) + Decimal(row.other_sku_sales_7d or 0)

    items = []
    for bucket in grouped.values():
        sales = Decimal(bucket['other_sku_sales_7d'])
        orders = int(bucket['other_sku_orders_7d'])
        units = int(bucket['other_sku_units_7d'])
        campaigns = bucket['campaigns']
        items.append(
            {
                'purchased_asin': str(bucket['purchased_asin']),
                'ad_sku': str(bucket['ad_sku']),
                'campaign_count': len(campaigns) if isinstance(campaigns, set) else 0,
                'other_sku_units_7d': units,
                'other_sku_orders_7d': orders,
                'other_sku_sales_7d': _serialize_decimal(sales),
                'action': _classify_cross_sell_action(sales=sales, orders=orders),
            }
        )

    items.sort(key=lambda item: (float(item['other_sku_sales_7d']), int(item['other_sku_orders_7d'])), reverse=True)
    return items


def _build_purchased_product_lookup(rows: list[AdUploadPurchasedProductRow]) -> dict[tuple[str, str], dict[str, object]]:
    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        ad_sku = (row.ad_sku or '').strip() or '-'
        ad_asin = (row.ad_asin or '').strip() or '-'
        key = (ad_sku, ad_asin)
        bucket = grouped.setdefault(
            key,
            {
                'cross_sell_asin_count': set(),
                'cross_sell_orders_7d': 0,
                'cross_sell_sales_7d': DECIMAL_ZERO,
                'top_purchased_asin': '-',
                'top_purchased_sales_7d': DECIMAL_ZERO,
            },
        )
        purchased_asin = (row.purchased_asin or '').strip() or '-'
        asins = bucket['cross_sell_asin_count']
        if isinstance(asins, set):
            asins.add(purchased_asin)
        bucket['cross_sell_orders_7d'] = int(bucket['cross_sell_orders_7d']) + int(row.other_sku_orders_7d or 0)
        bucket['cross_sell_sales_7d'] = Decimal(bucket['cross_sell_sales_7d']) + Decimal(row.other_sku_sales_7d or 0)
        row_sales = Decimal(row.other_sku_sales_7d or 0)
        if row_sales >= Decimal(bucket['top_purchased_sales_7d']):
            bucket['top_purchased_sales_7d'] = row_sales
            bucket['top_purchased_asin'] = purchased_asin

    lookup: dict[tuple[str, str], dict[str, object]] = {}
    for key, bucket in grouped.items():
        sales = Decimal(bucket['cross_sell_sales_7d'])
        orders = int(bucket['cross_sell_orders_7d'])
        asins = bucket['cross_sell_asin_count']
        lookup[key] = {
            'cross_sell_asin_count': len(asins) if isinstance(asins, set) else 0,
            'cross_sell_orders_7d': orders,
            'cross_sell_sales_7d': _serialize_decimal(sales),
            'top_purchased_asin': str(bucket['top_purchased_asin']),
            'cross_sell_action': _classify_cross_sell_action(sales=sales, orders=orders),
        }
    return lookup


def _build_campaign_budget_lookup(rows: list[AdUploadBudgetRow]) -> dict[str, dict[str, object]]:
    grouped: dict[str, list[AdUploadBudgetRow]] = {}
    for row in rows:
        campaign_name = (row.campaign_name or '').strip() or '-'
        grouped.setdefault(campaign_name, []).append(row)

    lookup: dict[str, dict[str, object]] = {}
    for key, bucket in grouped.items():
        latest_row = _pick_latest_row(bucket)
        if not isinstance(latest_row, AdUploadBudgetRow):
            continue
        budget_gap = max(
            Decimal(latest_row.suggested_budget or 0) - Decimal(latest_row.budget or 0),
            DECIMAL_ZERO,
        )
        lookup[key] = {
            'budget_gap': _serialize_decimal(budget_gap),
            'budget_utilization_rate': _round_ratio(Decimal(latest_row.budget_utilization_rate or 0)),
            'missed_sales_max': _serialize_decimal(Decimal(latest_row.missed_sales_max or 0)),
        }
    return lookup


def _build_campaign_cross_sell_lookup(rows: list[AdUploadPurchasedProductRow]) -> dict[str, dict[str, object]]:
    grouped: dict[str, dict[str, object]] = {}
    for row in rows:
        campaign_name = (row.campaign_name or '').strip() or '-'
        bucket = grouped.setdefault(
            campaign_name,
            {
                'cross_sell_orders_7d': 0,
                'cross_sell_sales_7d': DECIMAL_ZERO,
            },
        )
        bucket['cross_sell_orders_7d'] = int(bucket['cross_sell_orders_7d']) + int(row.other_sku_orders_7d or 0)
        bucket['cross_sell_sales_7d'] = Decimal(bucket['cross_sell_sales_7d']) + Decimal(row.other_sku_sales_7d or 0)

    lookup: dict[str, dict[str, object]] = {}
    for key, bucket in grouped.items():
        sales = Decimal(bucket['cross_sell_sales_7d'])
        orders = int(bucket['cross_sell_orders_7d'])
        lookup[key] = {
            'cross_sell_orders_7d': orders,
            'cross_sell_sales_7d': _serialize_decimal(sales),
            'cross_sell_action': _classify_cross_sell_action(sales=sales, orders=orders),
        }
    return lookup


def build_overview(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    previous_date_from, previous_date_to = _build_previous_period(date_from=date_from, date_to=date_to)

    campaign_rows = _load_campaign_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    budget_rows = _load_budget_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    product_rows = _load_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    placement_rows = _load_placement_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    search_term_rows = _load_search_term_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    invalid_traffic_rows = _load_invalid_traffic_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    time_trend_rows = _load_time_trend_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    purchased_product_rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    previous_campaign_rows = (
        _load_campaign_rows(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=previous_date_from,
            date_to=previous_date_to,
        )
        if previous_date_from is not None and previous_date_to is not None
        else []
    )
    trend_summary = _build_time_trend_summary(time_trend_rows)
    cross_sell_items = _build_purchased_product_items(purchased_product_rows)

    total_impressions = sum(int(row.impressions or 0) for row in campaign_rows)
    total_clicks = sum(int(row.clicks or 0) for row in campaign_rows)
    total_orders = sum(int(row.orders_7d or 0) for row in campaign_rows)
    total_spend = sum((Decimal(row.spend or 0) for row in campaign_rows), DECIMAL_ZERO)
    total_sales = sum((Decimal(row.sales_7d or 0) for row in campaign_rows), DECIMAL_ZERO)
    total_cross_sell_sales = sum(
        (Decimal(str(item['other_sku_sales_7d'])) for item in cross_sell_items),
        DECIMAL_ZERO,
    )
    total_cross_sell_orders = sum(int(item['other_sku_orders_7d']) for item in cross_sell_items)
    previous_total_clicks = sum(int(row.clicks or 0) for row in previous_campaign_rows)
    previous_total_orders = sum(int(row.orders_7d or 0) for row in previous_campaign_rows)
    previous_total_spend = sum((Decimal(row.spend or 0) for row in previous_campaign_rows), DECIMAL_ZERO)
    previous_total_sales = sum((Decimal(row.sales_7d or 0) for row in previous_campaign_rows), DECIMAL_ZERO)

    ctr = _safe_ratio(Decimal(total_clicks), total_impressions)
    cpc = _safe_ratio(total_spend, total_clicks)
    acos = _safe_ratio(total_spend, total_sales)
    roas = _safe_ratio(total_sales, total_spend)
    comparison = _build_period_comparison(
        current_start=date_from,
        current_end=date_to,
        previous_start=previous_date_from,
        previous_end=previous_date_to,
        current_spend=total_spend,
        previous_spend=previous_total_spend,
        current_clicks=total_clicks,
        previous_clicks=previous_total_clicks,
        current_sales=total_sales,
        previous_sales=previous_total_sales,
        current_orders=total_orders,
        previous_orders=previous_total_orders,
    )

    issue_cards: list[dict[str, str]] = []
    if total_clicks > 0 and total_orders == 0 and total_spend >= Decimal('10'):
        issue_cards.append(
            _build_issue_card(
                title='高花费无单',
                level='high',
                summary='当前汇总层出现明显点击消耗，但还没有形成订单转化。',
                drill_to='campaigns',
                next_step='先下钻活动页，收紧高花费无单活动，再联动搜索词排查浪费点。',
            )
        )
    if total_impressions > 0 and ctr < Decimal('0.005'):
        issue_cards.append(
            _build_issue_card(
                title='点击率偏低',
                level='medium',
                summary='当前 CTR 偏低，建议优先检查广告位、主图和关键词精准度。',
                drill_to='placements',
                next_step='先看广告位和投放入口，再决定是调 placement 还是回到素材与词路。',
            )
        )
    budget_limited_rows = [
        row
        for row in budget_rows
        if Decimal(row.budget_utilization_rate or 0) < Decimal('0.95')
        and (int(row.orders_7d or 0) > 0 or Decimal(row.sales_7d or 0) > DECIMAL_ZERO)
    ]
    if budget_limited_rows:
        issue_cards.append(
            _build_issue_card(
                title='存在预算受限活动',
                level='medium',
                summary=f'当前识别到 {len(budget_limited_rows)} 个有单或有销售额但预算在线时间不足的活动。',
                drill_to='budget',
                next_step='进入预算页，优先处理有订单或有关联销售的预算缺口活动。',
            )
        )
    waste_terms = [
        row for row in search_term_rows if int(row.clicks or 0) >= 3 and int(row.orders_7d or 0) == 0
    ]
    if waste_terms:
        issue_cards.append(
            _build_issue_card(
                title='存在浪费搜索词',
                level='medium',
                summary=f'当前识别到 {len(waste_terms)} 个达到观察门槛但未出单的搜索词。',
                drill_to='search-terms',
                next_step='进入搜索词页，优先处理达到否词或降价门槛的词。',
            )
        )
    high_risk_traffic_rows = [
        row
        for row in invalid_traffic_rows
        if Decimal(row.invalid_click_rate or 0) >= Decimal('0.2')
        or Decimal(row.invalid_impression_rate or 0) >= Decimal('0.35')
    ]
    if high_risk_traffic_rows:
        issue_cards.append(
            _build_issue_card(
                title='流量质量异常',
                level='high',
                summary=f'当前识别到 {len(high_risk_traffic_rows)} 个无效流量偏高的活动，建议优先排查异常入口。',
                drill_to='traffic-quality',
                next_step='先定位异常活动，再回到投放入口和广告位检查是否有异常流量来源。',
            )
        )
    weak_placement_rows = [
        row
        for row in placement_rows
        if int(row.clicks or 0) >= 3
        and int(row.orders_7d or 0) == 0
        and Decimal(row.spend or 0) >= Decimal('3')
    ]
    if weak_placement_rows:
        issue_cards.append(
            _build_issue_card(
                title='存在低效广告位',
                level='medium',
                summary=f'当前识别到 {len(weak_placement_rows)} 条高点击未出单的广告位明细，建议结合广告位页下钻。',
                drill_to='placements',
                next_step='进入广告位页，优先下调高点击无单的位置系数。',
            )
        )
    if len(trend_summary) >= 2:
        latest_day = trend_summary[-1]
        previous_day = trend_summary[-2]
        latest_spend = Decimal(str(latest_day['spend']))
        previous_spend = Decimal(str(previous_day['spend']))
        if latest_spend >= Decimal('20') and latest_spend > previous_spend * Decimal('1.5'):
            issue_cards.append(
                _build_issue_card(
                    title='单日花费突增',
                    level='medium',
                    summary=(
                        f"{latest_day['report_date']} 花费较上一日抬升 "
                        f"{Decimal(str(latest_day['spend_change_ratio'])) * Decimal('100'):.2f}%，建议回看活动和预算变更。"
                    ),
                    drill_to='time-trend',
                    next_step='先确认趋势页的异常日期，再回到活动页看是否有放量或预算变化。',
                )
            )
    high_cross_sell_items = [item for item in cross_sell_items if str(item['action']) == '放大关联']
    if high_cross_sell_items:
        issue_cards.append(
            _build_issue_card(
                title='存在关联购买放大量',
                level='medium',
                summary=f'当前识别到 {len(high_cross_sell_items)} 个广告 SKU 明显带动其他商品成交，可结合 SKU 页继续加码。',
                drill_to='products',
                next_step='进入 SKU 页，优先对能带动交叉销售的 SKU 做预算和承接优化。',
            )
        )

    top_campaigns = sorted(
        [
            {
                'campaign_name': row.campaign_name or '-',
                'spend': _serialize_decimal(Decimal(row.spend or 0)),
                'sales_7d': _serialize_decimal(Decimal(row.sales_7d or 0)),
                'orders_7d': int(row.orders_7d or 0),
                'acos': _round_ratio(Decimal(row.acos or 0)),
            }
            for row in campaign_rows
        ],
        key=lambda item: (float(item['spend']), float(item['sales_7d'])),
        reverse=True,
    )[:5]

    top_products = sorted(
        [
            {
                'ad_sku': row.ad_sku or '-',
                'ad_asin': row.ad_asin or '-',
                'spend': _serialize_decimal(Decimal(row.spend or 0)),
                'sales_7d': _serialize_decimal(Decimal(row.sales_7d or 0)),
                'orders_7d': int(row.orders_7d or 0),
                'acos': _round_ratio(Decimal(row.acos or 0)),
            }
            for row in product_rows
        ],
        key=lambda item: (float(item['spend']), float(item['sales_7d'])),
        reverse=True,
    )[:5]

    top_waste_terms = sorted(
        [
            {
                'search_term': row.search_term or '-',
                'campaign_name': row.campaign_name or '-',
                'clicks': int(row.clicks or 0),
                'spend': _serialize_decimal(Decimal(row.spend or 0)),
                'orders_7d': int(row.orders_7d or 0),
            }
            for row in waste_terms
        ],
        key=lambda item: (float(item['spend']), int(item['clicks'])),
        reverse=True,
    )[:5]

    low_ctr_product_rows = [
        row
        for row in product_rows
        if int(row.impressions or 0) >= 100 and Decimal(row.ctr or 0) < Decimal('0.005')
    ]
    high_click_low_order_products = [
        row
        for row in product_rows
        if int(row.clicks or 0) >= 5 and int(row.orders_7d or 0) == 0 and Decimal(row.spend or 0) >= Decimal('5')
    ]
    high_spend_campaign = top_campaigns[0] if top_campaigns else None
    high_spend_product = top_products[0] if top_products else None
    narrative_sections: list[dict[str, object]] = []

    scale_or_efficiency_summary = '当前广告整体'
    scale_or_efficiency_evidence: list[str] = [
        f"花费 {_serialize_decimal(total_spend):,.2f} 美元，销售额 {_serialize_decimal(total_sales):,.2f} 美元，订单 {total_orders} 单。",
        f"CTR {_round_ratio(ctr) * 100:.2f}%，CPC {_serialize_decimal(cpc):,.2f} 美元，ACOS {_round_ratio(acos) * 100:.2f}%。",
    ]
    if total_sales > DECIMAL_ZERO and acos <= Decimal('0.35'):
        scale_or_efficiency_summary += '处于可放量区间，效率仍在可控范围内。'
    elif total_sales > DECIMAL_ZERO:
        scale_or_efficiency_summary += '仍有产出，但效率承压，需要先控浪费再扩量。'
    elif total_spend > DECIMAL_ZERO:
        scale_or_efficiency_summary += '已有消耗但产出不足，当前更像是控损阶段。'
    else:
        scale_or_efficiency_summary += '尚未形成有效投放规模。'
    if high_spend_campaign is not None:
        scale_or_efficiency_evidence.append(
            f"当前高消耗活动是 {high_spend_campaign['campaign_name']}，花费 {float(high_spend_campaign['spend']):.2f} 美元。"
        )
    narrative_sections.append(
        _build_narrative_section(
            title='总体结论',
            summary=f"{scale_or_efficiency_summary}{(' ' + str(comparison['summary'])) if comparison is not None and comparison.get('summary') else ''}",
            evidence=scale_or_efficiency_evidence,
            action='先确认整体是在放量提效还是放量失效，再决定往活动还是承接层继续下钻。',
            drill_to='campaigns',
        )
    )

    management_evidence: list[str] = []
    management_summary = '管理运营层目前没有出现明显的预算、广告位或流量质量异常。'
    management_action = '保持当前活动结构，继续观察趋势和核心活动。'
    management_drill = 'campaigns'
    if budget_limited_rows:
        management_evidence.append(f"有 {len(budget_limited_rows)} 个活动预算在线时间不足但仍有订单或销售额。")
        management_summary = '管理运营层的主要问题先看预算受限，增长没有被完全接住。'
        management_action = '优先给有效活动补预算，再回查是否还有低效活动同步放量。'
        management_drill = 'budget'
    if weak_placement_rows:
        management_evidence.append(f"有 {len(weak_placement_rows)} 条广告位明细出现高点击无单。")
        management_summary = '管理运营层同时存在广告位效率分化，位置结构正在拖累整体效率。'
        management_action = '优先回看高点击无单的广告位，避免首页或商品页继续低效消耗。'
        management_drill = 'placements'
    if high_risk_traffic_rows:
        management_evidence.append(f"有 {len(high_risk_traffic_rows)} 个活动出现高无效点击或高无效曝光。")
        management_summary = '管理运营层还有流量质量风险，不能把问题全部归因给商品承接。'
        management_action = '先排查异常入口和异常广告位，再做常规调价。'
        management_drill = 'traffic-quality'
    narrative_sections.append(
        _build_narrative_section(
            title='管理层归因',
            summary=management_summary,
            evidence=management_evidence or ['预算、广告位、流量质量三层目前都没有触发明显异常信号。'],
            action=management_action,
            drill_to=management_drill,
        )
    )

    traffic_evidence: list[str] = []
    traffic_summary = '来源层暂时没有明显的浪费词集中问题。'
    traffic_action = '继续观察搜索词结构，重点看新词与高份额缺口词。'
    if top_waste_terms:
        first_waste_term = top_waste_terms[0]
        traffic_summary = '来源层已经出现明确浪费点，部分搜索词正在消耗但没有带来订单。'
        traffic_evidence.append(
            f"浪费最高的搜索词是 {first_waste_term['search_term']}，花费 {float(first_waste_term['spend']):.2f} 美元，点击 {int(first_waste_term['clicks'])} 次。"
        )
        traffic_evidence.append(f"当前共识别到 {len(waste_terms)} 个达到观察门槛但未出单的搜索词。")
        traffic_action = '优先做否词、降价或拆精确承接，避免继续用低质量词放量。'
    narrative_sections.append(
        _build_narrative_section(
            title='来源层归因',
            summary=traffic_summary,
            evidence=traffic_evidence or ['当前搜索词层没有出现集中性的高花费无单词。'],
            action=traffic_action,
            drill_to='search-terms',
        )
    )

    product_evidence: list[str] = []
    product_summary = '商品承接层暂时没有形成强烈异常，流量与成交大体匹配。'
    product_action = '继续观察高消耗 SKU 的点击与转化，确认是否需要做素材或页面优化。'
    if low_ctr_product_rows:
        product_evidence.append(f"有 {len(low_ctr_product_rows)} 个 SKU 曝光已达到观察门槛，但 CTR 仍低于 0.50%。")
        product_summary = '商品承接层已经出现点击承接偏弱，部分 SKU 曝光能拿到但点不进来。'
        product_action = '优先优化主图、标题和价格表达，再决定是否继续加量。'
    if high_click_low_order_products:
        product_evidence.append(f"有 {len(high_click_low_order_products)} 个 SKU 已出现高点击低转化。")
        product_summary = '商品承接层不仅有点击承接问题，还有转化承接问题。'
        product_action = '先排查落地页竞争力、评价和变体价格带，再决定是否控量。'
    if high_cross_sell_items:
        product_evidence.append(f"有 {len(high_cross_sell_items)} 个广告 SKU 正在明显带动关联购买。")
        if product_summary.startswith('商品承接层暂时没有'):
            product_summary = '商品承接层整体不错，且部分 SKU 已经带动关联购买。'
        product_action = '把能带动关联成交的 SKU 列为优先保量对象，同时补足关联页面承接。'
    if high_spend_product is not None:
        product_evidence.append(
            f"当前高消耗 SKU 是 {high_spend_product['ad_sku']}，花费 {float(high_spend_product['spend']):.2f} 美元。"
        )
    narrative_sections.append(
        _build_narrative_section(
            title='承接层归因',
            summary=product_summary,
            evidence=product_evidence or ['推广商品和已购买商品层暂时没有出现明显承接异常。'],
            action=product_action,
            drill_to='products',
        )
    )

    return {
        'project_id': project_id,
        'country': normalized_country,
        'metrics': [
            {
                'label': 'Spend',
                'value': _serialize_decimal(total_spend),
                'display_value': f'${_serialize_decimal(total_spend):,.2f}',
                'helper': '广告总花费',
            },
            {
                'label': 'Sales 7d',
                'value': _serialize_decimal(total_sales),
                'display_value': f'${_serialize_decimal(total_sales):,.2f}',
                'helper': '7天销售额',
            },
            {
                'label': 'Orders 7d',
                'value': float(total_orders),
                'display_value': str(total_orders),
                'helper': '7天订单数',
            },
            {
                'label': 'CTR',
                'value': _round_ratio(ctr),
                'display_value': f'{_round_ratio(ctr) * 100:.2f}%',
                'helper': '点击率',
            },
            {
                'label': 'CPC',
                'value': _serialize_decimal(cpc),
                'display_value': f'${_serialize_decimal(cpc):,.2f}',
                'helper': '单次点击成本',
            },
            {
                'label': 'ACOS',
                'value': _round_ratio(acos),
                'display_value': f'{_round_ratio(acos) * 100:.2f}%',
                'helper': '广告投入产出比',
            },
            {
                'label': 'ROAS',
                'value': _round_ratio(roas),
                'display_value': f'{_round_ratio(roas):.2f}',
                'helper': '广告投资回报率',
            },
            {
                'label': 'Trend Days',
                'value': float(len(trend_summary)),
                'display_value': str(len(trend_summary)),
                'helper': '当前筛选范围内已入库的趋势天数',
            },
            {
                'label': 'Cross-sell Sales 7d',
                'value': _serialize_decimal(total_cross_sell_sales),
                'display_value': f'${_serialize_decimal(total_cross_sell_sales):,.2f}',
                'helper': f'关联购买销售额 / 订单 {total_cross_sell_orders}',
            },
        ],
        'issue_cards': issue_cards,
        'narrative_sections': narrative_sections,
        'comparison': comparison,
        'top_campaigns': top_campaigns,
        'top_products': top_products,
        'top_waste_terms': top_waste_terms,
        'trend_summary': trend_summary[-7:],
        'top_cross_sell_products': cross_sell_items[:5],
    }


def build_campaigns(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    search_term: str | None = None,
    placement: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_campaign_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        search_term=search_term,
        placement=placement,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    budget_rows = _load_budget_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    budget_rows = _filter_rows_by_campaigns(budget_rows, campaign_scope)
    purchased_product_rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    purchased_product_rows = _filter_rows_by_campaigns(purchased_product_rows, campaign_scope)
    budget_lookup = _build_campaign_budget_lookup(budget_rows)
    cross_sell_lookup = _build_campaign_cross_sell_lookup(purchased_product_rows)

    grouped: dict[str, dict[str, object]] = {}
    for row in rows:
        key = (row.campaign_name or '').strip() or '-'
        bucket = grouped.setdefault(
            key,
            {
                'campaign_name': key,
                'status': row.status or '-',
                'targeting_type': row.targeting_type or '-',
                'bidding_strategy': row.bidding_strategy or '-',
                'latest_row': row,
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
            },
        )
        latest_row = bucket['latest_row']
        if isinstance(latest_row, AdUploadCampaignRow):
            if (row.report_end_date, int(row.id or 0)) >= (latest_row.report_end_date, int(latest_row.id or 0)):
                bucket['latest_row'] = row
                bucket['status'] = row.status or '-'
                bucket['targeting_type'] = row.targeting_type or '-'
                bucket['bidding_strategy'] = row.bidding_strategy or '-'
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)

    items = []
    for bucket in grouped.values():
        campaign_name = str(bucket['campaign_name'])
        budget_info = budget_lookup.get(
            campaign_name,
            {
                'budget_gap': 0.0,
                'budget_utilization_rate': 0.0,
                'missed_sales_max': 0.0,
            },
        )
        cross_sell_info = cross_sell_lookup.get(
            campaign_name,
            {
                'cross_sell_orders_7d': 0,
                'cross_sell_sales_7d': 0.0,
                'cross_sell_action': '暂无关联转化',
            },
        )
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        clicks = int(bucket['clicks'])
        impressions = int(bucket['impressions'])
        orders = int(bucket['orders_7d'])
        ctr = _safe_ratio(Decimal(clicks), impressions)
        cpc = _safe_ratio(spend, clicks)
        acos = _safe_ratio(spend, sales)
        roas = _safe_ratio(sales, spend)
        grade = _grade_campaign(orders=orders, acos=acos, clicks=clicks, spend=spend)
        budget_gap = Decimal(str(budget_info['budget_gap']))
        cross_sell_sales = Decimal(str(cross_sell_info['cross_sell_sales_7d']))
        latest_row = bucket['latest_row']
        latest_budget = Decimal(latest_row.budget or 0) if isinstance(latest_row, AdUploadCampaignRow) else DECIMAL_ZERO
        items.append(
            {
                'campaign_name': campaign_name,
                'status': bucket['status'],
                'targeting_type': bucket['targeting_type'],
                'bidding_strategy': bucket['bidding_strategy'],
                'budget': _serialize_decimal(latest_budget),
                'impressions': impressions,
                'clicks': clicks,
                'ctr': _round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'acos': _round_ratio(acos),
                'roas': _round_ratio(roas),
                'grade': grade,
                'budget_gap': float(budget_info['budget_gap']),
                'budget_utilization_rate': float(budget_info['budget_utilization_rate']),
                'missed_sales_max': float(budget_info['missed_sales_max']),
                'cross_sell_orders_7d': int(cross_sell_info['cross_sell_orders_7d']),
                'cross_sell_sales_7d': float(cross_sell_info['cross_sell_sales_7d']),
                'cross_sell_action': str(cross_sell_info['cross_sell_action']),
                'next_action': _classify_campaign_next_action(
                    grade=grade,
                    budget_gap=budget_gap,
                    cross_sell_sales=cross_sell_sales,
                    orders=orders,
                    spend=spend,
                ),
            }
        )

    items.sort(key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)
    high_grade_count = sum(1 for item in items if str(item['grade']) in {'A', 'B'})
    budget_candidate_count = sum(
        1
        for item in items
        if float(item['budget_gap']) > 0 and (int(item['orders_7d']) > 0 or float(item['cross_sell_sales_7d']) > 0)
    )
    cross_sell_winner_count = sum(1 for item in items if str(item['cross_sell_action']) == '放大关联')
    top_campaign = items[0] if items else None
    low_efficiency_campaigns = [
        item for item in items if (str(item['grade']) in {'C', 'D'}) or (float(item['spend']) >= 10 and int(item['orders_7d']) == 0)
    ]
    budget_gap_campaigns = [item for item in items if float(item['budget_gap']) > 0 and int(item['orders_7d']) > 0]
    cross_sell_campaigns = [item for item in items if str(item['cross_sell_action']) == '放大关联']
    campaign_narrative_sections = [
        _build_narrative_section(
            title='活动层结论',
            summary=(
                '当前活动层以稳定放量为主。'
                if high_grade_count > 0 and len(low_efficiency_campaigns) == 0
                else '当前活动层存在明显分化，部分活动可以放量，部分活动需要优先控损。'
            ),
            evidence=[
                f'当前共有 {len(items)} 个活动，其中 A/B 级活动 {high_grade_count} 个。',
                *(
                    [f"当前高消耗活动是 {top_campaign['campaign_name']}，花费 {float(top_campaign['spend']):.2f} 美元，ACOS {float(top_campaign['acos']) * 100:.2f}%."]
                    if top_campaign is not None
                    else []
                ),
                *(
                    [f'当前有 {len(low_efficiency_campaigns)} 个活动已进入低效或高花费无单区间。']
                    if low_efficiency_campaigns
                    else []
                ),
            ],
            action='先保住 A/B 级活动的量，再把 C/D 级活动拉回活动、搜索词、广告位逐层控浪费。',
            drill_to='campaigns',
        ),
        _build_narrative_section(
            title='预算归因',
            summary=(
                '活动层当前存在预算承接缺口，部分有效活动没有完全在线。'
                if budget_gap_campaigns
                else '活动层当前没有明显预算承接缺口，预算不是首要矛盾。'
            ),
            evidence=(
                [f'当前有 {len(budget_gap_campaigns)} 个有订单活动仍存在预算缺口。']
                if budget_gap_campaigns
                else ['当前高质量活动没有出现明显预算不足信号。']
            ),
            action='预算只优先给有单且 ACOS 可控的活动，其他活动先优化词路和广告位。',
            drill_to='budget',
        ),
        _build_narrative_section(
            title='关联放量判断',
            summary=(
                '部分活动不仅自身出单，还在带动其他商品成交。'
                if cross_sell_campaigns
                else '当前活动层的关联成交放大还不明显，主要先看主商品自身效率。'
            ),
            evidence=(
                [f'当前有 {len(cross_sell_campaigns)} 个活动出现明显关联带单。']
                if cross_sell_campaigns
                else ['已购买商品层暂时没有看到明显的活动级关联成交扩散。']
            ),
            action='对能带动关联成交的活动优先保预算，并把对应 SKU 列入承接优化名单。',
            drill_to='products',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '活动数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的活动数量',
            },
            {
                'label': 'A/B 活动',
                'value': str(high_grade_count),
                'helper': '达到稳定放量或持续观察标准的活动',
            },
            {
                'label': '预算候选',
                'value': str(budget_candidate_count),
                'helper': '有预算缺口且仍有产出空间的活动',
            },
            {
                'label': '关联放大量',
                'value': str(cross_sell_winner_count),
                'helper': '带动其他商品成交的活动',
            },
        ],
        'narrative_sections': campaign_narrative_sections,
        'items': items,
    }


def build_products(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    purchased_product_rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    purchased_lookup = _build_purchased_product_lookup(purchased_product_rows)
    normalized_sku = _normalize_dimension(sku)

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.ad_sku, normalized_sku):
            continue
        key = ((row.ad_sku or '').strip() or '-', (row.ad_asin or '').strip() or '-')
        bucket = grouped.setdefault(
            key,
            {
                'ad_sku': key[0],
                'ad_asin': key[1],
                'campaign_count': set(),
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
                'units_7d': 0,
            },
        )
        cast_set = bucket['campaign_count']
        if isinstance(cast_set, set):
            cast_set.add((row.campaign_name or '').strip() or '-')
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)
        bucket['units_7d'] = int(bucket['units_7d']) + int(row.units_7d or 0)

    items = []
    for bucket in grouped.values():
        lookup_key = (str(bucket['ad_sku']), str(bucket['ad_asin']))
        cross_sell = purchased_lookup.get(
            lookup_key,
            {
                'cross_sell_asin_count': 0,
                'cross_sell_orders_7d': 0,
                'cross_sell_sales_7d': 0.0,
                'top_purchased_asin': '-',
                'cross_sell_action': '暂无关联转化',
            },
        )
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = _safe_ratio(Decimal(clicks), impressions)
        cpc = _safe_ratio(spend, clicks)
        acos = _safe_ratio(spend, sales)
        cvr = _safe_ratio(Decimal(orders), clicks)
        grade = _grade_product(orders=orders, acos=acos, ctr=ctr, clicks=clicks)
        campaign_count = bucket['campaign_count']
        items.append(
            {
                'ad_sku': bucket['ad_sku'],
                'ad_asin': bucket['ad_asin'],
                'campaign_count': len(campaign_count) if isinstance(campaign_count, set) else 0,
                'primary_campaign': sorted(campaign_count)[0] if isinstance(campaign_count, set) and campaign_count else '-',
                'impressions': impressions,
                'clicks': clicks,
                'ctr': _round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'units_7d': int(bucket['units_7d']),
                'cvr_7d': _round_ratio(cvr),
                'acos': _round_ratio(acos),
                'grade': grade,
                'cross_sell_asin_count': int(cross_sell['cross_sell_asin_count']),
                'cross_sell_orders_7d': int(cross_sell['cross_sell_orders_7d']),
                'cross_sell_sales_7d': float(cross_sell['cross_sell_sales_7d']),
                'top_purchased_asin': str(cross_sell['top_purchased_asin']),
                'cross_sell_action': str(cross_sell['cross_sell_action']),
                'next_action': _classify_product_next_action(
                    grade=grade,
                    ctr=ctr,
                    clicks=clicks,
                    orders=orders,
                    cross_sell_action=str(cross_sell['cross_sell_action']),
                ),
            }
        )

    items.sort(key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)
    high_grade_count = sum(1 for item in items if str(item['grade']) in {'主推', '潜力'})
    cross_sell_winner_count = sum(1 for item in items if str(item['cross_sell_action']) == '放大关联')
    total_cross_sell_sales = sum((Decimal(str(item['cross_sell_sales_7d'])) for item in items), DECIMAL_ZERO)
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': 'SKU 数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的广告 SKU',
            },
            {
                'label': '主推/潜力',
                'value': str(high_grade_count),
                'helper': '值得继续放量的 SKU 数量',
            },
            {
                'label': '关联销售额',
                'value': f'${_serialize_decimal(total_cross_sell_sales):,.2f}',
                'helper': '来自已购买商品报表的其他 SKU 销售额',
            },
            {
                'label': '关联放大量',
                'value': str(cross_sell_winner_count),
                'helper': '存在明显交叉销售贡献的 SKU',
            },
        ],
        'items': items,
    }


def build_budget(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_budget_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)

    items = []
    for row in rows:
        budget = Decimal(row.budget or 0)
        suggested_budget = Decimal(row.suggested_budget or 0)
        utilization = Decimal(row.budget_utilization_rate or 0)
        spend = Decimal(row.spend or 0)
        sales = Decimal(row.sales_7d or 0)
        orders = int(row.orders_7d or 0)
        acos = Decimal(row.acos or 0)
        budget_gap = suggested_budget - budget

        action = _classify_budget_action(utilization=utilization, orders=orders, acos=acos, spend=spend)

        items.append(
            {
                'campaign_name': (row.campaign_name or '').strip() or '-',
                'status': row.status or '-',
                'budget': _serialize_decimal(budget),
                'suggested_budget': _serialize_decimal(suggested_budget),
                'budget_gap': _serialize_decimal(budget_gap if budget_gap > DECIMAL_ZERO else DECIMAL_ZERO),
                'budget_utilization_rate': _round_ratio(utilization),
                'missed_impressions_min': int(row.missed_impressions_min or 0),
                'missed_impressions_max': int(row.missed_impressions_max or 0),
                'missed_clicks_min': int(row.missed_clicks_min or 0),
                'missed_clicks_max': int(row.missed_clicks_max or 0),
                'missed_sales_min': _serialize_decimal(Decimal(row.missed_sales_min or 0)),
                'missed_sales_max': _serialize_decimal(Decimal(row.missed_sales_max or 0)),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'acos': _round_ratio(acos),
                'action': action,
                'next_step': _classify_budget_next_step(action),
            }
        )

    items.sort(
        key=lambda item: (
            float(item['budget_gap']),
            float(item['missed_sales_max']),
            1 if str(item['action']) == '优先加预算' else 0,
        ),
        reverse=True,
    )
    add_budget_count = sum(1 for item in items if str(item['action']) == '优先加预算')
    optimize_first_count = sum(1 for item in items if str(item['action']) == '先优化再加预算')
    observe_count = sum(1 for item in items if str(item['action']) == '观察预算')
    top_budget_item = items[0] if items else None
    budget_pressure_items = [item for item in items if float(item['budget_gap']) > 0 and int(item['orders_7d']) > 0]
    optimize_before_scale_items = [item for item in items if str(item['action']) == '先优化再加预算']
    budget_narrative_sections = [
        _build_narrative_section(
            title='预算层结论',
            summary=(
                '当前预算页已经出现明确承接缺口，部分有效活动没能完整在线。'
                if budget_pressure_items
                else '当前预算层整体平稳，预算不是当前最明显的限制项。'
            ),
            evidence=[
                f'当前共有 {len(items)} 条预算记录，其中优先加预算 {add_budget_count} 条。',
                *(
                    [f"当前预算缺口最大的活动是 {top_budget_item['campaign_name']}，预算差额 {float(top_budget_item['budget_gap']):.2f} 美元。"]
                    if top_budget_item is not None
                    else []
                ),
            ],
            action='先把有限预算给到有效活动，再回头处理低效活动，避免平均分配预算。',
            drill_to='budget',
        ),
        _build_narrative_section(
            title='是否直接加预算',
            summary=(
                '并不是所有预算缺口都应直接补，当前有一部分活动需要先优化再决定。'
                if optimize_before_scale_items
                else '当前预算候选活动大多可以直接进入补预算判断。'
            ),
            evidence=(
                [f'当前有 {len(optimize_before_scale_items)} 条预算记录属于“先优化再加预算”。']
                if optimize_before_scale_items
                else ['当前没有明显需要先优化词路和入口再决定预算的活动。']
            ),
            action='对“先优化再加预算”的活动，优先回看搜索词、投放入口和广告位质量。',
            drill_to='search-terms',
        ),
        _build_narrative_section(
            title='预算动作建议',
            summary='预算动作必须和活动质量联动，预算页本身不单独决定是否放量。',
            evidence=[
                '有单且 ACOS 可控的活动，预算缺口才有意义。',
                '高花费无单或 ACOS 失控活动，即使建议预算更高，也不应直接追加。',
            ],
            action='补预算前先确认活动等级，再把预算、词路和广告位作为一组动作一起处理。',
            drill_to='campaigns',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '预算活动数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的预算条目',
            },
            {
                'label': '优先加预算',
                'value': str(add_budget_count),
                'helper': '建议今天直接补预算的活动',
            },
            {
                'label': '先优化再加',
                'value': str(optimize_first_count),
                'helper': '需要先控浪费再决定预算的活动',
            },
            {
                'label': '继续观察',
                'value': str(observe_count),
                'helper': '当前只需要跟踪的预算条目',
            },
        ],
        'narrative_sections': budget_narrative_sections,
        'items': items,
    }


def build_placements(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    placement: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_placement_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        placement=placement,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    normalized_placement = _normalize_dimension(placement)

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.placement, normalized_placement):
            continue
        campaign_name = (row.campaign_name or '').strip() or '-'
        placement_name = (row.placement or '').strip() or '-'
        key = (campaign_name, placement_name)
        bucket = grouped.setdefault(
            key,
            {
                'campaign_name': campaign_name,
                'placement': placement_name,
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
                'units_7d': 0,
            },
        )
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)
        bucket['units_7d'] = int(bucket['units_7d']) + int(row.units_7d or 0)

    items = []
    for bucket in grouped.values():
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = _safe_ratio(Decimal(clicks), impressions)
        cpc = _safe_ratio(spend, clicks)
        acos = _safe_ratio(spend, sales)
        roas = _safe_ratio(sales, spend)
        cvr = _safe_ratio(Decimal(orders), clicks)

        action = _classify_placement_action(
            orders=orders,
            cvr=cvr,
            acos=acos,
            clicks=clicks,
            ctr=ctr,
        )

        items.append(
            {
                'campaign_name': bucket['campaign_name'],
                'placement': bucket['placement'],
                'impressions': impressions,
                'clicks': clicks,
                'ctr': _round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'units_7d': int(bucket['units_7d']),
                'cvr_7d': _round_ratio(cvr),
                'acos': _round_ratio(acos),
                'roas': _round_ratio(roas),
                'action': action,
                'next_step': _classify_placement_next_step(action),
            }
        )

    items.sort(key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)
    raise_count = sum(1 for item in items if str(item['action']) == '可提高系数')
    down_count = sum(1 for item in items if str(item['action']) == '谨慎降价')
    weak_count = sum(1 for item in items if str(item['action']) == '流量偏弱')
    top_placement_item = items[0] if items else None
    scale_placement_items = [item for item in items if str(item['action']) == '可提高系数']
    down_placement_items = [item for item in items if str(item['action']) == '谨慎降价']
    placement_narrative_sections = [
        _build_narrative_section(
            title='广告位层结论',
            summary=(
                '当前广告位层已经出现明显分化，不同位置不能再用同一套出价策略处理。'
                if scale_placement_items or down_placement_items
                else '当前广告位层暂时没有明显分化，位置不是当前最强归因。'
            ),
            evidence=[
                f'当前共有 {len(items)} 条“活动 × 广告位”记录，其中可提高系数 {raise_count} 条，谨慎降价 {down_count} 条。',
                *(
                    [f"当前高消耗广告位记录是 {top_placement_item['campaign_name']} / {top_placement_item['placement']}，花费 {float(top_placement_item['spend']):.2f} 美元。"]
                    if top_placement_item is not None
                    else []
                ),
            ],
            action='不要把首页、其余搜索位、商品页混成同一类策略，先按活动 × 广告位分别判断。',
            drill_to='placements',
        ),
        _build_narrative_section(
            title='提系数与降系数判断',
            summary=(
                '当前既有值得提系数的位置，也有应该优先控价的位置。'
                if scale_placement_items and down_placement_items
                else '当前主要以争取更多高质量位置为主。'
                if scale_placement_items
                else '当前主要以控制低效位置消耗为主。'
                if down_placement_items
                else '当前广告位动作以持续观察为主。'
            ),
            evidence=[
                *([f'当前有 {len(scale_placement_items)} 条广告位记录进入“可提高系数”区间。'] if scale_placement_items else []),
                *([f'当前有 {len(down_placement_items)} 条广告位记录进入“谨慎降价”区间。'] if down_placement_items else []),
                *(['当前没有位置层的极端异常，更多是常规跟踪。'] if not scale_placement_items and not down_placement_items else []),
            ],
            action='对高转化位置提系数，对高点击无单位置先降价，再回到活动和词路看是否是入口跑偏。',
            drill_to='placements',
        ),
        _build_narrative_section(
            title='位置问题怎么归因',
            summary='广告位问题不能脱离活动和商品承接单独判断。',
            evidence=[
                '同一个广告位在不同活动里可能表现完全不同。',
                '首页贵不一定错，核心是贵得值不值，要同时看 CVR、ACOS 和承接商品竞争力。',
            ],
            action='如果某位置持续高点击无单，先回查对应活动、搜索词和 SKU 承接，而不是一刀切降低全部系数。',
            drill_to='campaigns',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '广告位数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的广告位维度',
            },
            {
                'label': '提高系数',
                'value': str(raise_count),
                'helper': '值得争取更多曝光的位置',
            },
            {
                'label': '谨慎降价',
                'value': str(down_count),
                'helper': '高点击低转化、需要控价的位置',
            },
            {
                'label': '流量偏弱',
                'value': str(weak_count),
                'helper': '曝光有量但点击承接差的位置',
            },
        ],
        'narrative_sections': placement_narrative_sections,
        'items': items,
    }


def build_traffic_quality(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_invalid_traffic_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)

    items = []
    for row in rows:
        invalid_impression_rate = Decimal(row.invalid_impression_rate or 0)
        invalid_click_rate = Decimal(row.invalid_click_rate or 0)
        risk_level = _classify_traffic_risk(
            invalid_click_rate=invalid_click_rate,
            invalid_impression_rate=invalid_impression_rate,
        )

        items.append(
            {
                'campaign_name': (row.campaign_name or '').strip() or '-',
                'status': row.status or '-',
                'total_impressions': int(row.total_impressions or 0),
                'valid_impressions': int(row.valid_impressions or 0),
                'invalid_impressions': int(row.invalid_impressions or 0),
                'invalid_impression_rate': _round_ratio(invalid_impression_rate),
                'total_clicks': int(row.total_clicks or 0),
                'valid_clicks': int(row.valid_clicks or 0),
                'invalid_clicks': int(row.invalid_clicks or 0),
                'invalid_click_rate': _round_ratio(invalid_click_rate),
                'risk_level': risk_level,
                'next_step': _classify_traffic_next_action(risk_level),
            }
        )

    items.sort(
        key=lambda item: (float(item['invalid_click_rate']), float(item['invalid_impression_rate'])),
        reverse=True,
    )
    high_risk_count = sum(1 for item in items if str(item['risk_level']) == '高风险')
    medium_risk_count = sum(1 for item in items if str(item['risk_level']) == '中风险')
    normal_count = sum(1 for item in items if str(item['risk_level']) == '正常')
    max_invalid_click_rate = max((float(item['invalid_click_rate']) for item in items), default=0.0)
    top_risk_item = items[0] if items else None
    traffic_narrative_sections = [
        _build_narrative_section(
            title='流量质量结论',
            summary=(
                '当前流量质量层存在明显异常，需要优先排查异常入口。'
                if high_risk_count > 0
                else '当前流量质量层有轻度波动，但还没有到需要立即收紧的程度。'
                if medium_risk_count > 0
                else '当前流量质量层整体稳定，没有看到明显异常流量。'
            ),
            evidence=[
                f'当前高风险活动 {high_risk_count} 个，中风险活动 {medium_risk_count} 个，正常活动 {normal_count} 个。',
                *(
                    [f"当前最高无效点击率来自 {top_risk_item['campaign_name']}，无效点击率 {float(top_risk_item['invalid_click_rate']) * 100:.2f}%。"]
                    if top_risk_item is not None
                    else []
                ),
            ],
            action='先确认异常是否集中在少数活动，再回查投放入口和广告位，而不是直接全账户降价。',
            drill_to='traffic-quality',
        ),
        _build_narrative_section(
            title='异常流量怎么排查',
            summary='无效点击和无效曝光要分开看，不能一概当成转化差处理。',
            evidence=[
                '无效点击率高，优先怀疑入口质量或异常点击。',
                '无效曝光率高，优先怀疑展示位置、投放面过宽或低意图流量。',
            ],
            action='先定位活动，再依次排查投放对象、搜索词和广告位，确认异常流量来自哪里。',
            drill_to='targets',
        ),
        _build_narrative_section(
            title='和转化问题的边界',
            summary='流量质量异常没有排清之前，不能把问题直接归因为商品承接差。',
            evidence=[
                '如果无效点击先偏高，后续 ACOS、CVR 的恶化可能只是表象。',
                '只有在流量质量基本稳定后，商品承接层的诊断才更可信。',
            ],
            action='高风险活动先做异常流量隔离，确认流量正常后再进入商品页和搜索词页优化转化。',
            drill_to='campaigns',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '高风险活动',
                'value': str(high_risk_count),
                'helper': '优先排查异常入口和异常广告位',
            },
            {
                'label': '中风险活动',
                'value': str(medium_risk_count),
                'helper': '需要继续跟踪的流量异常活动',
            },
            {
                'label': '正常活动',
                'value': str(normal_count),
                'helper': '当前无明显流量异常的活动',
            },
            {
                'label': '最高无效点击率',
                'value': f'{max_invalid_click_rate * 100:.2f}%',
                'helper': '用于快速判断当前最差入口',
            },
        ],
        'narrative_sections': traffic_narrative_sections,
        'items': items,
    }


def build_search_terms(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    search_term: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_search_term_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    share_rows = _load_search_term_share_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        search_term=search_term,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    share_rows = _filter_rows_by_campaigns(share_rows, campaign_scope)
    normalized_search_term = _normalize_dimension(search_term)

    share_by_term: dict[tuple[str, str, str], dict[str, Decimal | int]] = {}
    for row in share_rows:
        search_term_key = _normalize_dimension(row.search_term)
        if search_term_key is None:
            continue
        match_type_key = _normalize_dimension(row.match_type) or '-'
        campaign_key = _normalize_dimension(row.campaign_name) or '-'
        key = (search_term_key, match_type_key, campaign_key)
        current = share_by_term.setdefault(
            key,
            {
                'impression_share': DECIMAL_ZERO,
                'impression_rank': 0,
            },
        )
        share_value = Decimal(row.impression_share or 0)
        rank_value = int(row.impression_rank or 0)
        if share_value > Decimal(current['impression_share']):
            current['impression_share'] = share_value
        if rank_value > 0 and (int(current['impression_rank']) == 0 or rank_value < int(current['impression_rank'])):
            current['impression_rank'] = rank_value

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.search_term, normalized_search_term):
            continue
        search_term = (row.search_term or '').strip() or '-'
        match_type = (row.match_type or '').strip() or '-'
        key = (search_term, match_type)
        bucket = grouped.setdefault(
            key,
            {
                'search_term': search_term,
                'match_type': match_type,
                'campaigns': set(),
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
            },
        )
        campaigns = bucket['campaigns']
        if isinstance(campaigns, set):
            campaigns.add((row.campaign_name or '').strip() or '-')
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)

    items = []
    for bucket in grouped.values():
        search_term = str(bucket['search_term'])
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = _safe_ratio(Decimal(clicks), impressions)
        cpc = _safe_ratio(spend, clicks)
        acos = _safe_ratio(spend, sales)
        cvr = _safe_ratio(Decimal(orders), clicks)
        campaigns = bucket['campaigns']
        campaign_keys = sorted(_normalize_dimension(name) or '-' for name in campaigns) if isinstance(campaigns, set) else []
        share_key = None
        if len(campaign_keys) == 1:
            share_key = (
                _normalize_dimension(search_term) or '-',
                _normalize_dimension(str(bucket['match_type'])) or '-',
                campaign_keys[0],
            )
        share_info = share_by_term.get(share_key, {}) if share_key is not None else {}
        impression_share = Decimal(share_info.get('impression_share', DECIMAL_ZERO))
        impression_rank = int(share_info.get('impression_rank', 0))
        action = _classify_search_term_action(
            orders=orders,
            impression_share=impression_share,
            acos=acos,
            clicks=clicks,
        )
        items.append(
            {
                'search_term': search_term,
                'match_type': str(bucket['match_type']),
                'campaign_count': len(campaigns) if isinstance(campaigns, set) else 0,
                'primary_campaign': sorted(campaigns)[0] if isinstance(campaigns, set) and campaigns else '-',
                'impressions': impressions,
                'clicks': clicks,
                'ctr': _round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'cvr_7d': _round_ratio(cvr),
                'acos': _round_ratio(acos),
                'impression_share': _round_ratio(impression_share),
                'impression_rank': impression_rank,
                'action': action,
            }
        )

    items.sort(key=lambda item: (float(item['spend']), int(item['clicks'])), reverse=True)
    expand_count = sum(1 for item in items if str(item['action']) in {'提竞价争份额', '加词放量'})
    negative_count = sum(1 for item in items if str(item['action']) == '否词/降价')
    share_gap_count = sum(
        1
        for item in items
        if int(item['orders_7d']) >= 1 and float(item['impression_share']) > 0 and float(item['impression_share']) < 0.08
    )
    top_term = items[0] if items else None
    waste_term_count = sum(1 for item in items if str(item['action']) == '否词/降价')
    low_ctr_terms = sum(1 for item in items if int(item['impressions']) >= 100 and float(item['ctr']) < 0.005)
    search_term_narrative_sections = [
        _build_narrative_section(
            title='搜索词层结论',
            summary=(
                '当前搜索词层兼有扩量词和浪费词，需要同时做放量与控损。'
                if expand_count > 0 and waste_term_count > 0
                else '当前搜索词层以扩量机会为主。'
                if expand_count > 0
                else '当前搜索词层以控浪费为主。'
                if waste_term_count > 0
                else '当前搜索词层暂时较平稳。'
            ),
            evidence=[
                f'当前共识别到 {len(items)} 个搜索词，其中扩量候选 {expand_count} 个，否词候选 {waste_term_count} 个。',
                *(
                    [f"当前高消耗词是 {top_term['search_term']}，花费 {float(top_term['spend']):.2f} 美元，ACOS {float(top_term['acos']) * 100:.2f}%."]
                    if top_term is not None
                    else []
                ),
            ],
            action='先区分该词是值得继续抢份额，还是已经到达否词/降价门槛。',
            drill_to='search-terms',
        ),
        _build_narrative_section(
            title='份额归因',
            summary=(
                '搜索词层存在明确份额缺口，部分有订单词还没有拿到足够曝光。'
                if share_gap_count > 0
                else '搜索词层暂时没有明显份额缺口，当前更应先看词效而不是盲目提价。'
            ),
            evidence=(
                [f'当前有 {share_gap_count} 个已有订单词的展示量份额仍低于 8%。']
                if share_gap_count > 0
                else ['当前有订单词的份额没有集中落在明显偏低区间。']
            ),
            action='对已验证能转化的词，优先做提竞价、拉精确或拆单独活动承接。',
            drill_to='search-terms',
        ),
        _build_narrative_section(
            title='点击与转化判断',
            summary=(
                '部分词虽然能拿到曝光，但点击承接偏弱。'
                if low_ctr_terms > 0
                else '当前搜索词问题更多集中在转化而不是点击。'
            ),
            evidence=(
                [f'当前有 {low_ctr_terms} 个词曝光达到观察门槛但 CTR 仍低于 0.50%。']
                if low_ctr_terms > 0
                else ['主要问题词更多表现为点击后未转化，而不是展示后无人点击。']
            ),
            action='点击差先看词意图和广告位，转化差再回到商品承接层检查页面竞争力。',
            drill_to='products',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '搜索词数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的有效搜索词',
            },
            {
                'label': '扩量候选',
                'value': str(expand_count),
                'helper': '建议提竞价或加词放量的搜索词',
            },
            {
                'label': '否词候选',
                'value': str(negative_count),
                'helper': '达到降价或否词门槛的搜索词',
            },
            {
                'label': '份额缺口',
                'value': str(share_gap_count),
                'helper': '已有订单但展示量份额仍偏低的搜索词',
            },
        ],
        'narrative_sections': search_term_narrative_sections,
        'items': items,
    }


def build_targets(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    target_text: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_target_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    normalized_target_text = _normalize_dimension(target_text)

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.target_text, normalized_target_text):
            continue
        target_text = (row.target_text or '').strip() or '-'
        match_type = (row.match_type or '').strip() or '-'
        key = (target_text, match_type)
        bucket = grouped.setdefault(
            key,
            {
                'target_text': target_text,
                'match_type': match_type,
                'campaigns': set(),
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
                'top_of_search_impression_share': DECIMAL_ZERO,
            },
        )
        campaigns = bucket['campaigns']
        if isinstance(campaigns, set):
            campaigns.add((row.campaign_name or '').strip() or '-')
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)
        bucket['top_of_search_impression_share'] = max(
            Decimal(bucket['top_of_search_impression_share']),
            Decimal(row.top_of_search_impression_share or 0),
        )

    items = []
    for bucket in grouped.values():
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = _safe_ratio(Decimal(clicks), impressions)
        cpc = _safe_ratio(spend, clicks)
        acos = _safe_ratio(spend, sales)
        cvr = _safe_ratio(Decimal(orders), clicks)
        top_share = Decimal(bucket['top_of_search_impression_share'])

        action = _classify_target_action(
            orders=orders,
            acos=acos,
            clicks=clicks,
            ctr=ctr,
            top_share=top_share,
        )

        campaigns = bucket['campaigns']
        items.append(
            {
                'target_text': str(bucket['target_text']),
                'match_type': str(bucket['match_type']),
                'campaign_count': len(campaigns) if isinstance(campaigns, set) else 0,
                'primary_campaign': sorted(campaigns)[0] if isinstance(campaigns, set) and campaigns else '-',
                'impressions': impressions,
                'clicks': clicks,
                'ctr': _round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'cvr_7d': _round_ratio(cvr),
                'acos': _round_ratio(acos),
                'top_of_search_impression_share': _round_ratio(top_share),
                'action': action,
            }
        )

    items.sort(key=lambda item: (float(item['spend']), int(item['clicks'])), reverse=True)
    keep_scale_count = sum(1 for item in items if str(item['action']) == '保留放量')
    isolate_count = sum(1 for item in items if str(item['action']) == '降价/隔离')
    top_slot_gap_count = sum(
        1
        for item in items
        if float(item['ctr']) >= 0.01 and float(item['top_of_search_impression_share']) < 0.01
    )
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '投放入口数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的入口维度数量',
            },
            {
                'label': '保留放量',
                'value': str(keep_scale_count),
                'helper': '表现稳定、值得继续承接的入口',
            },
            {
                'label': '隔离候选',
                'value': str(isolate_count),
                'helper': '高消耗低转化、需要控价的入口',
            },
            {
                'label': '首页缺口',
                'value': str(top_slot_gap_count),
                'helper': 'CTR 不差但首页曝光份额偏低的入口',
            },
        ],
        'items': items,
    }


def build_time_trend(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    previous_date_from, previous_date_to = _build_previous_period(date_from=date_from, date_to=date_to)
    rows = _load_time_trend_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    previous_rows = (
        _load_time_trend_rows(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=previous_date_from,
            date_to=previous_date_to,
        )
        if previous_date_from is not None and previous_date_to is not None
        else []
    )
    current_summary = _build_time_trend_summary(rows)
    current_spend = sum((Decimal(row.spend or 0) for row in rows), DECIMAL_ZERO)
    previous_spend = sum((Decimal(row.spend or 0) for row in previous_rows), DECIMAL_ZERO)
    current_clicks = sum(int(row.clicks or 0) for row in rows)
    previous_clicks = sum(int(row.clicks or 0) for row in previous_rows)
    comparison = _build_period_comparison(
        current_start=date_from,
        current_end=date_to,
        previous_start=previous_date_from,
        previous_end=previous_date_to,
        current_spend=current_spend,
        previous_spend=previous_spend,
        current_clicks=current_clicks,
        previous_clicks=previous_clicks,
        current_sales=DECIMAL_ZERO,
        previous_sales=DECIMAL_ZERO,
        current_orders=0,
        previous_orders=0,
    )

    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary': current_summary,
        'comparison': comparison,
    }


def build_purchased_products(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    purchased_asin: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = _normalize_country(country)
    rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    normalized_sku = _normalize_dimension(sku)
    normalized_purchased_asin = _normalize_dimension(purchased_asin)
    rows = [
        row
        for row in rows
        if _matches_dimension(row.ad_sku, normalized_sku)
        and _matches_dimension(row.purchased_asin, normalized_purchased_asin)
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'items': _build_purchased_product_items(rows),
    }
