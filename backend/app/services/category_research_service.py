from __future__ import annotations

from collections import Counter
import csv
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import re
from threading import Lock
from typing import Any
import zipfile

import numpy as np
import pandas as pd
from openpyxl import Workbook, load_workbook
from sqlalchemy import Select, func, insert, select, update as sa_update
from sqlalchemy.orm import Session
from slugify import slugify

from app.models import (
    CategoryResearchDataset,
    CategoryResearchProductDetail,
    CategoryResearchSalesTrend,
)
from app.schemas.system_management import UserRoleType
from app.services.upload_service import resolve_upload_file_path, save_upload_file

_PRICE_RAW_ALIASES = ['实际价格($)', '目前销售价($)', '价格($)', 'Price']
_FBA_FEE_RAW_ALIASES = ['FBA费用($)', 'FBA费用']
_RATING_RAW_ALIASES = ['评分星级', '星级', 'Rating']
_REVIEW_COUNT_RAW_ALIASES = ['评价数量', 'Review Count', 'Reviews']
_LAUNCH_DATE_RAW_ALIASES = ['上架时间', 'Launch Date']
_LISTING_AGE_DAYS_RAW_ALIASES = ['上架天数', 'Listing Age Days']
_FULFILLMENT_METHOD_RAW_ALIASES = ['物流方式', 'Fulfillment', '配送方式']
_BBX_SELLER_ATTRIBUTE_RAW_ALIASES = ['BBX卖家属性', '卖家属性']
_VARIANT_COUNT_RAW_ALIASES = ['变体数量', 'Variations', 'Variation Count', 'Variation Count Total']
_MAIN_IMAGE_VIDEO_RAW_ALIASES = ['主图视频', 'Main Image Video', 'Has Main Image Video']
_CLIMATE_PLEDGE_RAW_ALIASES = ['是否气候承诺友好标', '气候承诺友好标', 'Climate Pledge Friendly']
_BRAND_STORE_RAW_ALIASES = ['是否做品牌旗舰店', '品牌旗舰店', 'Brand Store', 'Has Brand Store']
_SELLER_COUNTRY_REGION_RAW_ALIASES = ['国籍/地区', '国家/地区', 'Country/Region', 'Seller Country/Region']
_DIMENSION_ALIASES: dict[str, list[str]] = {
    'blade_material': ['Blade Material', '刀片材质', '刀片材料'],
    'product_material': ['Material', '材质', '产品材质'],
    'color': ['Color', '颜色'],
    'size': ['Size', '尺寸', '规格'],
}
_DIMENSION_LABELS: dict[str, str] = {
    'blade_material': 'Blade Material',
    'product_material': 'Material',
    'color': 'Color',
    'size': 'Size',
}
_PRICE_BAND_PRESETS: dict[str, list[float]] = {
    'default': [50.0, 100.0, 150.0],
    'value': [30.0, 60.0, 100.0, 150.0],
    'premium': [100.0, 150.0, 200.0, 300.0],
}
_EXPORT_ITEMS: tuple[dict[str, str], ...] = (
    {
        'key': 'raw_xlsx',
        'label': '原始上传文件',
        'description': '下载最初上传的类目调研工作簿，适合复核源数据。',
        'format': 'xlsx',
    },
    {
        'key': 'summary_pdf',
        'label': '摘要 PDF',
        'description': '面向汇报场景的调研摘要，包含结论、风险、机会与建议动作。',
        'format': 'pdf',
    },
    {
        'key': 'analysis_workbook',
        'label': '分析结果 Excel',
        'description': '包含摘要、品牌、价格带、产品明细、趋势明细和指标定义。',
        'format': 'xlsx',
    },
    {
        'key': 'product_details_csv',
        'label': '产品明细 CSV',
        'description': '导出结构化产品明细，方便二次筛选和脚本分析。',
        'format': 'csv',
    },
    {
        'key': 'trend_details_csv',
        'label': '趋势明细 CSV',
        'description': '导出 ASIN 月销量趋势明细，适合做时间序列分析。',
        'format': 'csv',
    },
    {
        'key': 'export_bundle_zip',
        'label': '导出打包 ZIP',
        'description': '打包原始文件、摘要 PDF、分析结果 Excel 和两份 CSV，适合直接交付。',
        'format': 'zip',
    },
)


@dataclass
class ParsedWorkbookPayload:
    product_rows: list[dict[str, Any]]
    trend_rows: list[dict[str, Any]]
    quality_warnings: dict[str, Any]


@dataclass
class CategoryResearchExportPayload:
    filename: str
    media_type: str
    content: bytes | None = None
    file_path: Path | None = None


def import_category_research_dataset(
    db: Session,
    *,
    settings: Any,
    marketplace: str,
    category_keyword_en: str,
    category_name_zh: str,
    upload_file: Any,
    created_by: str | None = None,
) -> CategoryResearchDataset:
    
    normalized_marketplace = _normalize_marketplace(marketplace)
    normalized_keyword = _normalize_category_keyword(category_keyword_en)
    normalized_name_zh = _normalize_name_zh(category_name_zh)

    folder_name = f'category-research-{normalized_marketplace}-{normalized_keyword}'
    file_payload = save_upload_file(
        file=upload_file,
        settings=settings,
        project_name=folder_name,
        file_type='category_research_xlsx',
    )

    workbook_path = Path(str(file_payload['file_path']))
    parsed = _parse_workbook(workbook_path)

    next_version = _next_version(
        db,
        marketplace=normalized_marketplace,
        category_keyword_en=normalized_keyword,
    )

    now = datetime.now(UTC)
    db.execute(
        sa_update(CategoryResearchDataset)
        .where(
            CategoryResearchDataset.marketplace == normalized_marketplace,
            CategoryResearchDataset.category_keyword_en == normalized_keyword,
            CategoryResearchDataset.is_current.is_(True),
        )
        .values(is_current=False, superseded_at=now)
    )

    dataset = CategoryResearchDataset(
        marketplace=normalized_marketplace,
        category_keyword_en=normalized_keyword,
        category_name_zh=normalized_name_zh,
        version=next_version,
        is_current=True,
        superseded_at=None,
        upload_file_id=str(file_payload['file_id']),
        upload_file_path=str(file_payload['file_path']),
        original_filename=str(file_payload.get('original_filename') or ''),
        stored_filename=str(file_payload['filename']),
        file_size_bytes=int(file_payload.get('size') or 0),
        file_sha256=_file_sha256(workbook_path),
        ingestion_status='success',
        ingestion_error=None,
        data_date=now.date(),
        row_count_products=len(parsed.product_rows),
        row_count_trends=len(parsed.trend_rows),
        quality_warnings=parsed.quality_warnings,
        created_by=(created_by or '').strip() or None,
    )
    db.add(dataset)
    db.flush()

    if parsed.product_rows:
        for row in parsed.product_rows:
            row['dataset_id'] = dataset.id
        db.execute(insert(CategoryResearchProductDetail), parsed.product_rows)

    if parsed.trend_rows:
        for row in parsed.trend_rows:
            row['dataset_id'] = dataset.id
        db.execute(insert(CategoryResearchSalesTrend), parsed.trend_rows)

    db.commit()
    db.refresh(dataset)
    return dataset


def list_datasets(
    db: Session,
    *,
    marketplace: str | None = None,
    category_keyword_en: str | None = None,
    current_only: bool = True,
    role_type: str | None = None,
    operator: str | None = None,
) -> list[CategoryResearchDataset]:
    
    stmt: Select = select(CategoryResearchDataset).order_by(
        CategoryResearchDataset.data_date.desc(),
        CategoryResearchDataset.created_at.desc(),
        CategoryResearchDataset.id.desc(),
    )
    if current_only:
        stmt = stmt.where(CategoryResearchDataset.is_current.is_(True))
    if marketplace:
        stmt = stmt.where(CategoryResearchDataset.marketplace == _normalize_marketplace(marketplace))
    if category_keyword_en:
        stmt = stmt.where(CategoryResearchDataset.category_keyword_en == _normalize_category_keyword(category_keyword_en))
    if role_type == UserRoleType.factory.value and operator:
        stmt = stmt.where(CategoryResearchDataset.created_by == operator)

    return list(db.execute(stmt).scalars().all())


def recompute_dataset_from_history(db: Session, dataset_id: int) -> CategoryResearchDataset:
    dataset = db.get(CategoryResearchDataset, dataset_id)
    if dataset is None:
        raise ValueError('Dataset not found')

    _recompute_dataset_fields(db, dataset)
    db.commit()
    db.refresh(dataset)
    return dataset


def recompute_datasets_from_history(
    db: Session,
    *,
    marketplace: str | None = None,
    category_keyword_en: str | None = None,
    include_history: bool = True,
) -> dict[str, Any]:
    
    stmt: Select = select(CategoryResearchDataset).order_by(
        CategoryResearchDataset.data_date.desc(),
        CategoryResearchDataset.created_at.desc(),
        CategoryResearchDataset.id.desc(),
    )
    if marketplace:
        stmt = stmt.where(CategoryResearchDataset.marketplace == _normalize_marketplace(marketplace))
    if category_keyword_en:
        stmt = stmt.where(CategoryResearchDataset.category_keyword_en == _normalize_category_keyword(category_keyword_en))
    if include_history is False:
        stmt = stmt.where(CategoryResearchDataset.is_current.is_(True))

    datasets = list(db.execute(stmt).scalars().all())
    updated_ids: list[int] = []
    for dataset in datasets:
        _recompute_dataset_fields(db, dataset)
        updated_ids.append(int(dataset.id))

    db.commit()
    return {
        'matched': len(datasets),
        'recomputed': len(updated_ids),
        'dataset_ids': updated_ids,
    }


def upsert_manual_dimensions(
    db: Session,
    *,
    dataset_id: int,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')
    if not items:
        return {'dataset_id': dataset_id, 'updated_count': 0}

    row_ids = sorted({int(item.get('product_row_id') or 0) for item in items if int(item.get('product_row_id') or 0) > 0})
    if not row_ids:
        raise ValueError('items.product_row_id is required')

    rows = list(
        db.execute(
            select(CategoryResearchProductDetail).where(
                CategoryResearchProductDetail.dataset_id == dataset_id,
                CategoryResearchProductDetail.id.in_(row_ids),
            )
        ).scalars().all()
    )
    row_map = {int(row.id): row for row in rows}
    updated_row_ids: set[int] = set()

    for item in items:
        row_id = int(item.get('product_row_id') or 0)
        row = row_map.get(row_id)
        if row is None:
            raise ValueError(f'product_row_id not found in dataset: {row_id}')

        key = _normalize_dimension_key(str(item.get('key') or ''))
        if not key:
            raise ValueError('dimension key is required')
        value = _normalize_dimension_value(item.get('value'))

        manual = _normalize_dimension_map(row.manual_dimensions)
        if value is None:
            manual.pop(key, None)
        else:
            manual[key] = value
        row.manual_dimensions = manual
        updated_row_ids.add(row_id)

    db.commit()
    return {'dataset_id': dataset_id, 'updated_count': len(updated_row_ids)}


def normalize_dimension_map(payload: Any) -> dict[str, str]:
    return _normalize_dimension_map(payload)


def effective_dimensions(row: CategoryResearchProductDetail) -> dict[str, str]:
    return _effective_dimensions(row)


def get_dataset_or_none(db: Session, dataset_id: int) -> CategoryResearchDataset | None:
    return db.get(CategoryResearchDataset, dataset_id)


def list_available_exports(
    db: Session,
    *,
    settings: Any,
    dataset_id: int,
) -> list[dict[str, Any]]:
    dataset = get_dataset_or_none(db, dataset_id)
    if dataset is None:
        raise ValueError('Dataset not found')

    items: list[dict[str, Any]] = []
    for item in _EXPORT_ITEMS:
        export_key = str(item['key'])
        items.append(
            {
                **item,
                'available': _export_is_available(settings, dataset, export_key),
                'filename': _export_filename(dataset, export_key),
            }
        )
    return items


def build_export_payload(
    db: Session,
    *,
    settings: Any,
    dataset_id: int,
    export_key: str,
    price_band_standard: str | None = None,
    price_band_breaks: str | None = None,
) -> CategoryResearchExportPayload:
    dataset = get_dataset_or_none(db, dataset_id)
    if dataset is None:
        raise ValueError('Dataset not found')

    normalized_key = (export_key or '').strip()
    if normalized_key == 'raw_xlsx':
        raw_path = _resolve_dataset_raw_file_path(settings, dataset)
        return CategoryResearchExportPayload(
            filename=_export_filename(dataset, normalized_key, original_filename=dataset.original_filename),
            media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            file_path=raw_path,
        )

    products = _list_all_dataset_products(db, dataset_id=dataset_id)
    trends = _list_all_dataset_trends(db, dataset_id=dataset_id)
    overview = get_dataset_overview(
        db,
        dataset_id,
        price_band_standard=price_band_standard,
        price_band_breaks=price_band_breaks,
    )

    if normalized_key == 'analysis_workbook':
        return CategoryResearchExportPayload(
            filename=_export_filename(dataset, normalized_key),
            media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            content=_build_analysis_workbook_bytes(
                dataset=dataset,
                overview=overview,
                products=products,
                trends=trends,
            ),
        )

    if normalized_key == 'summary_pdf':
        return CategoryResearchExportPayload(
            filename=_export_filename(dataset, normalized_key),
            media_type='application/pdf',
            content=_build_summary_pdf_bytes(
                dataset=dataset,
                overview=overview,
            ),
        )

    if normalized_key == 'product_details_csv':
        return CategoryResearchExportPayload(
            filename=_export_filename(dataset, normalized_key),
            media_type='text/csv; charset=utf-8',
            content=_build_product_csv_bytes(products),
        )

    if normalized_key == 'trend_details_csv':
        return CategoryResearchExportPayload(
            filename=_export_filename(dataset, normalized_key),
            media_type='text/csv; charset=utf-8',
            content=_build_trend_csv_bytes(trends),
        )

    if normalized_key == 'export_bundle_zip':
        return CategoryResearchExportPayload(
            filename=_export_filename(dataset, normalized_key),
            media_type='application/zip',
            content=_build_export_bundle_zip_bytes(
                settings=settings,
                dataset=dataset,
                overview=overview,
                products=products,
                trends=trends,
            ),
        )

    raise ValueError('Unsupported export type')


def get_dataset_overview(
    db: Session,
    dataset_id: int,
    *,
    price_band_standard: str | None = None,
    price_band_breaks: str | None = None,
) -> dict[str, Any]:
    dataset = db.get(CategoryResearchDataset, dataset_id)
    if dataset is None:
        raise ValueError('Dataset not found')

    rows = list(
        db.execute(
            select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)
        ).scalars().all()
    )
    trend_rows = list(
        db.execute(
            select(CategoryResearchSalesTrend).where(CategoryResearchSalesTrend.dataset_id == dataset_id)
        ).scalars().all()
    )
    asins = sorted(
        {
            str(item.asin)
            for item in trend_rows
            if item
        }
    )

    prices = [float(item.price_usd) for item in rows if item.price_usd is not None]
    monthly_sales_values = [int(item.monthly_sales or 0) for item in rows]
    monthly_revenue_values = [float(item.monthly_revenue_usd or 0) for item in rows]
    total_monthly_sales = int(sum(monthly_sales_values))
    total_monthly_revenue = float(sum(monthly_revenue_values))
    amazon_count = sum(1 for item in rows if item.is_amazon)

    brand_counter: dict[str, int] = {}
    for item in rows:
        brand = (item.brand or 'Unknown').strip() or 'Unknown'
        brand_counter[brand] = brand_counter.get(brand, 0) + int(item.monthly_sales or 0)
    total_brand_sales = sum(brand_counter.values())
    brand_sales_share = [
        {
            'brand': brand,
            'monthly_sales': int(sales),
            'share': round((sales / total_brand_sales) if total_brand_sales else 0.0, 6),
        }
        for brand, sales in sorted(brand_counter.items(), key=lambda pair: pair[1], reverse=True)[:10]
    ]

    listing_age_distribution_counter: Counter[str] = Counter()
    for item in rows:
        age = item.listing_age_days
        if age is None:
            listing_age_distribution_counter['未知'] += 1
        elif age <= 90:
            listing_age_distribution_counter['0-90天'] += 1
        elif age <= 180:
            listing_age_distribution_counter['91-180天'] += 1
        elif age <= 365:
            listing_age_distribution_counter['181-365天'] += 1
        else:
            listing_age_distribution_counter['365天+'] += 1

    launch_month_distribution = _build_launch_month_distribution(rows)
    fulfillment_counter: Counter[str] = Counter()
    for item in rows:
        key = (item.fulfillment_method or '未知').strip() or '未知'
        fulfillment_counter[key] += 1

    price_band_spec = _resolve_price_band_spec(standard=price_band_standard, breaks_text=price_band_breaks, prices=prices)
    fixed_price_bands = _build_fixed_price_bands(prices, spec=price_band_spec)
    quantile_price_bands = _build_quantile_price_bands(prices)
    price_stats = _build_price_stats(prices)

    correlation = _price_sales_correlation(rows)

    fba_fee_distribution = _build_fba_fee_distribution(rows)

    points = [
        {
            'asin': item.asin,
            'price_usd': float(item.price_usd),
            'monthly_sales': int(item.monthly_sales or 0),
        }
        for item in rows
        if item.price_usd is not None
    ]
    points = sorted(points, key=lambda entry: entry['monthly_sales'], reverse=True)[:300]

    market_concentration = _build_market_concentration(brand_counter, total_brand_sales)
    brand_monopoly = _build_brand_monopoly(brand_counter, total_brand_sales)
    seller_monopoly = _build_seller_monopoly(rows)
    product_monopoly = _build_product_monopoly(rows)
    china_seller_competition = _build_china_seller_competition(rows)
    market_growth = _build_market_growth(trend_rows)
    seasonality = _build_seasonality(trend_rows)
    review_research = _build_review_research(rows)
    price_band_opportunities = _build_price_band_opportunities(
            rows,
            total_monthly_sales=total_monthly_sales,
            total_monthly_revenue=total_monthly_revenue,
            spec=price_band_spec,
    )
    dimension_price_band_analysis = _build_dimension_price_band_analysis(rows, spec=price_band_spec)
    brand_price_band_analysis = _build_brand_price_band_analysis(rows, spec=price_band_spec)
    new_product_opportunity = _build_new_product_opportunity(rows, total_monthly_sales=total_monthly_sales)
    supply_complexity = _build_supply_complexity(
            rows,
            fulfillment_counter=fulfillment_counter,
            prices=prices,
    )
    asin_momentum = _build_asin_momentum(trend_rows)
    data_quality = _build_data_quality(dataset, rows)

    advanced_metrics = {
        'market_concentration': market_concentration,
        'brand_monopoly': brand_monopoly,
        'seller_monopoly': seller_monopoly,
        'product_monopoly': product_monopoly,
        'china_seller_competition': china_seller_competition,
        'market_growth': market_growth,
        'seasonality': seasonality,
        'review_research': review_research,
        'price_band_opportunities': price_band_opportunities,
        'price_band_standard': price_band_spec['name'],
        'price_band_method': price_band_spec['method'],
        'price_band_method_description': price_band_spec['description'],
        'price_band_breaks': price_band_spec['breaks'],
        'price_correlation_score': round(max(0.0, 100.0 - (abs(correlation) * 100.0)), 2),
        'dimension_price_band_analysis': dimension_price_band_analysis,
        'brand_price_band_analysis': brand_price_band_analysis,
        'new_product_opportunity': new_product_opportunity,
        'supply_complexity': supply_complexity,
        'asin_momentum': asin_momentum,
        'data_quality': data_quality,
    }
    advanced_metrics['dimension_blocks'] = _build_dimension_blocks(advanced_metrics)
    advanced_metrics['metric_definitions'] = _build_metric_definitions(advanced_metrics)
    advanced_metrics['action_recommendations'] = _build_action_recommendations(advanced_metrics)
    advanced_metrics['signals'] = _build_signals(advanced_metrics)
    advanced_metrics['dimension_profiles'] = _build_dimension_profiles(rows)

    return {
        'dataset': dataset,
        'kpis': {
            'sample_count': len(rows),
            'brand_count': len({(item.brand or '').strip() for item in rows if (item.brand or '').strip()}),
            'average_price_usd': round(float(np.mean(prices)) if prices else 0.0, 2),
            'total_monthly_sales': total_monthly_sales,
            'total_monthly_revenue_usd': round(total_monthly_revenue, 2),
            'amazon_share': round((amazon_count / len(rows)) if rows else 0.0, 6),
        },
        'brand_sales_share': brand_sales_share,
        'listing_age_distribution': [
            {'label': label, 'count': int(count)}
            for label, count in listing_age_distribution_counter.items()
        ],
        'launch_month_distribution': launch_month_distribution,
        'fulfillment_distribution': [
            {'label': label, 'count': int(count)}
            for label, count in fulfillment_counter.items()
        ],
        'fixed_price_bands': fixed_price_bands,
        'quantile_price_bands': quantile_price_bands,
        'price_stats': price_stats,
        'price_sales_correlation': round(correlation, 6),
        'fba_fee_distribution': fba_fee_distribution,
        'price_sales_points': points,
        'available_asins': asins,
        'advanced_metrics': advanced_metrics,
    }


