"""Dataset parsers for category research Excel workbook parsing.

Handles Excel workbook parsing, header matching, and data normalization.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any
from pathlib import Path

from openpyxl import load_workbook
from sqlalchemy.orm import Session

from app.models import CategoryResearchDataset


# --- Constants ---

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


@dataclass
class ParsedWorkbookPayload:
    """Result of parsing a category research Excel workbook."""
    product_rows: list[dict[str, Any]]
    trend_rows: list[dict[str, Any]]
    quality_warnings: dict[str, Any]


# --- Main Parsing Functions ---

def _parse_workbook(path: Path) -> ParsedWorkbookPayload:
    """Parse category research Excel workbook."""
    wb = load_workbook(path, data_only=True)
    product_rows: list[dict[str, Any]] = []
    trend_rows: list[dict[str, Any]] = []
    quality_warnings: dict[str, Any] = {}

    product_sheet_names = ['产品明细', 'Product Detail', 'ProductDetails']
    for name in product_sheet_names:
        if name in wb.sheetnames:
            rows, invalid_price, invalid_fba = _parse_product_sheet(wb[name])
            product_rows.extend(rows)
            quality_warnings['invalid_price_count'] = invalid_price
            quality_warnings['invalid_fba_fee_count'] = invalid_fba
            break

    trend_sheet_names = ['趋势明细', 'Trend Detail', 'TrendDetails']
    for name in trend_sheet_names:
        if name in wb.sheetnames:
            rows, missing_trend, duplicate_asin = _parse_trend_sheet(wb[name])
            trend_rows.extend(rows)
            quality_warnings['missing_trend_for_asin_count'] = missing_trend
            quality_warnings['duplicate_asin_count'] = duplicate_asin
            break

    wb.close()
    return ParsedWorkbookPayload(
        product_rows=product_rows,
        trend_rows=trend_rows,
        quality_warnings=quality_warnings,
    )


def _parse_product_sheet(
    worksheet: Any,
) -> tuple[list[dict[str, Any]], int, int]:
    """Parse product detail sheet."""
    headers = _worksheet_headers(worksheet, header_row=3)
    col_map = _match_columns(headers, {
        'asin': ['ASIN', 'Asin'],
        'parent_asin': ['Parent ASIN', 'ParentAsin', '父ASIN'],
        'product_name': ['Product Name', '产品名称', '名称', 'Name'],
        'brand': ['Brand', '品牌'],
        'seller': ['Seller', '卖家', 'Seller Name'],
        'price': _PRICE_RAW_ALIASES,
        'monthly_sales': ['月销量', 'Monthly Sales', 'MonthlySales', '销量'],
        'monthly_revenue': ['月销售额', 'Monthly Revenue', 'MonthlyRevenue', '销售额'],
        'rating': _RATING_RAW_ALIASES,
        'review_count': _REVIEW_COUNT_RAW_ALIASES,
        'launch_date': _LAUNCH_DATE_RAW_ALIASES,
        'listing_age_days': _LISTING_AGE_DAYS_RAW_ALIASES,
        'fulfillment_method': _FULFILLMENT_METHOD_RAW_ALIASES,
        'fba_fee': _FBA_FEE_RAW_ALIASES,
        'bbx_seller_attribute': _BBX_SELLER_ATTRIBUTE_RAW_ALIASES,
        'variant_count': _VARIANT_COUNT_RAW_ALIASES,
        'has_main_image_video': _MAIN_IMAGE_VIDEO_RAW_ALIASES,
        'is_climate_pledge_friendly': _CLIMATE_PLEDGE_RAW_ALIASES,
        'has_brand_store': _BRAND_STORE_RAW_ALIASES,
        'seller_country_region': _SELLER_COUNTRY_REGION_RAW_ALIASES,
        **{dim_key: aliases for dim_key, aliases in _DIMENSION_ALIASES.items()},
    })

    rows: list[dict[str, Any]] = []
    invalid_price_count = 0
    invalid_fba_fee_count = 0
    seen_asins: set[str] = set()
    duplicate_asin_count = 0

    for row_idx, row in enumerate(worksheet.iter_rows(min_row=4, values_only=True), start=4):
        if _is_empty_row(list(row)):
            continue

        raw_row = {headers[i]: row[i] for i in range(len(headers)) if i < len(row)}

        asin = _normalize_asin(_extract_raw_value(raw_row, col_map['asin']))
        if not asin:
            continue

        if asin in seen_asins:
            duplicate_asin_count += 1
        seen_asins.add(asin)

        price_usd, price_is_valid = _to_decimal_or_none(_extract_raw_value(raw_row, col_map['price']))
        if price_is_valid is False:
            invalid_price_count += 1

        fba_fee_usd, fba_is_valid = _to_decimal_or_none(_extract_raw_value(raw_row, col_map['fba_fee']))
        if fba_is_valid is False:
            invalid_fba_fee_count += 1

        source_row_no = row_idx
        parent_asin = _normalize_asin(_extract_raw_value(raw_row, col_map['parent_asin']))
        product_name = _normalize_text(_extract_raw_value(raw_row, col_map['product_name']))
        brand = _normalize_text(_extract_raw_value(raw_row, col_map['brand']))
        seller = _normalize_text(_extract_raw_value(raw_row, col_map['seller']))
        monthly_sales = _to_int(_extract_raw_value(raw_row, col_map['monthly_sales']))
        monthly_revenue_usd, _ = _to_decimal_or_none(_extract_raw_value(raw_row, col_map['monthly_revenue']))
        rating_raw = _extract_raw_value(raw_row, col_map['rating'])
        rating = float(rating_raw) if rating_raw is not None else None
        review_count = _to_int(_extract_raw_value(raw_row, col_map['review_count']))
        launch_date = _to_date_or_none(_extract_raw_value(raw_row, col_map['launch_date']))
        listing_age_days = _to_int_or_none(_extract_raw_value(raw_row, col_map['listing_age_days']))
        fulfillment_method = _normalize_text(_extract_raw_value(raw_row, col_map['fulfillment_method']))
        variant_count = _to_int_or_none(_extract_raw_value(raw_row, col_map['variant_count']))
        has_main_image_video = _to_bool_or_none(_extract_raw_value(raw_row, col_map['has_main_image_video']))
        is_climate_pledge_friendly = _to_bool_or_none(_extract_raw_value(raw_row, col_map['is_climate_pledge_friendly']))
        has_brand_store = _to_bool_or_none(_extract_raw_value(raw_row, col_map['has_brand_store']))
        seller_country_region = _normalize_text(_extract_raw_value(raw_row, col_map['seller_country_region']))

        is_amazon = _is_amazon_seller(seller, _extract_raw_value(raw_row, col_map['bbx_seller_attribute']))
        is_new_90d = listing_age_days is not None and listing_age_days <= 90

        dimensions: dict[str, str] = {}
        for dim_key, aliases in _DIMENSION_ALIASES.items():
            value = _extract_raw_value(raw_row, col_map.get(dim_key, []))
            if value is not None:
                normalized = _normalize_text(value)
                if normalized:
                    dimensions[dim_key] = normalized

        rows.append({
            'source_row_no': source_row_no,
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
            'fulfillment_method': fulfillment_method,
            'fba_fee_usd': fba_fee_usd,
            'bbx_seller_attribute': _extract_raw_value(raw_row, col_map['bbx_seller_attribute']),
            'variant_count': variant_count,
            'has_main_image_video': has_main_image_video,
            'is_climate_pledge_friendly': is_climate_pledge_friendly,
            'has_brand_store': has_brand_store,
            'seller_country_region': seller_country_region,
            'is_amazon': is_amazon,
            'is_new_90d': is_new_90d,
            'extracted_dimensions': dimensions,
            'manual_dimensions': {},
            'effective_dimensions': dimensions.copy(),
        })

    return rows, invalid_price_count, invalid_fba_fee_count


def _parse_trend_sheet(worksheet: Any) -> tuple[list[dict[str, Any]], int, int]:
    """Parse trend detail sheet."""
    headers = _worksheet_headers(worksheet, header_row=2)
    col_map = _match_columns(headers, {
        'asin': ['ASIN', 'Asin'],
        'parent_asin': ['Parent ASIN', 'ParentAsin'],
        'year_month': ['Year-Month', '年月', 'Month', 'YearMonth'],
        'monthly_sales': ['月销量', 'Monthly Sales', 'MonthlySales', '销量'],
    })

    rows: list[dict[str, Any]] = []
    asins_without_trend: set[str] = set()
    seen_asin_month: set[tuple[str, str]] = set()
    duplicate_count = 0

    for row_idx, row in enumerate(worksheet.iter_rows(min_row=3, values_only=True), start=3):
        if _is_empty_row(list(row)):
            continue

        raw_row = {headers[i]: row[i] for i in range(len(headers)) if i < len(row)}

        asin = _normalize_asin(_extract_raw_value(raw_row, col_map['asin']))
        year_month = str(_extract_raw_value(raw_row, col_map['year_month']) or '').strip()
        monthly_sales = _to_int(_extract_raw_value(raw_row, col_map['monthly_sales']))

        if not asin or not year_month:
            if asin:
                asins_without_trend.add(asin)
            continue

        if (asin, year_month) in seen_asin_month:
            duplicate_count += 1
        else:
            seen_asin_month.add((asin, year_month))

        rows.append({
            'asin': asin,
            'parent_asin': _normalize_asin(_extract_raw_value(raw_row, col_map['parent_asin'])),
            'year_month': year_month,
            'monthly_sales': monthly_sales,
        })

    return rows, len(asins_without_trend), duplicate_count


# --- Helper Functions ---

def _worksheet_headers(worksheet: Any, *, header_row: int) -> list[str]:
    """Extract headers from worksheet."""
    headers = []
    for cell in worksheet[header_row]:
        value = cell.value
        if value is not None:
            headers.append(str(value).strip())
        else:
            headers.append('')
    return headers


def _match_columns(headers: list[str], aliases: dict[str, list[str]]) -> dict[str, int | None]:
    """Match column names to header indices."""
    result: dict[str, int | None] = {}
    for key, candidates in aliases.items():
        index = _find_header_index(headers, candidates)
        result[key] = index
    return result


def _find_header_index(headers: list[str], candidates: list[str]) -> int | None:
    """Find index of header matching any of the candidates."""
    normalized_candidates = {_normalize_header(c) for c in candidates}
    for i, header in enumerate(headers):
        if _normalize_header(header) in normalized_candidates:
            return i
    return None


def _normalize_header(value: Any) -> str:
    """Normalize header text."""
    return str(value).strip().lower()


def _normalize_marketplace(value: str | None) -> str:
    """Normalize marketplace name."""
    if not value:
        return ''
    normalized = str(value).strip().lower()
    mapping = {
        'us': 'US', 'usa': 'US', 'amazon.com': 'US',
        'uk': 'UK', 'gb': 'UK', 'amazon.co.uk': 'UK',
        'ca': 'CA', 'amazon.ca': 'CA',
        'de': 'DE', 'germany': 'DE', 'amazon.de': 'DE',
        'fr': 'FR', 'france': 'FR', 'amazon.fr': 'FR',
        'it': 'IT', 'italy': 'IT', 'amazon.it': 'IT',
        'es': 'ES', 'spain': 'ES', 'amazon.es': 'ES',
        'jp': 'JP', 'japan': 'JP', 'amazon.co.jp': 'JP',
    }
    return mapping.get(normalized, str(value).strip().upper())


def _normalize_category_keyword(value: str | None) -> str:
    """Normalize category keyword."""
    if not value:
        return ''
    return str(value).strip().lower()


def _normalize_name_zh(value: str | None) -> str:
    """Normalize Chinese category name."""
    if not value:
        return ''
    return str(value).strip()


def _normalize_text(value: Any) -> str | None:
    """Normalize text value."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).strip()
    return text if text else None


