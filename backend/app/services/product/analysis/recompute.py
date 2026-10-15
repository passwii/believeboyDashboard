"""Product analysis recompute functions."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import select, and_, or_
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, AdUploadFile, AnalysisPT1Calculation, Project
from app.services.product._internal import _is_single_full_week
from app.services.product.analysis.costs import _build_active_product_costs_df
from app.services.product.analysis.period_sources import _list_history_weekly_period_sources
from app.services.product.persistence import (
    ensure_tables,
    persist_product_analysis_pt1_calculation,
)
from app.services.product.business import (
    _build_business_df_from_source,
    _build_business_df_from_sources,
    _build_business_df_from_file,
)
from app.services.product.ad import (
    _build_ad_df_from_source,
    _build_ad_df_from_sources,
    _build_ad_df_from_c_source,
    _build_ad_df_from_file,
)
from app.services.payment import build_df_from_source, build_df_from_sources
from app.services.payment.db_reader import build_df_from_file as _build_payment_df_from_file
from app.tasks.scripts import product_analysis as product_analysis_script
from app.services.report_type_service import AD_PRODUCT_REPORT
from app.utils.country import normalize_country as _normalize_country


def recompute_weekly_product_analysis_from_history(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date | None = None,
    end_date: date | None = None,
    current_only: bool = True,
) -> dict[str, Any]:
    ensure_tables(db)
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)
    period_sources = _list_history_weekly_period_sources(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    )

    periods: list[dict[str, Any]] = []
    for item in period_sources:
        report_start_date = item['report_start_date']
        report_end_date = item['report_end_date']
        report_year_month = report_end_date.strftime('%Y-%m')
        df_cost = _build_active_product_costs_df(
            db,
            project_name=project.project_name,
            country=normalized_country,
            year_month=report_year_month,
        )
        df_business = _build_business_df_from_sources(
            db,
            source_ids=item['business_report_source_ids'],
        )
        df_ad = _build_ad_df_from_sources(
            db,
            source_ids=item['ad_report_source_ids'],
        )
        df_payment = build_df_from_sources(
            db,
            source_ids=item['payment_report_source_ids'],
        )
        report_date = product_analysis_script._format_report_date(
            report_start_date.isoformat(),
            report_end_date.isoformat(),
        )
        df_overview = product_analysis_script._build_overview(
            project.project_name,
            report_date,
            df_cost,
            df_business,
            df_ad,
            product_analysis_script._build_payment_aggregate(df_payment),
        )
        df_overview = product_analysis_script._append_summary_row(df_overview, report_date)
        pt1 = product_analysis_script._build_pt1_payload(df_overview)
        if item.get('completeness'):
            pt1['summary']['_completeness'] = item['completeness']
            pt1['summary']['_is_partial'] = item.get('is_partial', False)
        pt1_row = persist_product_analysis_pt1_calculation(
            db,
            project_name=project.project_name,
            country=normalized_country,
            report_start_date=report_start_date.isoformat(),
            report_end_date=report_end_date.isoformat(),
            pt1=pt1,
            result_file_path=None,
            calculation_version=1,
        )
        period_entry: dict[str, Any] = {
            'pt1_id': int(pt1_row.id),
            'version': int(pt1_row.version),
            'report_start_date': report_start_date.isoformat(),
            'report_end_date': report_end_date.isoformat(),
            'row_count': int(pt1_row.row_count or 0),
            'business_report_source_id': int(item['business_report_source_ids'][0]),
            'ad_report_source_id': int(item['ad_report_source_ids'][0]),
            'payment_report_source_id': int(item['payment_report_source_ids'][0]) if item['payment_report_source_ids'] else None,
            'is_partial': item.get('is_partial', False),
            'completeness': item.get('completeness', {}),
        }
        periods.append(period_entry)

    return {
        'project_id': int(project.id),
        'project_name': project.project_name,
        'country': normalized_country,
        'recomputed': len(periods),
        'skipped': 0,
        'periods': periods,
    }


def recompute_pt1_for_period(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    period_start_date: date,
    period_end_date: date,
) -> dict[str, Any]:
    ensure_tables(db)
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)

    # business / payment 来自 A 表 (AnalysisSourceFile)
    stmt = select(AnalysisSourceFile).where(
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type.in_(('business_report', 'payment_report')),
        AnalysisSourceFile.country == normalized_country,
        AnalysisSourceFile.is_current.is_(True),
        AnalysisSourceFile.period_start_date == period_start_date,
        AnalysisSourceFile.period_end_date == period_end_date,
    )
    rows = db.execute(stmt.order_by(AnalysisSourceFile.report_type.asc())).scalars().all()

    source_map: dict[str, AnalysisSourceFile] = {}
    for row in rows:
        source_map[row.report_type] = row

    # ad_product_report 来自 C 表 (AdUploadFile)
    ad_row = db.execute(
        select(AdUploadFile)
        .where(
            AdUploadFile.project_id == project_id,
            AdUploadFile.report_type == 'ad_promoted_product_report',
            AdUploadFile.country == normalized_country,
            AdUploadFile.is_current.is_(True),
            AdUploadFile.period_start_date == period_start_date,
            AdUploadFile.period_end_date == period_end_date,
        )
        .order_by(AdUploadFile.version.desc())
        .limit(1)
    ).scalar_one_or_none()

    missing = {'business_report', AD_PRODUCT_REPORT, 'payment_report'} - set(source_map.keys())
    if AD_PRODUCT_REPORT in missing and ad_row is not None:
        missing.discard(AD_PRODUCT_REPORT)
    if missing:
        raise ValueError(
            f'Missing source files for period {period_start_date}-{period_end_date}: '
            f'{", ".join(missing)}'
        )

    business_source = source_map['business_report']
    ad_source = source_map[AD_PRODUCT_REPORT]
    payment_source = source_map['payment_report']

    report_year_month = period_end_date.strftime('%Y-%m')
    df_cost = _build_active_product_costs_df(
        db,
        project_name=project.project_name,
        country=normalized_country,
        year_month=report_year_month,
    )
    df_business = _build_business_df_from_source(db, source_id=int(business_source.id))
    if ad_source is not None:
        # A 表记录存在 (历史数据)，走原有逻辑
        df_ad = _build_ad_df_from_source(db, source_id=int(ad_source.id))
    elif ad_row is not None:
        # A 表没有，直接从 C 表读
        df_ad = _build_ad_df_from_c_source(db, c_source_id=int(ad_row.id))
    else:
        from pandas import DataFrame
        df_ad = DataFrame(columns=['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量'])
    df_payment = build_df_from_source(db, source_id=int(payment_source.id))

    report_date_str = product_analysis_script._format_report_date(
        period_start_date.isoformat(),
        period_end_date.isoformat(),
    )
    df_overview = product_analysis_script._build_overview(
        project.project_name,
        report_date_str,
        df_cost,
        df_business,
        df_ad,
        product_analysis_script._build_payment_aggregate(df_payment),
    )
    df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
    pt1_payload = product_analysis_script._build_pt1_payload(df_overview)

    pt1_row = persist_product_analysis_pt1_calculation(
        db,
        project_name=project.project_name,
        country=normalized_country,
        report_start_date=period_start_date.isoformat(),
        report_end_date=period_end_date.isoformat(),
        pt1=pt1_payload,
        result_file_path=None,
        calculation_version=1,
    )

    return {
        'pt1_id': int(pt1_row.id),
        'version': int(pt1_row.version),
        'report_start_date': period_start_date.isoformat(),
        'report_end_date': period_end_date.isoformat(),
        'row_count': int(pt1_row.row_count or 0),
        'business_report_source_id': int(business_source.id),
        'ad_report_source_id': int(ad_source.id) if ad_source is not None else int(ad_row.id),
        'payment_report_source_id': int(payment_source.id),
    }


def run_product_analysis_from_history(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date | None = None,
    end_date: date | None = None,
    current_only: bool = True,
) -> dict[str, Any]:
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)
    period_sources = _list_history_weekly_period_sources(
        db,
        project_id=project_id,
        country=normalized_country,
        start_date=start_date,
        end_date=end_date,
        current_only=current_only,
    )
    should_persist = (
        start_date is not None
        and end_date is not None
        and _is_single_full_week(start_date, end_date)
    )

    if should_persist:
        periods: list[dict[str, Any]] = []
        for item in period_sources:
            week_start = item['report_start_date']
            week_end = item['report_end_date']
            year_month = week_end.strftime('%Y-%m')

            df_cost = _build_active_product_costs_df(
                db,
                project_name=project.project_name,
                country=normalized_country,
                year_month=year_month,
            )
            df_business = _build_business_df_from_sources(
                db,
                source_ids=item['business_report_source_ids'],
            )
            df_ad = _build_ad_df_from_sources(
                db,
                source_ids=item['ad_report_source_ids'],
            )
            df_payment = build_df_from_sources(
                db,
                source_ids=item['payment_report_source_ids'],
            )
            report_date_str = product_analysis_script._format_report_date(
                week_start.isoformat(),
                week_end.isoformat(),
            )
            df_overview = product_analysis_script._build_overview(
                project.project_name,
                report_date_str,
                df_cost,
                df_business,
                df_ad,
                product_analysis_script._build_payment_aggregate(df_payment),
            )
            df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
            pt1 = product_analysis_script._build_pt1_payload(df_overview)
            if item.get('completeness'):
                pt1['summary']['_completeness'] = item['completeness']
                pt1['summary']['_is_partial'] = item.get('is_partial', False)
            pt1_row = persist_product_analysis_pt1_calculation(
                db,
                project_name=project.project_name,
                country=normalized_country,
                report_start_date=week_start.isoformat(),
                report_end_date=week_end.isoformat(),
                pt1=pt1,
                result_file_path=None,
                calculation_version=1,
            )
            periods.append({
                'pt1_id': int(pt1_row.id),
                'version': int(pt1_row.version),
                'report_start_date': week_start.isoformat(),
                'report_end_date': week_end.isoformat(),
                'summary': pt1['summary'],
                'details': pt1['details'],
                'is_partial': item.get('is_partial', False),
                'completeness': item.get('completeness', {}),
                'persisted': True,
            })
    elif start_date is not None and end_date is not None and period_sources:
        all_business_ids: list[int] = []
        all_ad_ids: list[int] = []
        all_payment_ids: list[int] = []
        is_partial = False
        merged_completeness: dict[str, Any] = {}
        for item in period_sources:
            all_business_ids.extend(item['business_report_source_ids'])
            all_ad_ids.extend(item['ad_report_source_ids'])
            all_payment_ids.extend(item['payment_report_source_ids'])
            if item.get('is_partial'):
                is_partial = True
            if not merged_completeness and item.get('completeness'):
                merged_completeness = item['completeness']

        year_month = end_date.strftime('%Y-%m')
        df_cost = _build_active_product_costs_df(
            db,
            project_name=project.project_name,
            country=normalized_country,
            year_month=year_month,
        )
        df_business = _build_business_df_from_sources(
            db,
            source_ids=all_business_ids,
        )
        df_ad = _build_ad_df_from_sources(
            db,
            source_ids=all_ad_ids,
        )
        df_payment = build_df_from_sources(
            db,
            source_ids=all_payment_ids,
        )
        report_date_str = product_analysis_script._format_report_date(
            start_date.isoformat(),
            end_date.isoformat(),
        )
        df_overview = product_analysis_script._build_overview(
            project.project_name,
            report_date_str,
            df_cost,
            df_business,
            df_ad,
            product_analysis_script._build_payment_aggregate(df_payment),
        )
        df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
        pt1 = product_analysis_script._build_pt1_payload(df_overview)
        if merged_completeness:
            pt1['summary']['_completeness'] = merged_completeness
            pt1['summary']['_is_partial'] = is_partial
        periods = [{
            'pt1_id': None,
            'version': None,
            'report_start_date': start_date.isoformat(),
            'report_end_date': end_date.isoformat(),
            'summary': pt1['summary'],
            'details': pt1['details'],
            'is_partial': is_partial,
            'completeness': merged_completeness,
            'persisted': False,
        }]
    else:
        periods = []

    return {
        'project_id': int(project.id),
        'project_name': project.project_name,
        'country': normalized_country,
        'total_periods': len(periods),
        'periods': periods,
    }


def preview_product_analysis_from_files(
    db: Session,
    *,
    project_id: int,
    country: str = 'US',
    start_date: date,
    end_date: date,
    business_file_path: Path | None = None,
    payment_file_path: Path | None = None,
    ad_file_path: Path | None = None,
) -> dict[str, Any]:
    """月度 SKU 预览：直接从临时文件构造 DataFrame 跑核算，不写 DB。

    与 run_product_analysis_from_history 的区别：
    - 跳过 _list_history_weekly_period_sources（DB 查询源文件）
    - 直接用传入的 temp file path 调 _build_*_df_from_file
    - 永不调用 persist_product_analysis_pt1_calculation（即使日期是单整周）

    返回结构与 run_product_analysis_from_history 完全一致（persisted: false），
    前端可以直接喂给 exportProductAnalysisToExcel。
    """
    project = db.get(Project, project_id)
    if project is None:
        raise ValueError('project not found')

    normalized_country = _normalize_country(country)

    # Product cost 仍然从 DB 读（这是项目主数据，临时预览场景下也合理从主数据拿）
    year_month = end_date.strftime('%Y-%m')
    try:
        df_cost = _build_active_product_costs_df(
            db,
            project_name=project.project_name,
            country=normalized_country,
            year_month=year_month,
        )
    except ValueError:
        # 没有 active product_costs 也能算（仅 0 cost 行），让上层 UI 决定
        from pandas import DataFrame
        df_cost = DataFrame(columns=['SKU', 'ASIN', '头程单价', 'FOB单价'])

    # 业务/广告/付款 — 从 temp file 路径直读
    if business_file_path is not None and Path(business_file_path).exists():
        df_business = _build_business_df_from_file(Path(business_file_path))
    else:
        from pandas import DataFrame
        df_business = DataFrame(columns=['ASIN', '页面浏览量', '总销量', '总访客', '总销售额'])

    if ad_file_path is not None and Path(ad_file_path).exists():
        # 需要 known_skus/known_asins 解析 ad 时正确分类 scope
        from app.services.product.persistence import _load_project_product_mapping
        try:
            known_skus, known_asins = _load_project_product_mapping(
                db, project.project_name, normalized_country,
            )
        except Exception:
            known_skus, known_asins = set(), set()
        df_ad = _build_ad_df_from_file(
            Path(ad_file_path),
            known_skus=known_skus,
            known_asins=known_asins,
        )
    else:
        from pandas import DataFrame
        df_ad = DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])

    if payment_file_path is not None and Path(payment_file_path).exists():
        df_payment = _build_payment_df_from_file(
            Path(payment_file_path), country=normalized_country,
        )
    else:
        from pandas import DataFrame
        df_payment = DataFrame(columns=[
            'type', 'sku', 'quantity', 'product sales', 'shipping credits',
            'promotional rebates', 'other', 'selling fees', 'fba fees',
        ])

    report_date_str = product_analysis_script._format_report_date(
        start_date.isoformat(), end_date.isoformat(),
    )
    df_overview = product_analysis_script._build_overview(
        project.project_name,
        report_date_str,
        df_cost,
        df_business,
        df_ad,
        product_analysis_script._build_payment_aggregate(df_payment),
    )
    df_overview = product_analysis_script._append_summary_row(df_overview, report_date_str)
    pt1 = product_analysis_script._build_pt1_payload(df_overview)

    return {
        'project_id': int(project.id),
        'project_name': project.project_name,
        'country': normalized_country,
        'total_periods': 1,
        'periods': [{
            'pt1_id': None,
            'version': None,
            'report_start_date': start_date.isoformat(),
            'report_end_date': end_date.isoformat(),
            'summary': pt1['summary'],
            'details': pt1['details'],
            'is_partial': False,
            'completeness': None,
            'persisted': False,
            'preview': True,
        }],
    }