def list_dataset_products(
    db: Session,
    *,
    dataset_id: int,
    page: int,
    page_size: int,
    brand: str | None = None,
    fulfillment_method: str | None = None,
    price_band: str | None = None,
    price_band_standard: str | None = None,
    price_band_breaks: str | None = None,
) -> tuple[list[CategoryResearchProductDetail], bool]:
    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')

    stmt: Select = select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)

    if brand and brand.strip():
        stmt = stmt.where(CategoryResearchProductDetail.brand == brand.strip())
    if fulfillment_method and fulfillment_method.strip():
        stmt = stmt.where(CategoryResearchProductDetail.fulfillment_method == fulfillment_method.strip())

    if price_band and price_band.strip():
        price_band_spec = _resolve_price_band_spec(standard=price_band_standard, breaks_text=price_band_breaks)
        normalized = price_band.strip()
        match_band = next((item for item in price_band_spec['bands'] if item['key'] == normalized or item['label'] == normalized), None)
        if match_band is not None:
            lower = float(match_band['lower'])
            upper = float(match_band['upper']) if match_band['upper'] is not None else None
            conditions = [CategoryResearchProductDetail.price_usd.is_not(None), CategoryResearchProductDetail.price_usd >= lower]
            if upper is not None:
                conditions.append(CategoryResearchProductDetail.price_usd < upper)
            stmt = stmt.where(*conditions)

    stmt = stmt.order_by(
        CategoryResearchProductDetail.monthly_sales.desc(),
        CategoryResearchProductDetail.id.asc(),
    )

    offset = (page - 1) * page_size
    rows = list(db.execute(stmt.offset(offset).limit(page_size + 1)).scalars().all())
    has_next = len(rows) > page_size
    return rows[:page_size], has_next


def list_dataset_trend_points(
    db: Session,
    *,
    dataset_id: int,
    asin: str,
) -> list[CategoryResearchSalesTrend]:
    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')
    normalized_asin = _normalize_asin(asin)
    if not normalized_asin:
        raise ValueError('asin is required')

    rows = list(
        db.execute(
            select(CategoryResearchSalesTrend)
            .where(
                CategoryResearchSalesTrend.dataset_id == dataset_id,
                CategoryResearchSalesTrend.asin == normalized_asin,
            )
            .order_by(CategoryResearchSalesTrend.year_month.asc())
        ).scalars().all()
    )
    return rows


def get_dataset_market_trend_points(
    db: Session,
    *,
    dataset_id: int,
    months: int = 24,
) -> list[dict[str, Any]]:
    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')
    if months < 1:
        raise ValueError('months must be >= 1')

    trend_rows = list(
        db.execute(
            select(CategoryResearchSalesTrend).where(CategoryResearchSalesTrend.dataset_id == dataset_id)
        ).scalars().all()
    )
    monthly_totals = _aggregate_market_monthly_sales(trend_rows)
    totals_by_month: dict[date, int] = {}
    for year_month, sales in monthly_totals.items():
        if not _is_year_month(year_month):
            continue
        month_date = date(int(year_month[:4]), int(year_month[5:7]), 1)
        totals_by_month[month_date] = int(sales)

    if not totals_by_month:
        return []

    end_month = max(totals_by_month.keys())
    start_month = _shift_month(end_month, -(months - 1))

    points: list[dict[str, Any]] = []
    current = start_month
    while current <= end_month:
        points.append(
            {
                'year_month': f'{current.year:04d}-{current.month:02d}',
                'monthly_sales': int(totals_by_month.get(current, 0)),
            }
        )
        current = _shift_month(current, 1)
    return points


def _export_is_available(settings: Any, dataset: CategoryResearchDataset, export_key: str) -> bool:
    if export_key in {'summary_pdf', 'export_bundle_zip'} and not _has_reportlab():
        return False
    if export_key != 'raw_xlsx':
        return True
    try:
        raw_path = _resolve_dataset_raw_file_path(settings, dataset)
    except FileNotFoundError:
        return False
    return raw_path.exists() and raw_path.is_file()


def _resolve_dataset_raw_file_path(settings: Any, dataset: CategoryResearchDataset) -> Path:
    file_path = Path(str(dataset.upload_file_path or '')).expanduser()
    if file_path.exists() and file_path.is_file():
        return file_path
    folder_name = f'category-research-{dataset.marketplace}-{dataset.category_keyword_en}'
    return resolve_upload_file_path(settings, folder_name, 'category_research_xlsx', str(dataset.upload_file_id))


def _dataset_base_slug(dataset: CategoryResearchDataset) -> str:
    keyword_slug = slugify(dataset.category_keyword_en or '')[:60] or 'category-research'
    return f'category-research-{dataset.marketplace.lower()}-{keyword_slug}-v{int(dataset.version)}'


def _export_filename(
    dataset: CategoryResearchDataset,
    export_key: str,
    *,
    original_filename: str | None = None,
) -> str:
    base = _dataset_base_slug(dataset)
    if export_key == 'raw_xlsx':
        original = Path(original_filename or '').name
        if original:
            return original
        return f'{base}-raw.xlsx'
    if export_key == 'summary_pdf':
        return f'{base}-summary.pdf'
    if export_key == 'analysis_workbook':
        return f'{base}-analysis.xlsx'
    if export_key == 'product_details_csv':
        return f'{base}-products.csv'
    if export_key == 'trend_details_csv':
        return f'{base}-trends.csv'
    if export_key == 'export_bundle_zip':
        return f'{base}-bundle.zip'
    return f'{base}-{slugify(export_key) or "export"}.bin'


def _list_all_dataset_products(db: Session, *, dataset_id: int) -> list[CategoryResearchProductDetail]:
    return list(
        db.execute(
            select(CategoryResearchProductDetail)
            .where(CategoryResearchProductDetail.dataset_id == dataset_id)
            .order_by(
                CategoryResearchProductDetail.monthly_sales.desc(),
                CategoryResearchProductDetail.id.asc(),
            )
        ).scalars().all()
    )


def _list_all_dataset_trends(db: Session, *, dataset_id: int) -> list[CategoryResearchSalesTrend]:
    return list(
        db.execute(
            select(CategoryResearchSalesTrend)
            .where(CategoryResearchSalesTrend.dataset_id == dataset_id)
            .order_by(
                CategoryResearchSalesTrend.asin.asc(),
                CategoryResearchSalesTrend.year_month.asc(),
                CategoryResearchSalesTrend.id.asc(),
            )
        ).scalars().all()
    )


