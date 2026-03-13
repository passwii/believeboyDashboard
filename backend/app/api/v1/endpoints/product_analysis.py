from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.models import AnalysisPT1Calculation, AnalysisPTSKUDetail, ProductCost
from app.schemas.product_analysis_source import (
    AnalysisSourceFileItem,
    AnalysisSourceRowsResponse,
    CurrentInventorySnapshotResponse,
    ProductAnalysisWeeklyRecomputeResponse,
)
from app.services import product_analysis_source_service, project_service

router = APIRouter(dependencies=[Depends(protected)])

WEEKLY_SUMMARY_COLUMNS = [
    '日期',
    'SKU',
    'ASIN',
    '总销量',
    '总销售额',
    '页面浏览量',
    '总访客',
    '总转化',
    '广告展示量',
    '广告点击量',
    '广告点击率',
    '广告订单量',
    '广告单占比',
    '广告转化率',
    '广告花费',
    '广告销售额',
    'CPC',
    'ACOS',
    'SP占比',
    '自然流量',
    '自然流量占比',
    '自然单',
    '自然单转化',
    '产品FOB',
    '成本占比',
    '销售头程',
    '头程占比',
    'FBA配送费',
    '配送费占比',
    '平台佣金',
    '佣金占比',
    '总成本',
    '总成本占比',
    '利润',
    '利润率',
    '实际销售额',
    '实际销售量',
    '实际退款额',
    '实际退款量',
    '平均售价',
    '退款率',
]

WEEKLY_SUMMARY_SUM_COLUMNS = {
    '总销量',
    '总销售额',
    '页面浏览量',
    '总访客',
    '广告展示量',
    '广告点击量',
    '广告订单量',
    '广告花费',
    '广告销售额',
    '自然流量',
    '自然单',
    '产品FOB',
    '实际销售额',
    '实际销售量',
    '实际退款额',
    '实际退款量',
    '销售头程',
    'FBA配送费',
    '平台佣金',
    '总成本',
    '利润',
}

WEEKLY_SUMMARY_INT_COLUMNS = {
    '总销量',
    '页面浏览量',
    '总访客',
    '广告展示量',
    '广告点击量',
    '广告订单量',
    '自然流量',
    '自然单',
    '实际销售量',
    '实际退款量',
}

WEEKLY_SUMMARY_MONEY_COLUMNS = {
    '总销售额',
    '广告花费',
    '广告销售额',
    'CPC',
    '产品FOB',
    '销售头程',
    'FBA配送费',
    '平台佣金',
    '总成本',
    '利润',
    '实际销售额',
    '实际退款额',
    '平均售价',
}

COUNTRY_ALIASES = {
    'US': 'US',
    'USA': 'US',
    '美国': 'US',
    '美国站': 'US',
    'DE': 'DE',
    'GERMANY': 'DE',
    '德国': 'DE',
    '德国站': 'DE',
    'UK': 'UK',
    'GB': 'UK',
    'UNITED KINGDOM': 'UK',
    '英国': 'UK',
    '英国站': 'UK',
}