def _normalize_asin(value: Any) -> str | None:
    """Normalize ASIN."""
    if value is None:
        return None
    text = str(value).strip().upper()
    text = text.replace(' ', '')
    return text if text else None


def _to_decimal_or_none(value: Any) -> tuple[Decimal | None, bool]:
    """Convert value to Decimal, return (value, is_valid)."""
    if value is None:
        return None, True
    if isinstance(value, (int, float)):
        return Decimal(str(value)), True
    if isinstance(value, Decimal):
        return value, True
    text = str(value).strip()
    if not text:
        return None, True
    try:
        return Decimal(text.replace(',', '')), True
    except InvalidOperation:
        return None, False


def _to_int(value: Any) -> int:
    """Convert value to int."""
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return 0
    try:
        return int(float(text.replace(',', '')))
    except (ValueError, InvalidOperation):
        return 0


def _to_int_or_none(value: Any) -> int | None:
    """Convert value to int or None."""
    if value is None:
        return None
    result = _to_int(value)
    return result if result != 0 else None


def _to_date_or_none(value: Any) -> date | None:
    """Convert value to date."""
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value).strip()
    if not text:
        return None
    for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%d/%m/%Y', '%Y/%m/%d', '%Y%m%d'):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _to_bool_or_none(value: Any) -> bool | None:
    """Convert value to bool or None."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in ('true', 'yes', 'y', '1', '是', '有'):
        return True
    if text in ('false', 'no', 'n', '0', '否', '无'):
        return False
    return None


def _is_year_month(value: Any) -> bool:
    """Check if value is in YYYY-MM format."""
    if not value:
        return False
    text = str(value).strip()
    return bool(__import__('re').match(r'^\d{4}-\d{2}$', text))


def _shift_month(value: date, delta: int) -> date:
    """Shift date by delta months."""
    from datetime import timedelta
    total_days = delta * 30
    return value + timedelta(days=total_days)


def _is_empty_row(values: list[Any]) -> bool:
    """Check if row is empty."""
    return all(v is None or str(v).strip() == '' for v in values)


def _to_raw_row(payload: dict[str, Any]) -> dict[str, Any]:
    """Convert payload to raw row dict."""
    return payload.copy()


def _normalize_dimension_key(value: str | None) -> str:
    """Normalize dimension key."""
    if not value:
        return ''
    return str(value).strip().lower()


def _normalize_dimension_value(value: Any) -> str | None:
    """Normalize dimension value."""
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _normalize_dimension_map(payload: Any) -> dict[str, str]:
    """Normalize dimension map from various input formats."""
    import json
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return {str(k): str(v) if v is not None else '' for k, v in payload.items()}
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                return {str(k): str(v) if v is not None else '' for k, v in parsed.items()}
        except (json.JSONDecodeError, TypeError):
            pass
    return {}


def _extract_dimensions_from_raw_row(raw_row: Any) -> dict[str, str]:
    """Extract dimension values from raw row."""
    result: dict[str, str] = {}
    for dim_key, aliases in _DIMENSION_ALIASES.items():
        value = _extract_raw_value(raw_row, aliases)
        if value is not None:
            normalized = _normalize_text(value)
            if normalized:
                result[dim_key] = normalized
    return result


def _extract_raw_value(raw_row: Any, aliases: list[str]) -> Any:
    """Extract value from raw row using column aliases."""
    if not isinstance(raw_row, dict):
        return None
    normalized_aliases = {_normalize_header(alias) for alias in aliases}
    for key, value in raw_row.items():
        if _normalize_header(str(key)) in normalized_aliases:
            return value
    return None


def _is_invalid_numeric_from_raw(raw_row: Any, aliases: list[str], parsed_value: Any) -> bool:
    """Check if parsed numeric value is invalid."""
    if parsed_value is not None:
        return False
    raw = _extract_raw_value(raw_row, aliases)
    if raw is None:
        return False
    text = str(raw).strip()
    return bool(text) and text not in ('', 'n/a', 'N/A', 'null', 'NULL')


def _is_amazon_seller(seller: str | None, bbx_attr: Any) -> bool:
    """Check if seller is Amazon."""
    seller_text = (seller or '').strip().lower()
    bbx_text = (str(bbx_attr or '')).strip().lower()
    if '亚马逊自营' in str(bbx_attr or ''):
        return True
    return (
        ('amazon' in seller_text)
        or ('amazon' in bbx_text)
        or ('亚马逊' in (seller or ''))
        or ('亚马逊' in (bbx_attr or ''))
    )


# --- Version Management ---

def _next_version(db: Session, *, marketplace: str, category_keyword_en: str) -> int:
    """Get next version number for a dataset."""
    from sqlalchemy import func, select

    result = db.execute(
        select(func.max(CategoryResearchDataset.version))
        .where(
            CategoryResearchDataset.marketplace == marketplace,
            CategoryResearchDataset.category_keyword_en == category_keyword_en,
        )
    ).scalar()
    return (int(result) + 1) if result else 1


from datetime import datetime