def _stringify_json(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _csv_bytes(headers: list[str], rows: list[list[Any]]) -> bytes:
    stream = StringIO()
    writer = csv.writer(stream)
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue().encode('utf-8-sig')


def _build_product_csv_bytes(products: list[CategoryResearchProductDetail]) -> bytes:
    headers = [
        'product_row_id',
        'source_row_no',
        'asin',
        'parent_asin',
        'product_name',
        'brand',
        'seller',
        'price_usd',
        'monthly_sales',
        'monthly_revenue_usd',
        'rating',
        'review_count',
        'launch_date',
        'listing_age_days',
        'fba_fee_usd',
        'fulfillment_method',
        'bbx_seller_attribute',
        'variant_count',
        'has_main_image_video',
        'is_climate_pledge_friendly',
        'has_brand_store',
        'seller_country_region',
        'is_amazon',
        'is_new_90d',
        'extracted_dimensions',
        'manual_dimensions',
        'effective_dimensions',
    ]
    rows = [
        [
            int(item.id),
            int(item.source_row_no),
            item.asin or '',
            item.parent_asin or '',
            item.product_name or '',
            item.brand or '',
            item.seller or '',
            float(item.price_usd) if item.price_usd is not None else '',
            int(item.monthly_sales or 0),
            float(item.monthly_revenue_usd) if item.monthly_revenue_usd is not None else '',
            float(item.rating) if item.rating is not None else '',
            int(item.review_count or 0),
            item.launch_date.isoformat() if item.launch_date else '',
            int(item.listing_age_days) if item.listing_age_days is not None else '',
            float(item.fba_fee_usd) if item.fba_fee_usd is not None else '',
            item.fulfillment_method or '',
            item.bbx_seller_attribute or '',
            int(item.variant_count) if item.variant_count is not None else '',
            bool(item.has_main_image_video) if item.has_main_image_video is not None else '',
            bool(item.is_climate_pledge_friendly) if item.is_climate_pledge_friendly is not None else '',
            bool(item.has_brand_store) if item.has_brand_store is not None else '',
            item.seller_country_region or '',
            bool(item.is_amazon),
            bool(item.is_new_90d),
            _stringify_json(item.extracted_dimensions),
            _stringify_json(item.manual_dimensions),
            _stringify_json(_effective_dimensions(item)),
        ]
        for item in products
    ]
    return _csv_bytes(headers, rows)


def _build_trend_csv_bytes(trends: list[CategoryResearchSalesTrend]) -> bytes:
    headers = ['trend_row_id', 'asin', 'parent_asin', 'year_month', 'monthly_sales']
    rows = [
        [
            int(item.id),
            item.asin,
            item.parent_asin or '',
            item.year_month,
            int(item.monthly_sales or 0),
        ]
        for item in trends
    ]
    return _csv_bytes(headers, rows)


def _append_sheet_rows(worksheet: Any, headers: list[str], rows: list[list[Any]]) -> None:
    worksheet.append(headers)
    for row in rows:
        worksheet.append(row)


def _require_reportlab():
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfbase.pdfmetrics import registerFont
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise ValueError('PDF 导出依赖未安装，请先在 backend 环境安装 reportlab==4.4.1') from exc
    return A4, UnicodeCIDFont, registerFont, canvas


def _has_reportlab() -> bool:
    try:
        _require_reportlab()
    except ValueError:
        return False
    return True


def _pdf_text_lines(
    dataset: CategoryResearchDataset,
    overview: dict[str, Any],
) -> list[str]:
    metrics = overview['advanced_metrics']
    growth = metrics['market_growth']
    seasonality = metrics['seasonality']
    brand_monopoly = metrics['brand_monopoly']
    seller_monopoly = metrics['seller_monopoly']
    china = metrics['china_seller_competition']
    new_product = metrics['new_product_opportunity']
    quality = metrics['data_quality']

    lines: list[str] = [
        f"调研分析摘要 | {dataset.category_name_zh} | {dataset.marketplace} | V{int(dataset.version)}",
        f"关键词: {dataset.category_keyword_en}",
        f"数据日期: {dataset.data_date.isoformat() if dataset.data_date else '-'}",
        f"样本产品: {int(dataset.row_count_products or 0)} | 趋势样本: {int(dataset.row_count_trends or 0)}",
        "",
        "一、核心指标",
        f"样本数: {int(overview['kpis']['sample_count'])}",
        f"品牌数: {int(overview['kpis']['brand_count'])}",
        f"平均价格: ${float(overview['kpis']['average_price_usd']):.2f}",
        f"总月销量: {int(overview['kpis']['total_monthly_sales'])}",
        f"总月销售额: ${float(overview['kpis']['total_monthly_revenue_usd']):.2f}",
        f"Amazon 占比: {float(overview['kpis']['amazon_share']) * 100:.1f}%",
        "",
        "二、进入判断",
        f"增长层级: {growth.get('growth_tier', growth.get('growth_level', '-'))} | 最近 12M vs 前 12M: {float(growth['last12_vs_prev12_growth']) * 100:.1f}%",
        f"季节性层级: {seasonality.get('seasonality_tier', seasonality.get('seasonality_level', '-'))} | 旺季前三月销量占比: {float(seasonality['peak3_month_sales_share']) * 100:.1f}%",
        f"建议入场月: {', '.join(seasonality.get('recommended_entry_months', [])) or '-'}",
        f"新品机会: {new_product.get('opportunity_level', '-')} | 新品销量占比: {float(new_product['new_product_sales_share']) * 100:.1f}%",
        "",
        "三、竞争与风险",
        f"品牌集中度: CR3 {float(brand_monopoly['brand_cr3']) * 100:.1f}% | 风险 {brand_monopoly.get('risk_level', '-')}",
        f"卖家集中度: CR3 {float(seller_monopoly['seller_cr3']) * 100:.1f}% | 风险 {seller_monopoly.get('risk_level', '-')}",
        f"中国卖家销量占比: {float(china['china_seller_sales_share']) * 100:.1f}% | 风险 {china.get('risk_level', '-')}",
        f"价格-销量相关系数: {float(overview['price_sales_correlation']):.4f}",
        f"数据质量分: {float(quality['score']):.1f} | 综述: {quality.get('summary', '') or '-'}",
        "",
        "四、建议动作",
    ]

    actions = metrics.get('action_recommendations', [])[:5]
    if actions:
        for index, item in enumerate(actions, start=1):
            validations = ', '.join(item.get('required_validation', [])) or '-'
            lines.append(f"{index}. [{item.get('priority', '-')}] {item.get('action', '')}")
            lines.append(f"   原因: {item.get('why', '')}")
            lines.append(f"   先验证: {validations}")
    else:
        lines.append("1. 当前无自动建议动作，请结合市场节奏、品牌集中度和价格带机会手动判断。")

    lines.extend([
        "",
        "五、补充说明",
        f"价格带方法: {metrics.get('price_band_method_description', '') or '-'}",
    ])

    top_bands = metrics.get('price_band_opportunities', [])[:3]
    if top_bands:
        for item in top_bands:
            lines.append(
                f"机会价格带 {item.get('label', '-')}: 月销量 {int(item.get('monthly_sales', 0))} | 销量占比 {float(item.get('sales_share', 0.0)) * 100:.1f}%"
            )

    top_brands = overview.get('brand_sales_share', [])[:3]
    if top_brands:
        lines.append("头部品牌:")
        for item in top_brands:
            lines.append(
                f"- {item.get('brand', '-')}: 月销量 {int(item.get('monthly_sales', 0))} | 占比 {float(item.get('share', 0.0)) * 100:.1f}%"
            )

    return lines


def _build_summary_pdf_bytes(
    *,
    dataset: CategoryResearchDataset,
    overview: dict[str, Any],
) -> bytes:
    A4, UnicodeCIDFont, registerFont, canvas = _require_reportlab()
    registerFont(UnicodeCIDFont('STSong-Light'))

    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    pdf.setAuthor('BelieveBoy Dashboard')
    pdf.setTitle(_export_filename(dataset, 'summary_pdf'))

    width, height = A4
    left_margin = 40
    top = height - 46
    bottom = 48
    line_height = 16
    y = top

    pdf.setFont('STSong-Light', 16)
    pdf.drawString(left_margin, y, '调研分析摘要 PDF')
    y -= 24

    pdf.setFont('STSong-Light', 10)
    for line in _pdf_text_lines(dataset, overview):
        if y <= bottom:
            pdf.showPage()
            pdf.setFont('STSong-Light', 10)
            y = top
        if not line:
            y -= line_height
            continue
        wrapped = _wrap_pdf_line(line, max_chars=46)
        for segment in wrapped:
            if y <= bottom:
                pdf.showPage()
                pdf.setFont('STSong-Light', 10)
                y = top
            pdf.drawString(left_margin, y, segment)
            y -= line_height

    pdf.save()
    return buffer.getvalue()


def _wrap_pdf_line(text: str, *, max_chars: int) -> list[str]:
    normalized = str(text or '')
    if len(normalized) <= max_chars:
        return [normalized]
    lines: list[str] = []
    current = ''
    for char in normalized:
        current += char
        if len(current) >= max_chars:
            lines.append(current)
            current = ''
    if current:
        lines.append(current)
    return lines


def _build_analysis_workbook_bytes(
    *,
    dataset: CategoryResearchDataset,
    overview: dict[str, Any],
    products: list[CategoryResearchProductDetail],
    trends: list[CategoryResearchSalesTrend],
) -> bytes:
    workbook = Workbook()
    summary_sheet = workbook.active
    summary_sheet.title = 'Summary'

    dataset_meta_rows = [
        ['dataset_id', int(dataset.id)],
        ['marketplace', dataset.marketplace],
        ['category_keyword_en', dataset.category_keyword_en],
        ['category_name_zh', dataset.category_name_zh],
        ['version', int(dataset.version)],
        ['is_current', bool(dataset.is_current)],
        ['data_date', dataset.data_date.isoformat() if dataset.data_date else ''],
        ['row_count_products', int(dataset.row_count_products or 0)],
        ['row_count_trends', int(dataset.row_count_trends or 0)],
        ['original_filename', dataset.original_filename or ''],
        ['created_at', dataset.created_at.isoformat() if dataset.created_at else ''],
        ['price_band_standard', overview['advanced_metrics'].get('price_band_standard', '')],
        ['price_band_method', overview['advanced_metrics'].get('price_band_method', '')],
        ['price_band_breaks', ', '.join(str(item) for item in overview['advanced_metrics'].get('price_band_breaks', []))],
    ]
    _append_sheet_rows(summary_sheet, ['field', 'value'], dataset_meta_rows)

    kpi_sheet = workbook.create_sheet('KPIs')
    _append_sheet_rows(
        kpi_sheet,
        ['metric', 'value'],
        [
            ['sample_count', int(overview['kpis']['sample_count'])],
            ['brand_count', int(overview['kpis']['brand_count'])],
            ['average_price_usd', float(overview['kpis']['average_price_usd'])],
            ['total_monthly_sales', int(overview['kpis']['total_monthly_sales'])],
            ['total_monthly_revenue_usd', float(overview['kpis']['total_monthly_revenue_usd'])],
            ['amazon_share', float(overview['kpis']['amazon_share'])],
            ['price_sales_correlation', float(overview['price_sales_correlation'])],
            ['brand_cr3', float(overview['advanced_metrics']['brand_monopoly']['brand_cr3'])],
            ['seller_cr3', float(overview['advanced_metrics']['seller_monopoly']['seller_cr3'])],
            ['china_seller_sales_share', float(overview['advanced_metrics']['china_seller_competition']['china_seller_sales_share'])],
            ['market_growth_last12_vs_prev12', float(overview['advanced_metrics']['market_growth']['last12_vs_prev12_growth'])],
            ['seasonality_peak3_month_sales_share', float(overview['advanced_metrics']['seasonality']['peak3_month_sales_share'])],
            ['new_product_sales_share', float(overview['advanced_metrics']['new_product_opportunity']['new_product_sales_share'])],
            ['data_quality_score', float(overview['advanced_metrics']['data_quality']['score'])],
        ],
    )

    brand_sheet = workbook.create_sheet('BrandShare')
    _append_sheet_rows(
        brand_sheet,
        ['brand', 'monthly_sales', 'share'],
        [
            [item['brand'], int(item['monthly_sales']), float(item['share'])]
            for item in overview['brand_sales_share']
        ],
    )

    opportunity_sheet = workbook.create_sheet('PriceBands')
    _append_sheet_rows(
        opportunity_sheet,
        [
            'label',
            'count',
            'monthly_sales',
            'monthly_revenue_usd',
            'sales_share',
            'revenue_share',
            'average_rating',
            'average_review_count',
        ],
        [
            [
                item['label'],
                int(item['count']),
                int(item['monthly_sales']),
                float(item['monthly_revenue_usd']),
                float(item['sales_share']),
                float(item['revenue_share']),
                float(item['average_rating']),
                float(item['average_review_count']),
            ]
            for item in overview['advanced_metrics'].get('price_band_opportunities', [])
        ],
    )

    definitions_sheet = workbook.create_sheet('Definitions')
    _append_sheet_rows(
        definitions_sheet,
        ['key', 'name', 'formula_text', 'thresholds', 'interpretation_template', 'pitfall', 'action_hint'],
        [
            [
                item.get('key', ''),
                item.get('name', ''),
                item.get('formula_text', ''),
                ' | '.join(item.get('thresholds', [])),
                item.get('interpretation_template', ''),
                item.get('pitfall', ''),
                item.get('action_hint', ''),
            ]
            for item in overview['advanced_metrics'].get('metric_definitions', [])
        ],
    )

    actions_sheet = workbook.create_sheet('Actions')
    _append_sheet_rows(
        actions_sheet,
        ['priority', 'action', 'why', 'required_validation', 'linked_dimension', 'rule_basis'],
        [
            [
                item.get('priority', ''),
                item.get('action', ''),
                item.get('why', ''),
                ' | '.join(item.get('required_validation', [])),
                item.get('linked_dimension', ''),
                ' | '.join(item.get('rule_basis', [])),
            ]
            for item in overview['advanced_metrics'].get('action_recommendations', [])
        ],
    )

    products_sheet = workbook.create_sheet('Products')
    _append_sheet_rows(
        products_sheet,
        [
            'product_row_id',
            'source_row_no',
            'asin',
            'parent_asin',
            'product_name',
            'brand',
            'seller',
            'price_usd',
            'monthly_sales',
            'monthly_revenue_usd',
            'rating',
            'review_count',
            'launch_date',
            'listing_age_days',
            'fba_fee_usd',
            'fulfillment_method',
            'bbx_seller_attribute',
            'variant_count',
            'has_main_image_video',
            'is_climate_pledge_friendly',
            'has_brand_store',
            'seller_country_region',
            'is_amazon',
            'is_new_90d',
            'extracted_dimensions',
            'manual_dimensions',
            'effective_dimensions',
        ],
        [
            [
                int(item.id),
                int(item.source_row_no),
                item.asin or '',
                item.parent_asin or '',
                item.product_name or '',
                item.brand or '',
                item.seller or '',
                float(item.price_usd) if item.price_usd is not None else None,
                int(item.monthly_sales or 0),
                float(item.monthly_revenue_usd) if item.monthly_revenue_usd is not None else None,
                float(item.rating) if item.rating is not None else None,
                int(item.review_count or 0),
                item.launch_date.isoformat() if item.launch_date else '',
                int(item.listing_age_days) if item.listing_age_days is not None else None,
                float(item.fba_fee_usd) if item.fba_fee_usd is not None else None,
                item.fulfillment_method or '',
                item.bbx_seller_attribute or '',
                int(item.variant_count) if item.variant_count is not None else None,
                bool(item.has_main_image_video) if item.has_main_image_video is not None else None,
                bool(item.is_climate_pledge_friendly) if item.is_climate_pledge_friendly is not None else None,
                bool(item.has_brand_store) if item.has_brand_store is not None else None,
                item.seller_country_region or '',
                bool(item.is_amazon),
                bool(item.is_new_90d),
                _stringify_json(item.extracted_dimensions),
                _stringify_json(item.manual_dimensions),
                _stringify_json(_effective_dimensions(item)),
            ]
            for item in products
        ],
    )

    trends_sheet = workbook.create_sheet('Trends')
    _append_sheet_rows(
        trends_sheet,
        ['trend_row_id', 'asin', 'parent_asin', 'year_month', 'monthly_sales'],
        [
            [int(item.id), item.asin, item.parent_asin or '', item.year_month, int(item.monthly_sales or 0)]
            for item in trends
        ],
    )

    for worksheet in workbook.worksheets:
        for column_cells in worksheet.columns:
            values = [len(str(cell.value)) for cell in column_cells if cell.value is not None]
            width = min(max(values, default=8) + 2, 48)
            worksheet.column_dimensions[column_cells[0].column_letter].width = width

    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _build_export_bundle_zip_bytes(
    *,
    settings: Any,
    dataset: CategoryResearchDataset,
    overview: dict[str, Any],
    products: list[CategoryResearchProductDetail],
    trends: list[CategoryResearchSalesTrend],
) -> bytes:
    summary_pdf_bytes = _build_summary_pdf_bytes(
        dataset=dataset,
        overview=overview,
    )
    workbook_bytes = _build_analysis_workbook_bytes(
        dataset=dataset,
        overview=overview,
        products=products,
        trends=trends,
    )
    product_csv_bytes = _build_product_csv_bytes(products)
    trend_csv_bytes = _build_trend_csv_bytes(trends)

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(_export_filename(dataset, 'summary_pdf'), summary_pdf_bytes)
        archive.writestr(_export_filename(dataset, 'analysis_workbook'), workbook_bytes)
        archive.writestr(_export_filename(dataset, 'product_details_csv'), product_csv_bytes)
        archive.writestr(_export_filename(dataset, 'trend_details_csv'), trend_csv_bytes)
        try:
            raw_path = _resolve_dataset_raw_file_path(settings, dataset)
        except FileNotFoundError:
            raw_path = None
        if raw_path and raw_path.exists() and raw_path.is_file():
            archive.write(raw_path, arcname=_export_filename(dataset, 'raw_xlsx', original_filename=dataset.original_filename))
    return buffer.getvalue()


def _next_version(db: Session, *, marketplace: str, category_keyword_en: str) -> int:
    value = db.execute(
        select(func.max(CategoryResearchDataset.version)).where(
            CategoryResearchDataset.marketplace == marketplace,
            CategoryResearchDataset.category_keyword_en == category_keyword_en,
        )
    ).scalar_one_or_none()
    return int(value or 0) + 1


def _parse_workbook(path: Path) -> ParsedWorkbookPayload:
    wb = load_workbook(path, data_only=True, read_only=False)
    if '产品详情' not in wb.sheetnames or '销量趋势' not in wb.sheetnames:
        raise ValueError('Excel must include sheets: 产品详情, 销量趋势')

    product_rows, detail_asins, detail_warnings = _parse_product_sheet(wb['产品详情'])
    trend_rows, trend_asins = _parse_trend_sheet(wb['销量趋势'])

    missing_trend_count = len(detail_asins - trend_asins)

    quality_warnings = {
        'missing_trend_for_asin_count': missing_trend_count,
        'invalid_price_count': detail_warnings['invalid_price_count'],
        'invalid_fba_fee_count': detail_warnings['invalid_fba_fee_count'],
        'duplicate_asin_count': detail_warnings['duplicate_asin_count'],
    }

    return ParsedWorkbookPayload(
        product_rows=product_rows,
        trend_rows=trend_rows,
        quality_warnings=quality_warnings,
    )


def _parse_product_sheet(worksheet: Any) -> tuple[list[dict[str, Any]], set[str], dict[str, int]]:
    headers = _worksheet_headers(worksheet, header_row=2)

    aliases = {
        'asin': ['ASIN', 'asin'],
        'parent_asin': ['ParentAsin', 'ParentASIN', 'Parent Asin'],
        'product_name': ['产品名称', 'Product Name', 'Title'],
        'brand': ['品牌', 'Brand'],
        'seller': ['店铺', 'Seller', '卖家'],
        'price_usd': ['实际价格($)', '目前销售价($)', '价格($)', 'Price'],
        'monthly_sales': ['预计Listing月销量', '月销量', '预计月销量'],
        'monthly_revenue_usd': ['预计月销售额($)', '月销售额($)', '预计月销售额'],
        'rating': ['评分星级', '星级', 'Rating'],
        'review_count': ['评价数量', 'Review Count', 'Reviews'],
        'launch_date': ['上架时间', 'Launch Date'],
        'listing_age_days': ['上架天数', 'Listing Age Days'],
        'fba_fee_usd': ['FBA费用($)', 'FBA费用'],
        'fulfillment_method': ['物流方式', 'Fulfillment', '配送方式'],
        'bbx_seller_attribute': ['BBX卖家属性', '卖家属性'],
        'variant_count': ['变体数量', 'Variations', 'Variation Count', 'Variation Count Total'],
        'has_main_image_video': ['主图视频', 'Main Image Video', 'Has Main Image Video'],
        'is_climate_pledge_friendly': ['是否气候承诺友好标', '气候承诺友好标', 'Climate Pledge Friendly'],
        'has_brand_store': ['是否做品牌旗舰店', '品牌旗舰店', 'Brand Store', 'Has Brand Store'],
        'seller_country_region': ['国籍/地区', '国家/地区', 'Country/Region', 'Seller Country/Region'],
    }

    mapped = _match_columns(headers, aliases)
    if 'asin' not in mapped or 'monthly_sales' not in mapped:
        raise ValueError('产品详情 sheet missing required columns: ASIN / 预计Listing月销量')

    payloads: list[dict[str, Any]] = []
    asin_counter: Counter[str] = Counter()
    detail_asins: set[str] = set()

    invalid_price_count = 0
    invalid_fba_fee_count = 0

    max_col = len(headers)
    for row_no in range(3, worksheet.max_row + 1):
        values = [worksheet.cell(row_no, index + 1).value for index in range(max_col)]
        if _is_empty_row(values):
            continue

        raw_row = {
            headers[index]: values[index]
            for index in range(max_col)
            if headers[index]
        }
        raw_row_payload = _to_raw_row(raw_row)

        asin = _normalize_asin(values[mapped['asin']])
        if not asin:
            continue

        parent_asin = _normalize_asin(values[mapped['parent_asin']]) if 'parent_asin' in mapped else None
        product_name = _normalize_text(values[mapped['product_name']]) if 'product_name' in mapped else None
        brand = _normalize_text(values[mapped['brand']]) if 'brand' in mapped else None
        seller = _normalize_text(values[mapped['seller']]) if 'seller' in mapped else None
        fulfillment = _normalize_text(values[mapped['fulfillment_method']]) if 'fulfillment_method' in mapped else None

        price_usd, price_invalid = _to_decimal_or_none(values[mapped['price_usd']]) if 'price_usd' in mapped else (None, False)
        if price_invalid:
            invalid_price_count += 1

        monthly_sales = _to_int(values[mapped['monthly_sales']])
        monthly_revenue_usd, _ = (
            _to_decimal_or_none(values[mapped['monthly_revenue_usd']])
            if 'monthly_revenue_usd' in mapped
            else (None, False)
        )

        rating, _ = _to_decimal_or_none(values[mapped['rating']]) if 'rating' in mapped else (None, False)
        review_count = _to_int(values[mapped['review_count']]) if 'review_count' in mapped else 0
        launch_date = _to_date_or_none(values[mapped['launch_date']]) if 'launch_date' in mapped else None
        listing_age_days = _to_int_or_none(values[mapped['listing_age_days']]) if 'listing_age_days' in mapped else None

        fba_fee_usd, fba_invalid = _to_decimal_or_none(values[mapped['fba_fee_usd']]) if 'fba_fee_usd' in mapped else (None, False)
        if fba_invalid:
            invalid_fba_fee_count += 1

        bbx_attr = _normalize_text(values[mapped['bbx_seller_attribute']]) if 'bbx_seller_attribute' in mapped else None
        variant_count = _to_int_or_none(values[mapped['variant_count']]) if 'variant_count' in mapped else None
        has_main_image_video = _to_bool_or_none(values[mapped['has_main_image_video']]) if 'has_main_image_video' in mapped else None
        is_climate_pledge_friendly = (
            _to_bool_or_none(values[mapped['is_climate_pledge_friendly']])
            if 'is_climate_pledge_friendly' in mapped
            else None
        )
        has_brand_store = _to_bool_or_none(values[mapped['has_brand_store']]) if 'has_brand_store' in mapped else None
        seller_country_region = _normalize_text(values[mapped['seller_country_region']]) if 'seller_country_region' in mapped else None
        is_amazon = _is_amazon_seller(seller, bbx_attr)
        is_new_90d = listing_age_days is not None and listing_age_days <= 90

        payloads.append(
            {
                'dataset_id': 0,
                'source_row_no': row_no,
                'asin': asin,
                'parent_asin': parent_asin,
                'product_name': product_name,
                'brand': brand,
                'seller': seller,
                'price_usd': price_usd,
                'monthly_sales': monthly_sales,
                'monthly_revenue_usd': monthly_revenue_usd,
                'rating': rating,
                'review_count': review_count,
                'launch_date': launch_date,
                'listing_age_days': listing_age_days,
                'fba_fee_usd': fba_fee_usd,
                'fulfillment_method': fulfillment,
                'bbx_seller_attribute': bbx_attr,
                'variant_count': variant_count,
                'has_main_image_video': has_main_image_video,
                'is_climate_pledge_friendly': is_climate_pledge_friendly,
                'has_brand_store': has_brand_store,
                'seller_country_region': seller_country_region,
                'is_amazon': is_amazon,
                'is_new_90d': is_new_90d,
                'extracted_dimensions': _extract_dimensions_from_raw_row(raw_row_payload),
                'manual_dimensions': {},
                'raw_row': raw_row_payload,
            }
        )
        asin_counter[asin] += 1
        detail_asins.add(asin)

    duplicate_count = sum(max(0, count - 1) for count in asin_counter.values())
    warnings = {
        'invalid_price_count': invalid_price_count,
        'invalid_fba_fee_count': invalid_fba_fee_count,
        'duplicate_asin_count': duplicate_count,
    }
    return payloads, detail_asins, warnings


def _parse_trend_sheet(worksheet: Any) -> tuple[list[dict[str, Any]], set[str]]:
    headers = _worksheet_headers(worksheet, header_row=1)

    month_columns: list[tuple[int, str]] = []
    for index, value in enumerate(headers):
        if _is_year_month(value):
            month_columns.append((index, value))

    if len(month_columns) < 24:
        raise ValueError('销量趋势 sheet must contain at least 24 month columns (YYYY-MM)')

    asin_col = _find_header_index(headers, ['ASIN', 'asin'])
    parent_asin_col = _find_header_index(headers, ['ParentASIN', 'ParentAsin', 'parent_asin'])
    if asin_col is None:
        raise ValueError('销量趋势 sheet missing required column: ASIN')

    payloads: list[dict[str, Any]] = []
    trend_asins: set[str] = set()

    max_col = len(headers)
    for row_no in range(2, worksheet.max_row + 1):
        values = [worksheet.cell(row_no, index + 1).value for index in range(max_col)]
        if _is_empty_row(values):
            continue

        asin = _normalize_asin(values[asin_col])
        if not asin:
            continue

        parent_asin = _normalize_asin(values[parent_asin_col]) if parent_asin_col is not None else None
        trend_asins.add(asin)

        for col_index, year_month in month_columns:
            payloads.append(
                {
                    'dataset_id': 0,
                    'asin': asin,
                    'parent_asin': parent_asin,
                    'year_month': year_month,
                    'monthly_sales': _to_int(values[col_index]),
                }
            )

    return payloads, trend_asins


def _worksheet_headers(worksheet: Any, *, header_row: int) -> list[str]:
    max_col = worksheet.max_column
    headers = [
        _normalize_text(worksheet.cell(header_row, col).value) or ''
        for col in range(1, max_col + 1)
    ]
    while headers and headers[-1] == '':
        headers.pop()
    return headers


def _match_columns(headers: list[str], aliases: dict[str, list[str]]) -> dict[str, int]:
    normalized_headers = [_normalize_header(item) for item in headers]
    mapped: dict[str, int] = {}
    for target, candidates in aliases.items():
        for candidate in candidates:
            normalized = _normalize_header(candidate)
            if normalized in normalized_headers:
                mapped[target] = normalized_headers.index(normalized)
                break
    return mapped


def _find_header_index(headers: list[str], candidates: list[str]) -> int | None:
    normalized_headers = [_normalize_header(item) for item in headers]
    for candidate in candidates:
        normalized = _normalize_header(candidate)
        if normalized in normalized_headers:
            return normalized_headers.index(normalized)
    return None


def _normalize_header(value: Any) -> str:
    text = str(value or '').strip().lower()
    return re.sub(r'[^0-9a-z\u4e00-\u9fff]+', '', text)


def _normalize_marketplace(value: str | None) -> str:
    text = (value or 'US').strip().upper()
    if not text:
        text = 'US'
    return text[:16]


def _normalize_category_keyword(value: str | None) -> str:
    text = (value or '').strip().lower()
    if not text:
        raise ValueError('category_keyword_en is required')
    if re.search(r'[\u4e00-\u9fff]', text):
        raise ValueError('category_keyword_en must be English')
    return re.sub(r'\s+', ' ', text)[:255]


def _normalize_name_zh(value: str | None) -> str:
    text = (value or '').strip()
    if not text:
        raise ValueError('category_name_zh is required')
    return text[:255]


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text == '--':
        return None
    return text


def _normalize_asin(value: Any) -> str | None:
    text = _normalize_text(value)
    if not text:
        return None
    return text.upper()


def _to_decimal_or_none(value: Any) -> tuple[Decimal | None, bool]:
    text = _normalize_text(value)
    if text is None:
        return None, False
    cleaned = re.sub(r'[^0-9.\-]', '', text)
    if not cleaned:
        return None, True
    try:
        return Decimal(cleaned), False
    except InvalidOperation:
        return None, True


def _to_int(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip().replace(',', '')
    if not text or text == '--':
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def _to_int_or_none(value: Any) -> int | None:
    text = _normalize_text(value)
    if text is None:
        return None
    try:
        return int(float(text.replace(',', '')))
    except ValueError:
        return None


def _to_date_or_none(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value).strip()
    if not text or text == '--':
        return None
    for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%m/%d/%Y'):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _to_bool_or_none(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)

    text = str(value).strip().lower()
    if not text or text == '--':
        return None

    true_values = {
        '1', 'y', 'yes', 'true', 't', '是', '有', '支持', '已开通', '开通', '√', 'check', 'checked',
    }
    false_values = {
        '0', 'n', 'no', 'false', 'f', '否', '无', '不支持', '未开通', '×', 'x',
    }
    if text in true_values:
        return True
    if text in false_values:
        return False
    return None


def _is_year_month(value: Any) -> bool:
    text = str(value or '').strip()
    return bool(re.fullmatch(r'\d{4}-\d{2}', text))


def _shift_month(value: date, delta: int) -> date:
    month_index = (value.year * 12 + (value.month - 1)) + delta
    year = month_index // 12
    month = (month_index % 12) + 1
    return date(year, month, 1)


def _is_empty_row(values: list[Any]) -> bool:
    for value in values:
        text = _normalize_text(value)
        if text:
            return False
    return True


def _to_raw_row(payload: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in payload.items():
        if isinstance(value, (datetime, date)):
            normalized[str(key)] = value.isoformat()
        elif isinstance(value, Decimal):
            normalized[str(key)] = float(value)
        elif isinstance(value, float):
            if np.isnan(value):
                normalized[str(key)] = None
            else:
                normalized[str(key)] = value
        else:
            normalized[str(key)] = value
    return normalized


def _normalize_dimension_key(value: str | None) -> str:
    text = (value or '').strip().lower()
    if not text:
        return ''
    snake = re.sub(r'[^0-9a-z]+', '_', text).strip('_')
    return snake[:64]


def _normalize_dimension_value(value: Any) -> str | None:
    text = _normalize_text(value)
    if not text:
        return None
    compact = re.sub(r'\s+', ' ', text).strip()
    return compact[:255]


def _normalize_dimension_map(payload: Any) -> dict[str, str]:
    if not isinstance(payload, dict):
        return {}
    normalized: dict[str, str] = {}
    for raw_key, raw_value in payload.items():
        key = _normalize_dimension_key(str(raw_key))
        value = _normalize_dimension_value(raw_value)
        if not key or value is None:
            continue
        normalized[key] = value
    return normalized


def _extract_dimensions_from_raw_row(raw_row: Any) -> dict[str, str]:
    if not isinstance(raw_row, dict):
        return {}

    extracted: dict[str, str] = {}
    for key, aliases in _DIMENSION_ALIASES.items():
        raw_value = _extract_raw_value(raw_row, aliases)
        value = _normalize_dimension_value(raw_value)
        if value is not None:
            extracted[key] = value
    return extracted


def _effective_dimensions(row: CategoryResearchProductDetail) -> dict[str, str]:
    extracted = _normalize_dimension_map(row.extracted_dimensions)
    manual = _normalize_dimension_map(row.manual_dimensions)
    if not manual:
        return extracted
    merged = dict(extracted)
    merged.update(manual)
    return merged


def _hydrate_product_detail_fields_from_raw_row(item: CategoryResearchProductDetail) -> None:
    raw_row = item.raw_row if isinstance(item.raw_row, dict) else {}

    rating_raw = _extract_raw_value(raw_row, _RATING_RAW_ALIASES)
    rating, _ = _to_decimal_or_none(rating_raw)
    item.rating = rating

    review_count_raw = _extract_raw_value(raw_row, _REVIEW_COUNT_RAW_ALIASES)
    item.review_count = _to_int(review_count_raw)

    launch_date_raw = _extract_raw_value(raw_row, _LAUNCH_DATE_RAW_ALIASES)
    item.launch_date = _to_date_or_none(launch_date_raw)

    listing_age_days_raw = _extract_raw_value(raw_row, _LISTING_AGE_DAYS_RAW_ALIASES)
    item.listing_age_days = _to_int_or_none(listing_age_days_raw)

    fba_fee_raw = _extract_raw_value(raw_row, _FBA_FEE_RAW_ALIASES)
    fba_fee_usd, _ = _to_decimal_or_none(fba_fee_raw)
    item.fba_fee_usd = fba_fee_usd

    fulfillment_raw = _extract_raw_value(raw_row, _FULFILLMENT_METHOD_RAW_ALIASES)
    item.fulfillment_method = _normalize_text(fulfillment_raw)

    bbx_raw = _extract_raw_value(raw_row, _BBX_SELLER_ATTRIBUTE_RAW_ALIASES)
    item.bbx_seller_attribute = _normalize_text(bbx_raw)

    variant_count_raw = _extract_raw_value(raw_row, _VARIANT_COUNT_RAW_ALIASES)
    item.variant_count = _to_int_or_none(variant_count_raw)

    main_image_video_raw = _extract_raw_value(raw_row, _MAIN_IMAGE_VIDEO_RAW_ALIASES)
    item.has_main_image_video = _to_bool_or_none(main_image_video_raw)

    climate_pledge_raw = _extract_raw_value(raw_row, _CLIMATE_PLEDGE_RAW_ALIASES)
    item.is_climate_pledge_friendly = _to_bool_or_none(climate_pledge_raw)

    brand_store_raw = _extract_raw_value(raw_row, _BRAND_STORE_RAW_ALIASES)
    item.has_brand_store = _to_bool_or_none(brand_store_raw)

    seller_country_region_raw = _extract_raw_value(raw_row, _SELLER_COUNTRY_REGION_RAW_ALIASES)
    item.seller_country_region = _normalize_text(seller_country_region_raw)

    item.is_amazon = _is_amazon_seller(item.seller, item.bbx_seller_attribute)
    item.is_new_90d = item.listing_age_days is not None and item.listing_age_days <= 90


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _recompute_dataset_fields(db: Session, dataset: CategoryResearchDataset) -> None:
    dataset_id = int(dataset.id)
    product_rows = list(
        db.execute(
            select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)
        ).scalars().all()
    )
    trend_rows = list(
        db.execute(
            select(CategoryResearchSalesTrend).where(CategoryResearchSalesTrend.dataset_id == dataset_id)
        ).scalars().all()
    )

    asin_counter: Counter[str] = Counter()
    detail_asins: set[str] = set()
    invalid_price_count = 0
    invalid_fba_fee_count = 0
    for item in product_rows:
        _hydrate_product_detail_fields_from_raw_row(item)
        item.extracted_dimensions = _extract_dimensions_from_raw_row(item.raw_row)
        item.manual_dimensions = _normalize_dimension_map(item.manual_dimensions)

        asin = _normalize_asin(item.asin)
        if asin:
            asin_counter[asin] += 1
            detail_asins.add(asin)

        if _is_invalid_numeric_from_raw(item.raw_row, _PRICE_RAW_ALIASES, item.price_usd):
            invalid_price_count += 1
        if _is_invalid_numeric_from_raw(item.raw_row, _FBA_FEE_RAW_ALIASES, item.fba_fee_usd):
            invalid_fba_fee_count += 1

    trend_asins = {
        normalized
        for normalized in (_normalize_asin(item.asin) for item in trend_rows)
        if normalized
    }
    missing_trend_count = len(detail_asins - trend_asins)
    duplicate_count = sum(max(0, count - 1) for count in asin_counter.values())

    dataset.row_count_products = len(product_rows)
    dataset.row_count_trends = len(trend_rows)
    dataset.quality_warnings = {
        'missing_trend_for_asin_count': int(missing_trend_count),
        'invalid_price_count': int(invalid_price_count),
        'invalid_fba_fee_count': int(invalid_fba_fee_count),
        'duplicate_asin_count': int(duplicate_count),
    }


def _is_invalid_numeric_from_raw(raw_row: Any, aliases: list[str], parsed_value: Any) -> bool:
    if parsed_value is not None:
        return False
    raw_value = _extract_raw_value(raw_row, aliases)
    if raw_value is None:
        return False
    _, is_invalid = _to_decimal_or_none(raw_value)
    return bool(is_invalid)


def _extract_raw_value(raw_row: Any, aliases: list[str]) -> Any:
    if not isinstance(raw_row, dict):
        return None
    normalized_aliases = {_normalize_header(alias) for alias in aliases}
    for key, value in raw_row.items():
        if _normalize_header(str(key)) in normalized_aliases:
            return value
    return None


def _build_dimension_profiles(rows: list[CategoryResearchProductDetail]) -> list[dict[str, Any]]:
    total = len(rows)
    if total <= 0:
        return []

    counters: dict[str, Counter[str]] = {}
    coverage_counts: Counter[str] = Counter()
    for item in rows:
        dimensions = _effective_dimensions(item)
        for key, value in dimensions.items():
            if not value:
                continue
            coverage_counts[key] += 1
            counters.setdefault(key, Counter())[value] += 1

    profiles: list[dict[str, Any]] = []
    for key, count in coverage_counts.items():
        value_counter = counters.get(key, Counter())
        profiles.append(
            {
                'key': key,
                'label': _DIMENSION_LABELS.get(key, key.replace('_', ' ').title()),
                'coverage': round((count / total), 6),
                'distinct_count': len(value_counter),
                'top_values': [
                    {
                        'value': value,
                        'count': int(value_count),
                        'share': round((value_count / max(1, count)), 6),
                    }
                    for value, value_count in value_counter.most_common(10)
                ],
            }
        )
    profiles.sort(key=lambda entry: (entry['coverage'], entry['distinct_count']), reverse=True)
    return profiles


def _build_market_concentration(brand_counter: dict[str, int], total_brand_sales: int) -> dict[str, float]:
    if total_brand_sales <= 0:
        return {'cr1': 0.0, 'cr3': 0.0, 'cr5': 0.0, 'cr10': 0.0, 'hhi': 0.0}

    sorted_sales = sorted(brand_counter.values(), reverse=True)
    shares = [value / total_brand_sales for value in sorted_sales]

    return {
        'cr1': round(float(sum(shares[:1])), 6),
        'cr3': round(float(sum(shares[:3])), 6),
        'cr5': round(float(sum(shares[:5])), 6),
        'cr10': round(float(sum(shares[:10])), 6),
        'hhi': round(float(sum((share * 100) ** 2 for share in shares)), 2),
    }


def _risk_level_by_concentration(*, cr3: float, hhi: float) -> str:
    if cr3 >= 0.7 or hhi >= 2500:
        return 'high'
    if cr3 >= 0.45 or hhi >= 1500:
        return 'medium'
    return 'low'


def _aggregate_sales_share_pairs(pairs: list[tuple[str, int]], *, limit: int = 10) -> list[dict[str, Any]]:
    if not pairs:
        return []
    total_sales = sum(max(0, int(sales)) for _, sales in pairs)
    if total_sales <= 0:
        total_sales = 1
    sorted_pairs = sorted(pairs, key=lambda item: item[1], reverse=True)
    return [
        {
            'name': name,
            'monthly_sales': int(sales),
            'share': round(float(sales) / float(total_sales), 6),
        }
        for name, sales in sorted_pairs[:limit]
    ]


def _build_brand_monopoly(brand_counter: dict[str, int], total_brand_sales: int) -> dict[str, Any]:
    concentration = _build_market_concentration(brand_counter, total_brand_sales)
    risk_level = _risk_level_by_concentration(cr3=float(concentration['cr3']), hhi=float(concentration['hhi']))
    return {
        'brand_cr3': concentration['cr3'],
        'brand_cr5': concentration['cr5'],
        'brand_cr10': concentration['cr10'],
        'brand_hhi': concentration['hhi'],
        'risk_level': risk_level,
    }


def _build_seller_monopoly(rows: list[CategoryResearchProductDetail]) -> dict[str, Any]:
    seller_counter: dict[str, int] = {}
    total_sales = 0
    amazon_sales = 0
    for item in rows:
        seller = (item.seller or 'Unknown').strip() or 'Unknown'
        sales = int(item.monthly_sales or 0)
        total_sales += sales
        seller_counter[seller] = seller_counter.get(seller, 0) + sales
        if item.is_amazon:
            amazon_sales += sales

    concentration = _build_market_concentration(seller_counter, total_sales)
    top_sellers = _aggregate_sales_share_pairs(list(seller_counter.items()), limit=10)
    risk_level = _risk_level_by_concentration(cr3=float(concentration['cr3']), hhi=float(concentration['hhi']))
    return {
        'seller_count': len(seller_counter),
        'seller_cr1': concentration['cr1'],
        'seller_cr3': concentration['cr3'],
        'seller_cr5': concentration['cr5'],
        'seller_cr10': concentration['cr10'],
        'seller_hhi': concentration['hhi'],
        'amazon_seller_sales_share': round((amazon_sales / max(1, total_sales)), 6),
        'risk_level': risk_level,
        'top_sellers': [
            {
                'seller': entry['name'],
                'monthly_sales': entry['monthly_sales'],
                'share': entry['share'],
            }
            for entry in top_sellers
        ],
    }


def _build_product_monopoly(rows: list[CategoryResearchProductDetail]) -> dict[str, Any]:
    asin_counter: dict[str, int] = {}
    for item in rows:
        asin = (item.asin or '').strip().upper()
        if not asin:
            continue
        asin_counter[asin] = asin_counter.get(asin, 0) + int(item.monthly_sales or 0)

    total_sales = sum(asin_counter.values())
    sorted_sales = sorted(asin_counter.items(), key=lambda pair: pair[1], reverse=True)
    top100_sales = sum(max(0, int(sales)) for _, sales in sorted_sales[:100])
    top1_sales = int(sorted_sales[0][1]) if sorted_sales else 0
    top_summaries = _aggregate_sales_share_pairs(sorted_sales, limit=10)

    asin_top1_share = round((top1_sales / max(1, total_sales)), 6)
    asin_top3_share = round((sum(int(sales) for _, sales in sorted_sales[:3]) / max(1, total_sales)), 6)
    asin_top10_share = round((sum(int(sales) for _, sales in sorted_sales[:10]) / max(1, total_sales)), 6)
    top1_to_top100_ratio = round((top1_sales / max(1, top100_sales)), 6)

    if asin_top1_share >= 0.35 or asin_top3_share >= 0.65 or top1_to_top100_ratio >= 0.2:
        risk_level = 'high'
    elif asin_top1_share >= 0.2 or asin_top3_share >= 0.45 or top1_to_top100_ratio >= 0.12:
        risk_level = 'medium'
    else:
        risk_level = 'low'

    return {
        'asin_top1_share': asin_top1_share,
        'asin_top3_share': asin_top3_share,
        'asin_top10_share': asin_top10_share,
        'top1_to_top100_ratio': top1_to_top100_ratio,
        'risk_level': risk_level,
        'top_asins': [
            {
                'asin': entry['name'],
                'monthly_sales': entry['monthly_sales'],
                'share': entry['share'],
            }
            for entry in top_summaries
        ],
    }


def _is_china_seller(item: CategoryResearchProductDetail) -> bool:
    country_region = (item.seller_country_region or '').strip().lower()
    if country_region in {'cn', 'china', '中国', '中国大陆', 'mainland china', 'hong kong', '香港', '中国香港'}:
        return True

    seller_text = (item.seller or '').lower()
    bbx_raw = _extract_raw_value(item.raw_row, ['BBX卖家属性', '卖家属性'])
    bbx_text = (str(bbx_raw or '')).strip().lower()
    combined = f'{seller_text} {bbx_text}'
    keywords = [
        '中国',
        'china',
        'chinese',
        'cn seller',
        'mainland',
        '香港',
        'hong kong',
        'shenzhen',
        'guangdong',
        '义乌',
    ]
    return any(keyword in combined for keyword in keywords)


def _is_amazon_seller(seller: str | None, bbx_attr: str | None) -> bool:
    seller_text = (seller or '').strip().lower()
    bbx_text = (bbx_attr or '').strip().lower()
    if '亚马逊自营' in (bbx_attr or ''):
        return True
    return (
        ('amazon' in seller_text)
        or ('amazon' in bbx_text)
        or ('亚马逊' in (seller or ''))
        or ('亚马逊' in (bbx_attr or ''))
    )


def _build_china_seller_competition(rows: list[CategoryResearchProductDetail]) -> dict[str, Any]:
    seller_set: set[str] = set()
    china_seller_set: set[str] = set()
    total_sales = 0
    china_sales = 0
    for item in rows:
        seller = (item.seller or 'Unknown').strip() or 'Unknown'
        seller_set.add(seller)
        sales = int(item.monthly_sales or 0)
        total_sales += sales
        if _is_china_seller(item):
            china_seller_set.add(seller)
            china_sales += sales

    count_share = round((len(china_seller_set) / max(1, len(seller_set))), 6)
    sales_share = round((china_sales / max(1, total_sales)), 6)
    if count_share >= 0.7 or sales_share >= 0.7:
        risk_level = 'high'
    elif count_share >= 0.5 or sales_share >= 0.5:
        risk_level = 'medium'
    else:
        risk_level = 'low'

    return {
        'china_seller_count': len(china_seller_set),
        'china_seller_count_share': count_share,
        'china_seller_sales_share': sales_share,
        'risk_level': risk_level,
    }


def _build_market_growth(trend_rows: list[CategoryResearchSalesTrend]) -> dict[str, Any]:
    monthly_totals = _aggregate_market_monthly_sales(trend_rows)
    ordered = sorted(monthly_totals.items(), key=lambda item: item[0])
    if len(ordered) < 2:
        return {
            'trend_slope': 0.0,
            'last12_vs_prev12_growth': 0.0,
            'cagr_like_growth': 0.0,
            'growth_level': 'stable',
        }

    months = np.array(range(len(ordered)), dtype=float)
    sales = np.array([float(item[1]) for item in ordered], dtype=float)
    trend_slope = float(np.polyfit(months, sales, 1)[0]) if len(ordered) >= 2 else 0.0

    if len(sales) >= 24:
        prev12 = float(np.sum(sales[-24:-12]))
        last12 = float(np.sum(sales[-12:]))
    elif len(sales) >= 12:
        split = len(sales) // 2
        prev12 = float(np.sum(sales[:split]))
        last12 = float(np.sum(sales[split:]))
    else:
        prev12 = float(np.sum(sales[:-1]))
        last12 = float(sales[-1])
    last12_vs_prev12_growth = (last12 - prev12) / prev12 if prev12 > 0 else (1.0 if last12 > 0 else 0.0)

    first = float(sales[0])
    last = float(sales[-1])
    periods = max(1, len(sales) - 1)
    if first > 0:
        cagr_like_growth = (last / first) ** (12.0 / periods) - 1.0
    else:
        cagr_like_growth = 1.0 if last > 0 else 0.0

    if last12_vs_prev12_growth >= 0.08 or cagr_like_growth >= 0.1:
        growth_level = 'growing'
    elif last12_vs_prev12_growth <= -0.08 or cagr_like_growth <= -0.08:
        growth_level = 'shrinking'
    else:
        growth_level = 'stable'

    growth_anchor = max(last12_vs_prev12_growth, cagr_like_growth)
    if growth_anchor >= 0.25:
        growth_tier = 'explosive'
        radar_score = 96.0
    elif growth_anchor >= 0.12:
        growth_tier = 'fast_growing'
        radar_score = 84.0
    elif growth_anchor >= 0.03:
        growth_tier = 'growing'
        radar_score = 68.0
    elif growth_anchor > -0.03:
        growth_tier = 'stable'
        radar_score = 52.0
    elif growth_anchor > -0.12:
        growth_tier = 'softening'
        radar_score = 30.0
    else:
        growth_tier = 'shrinking'
        radar_score = 12.0

    return {
        'trend_slope': round(trend_slope, 4),
        'last12_vs_prev12_growth': round(float(last12_vs_prev12_growth), 6),
        'cagr_like_growth': round(float(cagr_like_growth), 6),
        'growth_level': growth_level,
        'growth_tier': growth_tier,
        'radar_score': radar_score,
        'tier_thresholds': [
            '爆发增长 >= 25%',
            '快速增长 12%-25%',
            '温和增长 3%-12%',
            '平稳 -3%~3%',
            '走弱 -12%~-3%',
            '收缩 < -12%',
        ],
    }


def _build_seasonality(trend_rows: list[CategoryResearchSalesTrend]) -> dict[str, Any]:
    monthly_totals = _aggregate_market_monthly_sales(trend_rows)
    ordered = sorted(monthly_totals.items(), key=lambda item: item[0])
    if not ordered:
        return {
            'peak3_month_sales_share': 0.0,
            'monthly_sales_cv': 0.0,
            'seasonality_level': 'weak',
            'recommended_entry_months': [],
        }

    sales = [float(item[1]) for item in ordered]
    total_sales = float(sum(sales))
    peak3_month_sales_share = round((sum(sorted(sales, reverse=True)[:3]) / total_sales) if total_sales > 0 else 0.0, 6)
    mean_sales = float(np.mean(sales)) if sales else 0.0
    monthly_sales_cv = round((float(np.std(sales)) / mean_sales) if mean_sales > 0 else 0.0, 6)

    month_bucket: dict[int, float] = {}
    for year_month, value in ordered:
        month = int(year_month[-2:])
        month_bucket[month] = month_bucket.get(month, 0.0) + float(value)
    hot_months = [month for month, _ in sorted(month_bucket.items(), key=lambda item: item[1], reverse=True)[:3]]
    recommended_entry_months = []
    for month in hot_months:
        entry = month - 1 if month > 1 else 12
        text = f'{entry:02d}'
        if text not in recommended_entry_months:
            recommended_entry_months.append(text)

    if peak3_month_sales_share >= 0.45 or monthly_sales_cv >= 0.6:
        seasonality_level = 'strong'
    elif peak3_month_sales_share >= 0.32 or monthly_sales_cv >= 0.35:
        seasonality_level = 'moderate'
    else:
        seasonality_level = 'weak'

    if peak3_month_sales_share >= 0.58 or monthly_sales_cv >= 0.85:
        seasonality_tier = 'extreme'
        entry_friendliness_score = 12.0
    elif peak3_month_sales_share >= 0.45 or monthly_sales_cv >= 0.6:
        seasonality_tier = 'strong'
        entry_friendliness_score = 28.0
    elif peak3_month_sales_share >= 0.38 or monthly_sales_cv >= 0.45:
        seasonality_tier = 'elevated'
        entry_friendliness_score = 46.0
    elif peak3_month_sales_share >= 0.32 or monthly_sales_cv >= 0.35:
        seasonality_tier = 'moderate'
        entry_friendliness_score = 64.0
    elif peak3_month_sales_share >= 0.26 or monthly_sales_cv >= 0.22:
        seasonality_tier = 'mild'
        entry_friendliness_score = 82.0
    else:
        seasonality_tier = 'balanced'
        entry_friendliness_score = 94.0

    return {
        'peak3_month_sales_share': peak3_month_sales_share,
        'monthly_sales_cv': monthly_sales_cv,
        'seasonality_level': seasonality_level,
        'recommended_entry_months': recommended_entry_months,
        'seasonality_tier': seasonality_tier,
        'entry_friendliness_score': entry_friendliness_score,
        'tier_thresholds': [
            '全年均衡: Peak3 < 26% 且 CV < 0.22',
            '轻季节性: Peak3 26%-32% 或 CV 0.22-0.35',
            '中季节性: Peak3 32%-45% 或 CV 0.35-0.60',
            '强季节性: Peak3 45%-58% 或 CV 0.60-0.85',
            '极强季节性: Peak3 >= 58% 或 CV >= 0.85',
        ],
    }


def _build_review_research(rows: list[CategoryResearchProductDetail]) -> dict[str, Any]:
    review_values = [max(0, int(item.review_count or 0)) for item in rows]
    rating_values = [float(item.rating) for item in rows if item.rating is not None]
    if not review_values:
        return {
            'average_rating': 0.0,
            'review_median': 0.0,
            'review_p75': 0.0,
            'review_top10_share': 0.0,
            'low_review_product_share': 0.0,
            'low_review_threshold': 100,
            'bottom_quartile_product_share': 0.0,
            'rating_band_distribution': [],
            'review_segment_distribution': [],
        }

    total_reviews = float(sum(review_values))
    sorted_reviews = sorted(review_values, reverse=True)
    top10_reviews = float(sum(sorted_reviews[:10]))
    low_review_threshold = 100
    low_review_count = sum(1 for value in review_values if value < low_review_threshold)
    bottom_quartile_cutoff = float(np.percentile(review_values, 25)) if review_values else 0.0
    bottom_quartile_count = sum(1 for value in review_values if value <= bottom_quartile_cutoff)

    rating_bands = [
        ('1.0-1.5', 1.0, 1.5),
        ('1.5-2.0', 1.5, 2.0),
        ('2.0-2.5', 2.0, 2.5),
        ('2.5-3.0', 2.5, 3.0),
        ('3.0-3.5', 3.0, 3.5),
        ('3.5-4.0', 3.5, 4.0),
        ('4.0-4.5', 4.0, 4.5),
        ('4.5-5.0', 4.5, 5.01),
    ]
    rating_distribution: list[dict[str, Any]] = []
    for label, lower, upper in rating_bands:
        count = 0
        for value in rating_values:
            if lower <= value < upper:
                count += 1
        rating_distribution.append({'label': label, 'count': count})

    positive_reviews = sorted({value for value in review_values if value > 0})
    if positive_reviews:
        quantiles = [float(np.percentile(positive_reviews, q)) for q in range(10, 100, 10)]
        rounded = sorted({max(1, int(round(value))) for value in quantiles})
    else:
        rounded = []
    boundaries = [0]
    for value in rounded:
        if value > boundaries[-1]:
            boundaries.append(value)
    if not boundaries or boundaries[-1] < max(review_values):
        boundaries.append(max(review_values))

    review_segments: list[dict[str, Any]] = []
    for index in range(len(boundaries) - 1):
        lower = boundaries[index]
        upper = boundaries[index + 1]
        if index == len(boundaries) - 2:
            label = f'{lower}+'
            segment_rows = [item for item in rows if max(0, int(item.review_count or 0)) >= lower]
        else:
            label = f'{lower}-{max(lower, upper - 1)}'
            segment_rows = [
                item
                for item in rows
                if lower <= max(0, int(item.review_count or 0)) < upper
            ]
        review_segments.append(
            {
                'label': label,
                'count': len(segment_rows),
                'monthly_sales': int(sum(int(item.monthly_sales or 0) for item in segment_rows)),
            }
        )

    return {
        'average_rating': round(float(np.mean(rating_values)) if rating_values else 0.0, 2),
        'review_median': round(float(np.median(review_values)), 2),
        'review_p75': round(float(np.percentile(review_values, 75)), 2),
        'review_top10_share': round((top10_reviews / total_reviews) if total_reviews > 0 else 0.0, 6),
        'low_review_product_share': round((low_review_count / len(review_values)), 6),
        'low_review_threshold': low_review_threshold,
        'bottom_quartile_product_share': round((bottom_quartile_count / len(review_values)), 6),
        'rating_band_distribution': rating_distribution,
        'review_segment_distribution': review_segments,
    }


def _aggregate_market_monthly_sales(trend_rows: list[CategoryResearchSalesTrend]) -> dict[str, int]:
    monthly_totals: dict[str, int] = {}
    for item in trend_rows:
        key = (item.year_month or '').strip()
        if not key:
            continue
        monthly_totals[key] = monthly_totals.get(key, 0) + int(item.monthly_sales or 0)
    return monthly_totals


def _build_launch_month_distribution(rows: list[CategoryResearchProductDetail]) -> list[dict[str, Any]]:
    bucket: dict[str, dict[str, int]] = {}
    for item in rows:
        if item.launch_date is None:
            continue
        label = item.launch_date.strftime('%Y-%m')
        current = bucket.get(label)
        if current is None:
            current = {'count': 0, 'monthly_sales': 0}
            bucket[label] = current
        current['count'] += 1
        current['monthly_sales'] += int(item.monthly_sales or 0)

    ordered = sorted(bucket.items(), key=lambda item: item[0])
    return [
        {
            'label': label,
            'count': int(values['count']),
            'monthly_sales': int(values['monthly_sales']),
        }
        for label, values in ordered[-18:]
    ]


def _nice_price_step(raw_step: float) -> float:
    if raw_step <= 0:
        return 10.0
    exponent = np.floor(np.log10(raw_step))
    fraction = raw_step / (10 ** exponent)
    if fraction <= 1:
        nice_fraction = 1
    elif fraction <= 2:
        nice_fraction = 2
    elif fraction <= 2.5:
        nice_fraction = 2.5
    elif fraction <= 5:
        nice_fraction = 5
    else:
        nice_fraction = 10
    return float(nice_fraction * (10 ** exponent))


def _auto_price_breaks(prices: list[float], *, max_breaks: int = 8) -> list[float]:
    valid_prices = sorted(float(price) for price in prices if float(price) > 0)
    if len(valid_prices) < 3:
        return _PRICE_BAND_PRESETS['default']

    q1 = float(np.percentile(valid_prices, 25))
    q3 = float(np.percentile(valid_prices, 75))
    iqr = max(1.0, q3 - q1)
    fd_width = (2 * iqr) / (len(valid_prices) ** (1 / 3))
    full_range = max(valid_prices) - min(valid_prices)
    target_width = max(fd_width, full_range / max(4, max_breaks))
    step = _nice_price_step(target_width)

    upper_limit = _nice_price_step(max(valid_prices))
    breaks: list[float] = []
    current = step
    while current < upper_limit and len(breaks) < max_breaks:
        breaks.append(round(current, 2))
        current += step

    while len(breaks) > max_breaks:
        step = _nice_price_step(step * 1.5)
        breaks = []
        current = step
        while current < upper_limit and len(breaks) < max_breaks:
            breaks.append(round(current, 2))
            current += step

    return breaks or _PRICE_BAND_PRESETS['default']


def _resolve_price_band_spec(*, standard: str | None, breaks_text: str | None, prices: list[float] | None = None) -> dict[str, Any]:
    normalized_standard = (standard or 'default').strip().lower() or 'default'
    if breaks_text and breaks_text.strip():
        breaks = _parse_price_breaks_text(breaks_text)
        return _build_price_band_spec(name='custom', breaks=breaks, method='manual_custom')

    if normalized_standard in {'default', 'refined', 'scientific'}:
        return _build_price_band_spec(
            name='refined',
            breaks=_auto_price_breaks(prices or []),
            method='scientific_refined',
        )

    preset_breaks = _PRICE_BAND_PRESETS.get(normalized_standard) or _PRICE_BAND_PRESETS['default']
    return _build_price_band_spec(name=normalized_standard, breaks=preset_breaks, method=f'preset_{normalized_standard}')


def _parse_price_breaks_text(breaks_text: str) -> list[float]:
    values: list[float] = []
    for part in breaks_text.split(','):
        text = part.strip()
        if not text:
            continue
        try:
            values.append(float(text))
        except ValueError as exc:
            raise ValueError(f'invalid price_band_breaks value: {text}') from exc
    if not values:
        raise ValueError('price_band_breaks is empty')
    unique_sorted = sorted({round(value, 2) for value in values if value > 0})
    if not unique_sorted:
        raise ValueError('price_band_breaks must be positive')
    if len(unique_sorted) > 8:
        raise ValueError('price_band_breaks supports up to 8 breakpoints')
    return unique_sorted


def _build_price_band_spec(*, name: str, breaks: list[float], method: str) -> dict[str, Any]:
    sorted_breaks = sorted({round(float(value), 2) for value in breaks if float(value) > 0})
    if not sorted_breaks:
        sorted_breaks = _PRICE_BAND_PRESETS['default']

    bands: list[dict[str, Any]] = []
    lower = 0.0
    for upper in sorted_breaks:
        bands.append(
            {
                'key': _price_band_key(lower=lower, upper=upper),
                'label': _price_band_label(lower=lower, upper=upper),
                'lower': lower,
                'upper': upper,
            }
        )
        lower = upper
    bands.append(
        {
            'key': _price_band_key(lower=lower, upper=None),
            'label': _price_band_label(lower=lower, upper=None),
            'lower': lower,
            'upper': None,
        }
    )

    return {
        'name': name,
        'method': method,
        'description': '基于价格分布、IQR 和 nice step 自动生成精细价格带。' if method == 'scientific_refined' else '基于预设或手动断点生成价格带。',
        'breaks': sorted_breaks,
        'bands': bands,
    }


def _price_band_label(*, lower: float, upper: float | None) -> str:
    lower_text = f'{int(lower)}' if float(lower).is_integer() else f'{lower:.2f}'.rstrip('0').rstrip('.')
    if upper is None:
        return f'${lower_text}+'
    upper_value = float(upper)
    if upper_value.is_integer():
        upper_text = f'{int(upper_value) - 1}'
    else:
        upper_text = f'{upper_value:.2f}'.rstrip('0').rstrip('.')
    return f'${lower_text}-{upper_text}'


def _price_band_key(*, lower: float, upper: float | None) -> str:
    if upper is None:
        return f'{int(lower)}+'
    if float(upper).is_integer():
        return f'{int(lower)}-{int(upper) - 1}'
    return f'{lower:.2f}-{upper:.2f}'


def _build_dimension_price_band_analysis(
    rows: list[CategoryResearchProductDetail],
    *,
    spec: dict[str, Any],
    top_values_per_dimension: int = 8,
) -> list[dict[str, Any]]:
    labels = [str(item['label']) for item in spec['bands']]
    totals: dict[str, dict[str, Any]] = {}
    for item in rows:
        if item.price_usd is None:
            continue
        price = float(item.price_usd)
        band_label = _resolve_price_band(price, spec=spec)
        for key, value in _effective_dimensions(item).items():
            if not value:
                continue
            dimension_entry = totals.setdefault(
                key,
                {
                    'key': key,
                    'label': _DIMENSION_LABELS.get(key, key.replace('_', ' ').title()),
                    'total_count': 0,
                    'value_map': {},
                },
            )
            value_entry = dimension_entry['value_map'].setdefault(
                value,
                {
                    'value': value,
                    'count': 0,
                    'band_counts': {label: 0 for label in labels},
                },
            )
            value_entry['count'] += 1
            value_entry['band_counts'][band_label] += 1
            dimension_entry['total_count'] += 1

    payload: list[dict[str, Any]] = []
    for entry in totals.values():
        values = list(entry['value_map'].values())
        values.sort(key=lambda item: item['count'], reverse=True)
        payload.append(
            {
                'key': entry['key'],
                'label': entry['label'],
                'total_count': int(entry['total_count']),
                'values': [
                    {
                        'value': value_entry['value'],
                        'count': int(value_entry['count']),
                        'share': round(float(value_entry['count']) / max(1, int(entry['total_count'])), 6),
                        'band_distribution': [
                            {
                                'label': label,
                                'count': int(value_entry['band_counts'][label]),
                                'share': round(float(value_entry['band_counts'][label]) / max(1, int(value_entry['count'])), 6),
                            }
                            for label in labels
                        ],
                    }
                    for value_entry in values[:top_values_per_dimension]
                ],
            }
        )
    payload.sort(key=lambda item: item['total_count'], reverse=True)
    return payload


def _build_brand_price_band_analysis(
    rows: list[CategoryResearchProductDetail],
    *,
    spec: dict[str, Any],
    limit: int = 12,
) -> list[dict[str, Any]]:
    labels = [str(item['label']) for item in spec['bands']]
    brand_map: dict[str, dict[str, Any]] = {}
    for item in rows:
        if item.price_usd is None:
            continue
        brand = (item.brand or 'Unknown').strip() or 'Unknown'
        price = float(item.price_usd)
        band_label = _resolve_price_band(price, spec=spec)
        entry = brand_map.setdefault(
            brand,
            {
                'brand': brand,
                'product_count': 0,
                'monthly_sales': 0,
                'band_counts': {label: 0 for label in labels},
                'min_price': None,
                'max_price': None,
            },
        )
        entry['product_count'] += 1
        entry['monthly_sales'] += int(item.monthly_sales or 0)
        entry['band_counts'][band_label] += 1
        entry['min_price'] = price if entry['min_price'] is None else min(float(entry['min_price']), price)
        entry['max_price'] = price if entry['max_price'] is None else max(float(entry['max_price']), price)

    brands = list(brand_map.values())
    brands.sort(key=lambda item: (item['monthly_sales'], item['product_count']), reverse=True)
    payload: list[dict[str, Any]] = []
    for item in brands[:limit]:
        product_count = int(item['product_count'])
        payload.append(
            {
                'brand': item['brand'],
                'product_count': product_count,
                'monthly_sales': int(item['monthly_sales']),
                'price_range': {
                    'min_price': round(float(item['min_price'] or 0.0), 2),
                    'max_price': round(float(item['max_price'] or 0.0), 2),
                },
                'covered_bands': [label for label in labels if int(item['band_counts'][label]) > 0],
                'band_distribution': [
                    {
                        'label': label,
                        'count': int(item['band_counts'][label]),
                        'share': round(float(item['band_counts'][label]) / max(1, product_count), 6),
                    }
                    for label in labels
                ],
            }
        )
    return payload


def _build_price_band_opportunities(
    rows: list[CategoryResearchProductDetail],
    *,
    total_monthly_sales: int,
    total_monthly_revenue: float,
    spec: dict[str, Any],
) -> list[dict[str, Any]]:
    labels = [str(item['label']) for item in spec['bands']]
    buckets: dict[str, dict[str, float]] = {
        label: {
            'count': 0,
            'monthly_sales': 0,
            'monthly_revenue_usd': 0.0,
            'rating_sum': 0.0,
            'rating_count': 0,
            'review_count_sum': 0.0,
        }
        for label in labels
    }

    for item in rows:
        if item.price_usd is None:
            continue
        label = _resolve_price_band(float(item.price_usd), spec=spec)
        entry = buckets[label]
        entry['count'] += 1
        entry['monthly_sales'] += int(item.monthly_sales or 0)
        entry['monthly_revenue_usd'] += float(item.monthly_revenue_usd or 0)
        entry['review_count_sum'] += float(item.review_count or 0)
        if item.rating is not None:
            entry['rating_sum'] += float(item.rating)
            entry['rating_count'] += 1

    total_sales = max(1, total_monthly_sales)
    total_revenue = max(1e-9, total_monthly_revenue)

    payload: list[dict[str, Any]] = []
    for label in labels:
        entry = buckets[label]
        count = int(entry['count'])
        rating_count = int(entry['rating_count'])
        payload.append(
            {
                'label': label,
                'count': count,
                'monthly_sales': int(entry['monthly_sales']),
                'monthly_revenue_usd': round(float(entry['monthly_revenue_usd']), 2),
                'sales_share': round(float(entry['monthly_sales']) / total_sales, 6),
                'revenue_share': round(float(entry['monthly_revenue_usd']) / total_revenue, 6),
                'average_rating': round((float(entry['rating_sum']) / rating_count) if rating_count > 0 else 0.0, 4),
                'average_review_count': round((float(entry['review_count_sum']) / count) if count > 0 else 0.0, 2),
            }
        )
    return payload


def _resolve_price_band(price_usd: float, *, spec: dict[str, Any]) -> str:
    bands = spec['bands']
    for band in bands:
        lower = float(band['lower'])
        upper = float(band['upper']) if band['upper'] is not None else None
        if upper is None:
            if price_usd >= lower:
                return str(band['label'])
        elif lower <= price_usd < upper:
            return str(band['label'])
    return str(bands[-1]['label'])


def _build_new_product_opportunity(
    rows: list[CategoryResearchProductDetail],
    *,
    total_monthly_sales: int,
) -> dict[str, float]:
    if not rows:
        return {
            'new_product_count': 0,
            'new_product_share': 0.0,
            'new_product_sales_share': 0.0,
            'new_product_avg_monthly_sales': 0.0,
            'new_product_median_price_usd': 0.0,
        }

    new_rows = [item for item in rows if item.is_new_90d]
    new_sales = sum(int(item.monthly_sales or 0) for item in new_rows)
    new_prices = [float(item.price_usd) for item in new_rows if item.price_usd is not None]
    new_sales_values = [int(item.monthly_sales or 0) for item in new_rows]

    new_product_share = round(len(new_rows) / len(rows), 6)
    new_product_sales_share = round(new_sales / max(1, total_monthly_sales), 6)
    opportunity_signal = max(new_product_share, new_product_sales_share * 1.15)
    if opportunity_signal >= 0.25:
        opportunity_level = 'very_high'
        radar_score = 92.0
    elif opportunity_signal >= 0.16:
        opportunity_level = 'high'
        radar_score = 76.0
    elif opportunity_signal >= 0.08:
        opportunity_level = 'medium'
        radar_score = 58.0
    elif opportunity_signal >= 0.04:
        opportunity_level = 'low'
        radar_score = 36.0
    else:
        opportunity_level = 'very_low'
        radar_score = 18.0

    return {
        'new_product_count': len(new_rows),
        'new_product_share': new_product_share,
        'new_product_sales_share': new_product_sales_share,
        'new_product_avg_monthly_sales': round(float(np.mean(new_sales_values)) if new_sales_values else 0.0, 2),
        'new_product_median_price_usd': round(float(np.median(new_prices)) if new_prices else 0.0, 2),
        'opportunity_level': opportunity_level,
        'radar_score': radar_score,
        'level_thresholds': [
            '极高 >= 25%',
            '高 16%-25%',
            '中 8%-16%',
            '低 4%-8%',
            '极低 < 4%',
            '判定取新品数量占比与新品销量占比的综合信号。',
        ],
    }


def _build_supply_complexity(
    rows: list[CategoryResearchProductDetail],
    *,
    fulfillment_counter: Counter[str],
    prices: list[float],
) -> dict[str, float]:
    total_fulfillment = sum(int(value) for value in fulfillment_counter.values())
    active_counts = [int(value) for value in fulfillment_counter.values() if int(value) > 0]
    if total_fulfillment <= 0 or len(active_counts) <= 1:
        fulfillment_mix_score = 0.0
    else:
        shares = np.array(active_counts, dtype=float) / float(total_fulfillment)
        entropy = float(-np.sum(shares * np.log(shares)))
        max_entropy = float(np.log(len(active_counts)))
        fulfillment_mix_score = (entropy / max_entropy) * 100 if max_entropy > 0 else 0.0

    fee_ratios: list[float] = []
    for item in rows:
        if item.fba_fee_usd is None or item.price_usd is None:
            continue
        price = float(item.price_usd)
        if price <= 0:
            continue
        fee_ratios.append(float(item.fba_fee_usd) / price)
    avg_fee_ratio = float(np.mean(fee_ratios)) if fee_ratios else 0.0
    fba_fee_pressure_score = min(100.0, avg_fee_ratio * 500)

    if len(prices) < 2:
        price_dispersion_score = 0.0
    else:
        mean_price = float(np.mean(prices))
        price_dispersion_score = min(100.0, (float(np.std(prices)) / mean_price) * 100) if mean_price > 0 else 0.0

    score = (fulfillment_mix_score * 0.4) + (fba_fee_pressure_score * 0.4) + (price_dispersion_score * 0.2)
    if score >= 75:
        complexity_level = 'very_high'
    elif score >= 58:
        complexity_level = 'high'
    elif score >= 40:
        complexity_level = 'medium'
    elif score >= 24:
        complexity_level = 'low'
    else:
        complexity_level = 'very_low'

    radar_score = round(max(0.0, 100.0 - score), 2)
    return {
        'score': round(score, 2),
        'fulfillment_mix_score': round(fulfillment_mix_score, 2),
        'fba_fee_pressure_score': round(fba_fee_pressure_score, 2),
        'price_dispersion_score': round(price_dispersion_score, 2),
        'complexity_level': complexity_level,
        'radar_score': radar_score,
        'level_thresholds': [
            '极低复杂度 < 24',
            '低复杂度 24-40',
            '中复杂度 40-58',
            '高复杂度 58-75',
            '极高复杂度 >= 75',
        ],
        'explanation_lines': [
            f'履约混合度 {round(fulfillment_mix_score, 2)} / 100，越高代表 FBA/FBM/SFP 等结构越分散，运营打法越复杂。',
            f'FBA 费用压力 {round(fba_fee_pressure_score, 2)} / 100，基于平均 FBA 费用占售价比例估算，越高代表费用侵蚀越明显。',
            f'价格离散度 {round(price_dispersion_score, 2)} / 100，基于价格标准差 / 平均价，越高代表同类产品价格带更分裂。',
        ],
    }


def _build_asin_momentum(trend_rows: list[CategoryResearchSalesTrend], *, limit: int = 30) -> list[dict[str, Any]]:
    grouped: dict[str, list[tuple[str, int]]] = {}
    for item in trend_rows:
        asin = (item.asin or '').strip().upper()
        if not asin:
            continue
        grouped.setdefault(asin, []).append((item.year_month, int(item.monthly_sales or 0)))

    payload: list[dict[str, Any]] = []
    for asin, points in grouped.items():
        ordered = sorted(points, key=lambda entry: entry[0])
        sales = [value for _, value in ordered]
        if not sales:
            continue

        avg_sales = float(np.mean(sales))
        std_sales = float(np.std(sales))
        sales_cv = (std_sales / avg_sales) if avg_sales > 0 else 0.0

        yoy_growth = 0.0
        if len(sales) >= 13:
            baseline = float(sales[-13])
            latest = float(sales[-1])
            if baseline > 0:
                yoy_growth = (latest - baseline) / baseline
            elif latest > 0:
                yoy_growth = 1.0

        recent_3m_momentum = 0.0
        if len(sales) >= 6:
            latest_avg = float(np.mean(sales[-3:]))
            previous_avg = float(np.mean(sales[-6:-3]))
            if previous_avg > 0:
                recent_3m_momentum = (latest_avg - previous_avg) / previous_avg
            elif latest_avg > 0:
                recent_3m_momentum = 1.0

        payload.append(
            {
                'asin': asin,
                'avg_monthly_sales': round(avg_sales, 2),
                'sales_cv': round(sales_cv, 6),
                'yoy_growth': round(float(yoy_growth), 6),
                'recent_3m_momentum': round(float(recent_3m_momentum), 6),
            }
        )

    payload.sort(key=lambda item: item['avg_monthly_sales'], reverse=True)
    return payload[:limit]


def _build_data_quality(dataset: CategoryResearchDataset, rows: list[CategoryResearchProductDetail]) -> dict[str, Any]:
    warnings = dataset.quality_warnings if isinstance(dataset.quality_warnings, dict) else {}
    missing_trend_for_asin_count = int(warnings.get('missing_trend_for_asin_count') or 0)
    invalid_price_count = int(warnings.get('invalid_price_count') or 0)
    invalid_fba_fee_count = int(warnings.get('invalid_fba_fee_count') or 0)
    duplicate_asin_count = int(warnings.get('duplicate_asin_count') or 0)
    missing_fba_fee_count = sum(1 for item in rows if item.fba_fee_usd is None)
    missing_seller_country_count = sum(1 for item in rows if not (item.seller_country_region or '').strip())
    missing_brand_count = sum(1 for item in rows if not (item.brand or '').strip())
    unknown_fulfillment_count = sum(
        1
        for item in rows
        if not (item.fulfillment_method or '').strip() or (item.fulfillment_method or '').strip() == '未知'
    )

    base = max(1, int(dataset.row_count_products or 0))
    completeness_penalty = (
        (missing_fba_fee_count / base) * 0.35
        + (missing_seller_country_count / base) * 0.25
        + (missing_brand_count / base) * 0.2
        + (missing_trend_for_asin_count / base) * 0.2
    )
    validity_penalty = (
        (invalid_price_count / base) * 0.55
        + (invalid_fba_fee_count / base) * 0.45
    )
    consistency_penalty = (
        (duplicate_asin_count / base) * 0.6
        + (unknown_fulfillment_count / base) * 0.4
    )
    coverage_penalty = (missing_trend_for_asin_count / base)

    completeness_score = max(0.0, 100.0 * (1.0 - min(1.0, completeness_penalty)))
    validity_score = max(0.0, 100.0 * (1.0 - min(1.0, validity_penalty)))
    consistency_score = max(0.0, 100.0 * (1.0 - min(1.0, consistency_penalty)))
    coverage_score = max(0.0, 100.0 * (1.0 - min(1.0, coverage_penalty)))
    score = (
        completeness_score * 0.3
        + validity_score * 0.3
        + consistency_score * 0.2
        + coverage_score * 0.2
    )
    warning_density = round(
        (
            missing_trend_for_asin_count
            + invalid_price_count
            + invalid_fba_fee_count
            + duplicate_asin_count
            + missing_fba_fee_count
            + missing_seller_country_count
            + missing_brand_count
            + unknown_fulfillment_count
        )
        / base,
        4,
    )

    if score >= 92:
        level = 'excellent'
    elif score >= 82:
        level = 'good'
    elif score >= 68:
        level = 'fair'
    else:
        level = 'poor'

    return {
        'score': round(score, 2),
        'missing_trend_for_asin_count': missing_trend_for_asin_count,
        'invalid_price_count': invalid_price_count,
        'invalid_fba_fee_count': invalid_fba_fee_count,
        'duplicate_asin_count': duplicate_asin_count,
        'missing_fba_fee_count': missing_fba_fee_count,
        'missing_seller_country_count': missing_seller_country_count,
        'missing_brand_count': missing_brand_count,
        'unknown_fulfillment_count': unknown_fulfillment_count,
        'completeness_score': round(completeness_score, 2),
        'validity_score': round(validity_score, 2),
        'consistency_score': round(consistency_score, 2),
        'coverage_score': round(coverage_score, 2),
        'level': level,
        'warning_density': warning_density,
        'summary': (
            f"完整性 {completeness_score:.1f}，有效性 {validity_score:.1f}，一致性 {consistency_score:.1f}，"
            f"覆盖度 {coverage_score:.1f}。每个样本平均警报 {warning_density:.2f} 个。"
        ),
    }


def _build_dimension_blocks(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    china = advanced_metrics['china_seller_competition']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    review = advanced_metrics['review_research']
    new_product = advanced_metrics['new_product_opportunity']
    quality = advanced_metrics['data_quality']
    structure_level = _max_risk_level([brand.get('risk_level'), seller.get('risk_level'), product.get('risk_level'), china.get('risk_level')])

    opportunity_score = 0
    if growth.get('growth_level') == 'growing':
        opportunity_score += 1
    if seasonality.get('seasonality_level') in {'weak', 'moderate'}:
        opportunity_score += 1
    if new_product.get('new_product_sales_share', 0.0) >= 0.12:
        opportunity_score += 1
    if review.get('low_review_product_share', 0.0) >= 0.35:
        opportunity_score += 1
    if opportunity_score >= 3:
        opportunity_level = 'high'
    elif opportunity_score >= 2:
        opportunity_level = 'medium'
    else:
        opportunity_level = 'low'

    execution_level = 'high' if quality.get('score', 0.0) < 80 else 'medium' if quality.get('score', 0.0) < 92 else 'low'

    return [
        {
            'key': 'structure',
            'label': '竞争结构',
            'summary': f"品牌CR3 {brand.get('brand_cr3', 0.0):.2%}，卖家CR3 {seller.get('seller_cr3', 0.0):.2%}，结构风险{_risk_label(structure_level)}。",
            'risk_level': structure_level,
            'metric_keys': ['brand_cr3', 'brand_hhi', 'seller_cr3', 'seller_hhi', 'asin_top1_share', 'china_seller_sales_share'],
        },
        {
            'key': 'opportunity',
            'label': '机会定位',
            'summary': f"增长 {growth.get('growth_level', 'stable')}，季节性 {seasonality.get('seasonality_level', 'weak')}，新品销量占比 {new_product.get('new_product_sales_share', 0.0):.2%}。",
            'risk_level': opportunity_level,
            'metric_keys': ['last12_vs_prev12_growth', 'cagr_like_growth', 'seasonality_level', 'review_p75', 'new_product_sales_share', 'supply_complexity_score'],
        },
        {
            'key': 'execution',
            'label': '执行落地',
            'summary': f"数据质量分 {quality.get('score', 0.0):.2f}，建议优先处理高影响验证项后推进候选池。",
            'risk_level': execution_level,
            'metric_keys': ['data_quality_score', 'missing_trend_for_asin_count', 'invalid_price_count', 'duplicate_asin_count'],
        },
    ]


def _build_metric_definitions(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    new_product = advanced_metrics['new_product_opportunity']
    supply = advanced_metrics['supply_complexity']
    quality = advanced_metrics['data_quality']
    china = advanced_metrics['china_seller_competition']
    return [
        {
            'key': 'brand_cr3',
            'name': '品牌CR3 (Concentration Ratio 3)',
            'formula_text': '前3品牌月销量之和 / 类目总月销量',
            'thresholds': ['低 < 45%', '中 45%-70%', '高 >= 70%'],
            'interpretation_template': f"当前值 {brand.get('brand_cr3', 0.0):.2%}，用于识别头部品牌垄断程度。",
            'pitfall': 'CR3高不等于不可进入，若利润带宽大且差异化明确仍可切入。',
            'action_hint': '若CR3高，优先寻找中尾部未被充分覆盖的价格带和功能点。',
        },
        {
            'key': 'brand_hhi',
            'name': '品牌HHI (Herfindahl-Hirschman Index)',
            'formula_text': 'Σ(品牌销量占比 × 100)^2',
            'thresholds': ['低 < 1500', '中 1500-2500', '高 >= 2500'],
            'interpretation_template': f"当前值 {brand.get('brand_hhi', 0.0):.0f}，用于综合衡量品牌集中度。",
            'pitfall': 'HHI对长尾品牌变化敏感，需和CR3联合判断。',
            'action_hint': 'HHI高时减少正面竞争，转向差异化卖点和细分场景。',
        },
        {
            'key': 'seller_cr3',
            'name': '卖家CR3 (Seller Concentration Ratio 3)',
            'formula_text': '前3卖家月销量之和 / 类目总月销量',
            'thresholds': ['低 < 45%', '中 45%-70%', '高 >= 70%'],
            'interpretation_template': f"当前值 {seller.get('seller_cr3', 0.0):.2%}，反映卖家侧渠道控制强度。",
            'pitfall': '卖家集中可能由季节活动驱动，需结合趋势判断持续性。',
            'action_hint': '卖家CR3高时，优先评估渠道壁垒和非价格竞争空间。',
        },
        {
            'key': 'seller_hhi',
            'name': '卖家HHI',
            'formula_text': 'Σ(卖家销量占比 × 100)^2',
            'thresholds': ['低 < 1500', '中 1500-2500', '高 >= 2500'],
            'interpretation_template': f"当前值 {seller.get('seller_hhi', 0.0):.0f}，用于识别渠道竞争集中度。",
            'pitfall': '卖家名称归一化不足会低估HHI，需要清洗同主体别名。',
            'action_hint': '卖家HHI高时，优先建立差异化供给与内容护城河。',
        },
        {
            'key': 'seller_monopoly_ratio',
            'name': '卖家垄断系数 (Seller Monopoly Coefficient)',
            'formula_text': '0.6 × Seller CR3 + 0.4 × min(Seller HHI / 2500, 1)',
            'thresholds': ['低 < 0.45', '中 0.45-0.70', '高 >= 0.70'],
            'interpretation_template': f"当前值 {(0.6 * seller.get('seller_cr3', 0.0) + 0.4 * min(seller.get('seller_hhi', 0.0) / 2500.0, 1.0)):.2f}，用于统一卖家垄断风险判断。",
            'pitfall': '该系数是策略指标，不替代原始CR3/HHI口径。',
            'action_hint': '系数偏高时，执行阶段应提高“暂缓进入”门槛。',
        },
        {
            'key': 'asin_top1_share',
            'name': '产品Top1份额',
            'formula_text': 'Top1 ASIN月销量 / 类目总月销量',
            'thresholds': ['低 < 20%', '中 20%-35%', '高 >= 35%'],
            'interpretation_template': f"当前值 {product.get('asin_top1_share', 0.0):.2%}，用于识别单品虹吸效应。",
            'pitfall': 'Top1高可能是短期爆款，需看动量和季节性。',
            'action_hint': 'Top1高时先验证同价带第二梯队产品是否具备承接能力。',
        },
        {
            'key': 'last12_vs_prev12_growth',
            'name': '市场增长层级',
            'formula_text': '最近12个月总销量 vs 之前12个月总销量',
            'thresholds': growth.get('tier_thresholds', []),
            'interpretation_template': (
                f"当前同比窗增长 {growth.get('last12_vs_prev12_growth', 0.0):.2%}，"
                f"CAGR-like {growth.get('cagr_like_growth', 0.0):.2%}，归类为 {growth.get('growth_tier', 'stable')}。"
            ),
            'pitfall': '短期爆发可能来自一次性事件，需排除大促、断货恢复和平台流量异常。',
            'action_hint': '增长层级越高，越适合优先验证差异化切入与补货能力。',
        },
        {
            'key': 'seasonality_level',
            'name': '季节性层级',
            'formula_text': 'Peak3 月销量占比 + 月销量变异系数(CV) 综合判断',
            'thresholds': seasonality.get('tier_thresholds', []),
            'interpretation_template': (
                f"当前 Peak3 占比 {seasonality.get('peak3_month_sales_share', 0.0):.2%}，"
                f"CV {seasonality.get('monthly_sales_cv', 0.0):.2f}，归类为 {seasonality.get('seasonality_tier', 'balanced')}。"
            ),
            'pitfall': '季节性强并不一定差，但会抬高入场时机和库存周转要求。',
            'action_hint': '强季节性类目需要把入场月份、首单节奏和补货周期前置验证。',
        },
        {
            'key': 'new_product_sales_share',
            'name': '新品机会层级',
            'formula_text': '新品数量占比 + 新品销量占比综合信号',
            'thresholds': new_product.get('level_thresholds', []),
            'interpretation_template': (
                f"当前新品数量占比 {new_product.get('new_product_share', 0.0):.2%}，"
                f"新品销量占比 {new_product.get('new_product_sales_share', 0.0):.2%}，"
                f"归类为 {new_product.get('opportunity_level', 'low')}。"
            ),
            'pitfall': '新品占比高也可能意味着市场动荡，需结合评论门槛和头部垄断判断。',
            'action_hint': '新品机会高时，优先验证新品是否能在主价格带快速承接销量。',
        },
        {
            'key': 'supply_complexity_score',
            'name': '供给复杂度',
            'formula_text': '0.4×履约混合度 + 0.4×FBA费用压力 + 0.2×价格离散度',
            'thresholds': supply.get('level_thresholds', []),
            'interpretation_template': f"当前分数 {supply.get('score', 0.0):.2f}，归类为 {supply.get('complexity_level', 'low')}。",
            'pitfall': '它是运营复杂度代理指标，不直接等于进入难度，需要结合品牌和卖家结构一起看。',
            'action_hint': '复杂度高时，优先确认物流、费用模型和可复制的履约策略。',
        },
        {
            'key': 'data_quality_score',
            'name': '数据质量',
            'formula_text': '0.3×完整性 + 0.3×有效性 + 0.2×一致性 + 0.2×覆盖度',
            'thresholds': ['优秀 >= 92', '良好 82-92', '一般 68-82', '较差 < 68'],
            'interpretation_template': (
                f"当前总分 {quality.get('score', 0.0):.2f}，完整性 {quality.get('completeness_score', 0.0):.2f}，"
                f"有效性 {quality.get('validity_score', 0.0):.2f}，一致性 {quality.get('consistency_score', 0.0):.2f}。"
            ),
            'pitfall': '高分不代表可直接决策，只代表当前样本内部更完整、更干净。',
            'action_hint': '若质量不达标，应先清洗缺失/异常字段再判断机会与风险。',
        },
        {
            'key': 'china_seller_sales_share',
            'name': '中国卖家竞争强度',
            'formula_text': '中国卖家月销量 / 全部月销量',
            'thresholds': ['低 < 50%', '中 50%-70%', '高 >= 70%'],
            'interpretation_template': f"当前值 {china.get('china_seller_sales_share', 0.0):.2%}，基于 seller_country_region 优先识别。",
            'pitfall': '如果卖家国家缺失较多，会低估国别竞争强度。',
            'action_hint': '中国卖家占比高时，优先评估供应链效率、价格战强度和差异化空间。',
        },
    ]


def _build_action_recommendations(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    quality = advanced_metrics['data_quality']
    new_product = advanced_metrics['new_product_opportunity']

    actions: list[dict[str, Any]] = [
        {
            'priority': 'high' if brand.get('risk_level') == 'high' or seller.get('risk_level') == 'high' else 'medium',
            'action': '优先锁定中尾部价格带做差异化切入',
            'why': '头部品牌/卖家集中度偏高，直接同质竞争成本高。',
            'required_validation': ['目标价格带毛利率', '头部品牌评价壁垒', '广告竞价成本'],
            'linked_dimension': 'structure',
            'rule_basis': [
                f"品牌风险={brand.get('risk_level', 'low')}",
                f"卖家风险={seller.get('risk_level', 'low')}",
                f"品牌CR3={brand.get('brand_cr3', 0.0):.2%}",
                f"卖家CR3={seller.get('seller_cr3', 0.0):.2%}",
            ],
        },
        {
            'priority': 'high' if growth.get('growth_level') == 'growing' and seasonality.get('seasonality_level') != 'strong' else 'medium',
            'action': '按推荐入场月提前铺货并验证转化',
            'why': '增长和季节性窗口决定入场时点与库存节奏。',
            'required_validation': ['近12月增长持续性', '季节峰值月份稳定性', '补货周期可行性'],
            'linked_dimension': 'opportunity',
            'rule_basis': [
                f"增长层级={growth.get('growth_tier', growth.get('growth_level', 'stable'))}",
                f"季节性层级={seasonality.get('seasonality_tier', seasonality.get('seasonality_level', 'weak'))}",
                f"建议入场月={','.join(seasonality.get('recommended_entry_months', [])) or '无'}",
            ],
        },
        {
            'priority': 'high' if quality.get('score', 0.0) < 90 else 'medium',
            'action': '先完成高影响数据校验再确定候选池',
            'why': '数据质量不足会直接放大错误决策风险。',
            'required_validation': ['缺失趋势ASIN补全', '异常价格/FBA清洗', '重复ASIN去重规则'],
            'linked_dimension': 'execution',
            'rule_basis': [
                f"数据质量={quality.get('score', 0.0):.1f}",
                f"完整性={quality.get('completeness_score', 0.0):.1f}",
                f"有效性={quality.get('validity_score', 0.0):.1f}",
                f"一致性={quality.get('consistency_score', 0.0):.1f}",
            ],
        },
    ]
    if product.get('risk_level') == 'high' and new_product.get('new_product_sales_share', 0.0) < 0.1:
        actions.append(
            {
                'priority': 'high',
                'action': '将该类目标记为暂缓进入，保留跟踪',
                'why': '单品垄断明显且新品承接不足，短期进入胜率低。',
                'required_validation': ['是否存在政策或平台扰动', '头部断货/侵权风险', '可替代细分场景'],
                'linked_dimension': 'execution',
                'rule_basis': [
                    f"单品风险={product.get('risk_level', 'low')}",
                    f"Top1份额={product.get('asin_top1_share', 0.0):.2%}",
                    f"新品销量占比={new_product.get('new_product_sales_share', 0.0):.2%}",
                ],
            }
        )
    return actions


def _build_signals(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    china = advanced_metrics['china_seller_competition']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    quality = advanced_metrics['data_quality']

    growth_level = growth.get('growth_level', 'stable')
    growth_signal = 'positive' if growth_level == 'growing' else 'negative' if growth_level == 'shrinking' else 'neutral'
    seasonality_level = seasonality.get('seasonality_level', 'weak')
    seasonality_signal_level = 'high' if seasonality_level == 'strong' else 'medium' if seasonality_level == 'moderate' else 'low'
    quality_score = float(quality.get('score', 0.0))

    return [
        {'key': 'brand_monopoly', 'label': '品牌垄断风险', 'level': brand.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'seller_monopoly', 'label': '卖家垄断风险', 'level': seller.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'product_monopoly', 'label': '产品垄断风险', 'level': product.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'china_seller_competition', 'label': '中国卖家拥挤', 'level': china.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'market_growth', 'label': '市场增长信号', 'level': 'high' if growth_level == 'growing' else 'medium' if growth_level == 'stable' else 'high', 'direction': growth_signal, 'linked_dimension': 'opportunity'},
        {'key': 'seasonality', 'label': '季节性波动', 'level': seasonality_signal_level, 'direction': 'negative' if seasonality_level == 'strong' else 'neutral', 'linked_dimension': 'opportunity'},
        {'key': 'data_quality', 'label': '数据可信度', 'level': 'high' if quality_score < 80 else 'medium' if quality_score < 92 else 'low', 'direction': 'negative' if quality_score < 92 else 'positive', 'linked_dimension': 'execution'},
    ]


def _risk_label(level: str) -> str:
    if level == 'high':
        return '高'
    if level == 'medium':
        return '中'
    return '低'


def _max_risk_level(levels: list[str | None]) -> str:
    valid = [item for item in levels if item in {'high', 'medium', 'low'}]
    if 'high' in valid:
        return 'high'
    if 'medium' in valid:
        return 'medium'
    return 'low'


def _build_fixed_price_bands(prices: list[float], *, spec: dict[str, Any]) -> list[dict[str, Any]]:
    counter = {str(item['label']): 0 for item in spec['bands']}
    for price in prices:
        label = _resolve_price_band(float(price), spec=spec)
        counter[label] += 1
    return [{'label': key, 'count': int(value)} for key, value in counter.items()]


def _build_quantile_price_bands(prices: list[float]) -> list[dict[str, Any]]:
    if not prices:
        return []

    series = pd.Series(prices)
    quantiles = series.quantile([0.25, 0.5, 0.75, 1.0]).tolist()
    p25, p50, p75, p100 = [float(item) for item in quantiles]

    counter = {'Q1': 0, 'Q2': 0, 'Q3': 0, 'Q4': 0}
    for value in prices:
        if value <= p25:
            counter['Q1'] += 1
        elif value <= p50:
            counter['Q2'] += 1
        elif value <= p75:
            counter['Q3'] += 1
        else:
            counter['Q4'] += 1

    min_price = float(series.min())
    return [
        {'label': 'Q1', 'min_price': min_price, 'max_price': p25, 'count': int(counter['Q1'])},
        {'label': 'Q2', 'min_price': p25, 'max_price': p50, 'count': int(counter['Q2'])},
        {'label': 'Q3', 'min_price': p50, 'max_price': p75, 'count': int(counter['Q3'])},
        {'label': 'Q4', 'min_price': p75, 'max_price': p100, 'count': int(counter['Q4'])},
    ]


def _build_price_stats(prices: list[float]) -> dict[str, float]:
    if not prices:
        return {'mean': 0.0, 'median': 0.0, 'p25': 0.0, 'p75': 0.0}

    series = pd.Series(prices)
    return {
        'mean': round(float(series.mean()), 2),
        'median': round(float(series.median()), 2),
        'p25': round(float(series.quantile(0.25)), 2),
        'p75': round(float(series.quantile(0.75)), 2),
    }


def _price_sales_correlation(rows: list[CategoryResearchProductDetail]) -> float:
    values: list[tuple[float, float]] = []
    for item in rows:
        if item.price_usd is None:
            continue
        values.append((float(item.price_usd), float(item.monthly_sales or 0)))
    if len(values) < 2:
        return 0.0

    price_vec = np.array([value[0] for value in values], dtype=float)
    sales_vec = np.array([value[1] for value in values], dtype=float)

    if np.std(price_vec) == 0 or np.std(sales_vec) == 0:
        return 0.0

    correlation = np.corrcoef(price_vec, sales_vec)[0, 1]
    if np.isnan(correlation):
        return 0.0
    return float(correlation)


def _build_fba_fee_distribution(rows: list[CategoryResearchProductDetail]) -> list[dict[str, Any]]:
    counter = {
        '0-5%': 0,
        '5-10%': 0,
        '10-15%': 0,
        '15%+': 0,
        '未知': 0,
    }
    for item in rows:
        if item.fba_fee_usd is None or item.price_usd is None or float(item.price_usd) <= 0:
            counter['未知'] += 1
            continue
        ratio = float(item.fba_fee_usd) / float(item.price_usd)
        if ratio < 0.05:
            counter['0-5%'] += 1
        elif ratio < 0.10:
            counter['5-10%'] += 1
        elif ratio < 0.15:
            counter['10-15%'] += 1
        else:
            counter['15%+'] += 1
    return [{'label': label, 'count': int(count)} for label, count in counter.items()]