def _to_float(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(',', '')
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def _safe_div(numerator: float, denominator: float) -> float:
    if denominator == 0:
        return 0.0
    return numerator / denominator


def _normalize_country(value: str | None) -> str:
    normalized = (value or '').strip().upper()
    if not normalized:
        return 'US'
    mapped = COUNTRY_ALIASES.get(normalized, normalized)
    if mapped not in {'US', 'DE', 'UK'}:
        raise HTTPException(status_code=422, detail='country must be one of: US, DE, UK')
    return mapped


def _build_report_label(start: date, end: date) -> str:
    return f'{start.strftime("%Y%m%d")}-{end.strftime("%m%d")}'


def _is_summary_complete(summary_row: Any) -> bool:
    if not isinstance(summary_row, dict):
        return False
    return all(column in summary_row for column in WEEKLY_SUMMARY_COLUMNS)


def _build_summary_from_detail_rows(
    details: list[AnalysisPTSKUDetail],
    *,
    report_start_date: date,
    report_end_date: date,
) -> dict[str, Any]:
    summary: dict[str, Any] = {column: 0 for column in WEEKLY_SUMMARY_COLUMNS}
    summary['日期'] = _build_report_label(report_start_date, report_end_date)
    summary['SKU'] = '汇总'
    summary['ASIN'] = '汇总'

    for detail in details:
        raw_row = detail.raw_row if isinstance(detail.raw_row, dict) else {}
        if isinstance(raw_row.get('日期'), str) and raw_row.get('日期'):
            summary['日期'] = raw_row['日期']
        for col in WEEKLY_SUMMARY_SUM_COLUMNS:
            summary[col] = _to_float(summary.get(col)) + _to_float(raw_row.get(col))

    summary['自然流量'] = _to_float(summary['页面浏览量']) - _to_float(summary['广告点击量'])
    summary['自然单'] = _to_float(summary['总销量']) - _to_float(summary['广告订单量'])

    summary['总转化'] = _safe_div(_to_float(summary['总销量']), _to_float(summary['页面浏览量']))
    summary['广告点击率'] = _safe_div(_to_float(summary['广告点击量']), _to_float(summary['广告展示量']))
    summary['广告单占比'] = _safe_div(_to_float(summary['广告订单量']), _to_float(summary['总销量']))
    summary['广告转化率'] = _safe_div(_to_float(summary['广告订单量']), _to_float(summary['广告点击量']))
    summary['CPC'] = _safe_div(_to_float(summary['广告花费']), _to_float(summary['广告点击量']))
    summary['ACOS'] = _safe_div(_to_float(summary['广告花费']), _to_float(summary['广告销售额']))
    summary['SP占比'] = _safe_div(_to_float(summary['广告花费']), _to_float(summary['总销售额']))
    summary['自然流量占比'] = _safe_div(_to_float(summary['自然流量']), _to_float(summary['页面浏览量']))
    summary['自然单转化'] = _safe_div(_to_float(summary['自然单']), _to_float(summary['自然流量']))
    summary['成本占比'] = _safe_div(_to_float(summary['产品FOB']), _to_float(summary['实际销售额']))
    summary['头程占比'] = _safe_div(_to_float(summary['销售头程']), _to_float(summary['实际销售额']))
    summary['配送费占比'] = _safe_div(_to_float(summary['FBA配送费']), _to_float(summary['实际销售额']))
    summary['佣金占比'] = _safe_div(_to_float(summary['平台佣金']), _to_float(summary['实际销售额']))
    summary['总成本占比'] = _safe_div(_to_float(summary['总成本']), _to_float(summary['实际销售额']))
    summary['利润率'] = _safe_div(_to_float(summary['利润']), _to_float(summary['实际销售额']))
    summary['平均售价'] = _safe_div(_to_float(summary['实际销售额']), _to_float(summary['实际销售量']))
    summary['退款率'] = _safe_div(_to_float(summary['实际退款额']), _to_float(summary['实际销售额']))

    for col in WEEKLY_SUMMARY_INT_COLUMNS:
        summary[col] = int(round(_to_float(summary[col])))
    for col in WEEKLY_SUMMARY_MONEY_COLUMNS:
        summary[col] = round(_to_float(summary[col]), 2)

    return summary


def _load_weekly_summary_map(db: Session, row_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not row_ids:
        return {}
    pt1_rows = (
        db.query(
            AnalysisPT1Calculation.id,
            AnalysisPT1Calculation.row_count,
            AnalysisPT1Calculation.summary_row,
            AnalysisPT1Calculation.report_start_date,
            AnalysisPT1Calculation.report_end_date,
        )
        .where(AnalysisPT1Calculation.id.in_(row_ids))
        .all()
    )

    needs_rebuild = [int(item.id) for item in pt1_rows if not _is_summary_complete(item.summary_row)]
    details_by_pt1: dict[int, list[AnalysisPTSKUDetail]] = defaultdict(list)
    if needs_rebuild:
        detail_rows = (
            db.query(AnalysisPTSKUDetail)
            .where(AnalysisPTSKUDetail.pt1_calculation_id.in_(needs_rebuild))
            .order_by(AnalysisPTSKUDetail.pt1_calculation_id.asc(), AnalysisPTSKUDetail.source_row_no.asc())
            .all()
        )
        for row in detail_rows:
            details_by_pt1[int(row.pt1_calculation_id)].append(row)

    summary_by_id: dict[int, dict[str, Any]] = {}
    for item in pt1_rows:
        row_id = int(item.id)
        existing_summary = item.summary_row if isinstance(item.summary_row, dict) else {}
        rebuilt_summary: dict[str, Any] = {}
        if row_id in needs_rebuild:
            rebuilt_summary = _build_summary_from_detail_rows(
                details_by_pt1.get(row_id, []),
                report_start_date=item.report_start_date,
                report_end_date=item.report_end_date,
            )
        merged_summary = dict(rebuilt_summary)
        merged_summary.update(existing_summary)
        summary_by_id[row_id] = {
            'row_count': int(item.row_count or 0),
            'summary_row': merged_summary,
        }
    return summary_by_id


@router.get('/product-analysis/sources', response_model=list[AnalysisSourceFileItem])
def list_product_analysis_sources(
    project_id: int | None = Query(default=None, gt=0),
    report_type: Literal['business_report', 'payment_report', 'ad_report', 'sales_report', 'inventory_report']
    | None = Query(default=None),
    period_start_date: date | None = Query(default=None),
    period_end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    include_history: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> list[AnalysisSourceFileItem]:
    effective_current_only = False if include_history else current_only
    rows = product_analysis_source_service.list_sources(
        db,
        project_id=project_id,
        report_type=report_type,
        period_start_date=period_start_date,
        period_end_date=period_end_date,
        current_only=effective_current_only,
    )
    return [_to_source_item(row) for row in rows]


@router.get('/product-analysis/sources/{source_id:int}/rows', response_model=AnalysisSourceRowsResponse)
def get_product_analysis_source_rows(
    source_id: int,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=1000),
    include_excluded: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> AnalysisSourceRowsResponse:
    try:
        source, rows, has_next = product_analysis_source_service.get_source_rows(
            db,
            source_id=source_id,
            page=page,
            page_size=page_size,
            include_excluded=include_excluded,
        )
    except ValueError as exc:
        if str(exc) == 'Source file not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return AnalysisSourceRowsResponse(
        source=_to_source_item(source),
        page=page,
        page_size=page_size,
        has_next=has_next,
        rows=rows,
    )


@router.get('/product-analysis/inventory/current', response_model=CurrentInventorySnapshotResponse)
def get_current_inventory_snapshot(
    project_id: int = Query(gt=0),
    db: Session = Depends(get_db_session),
) -> CurrentInventorySnapshotResponse:
    payload = product_analysis_source_service.get_current_inventory_snapshot(db, project_id=project_id)
    if payload is None:
        raise HTTPException(status_code=404, detail='Current inventory snapshot not found')
    source, rows = payload
    return CurrentInventorySnapshotResponse(source=_to_source_item(source), rows=rows)


@router.get('/product-analysis/pt1')
def list_product_analysis_pt1(
    project_id: int | None = Query(default=None, gt=0),
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    db: Session = Depends(get_db_session),
):
    stmt = db.query(AnalysisPT1Calculation).order_by(
        AnalysisPT1Calculation.report_start_date.desc(),
        AnalysisPT1Calculation.id.desc()
    )
    if current_only:
        stmt = stmt.where(AnalysisPT1Calculation.is_current.is_(True))
    if project_id is not None:
        stmt = stmt.where(AnalysisPT1Calculation.project_id == project_id)
    if start_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_end_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_start_date <= end_date)
    rows = stmt.all()
    
    return [
        {
            'id': row.id,
            'project_id': row.project_id,
            'project_name': row.project_name,
            'report_start_date': row.report_start_date,
            'report_end_date': row.report_end_date,
            'version': row.version,
            'is_current': row.is_current,
            'row_count': row.row_count,
            'summary_row': row.summary_row,
            'result_file_path': row.result_file_path,
            'calculation_version': row.calculation_version,
            'computed_at': row.computed_at,
            'created_at': row.created_at,
        }
        for row in rows
    ]


@router.get('/product-analysis/pt1/{pt1_id:int}/details')
def list_product_analysis_pt1_details(
    pt1_id: int,
    country: Annotated[str, Query()] = 'US',
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=500, ge=1, le=1000),
    db: Session = Depends(get_db_session),
):
    pt1 = db.get(AnalysisPT1Calculation, pt1_id)
    if pt1 is None:
        raise HTTPException(status_code=404, detail='PT1 calculation not found')

    normalized_country = _normalize_country(country)
    detail_sku = func.lower(func.coalesce(AnalysisPTSKUDetail.sku, ''))
    detail_asin = func.lower(func.coalesce(AnalysisPTSKUDetail.asin, ''))
    product_match = or_(
        func.lower(func.coalesce(ProductCost.sku, '')) == detail_sku,
        func.lower(func.coalesce(ProductCost.asin, '')) == detail_asin,
    )

    sort_order_expr = (
        select(func.min(ProductCost.sort_order))
        .where(
            ProductCost.project_name == pt1.project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == normalized_country,
            product_match,
        )
        .correlate(AnalysisPTSKUDetail)
        .scalar_subquery()
    )
    exists_expr = exists(
        select(1).where(
            ProductCost.project_name == pt1.project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == normalized_country,
            product_match,
        )
    )

    sort_order_label = sort_order_expr.label('sku_sort_order')
    rows = (
        db.query(AnalysisPTSKUDetail, sort_order_label)
        .where(AnalysisPTSKUDetail.pt1_calculation_id == pt1_id)
        .where(exists_expr)
        .order_by(func.coalesce(sort_order_label, 2147483647).asc(), AnalysisPTSKUDetail.source_row_no.asc(), AnalysisPTSKUDetail.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size + 1)
        .all()
    )

    has_next = len(rows) > page_size
    page_rows = rows[:page_size]

    return {
        'pt1_id': pt1.id,
        'project_id': pt1.project_id,
        'project_name': pt1.project_name,
        'report_start_date': pt1.report_start_date,
        'report_end_date': pt1.report_end_date,
        'version': pt1.version,
        'page': page,
        'page_size': page_size,
        'has_next': has_next,
        'rows': [
            {
                'id': detail_row.id,
                'source_row_no': detail_row.source_row_no,
                'sku': detail_row.sku,
                'asin': detail_row.asin,
                'sku_sort_order': int(sort_order) if sort_order is not None else None,
                'raw_row': detail_row.raw_row,
            }
            for detail_row, sort_order in page_rows
        ],
    }


