from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import pandas as pd
from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
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
    Project,
)
from app.schemas.ad_upload import (
    AdUploadCommitRequest,
    AdUploadCommitResponse,
    AdUploadStatusItem,
    AdUploadStatusResponse,
)
from app.services.ad.upload.project_match import _resolve_project
from app.services.ad.upload.recognition import (
    finalize_ad_upload_temp_file,
    recognize_saved_ad_upload,
    resolve_ad_upload_temp_file_path,
)
from app.services.ad.upload.utils import (
    _clean_string,
    _date_to_string,
    _ensure_single_day_range,
    _parse_yyyy_mm_dd,
    _prepare_ingest_dataframe,
    _raw_row_dict,
    _read_dataframe,
    _record_get_ci,
    _resolve_record_date_range,
    _to_decimal,
    _to_int,
)
from app.utils.country import normalize_country
from app.utils.utils import sha256_file


def _ensure_table(db: Session) -> None:
    AdUploadFile.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadBudgetRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadCampaignRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadPlacementRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadInvalidTrafficRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadTargetRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadSearchTermShareRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadTimeTrendRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadPurchasedProductRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadSearchTermRow.__table__.create(bind=db.get_bind(), checkfirst=True)
    AdUploadPromotedProductRow.__table__.create(bind=db.get_bind(), checkfirst=True)


