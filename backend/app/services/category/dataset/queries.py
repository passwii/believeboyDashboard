"""Dataset query functions."""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.models import (
    CategoryResearchDataset,
    CategoryResearchProductDetail,
    CategoryResearchSalesTrend,
)
from app.schemas.system_management import UserRoleType


# --- List & Query ---

def list_datasets(
    db: Session,
    *,
    marketplace: str | None = None,
    category_keyword_en: str | None = None,
    current_only: bool = True,
    role_type: str | None = None,
    operator: str | None = None,
) -> list[CategoryResearchDataset]:
    """List category research datasets with optional filtering."""
    from app.services.category.dataset_parsers import _normalize_marketplace, _normalize_category_keyword

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


def get_dataset_or_none(db: Session, dataset_id: int) -> CategoryResearchDataset | None:
    """Get dataset by ID."""
    return db.get(CategoryResearchDataset, dataset_id)


def list_available_exports(
    db: Session,
    *,
    settings: Any,
    dataset_id: int,
) -> list[dict[str, Any]]:
    """List available export types for a dataset."""
    from app.services.category.export_utils import _export_is_available, _export_filename

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
    """List products in a dataset with pagination and filtering."""
    from app.services.category.product_detail import resolve_price_band_spec

    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')

    stmt: Select = select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)

    if brand and brand.strip():
        stmt = stmt.where(CategoryResearchProductDetail.brand == brand.strip())
    if fulfillment_method and fulfillment_method.strip():
        stmt = stmt.where(CategoryResearchProductDetail.fulfillment_method == fulfillment_method.strip())

    if price_band and price_band.strip():
        price_band_spec = resolve_price_band_spec(standard=price_band_standard, breaks_text=price_band_breaks)
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
    """List trend data points for a specific ASIN."""
    from app.services.category.dataset_parsers import _normalize_asin

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
    """Get aggregated market trend data points."""
    from app.services.category.sales_trend import aggregate_market_monthly_sales, shift_month, is_year_month

    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')
    if months < 1:
        raise ValueError('months must be >= 1')

    trend_rows = list(
        db.execute(
            select(CategoryResearchSalesTrend).where(CategoryResearchSalesTrend.dataset_id == dataset_id)
        ).scalars().all()
    )
    monthly_totals = aggregate_market_monthly_sales(trend_rows)
    totals_by_month: dict[date, int] = {}
    for year_month, sales in monthly_totals.items():
        if not is_year_month(year_month):
            continue
        month_date = date(int(year_month[:4]), int(year_month[5:7]), 1)
        totals_by_month[month_date] = int(sales)

    if not totals_by_month:
        return []

    end_month = max(totals_by_month.keys())
    start_month = shift_month(end_month, -(months - 1))

    points: list[dict[str, Any]] = []
    current = start_month
    while current <= end_month:
        points.append(
            {
                'year_month': f'{current.year:04d}-{current.month:02d}',
                'monthly_sales': int(totals_by_month.get(current, 0)),
            }
        )
        current = shift_month(current, 1)
    return points


# --- Export Payload ---

def build_export_payload(
    db: Session,
    *,
    settings: Any,
    dataset_id: int,
    export_key: str,
    price_band_standard: str | None = None,
    price_band_breaks: str | None = None,
):
    """Build export payload for various export types."""
    from app.services.category.export import CategoryResearchExportPayload
    from app.services.category.export_utils import (
        _resolve_dataset_raw_file_path,
        _export_filename,
        _build_analysis_workbook_bytes,
        _build_summary_pdf_bytes,
        _build_product_csv_bytes,
        _build_trend_csv_bytes,
        _build_export_bundle_zip_bytes,
        _list_all_dataset_products,
        _list_all_dataset_trends,
    )
    from app.services.category.dataset.overview import get_dataset_overview

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


# --- Export Items Configuration ---

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