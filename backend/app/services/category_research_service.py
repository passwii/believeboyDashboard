from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
import hashlib
from pathlib import Path
import re
from threading import Lock
from typing import Any

import numpy as np
import pandas as pd
from openpyxl import load_workbook
from sqlalchemy import Select, func, insert, select, update as sa_update
from sqlalchemy.orm import Session

from app.models import (
    CategoryResearchDataset,
    CategoryResearchProductDetail,
    CategoryResearchSalesTrend,
)
from app.services.upload_service import save_upload_file

_SQLITE_TABLES_READY = False
_SQLITE_TABLES_LOCK = Lock()


@dataclass
class ParsedWorkbookPayload:
    product_rows: list[dict[str, Any]]
    trend_rows: list[dict[str, Any]]
    quality_warnings: dict[str, Any]


def ensure_tables(db: Session) -> None:
    global _SQLITE_TABLES_READY
    bind = db.get_bind()
    if bind.dialect.name != 'sqlite':
        return
    if _SQLITE_TABLES_READY:
        return

    with _SQLITE_TABLES_LOCK:
        if _SQLITE_TABLES_READY:
            return
        for table in (
            CategoryResearchDataset.__table__,
            CategoryResearchProductDetail.__table__,
            CategoryResearchSalesTrend.__table__,
        ):
            table.create(bind=bind, checkfirst=True)
        _SQLITE_TABLES_READY = True


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
    ensure_tables(db)

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
) -> list[CategoryResearchDataset]:
    ensure_tables(db)

    stmt: Select = select(CategoryResearchDataset).order_by(
        CategoryResearchDataset.created_at.desc(),
        CategoryResearchDataset.id.desc(),
    )
    if current_only:
        stmt = stmt.where(CategoryResearchDataset.is_current.is_(True))
    if marketplace:
        stmt = stmt.where(CategoryResearchDataset.marketplace == _normalize_marketplace(marketplace))
    if category_keyword_en:
        stmt = stmt.where(CategoryResearchDataset.category_keyword_en == _normalize_category_keyword(category_keyword_en))

    return list(db.execute(stmt).scalars().all())


def get_dataset_or_none(db: Session, dataset_id: int) -> CategoryResearchDataset | None:
    ensure_tables(db)
    return db.get(CategoryResearchDataset, dataset_id)


def get_dataset_overview(db: Session, dataset_id: int) -> dict[str, Any]:
    ensure_tables(db)
    dataset = db.get(CategoryResearchDataset, dataset_id)
    if dataset is None:
        raise ValueError('Dataset not found')

    rows = list(
        db.execute(
            select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)
        ).scalars().all()
    )
    asins = sorted(
        {
            str(item)
            for item in db.execute(
                select(CategoryResearchSalesTrend.asin)
                .where(CategoryResearchSalesTrend.dataset_id == dataset_id)
                .distinct()
            ).scalars().all()
            if item
        }
    )

    prices = [float(item.price_usd) for item in rows if item.price_usd is not None]
    monthly_sales_values = [int(item.monthly_sales or 0) for item in rows]
    monthly_revenue_values = [float(item.monthly_revenue_usd or 0) for item in rows]
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

    fulfillment_counter: Counter[str] = Counter()
    for item in rows:
        key = (item.fulfillment_method or '未知').strip() or '未知'
        fulfillment_counter[key] += 1

    fixed_price_bands = _build_fixed_price_bands(prices)
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

    return {
        'dataset': dataset,
        'kpis': {
            'sample_count': len(rows),
            'brand_count': len({(item.brand or '').strip() for item in rows if (item.brand or '').strip()}),
            'average_price_usd': round(float(np.mean(prices)) if prices else 0.0, 2),
            'total_monthly_sales': int(sum(monthly_sales_values)),
            'total_monthly_revenue_usd': round(float(sum(monthly_revenue_values)), 2),
            'amazon_share': round((amazon_count / len(rows)) if rows else 0.0, 6),
        },
        'brand_sales_share': brand_sales_share,
        'listing_age_distribution': [
            {'label': label, 'count': int(count)}
            for label, count in listing_age_distribution_counter.items()
        ],
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
) -> tuple[list[CategoryResearchProductDetail], bool]:
    ensure_tables(db)
    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')

    stmt: Select = select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)

    if brand and brand.strip():
        stmt = stmt.where(CategoryResearchProductDetail.brand == brand.strip())
    if fulfillment_method and fulfillment_method.strip():
        stmt = stmt.where(CategoryResearchProductDetail.fulfillment_method == fulfillment_method.strip())

    if price_band and price_band.strip():
        normalized = price_band.strip()
        if normalized == '0-49':
            stmt = stmt.where(CategoryResearchProductDetail.price_usd.is_not(None), CategoryResearchProductDetail.price_usd < 50)
        elif normalized == '50-99':
            stmt = stmt.where(
                CategoryResearchProductDetail.price_usd.is_not(None),
                CategoryResearchProductDetail.price_usd >= 50,
                CategoryResearchProductDetail.price_usd < 100,
            )
        elif normalized == '100-149':
            stmt = stmt.where(
                CategoryResearchProductDetail.price_usd.is_not(None),
                CategoryResearchProductDetail.price_usd >= 100,
                CategoryResearchProductDetail.price_usd < 150,
            )
        elif normalized == '150+':
            stmt = stmt.where(CategoryResearchProductDetail.price_usd.is_not(None), CategoryResearchProductDetail.price_usd >= 150)

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
    ensure_tables(db)
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
        seller_text = (seller or '').lower()
        bbx_text = (bbx_attr or '').lower()
        is_amazon = ('amazon' in seller_text) or ('amazon' in bbx_text) or ('亚马逊' in (seller or '')) or ('亚马逊' in (bbx_attr or ''))
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
                'is_amazon': is_amazon,
                'is_new_90d': is_new_90d,
                'raw_row': _to_raw_row(raw_row),
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


def _is_year_month(value: Any) -> bool:
    text = str(value or '').strip()
    return bool(re.fullmatch(r'\d{4}-\d{2}', text))


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


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _build_fixed_price_bands(prices: list[float]) -> list[dict[str, Any]]:
    counter = {
        '$0-49': 0,
        '$50-99': 0,
        '$100-149': 0,
        '$150+': 0,
    }
    for price in prices:
        if price < 50:
            counter['$0-49'] += 1
        elif price < 100:
            counter['$50-99'] += 1
        elif price < 150:
            counter['$100-149'] += 1
        else:
            counter['$150+'] += 1
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