@router.get('/product-analysis/weekly')
def list_product_analysis_weekly(
    project_id: int = Query(gt=0),
    country: Annotated[str, Query()] = 'US',
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    normalized_country = _normalize_country(country)
    rows = product_analysis_source_service.list_weekly_product_analysis_from_details(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    )
    if rows:
        row_ids = [int(item['id']) for item in rows if item.get('id') is not None]
        summary_by_id = _load_weekly_summary_map(db, row_ids)

        enriched: list[dict] = []
        for item in rows:
            row_id = int(item['id'])
            summary_info = summary_by_id.get(row_id, {})
            summary_row = summary_info.get('summary_row', {})
            total_sales = float((summary_row or {}).get('实际销售额', (summary_row or {}).get('总销售额', item.get('total_sales', 0))) or 0)
            total_units = int((summary_row or {}).get('实际销售量', (summary_row or {}).get('总销量', item.get('total_units', 0))) or 0)
            total_ad_spend = float((summary_row or {}).get('广告花费', item.get('total_ad_spend', 0)) or 0)

            enriched.append(
                {
                    **item,
                    'row_count': int(item.get('row_count', 0) or summary_info.get('row_count', 0)),
                    'total_sales': total_sales,
                    'total_units': total_units,
                    'total_ad_spend': total_ad_spend,
                    'summary_row': summary_row,
                    'weekly_summary_raw': summary_row,
                }
            )
        return enriched

    stmt = db.query(AnalysisPT1Calculation).where(AnalysisPT1Calculation.project_id == project_id).order_by(
        AnalysisPT1Calculation.report_start_date.desc(),
        AnalysisPT1Calculation.id.desc(),
    )
    if current_only:
        stmt = stmt.where(AnalysisPT1Calculation.is_current.is_(True))
    if start_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_end_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(AnalysisPT1Calculation.report_start_date <= end_date)

    fallback_rows = stmt.all()
    row_ids = [int(row.id) for row in fallback_rows]
    summary_by_id = _load_weekly_summary_map(db, row_ids)
    fallback_payload: list[dict[str, Any]] = []
    for row in fallback_rows:
        row_id = int(row.id)
        summary_info = summary_by_id.get(row_id, {})
        summary_row = (summary_info.get('summary_row', row.summary_row or {}) or {})
        fallback_payload.append(
            {
                'id': row.id,
                'project_id': row.project_id,
                'project_name': row.project_name,
                'report_start_date': row.report_start_date,
                'report_end_date': row.report_end_date,
                'version': row.version,
                'is_current': row.is_current,
                'row_count': int(summary_info.get('row_count', row.row_count) or 0),
                'total_sales': float((summary_row or {}).get('实际销售额', (summary_row or {}).get('总销售额', 0)) or 0),
                'total_units': int((summary_row or {}).get('实际销售量', (summary_row or {}).get('总销量', 0)) or 0),
                'total_ad_spend': float((summary_row or {}).get('广告花费', 0) or 0),
                'summary_row': summary_row,
                'weekly_summary_raw': summary_row,
            }
        )
    return fallback_payload


@router.post('/product-analysis/weekly/recompute', response_model=ProductAnalysisWeeklyRecomputeResponse)
def recompute_product_analysis_weekly(
    project_id: int = Query(gt=0),
    country: Annotated[str, Query()] = 'US',
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    current_only: bool = Query(default=True),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    normalized_country = _normalize_country(country)
    try:
        payload = product_analysis_source_service.recompute_weekly_product_analysis_from_history(
            db,
            project_id=project_id,
            country=normalized_country,
            start_date=start_date,
            end_date=end_date,
            current_only=current_only,
        )
        db.commit()
    except ValueError as exc:
        db.rollback()
        detail = str(exc)
        if detail == 'project not found':
            raise HTTPException(status_code=404, detail=detail) from exc
        raise HTTPException(status_code=400, detail=detail) from exc
    except Exception:
        db.rollback()
        raise
    return payload


def _to_source_item(row) -> AnalysisSourceFileItem:
    return AnalysisSourceFileItem(
        id=row.id,
        project_id=row.project_id,
        report_type=row.report_type,
        period_start_date=row.period_start_date,
        period_end_date=row.period_end_date,
        snapshot_at=row.snapshot_at,
        version=row.version,
        is_current=row.is_current,
        superseded_at=row.superseded_at,
        upload_file_id=row.upload_file_id,
        upload_file_path=row.upload_file_path,
        original_filename=row.original_filename,
        stored_filename=row.stored_filename,
        logical_filename=row.logical_filename,
        storage_key=row.storage_key,
        file_size_bytes=row.file_size_bytes,
        file_sha256=row.file_sha256,
        ingestion_status=row.ingestion_status,
        ingestion_error=row.ingestion_error,
        row_count_total=row.row_count_total,
        row_count_included=row.row_count_included,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