def _ingest_budget_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadBudgetRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                status=_clean_string(_record_get_ci(record, '状态')),
                budget=_to_decimal(_record_get_ci(record, '预算')),
                suggested_budget=_to_decimal(_record_get_ci(record, '建议预算')),
                budget_utilization_rate=_to_decimal(_record_get_ci(record, '预算范围内的平均时间')),
                missed_impressions_min=_to_int(_record_get_ci(record, '预计错失的展示量范围（最小值）')),
                missed_impressions_max=_to_int(_record_get_ci(record, '预计错失的展示量范围（最大值）')),
                missed_clicks_min=_to_int(_record_get_ci(record, '预计错失的点击量范围（最小值）')),
                missed_clicks_max=_to_int(_record_get_ci(record, '预计错失的点击量范围（最大）')),
                missed_sales_min=_to_decimal(_record_get_ci(record, '预计错失的销售额范围（最小值）')),
                missed_sales_max=_to_decimal(_record_get_ci(record, '预计错失的销售额范围（最大值）')),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                sales_7d=_to_decimal(_record_get_ci(record, '7天总销售额')),
                orders_7d=_to_int(_record_get_ci(record, '7天总订单数(#)')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_campaign_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadCampaignRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                portfolio_name=_clean_string(_record_get_ci(record, '广告组合名称')),
                campaign_type=_clean_string(_record_get_ci(record, '广告活动类型')),
                targeting_type=_clean_string(_record_get_ci(record, '定位类型')),
                bidding_strategy=_clean_string(_record_get_ci(record, '竞价策略')),
                status=_clean_string(_record_get_ci(record, '状态')),
                budget=_to_decimal(_record_get_ci(record, '预算')),
                impressions=_to_int(_record_get_ci(record, '展示量')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                ctr=_to_decimal(_record_get_ci(record, '点击率 (CTR)'), percent=True),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                orders_7d=_to_int(_record_get_ci(record, '7天总订单数(#)')),
                sales_7d=_to_decimal(_record_get_ci(record, '7天总销售额')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(_record_get_ci(record, '总广告投资回报率 (ROAS)')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_placement_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadPlacementRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                placement=_clean_string(_record_get_ci(record, '放置')),
                bidding_strategy=_clean_string(_record_get_ci(record, '竞价策略')),
                impressions=_to_int(_record_get_ci(record, '展示量')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                sales_7d=_to_decimal(_record_get_ci(record, '7天总销售额')),
                orders_7d=_to_int(_record_get_ci(record, '7天总订单数(#)')),
                units_7d=_to_int(_record_get_ci(record, '7天总销售量(#)')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(_record_get_ci(record, '总广告投资回报率 (ROAS)')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_invalid_traffic_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadInvalidTrafficRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                status=_clean_string(_record_get_ci(record, '状态')),
                total_impressions=_to_int(_record_get_ci(record, '总展示量')),
                valid_impressions=_to_int(_record_get_ci(record, '展示量')),
                invalid_impressions=_to_int(_record_get_ci(record, '无效展示量')),
                invalid_impression_rate=_to_decimal(_record_get_ci(record, '无效展示率')),
                total_clicks=_to_int(_record_get_ci(record, '总点击量')),
                valid_clicks=_to_int(_record_get_ci(record, '点击量')),
                invalid_clicks=_to_int(_record_get_ci(record, '无效点击')),
                invalid_click_rate=_to_decimal(_record_get_ci(record, '无效的点击率')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_target_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadTargetRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                ad_group_name=_clean_string(_record_get_ci(record, '广告组名称')),
                target_text=_clean_string(_record_get_ci(record, '投放')),
                match_type=_clean_string(_record_get_ci(record, '匹配类型')),
                impressions=_to_int(_record_get_ci(record, '展示量')),
                top_of_search_impression_share=_to_decimal(_record_get_ci(record, '搜索结果首页首位展示量份额')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                ctr=_to_decimal(_record_get_ci(record, '点击率 (CTR)')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                sales_7d=_to_decimal(_record_get_ci(record, '7天总销售额')),
                orders_7d=_to_int(_record_get_ci(record, '7天总订单数(#)')),
                units_7d=_to_int(_record_get_ci(record, '7天总销售量(#)')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(_record_get_ci(record, '总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(_record_get_ci(record, '7天的转化率')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_search_term_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadSearchTermRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                ad_group_name=_clean_string(_record_get_ci(record, '广告组名称')),
                target_text=_clean_string(_record_get_ci(record, '投放')),
                match_type=_clean_string(_record_get_ci(record, '匹配类型')),
                search_term=_clean_string(_record_get_ci(record, '客户搜索词')),
                impressions=_to_int(_record_get_ci(record, '展示量')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                ctr=_to_decimal(_record_get_ci(record, '点击率 (CTR)')),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                orders_7d=_to_int(_record_get_ci(record, '7天总订单数(#)')),
                sales_7d=_to_decimal(_record_get_ci(record, '7天总销售额')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(_record_get_ci(record, '总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(_record_get_ci(record, '7天的转化率')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_search_term_share_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadSearchTermShareRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                search_term=_clean_string(_record_get_ci(record, '客户搜索词')),
                impression_rank=_to_int(_record_get_ci(record, '搜索词展示量排名')),
                impression_share=_to_decimal(_record_get_ci(record, '搜索词展示量份额'), percent=True),
                target_text=_clean_string(_record_get_ci(record, '投放')),
                match_type=_clean_string(_record_get_ci(record, '匹配类型')),
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                ad_group_name=_clean_string(_record_get_ci(record, '广告组名称')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                impressions=_to_int(_record_get_ci(record, '展示量')),
                ctr=_to_decimal(_record_get_ci(record, '点击率 (CTR)'), percent=True),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                orders_7d=_to_int(_record_get_ci(record, '7 天内的总订单量 (#)')),
                sales_7d=_to_decimal(_record_get_ci(record, '7 天内的总销售额 ')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(_record_get_ci(record, '总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(_record_get_ci(record, '7 天转化率'), percent=True),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_time_trend_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadTimeTrendRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                country=_clean_string(_record_get_ci(record, '国家/地区')),
                currency=_clean_string(_record_get_ci(record, '货币')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_promoted_product_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadPromotedProductRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                ad_group_name=_clean_string(_record_get_ci(record, '广告组名称')),
                ad_sku=_clean_string(_record_get_ci(record, '广告SKU')),
                ad_asin=_clean_string(_record_get_ci(record, '广告ASIN')),
                impressions=_to_int(_record_get_ci(record, '展示量')),
                clicks=_to_int(_record_get_ci(record, '点击量')),
                ctr=_to_decimal(_record_get_ci(record, '点击率 (CTR)')),
                spend=_to_decimal(_record_get_ci(record, '花费')),
                cpc=_to_decimal(_record_get_ci(record, '单次点击成本 (CPC)')),
                orders_7d=_to_int(_record_get_ci(record, '7天总订单数(#)')),
                units_7d=_to_int(_record_get_ci(record, '7天总销售量(#)')),
                sales_7d=_to_decimal(_record_get_ci(record, '7天总销售额')),
                acos=_to_decimal(_record_get_ci(record, '广告投入产出比 (ACOS) 总计')),
                roas=_to_decimal(_record_get_ci(record, '总广告投资回报率 (ROAS)')),
                cvr_7d=_to_decimal(_record_get_ci(record, '7天的转化率')),
                ad_sku_units_7d=_to_int(_record_get_ci(record, '7天内广告SKU销售量(#)')),
                other_sku_units_7d=_to_int(_record_get_ci(record, '7天内其他SKU销售量(#)')),
                ad_sku_sales_7d=_to_decimal(_record_get_ci(record, '7天内广告SKU销售额')),
                other_sku_sales_7d=_to_decimal(_record_get_ci(record, '7天内其他SKU销售额')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_purchased_product_rows(db: Session, *, source_file_id: int, df: pd.DataFrame) -> None:
    for index, (_, series) in enumerate(df.iterrows(), start=1):
        record = series.to_dict()
        report_start_date, report_end_date = _resolve_record_date_range(record)
        db.add(
            AdUploadPurchasedProductRow(
                source_file_id=source_file_id,
                source_row_no=index,
                report_start_date=report_start_date,
                report_end_date=report_end_date,
                campaign_name=_clean_string(_record_get_ci(record, '广告活动名称')),
                ad_group_name=_clean_string(_record_get_ci(record, '广告组名称')),
                ad_sku=_clean_string(_record_get_ci(record, '广告SKU')),
                ad_asin=_clean_string(_record_get_ci(record, '广告ASIN')),
                target_text=_clean_string(_record_get_ci(record, '投放')),
                match_type=_clean_string(_record_get_ci(record, '匹配类型')),
                purchased_asin=_clean_string(_record_get_ci(record, '已购买的ASIN')),
                other_sku_units_7d=_to_int(_record_get_ci(record, '7天内其他SKU销售量(#)')),
                other_sku_orders_7d=_to_int(_record_get_ci(record, '7天内其他SKU订单数(#)')),
                other_sku_sales_7d=_to_decimal(_record_get_ci(record, '7天内其他SKU销售额')),
                raw_row=_raw_row_dict(record),
            )
        )


def _ingest_detail_rows(
    db: Session,
    *,
    source_file_id: int,
    report_type: str,
    path: Path,
    df: pd.DataFrame | None = None,
) -> None:
    if report_type not in {
        'ad_budget_report',
        'ad_campaign_report',
        'ad_placement_report',
        'ad_invalid_traffic_report',
        'ad_target_report',
        'ad_search_term_report',
        'ad_search_term_share_report',
        'ad_time_trend_report',
        'ad_promoted_product_report',
        'ad_purchased_product_report',
    }:
        return

    prepared_df = _prepare_ingest_dataframe(df if df is not None else _read_dataframe(path))
    if report_type == 'ad_budget_report':
        _ingest_budget_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_campaign_report':
        _ingest_campaign_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_placement_report':
        _ingest_placement_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_invalid_traffic_report':
        _ingest_invalid_traffic_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_target_report':
        _ingest_target_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_search_term_report':
        _ingest_search_term_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_search_term_share_report':
        _ingest_search_term_share_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_time_trend_report':
        _ingest_time_trend_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_promoted_product_report':
        _ingest_promoted_product_rows(db, source_file_id=source_file_id, df=prepared_df)
    elif report_type == 'ad_purchased_product_report':
        _ingest_purchased_product_rows(db, source_file_id=source_file_id, df=prepared_df)


def save_ad_upload_scope(
    db: Session,
    *,
    project: Project,
    report_type: str,
    country: str,
    report_label: str,
    scope_date: date,
    scope_df: pd.DataFrame,
    row_count_preview: int,
    file_id: str,
    file_path: str,
    original_filename: str,
    recognition_status: str = 'recognized',
    matched_columns: list[str] | None = None,
    warnings: list[str] | None = None,
    recognition_payload: dict | None = None,
    created_by: str | None = None,
    file_sha256: str | None = None,
) -> AdUploadFile:
    """Persist a single (project, report_type, country, scope_date) AdUploadFile + detail rows.

    Module-level helper shared by:
      - ``commit_ad_upload`` (HTTP endpoint)
      - ``autoReportUpload.processor`` (RPA-style local ingestion)

    Supersedes the previous version of the same logic that lived as a nested
    function inside ``commit_ad_upload``. Centralizing it here avoids drift
    between the two entry points.

    Raises:
        ValueError on missing required fields; no HTTPException is thrown here.
    """
    if not report_type:
        raise ValueError('report_type is required')
    if not file_path:
        raise ValueError('file_path is required')

    scope_filters = (
        AdUploadFile.project_id == project.id,
        AdUploadFile.report_type == report_type,
        AdUploadFile.country == country,
        AdUploadFile.period_start_date == scope_date,
        AdUploadFile.period_end_date == scope_date,
    )

    max_version = (
        db.execute(
            select(func.coalesce(func.max(AdUploadFile.version), 0)).where(*scope_filters)
        )
        .scalar_one()
    )
    current_rows = (
        db.execute(
            select(AdUploadFile).where(*scope_filters, AdUploadFile.is_current.is_(True))
        )
        .scalars()
        .all()
    )
    for current_row in current_rows:
        current_row.is_current = False
        current_row.superseded_at = datetime.now(UTC)

    file_path_resolved = Path(file_path)
    file_size_bytes = file_path_resolved.stat().st_size if file_path_resolved.exists() else None
    file_extension = file_path_resolved.suffix.lower() or '.xlsx'

    new_row = AdUploadFile(
        project_id=project.id,
        project_name=project.project_name,
        report_type=report_type,
        report_label=report_label,
        country=country,
        report_date=scope_date,
        period_start_date=scope_date,
        period_end_date=scope_date,
        version=int(max_version) + 1,
        is_current=True,
        upload_file_id=str(file_id),
        upload_file_path=str(file_path_resolved),
        original_filename=(original_filename or '').strip() or None,
        stored_filename=str(file_id),
        logical_filename=(original_filename or file_id).strip(),
        file_extension=file_extension,
        file_size_bytes=file_size_bytes,
        recognition_status=recognition_status,
        ingestion_status='saved',
        row_count_preview=row_count_preview,
        matched_columns=list(matched_columns or []),
        warnings=list(warnings or []),
        recognition_payload=dict(recognition_payload or {}),
        created_by=(created_by or '').strip()[:255] or None,
        file_sha256=file_sha256,
    )
    db.add(new_row)
    db.flush()
    _ingest_detail_rows(
        db,
        source_file_id=int(new_row.id),
        report_type=new_row.report_type,
        path=file_path_resolved,
        df=scope_df,
    )
    return new_row


def commit_ad_upload(
    db: Session,
    settings: Settings,
    *,
    payload: AdUploadCommitRequest,
    operator: str | None = None,
    is_admin: bool = True,
) -> AdUploadCommitResponse:
    _ensure_table(db)

    recognition = recognize_saved_ad_upload(
        db,
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=payload.original_filename or '',
        country=payload.country,
        operator=operator,
        is_admin=is_admin,
    )
    if payload.report_type != recognition.report_type:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='report_type does not match recognized report',
        )

    project_name = (
        (payload.project_name or '').strip()
        or (recognition.project_match.project_name or '').strip()
    )
    project = _resolve_project(
        db,
        project_name=project_name,
        operator=operator,
        is_admin=is_admin,
    )

    report_start_date = _parse_yyyy_mm_dd(
        payload.report_start_date or recognition.detected_start_date or payload.report_date,
        'report_start_date',
    )
    report_end_date = _parse_yyyy_mm_dd(
        payload.report_end_date or recognition.detected_end_date or payload.report_date,
        'report_end_date',
    )
    if report_start_date > report_end_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='report_start_date must be <= report_end_date',
        )

    source_path = resolve_ad_upload_temp_file_path(settings, payload.temp_file_id)
    source_df = _prepare_ingest_dataframe(_read_dataframe(source_path))
    is_periodic_row_date_upload = (
        payload.report_type.startswith('ad_')
        and '日期' in source_df.columns
        and '开始日期' not in source_df.columns
        and '结束日期' not in source_df.columns
    )

    if not is_periodic_row_date_upload:
        _ensure_single_day_range(start_date=report_start_date, end_date=report_end_date)

    if payload.report_date and not is_periodic_row_date_upload:
        input_report_date = _parse_yyyy_mm_dd(payload.report_date, 'report_date')
        if input_report_date != report_start_date:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='report_date 必须与识别出的单日报表日期一致',
            )

    # dry_run=True：产品分析手动核算场景 — 仅完成识别校验 + 临时文件复制，
    # 不写入 ad_upload_files / ad_upload_promoted_product_rows，不写 ReportUploadLog，
    # 不占用版本号。原报表仍可继续在 ad-upload 页面通过正式 commit 入库。
    if payload.dry_run:
        try:
            file_meta = finalize_ad_upload_temp_file(
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=payload.original_filename or recognition.original_filename,
                project_name=project.project_name,
                report_type=payload.report_type,
            )
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f'临时文件不存在或已失效: {exc}',
            ) from exc

        return AdUploadCommitResponse(
            id=0,
            report_type=payload.report_type,
            report_label=recognition.report_label,
            ingestion_status='skipped',
            project_name=project.project_name,
            country=recognition.country,
            report_date=report_start_date.isoformat(),
            report_start_date=report_start_date.isoformat(),
            report_end_date=report_end_date.isoformat(),
            file_id=str(file_meta['file_id']),
            file_path=str(file_meta['file_path']),
            version=0,
            is_current=False,
            message=(
                f'已识别为周期/单日广告报表（dry_run）：未写入 ad_upload_files。'
                f'共解析 {len(source_df.index)} 行（{report_start_date} ~ {report_end_date}）。'
                if is_periodic_row_date_upload
                else f'已识别为单日广告报表（dry_run）：未写入 ad_upload_files。共解析 {len(source_df.index)} 行（{report_start_date}）。'
            ),
        )

    file_meta = finalize_ad_upload_temp_file(
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=payload.original_filename or recognition.original_filename,
        project_name=project.project_name,
        report_type=payload.report_type,
    )

    # Compute SHA-256 of the source file once; reused for all (periodic) scopes.
    file_sha256_hash: str | None = None
    try:
        file_sha256_hash = sha256_file(Path(str(file_meta['file_path'])))
    except (OSError, FileNotFoundError):
        # File not on disk (e.g. test fixtures) — leave hash as None.
        file_sha256_hash = None

    def _save_scope(*, scope_date: date, scope_df: pd.DataFrame, row_count_preview: int) -> AdUploadFile:
        return save_ad_upload_scope(
            db,
            project=project,
            report_type=payload.report_type,
            country=recognition.country,
            report_label=recognition.report_label,
            scope_date=scope_date,
            scope_df=scope_df,
            row_count_preview=row_count_preview,
            file_id=str(file_meta['file_id']),
            file_path=str(file_meta['file_path']),
            original_filename=payload.original_filename or recognition.original_filename or '',
            recognition_status=recognition.status,
            matched_columns=list(recognition.matched_columns),
            warnings=list(recognition.warnings),
            recognition_payload=recognition.model_dump(mode='json'),
            created_by=operator,
            file_sha256=file_sha256_hash,
        )

    saved_rows: list[AdUploadFile] = []
    if is_periodic_row_date_upload:
        source_df = source_df.copy()
        source_df['__row_date__'] = pd.to_datetime(source_df['日期'], errors='coerce')
        normalized_range = source_df.dropna(subset=['__row_date__']).copy()
        if normalized_range.empty:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail='日期 is required',
            )
        normalized_range['__row_date_key__'] = normalized_range['__row_date__'].dt.strftime('%Y-%m-%d')
        for row_date_text, scope_df in normalized_range.groupby('__row_date_key__', sort=True):
            scope_date = _parse_yyyy_mm_dd(str(row_date_text), '日期')
            saved_rows.append(
                _save_scope(
                    scope_date=scope_date,
                    scope_df=scope_df.drop(columns=['__row_date__', '__row_date_key__']),
                    row_count_preview=len(scope_df.index),
                )
            )
    else:
        saved_rows.append(
            _save_scope(
                scope_date=report_start_date,
                scope_df=source_df,
                row_count_preview=recognition.row_count_preview or len(source_df.index),
            )
        )

    # 为每个 scope 写入 ReportUploadLog（RPA 状态回退 Priority 1：写入日期判定）
    from app.utils.persist_helpers import write_report_upload_log

    for saved_row in saved_rows:
        write_report_upload_log(
            db,
            project_id=int(saved_row.project_id),
            country=saved_row.country,
            report_type=saved_row.report_type,
            upload_date=saved_row.report_date,
            source_file_id=None,
            has_real_data=saved_row.ingestion_status == "success",
            row_count=saved_row.row_count_preview or 0,
            original_filename=saved_row.original_filename,
        )

    # Also write a ReportUploadLog for today (upload date) so that the RPA
    # status grid shows green for the CURRENT day — not just the business
    # dates.  One log per (project, report_type, country, today) is enough;
    # dedup by writing only if no log for today exists yet.
    import datetime as _dt
    _today = _dt.date.today()
    _seen_today_keys: set[tuple[int, str, str]] = set()
    for saved_row in saved_rows:
        key = (int(saved_row.project_id), saved_row.report_type, saved_row.country)
        if key in _seen_today_keys:
            continue
        if saved_row.report_date == _today:
            continue  #已有跟今天同日期的业务日志,无需重复
        write_report_upload_log(
            db,
            project_id=int(saved_row.project_id),
            country=saved_row.country,
            report_type=saved_row.report_type,
            upload_date=_today,
            source_file_id=None,
            has_real_data=saved_row.ingestion_status == "success",
            row_count=saved_row.row_count_preview or 0,
            original_filename=saved_row.original_filename,
        )
        _seen_today_keys.add(key)

    db.commit()
    for saved_row in saved_rows:
        db.refresh(saved_row)

    result_row = saved_rows[-1]
    message = (
        f'广告报表已按 {len(saved_rows)} 个日期保存并覆盖对应单日数据'
        if is_periodic_row_date_upload
        else '广告报表已保存到新的 ad-upload 链路'
    )

    return AdUploadCommitResponse(
        id=int(result_row.id),
        report_type=result_row.report_type,
        report_label=result_row.report_label,
        ingestion_status=result_row.ingestion_status,
        project_name=result_row.project_name,
        country=result_row.country,
        report_date=result_row.report_date.isoformat() if result_row.report_date else None,
        report_start_date=result_row.period_start_date.isoformat(),
        report_end_date=result_row.period_end_date.isoformat(),
        file_id=result_row.upload_file_id,
        file_path=result_row.upload_file_path,
        version=result_row.version,
        is_current=result_row.is_current,
        message=message,
    )


def list_ad_upload_statuses(
    db: Session,
    *,
    country: str = 'US',
    project_name: str | None = None,
    report_type: str | None = None,
    report_date: str | None = None,
    limit: int = 50,
    operator: str | None = None,
    is_admin: bool = True,
) -> AdUploadStatusResponse:
    _ensure_table(db)

    normalized_country = normalize_country(country)
    stmt = select(AdUploadFile).where(AdUploadFile.country == normalized_country)

    import app.services.project_service as project_service

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(
            db,
            operator=operator,
            is_admin=is_admin,
        )
    }
    if allowed_projects:
        stmt = stmt.where(AdUploadFile.project_name.in_(sorted(allowed_projects)))
    elif not is_admin:
        return AdUploadStatusResponse(country=normalized_country, items=[])

    normalized_project_name = (project_name or '').strip()
    if normalized_project_name:
        stmt = stmt.where(AdUploadFile.project_name == normalized_project_name)

    normalized_report_type = (report_type or '').strip()
    if normalized_report_type:
        stmt = stmt.where(AdUploadFile.report_type == normalized_report_type)

    normalized_report_date = (report_date or '').strip()
    if normalized_report_date:
        stmt = stmt.where(AdUploadFile.report_date == _parse_yyyy_mm_dd(normalized_report_date, 'report_date'))

    rows = (
        db.execute(
            stmt.order_by(
                AdUploadFile.updated_at.desc(),
                AdUploadFile.id.desc(),
            ).limit(max(1, min(limit, 200)))
        )
        .scalars()
        .all()
    )

    return AdUploadStatusResponse(
        country=normalized_country,
        items=[
            AdUploadStatusItem(
                id=int(row.id),
                project_name=row.project_name,
                report_type=row.report_type,
                report_label=row.report_label,
                country=row.country,
                report_date=row.report_date.isoformat() if row.report_date else None,
                report_start_date=row.period_start_date.isoformat(),
                report_end_date=row.period_end_date.isoformat(),
                version=row.version,
                is_current=row.is_current,
                recognition_status=row.recognition_status,
                ingestion_status=row.ingestion_status,
                original_filename=row.original_filename,
                row_count_preview=row.row_count_preview,
                updated_at=row.updated_at.isoformat() if row.updated_at else None,
                warnings=list(row.warnings or []),
            )
            for row in rows
        ],
    )
