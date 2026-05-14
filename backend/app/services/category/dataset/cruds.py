"""Dataset CRUD operations and import functions."""

from __future__ import annotations

import json
from typing import Any
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import Select, select, update as sa_update, insert
from sqlalchemy.orm import Session

from app.models import (
    CategoryResearchDataset,
    CategoryResearchProductDetail,
    CategoryResearchSalesTrend,
)
from app.services.upload_service import resolve_upload_file_path, save_upload_file


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
_DIMENSION_LABELS: dict[str, str] = {
    'blade_material': 'Blade Material',
    'product_material': 'Material',
    'color': 'Color',
    'size': 'Size',
}


# --- Import & Recompute ---

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
    """Import a new category research dataset from uploaded Excel file."""
    from app.services.category.dataset_parsers import (
        _parse_workbook,
        _next_version,
        _normalize_marketplace,
        _normalize_category_keyword,
        _normalize_name_zh,
    )
    from app.services.category.export_utils import _file_sha256

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


def recompute_dataset_from_history(db: Session, dataset_id: int) -> CategoryResearchDataset:
    """Recompute metrics for a single dataset."""
    from app.services.category.export_utils import _recompute_dataset_fields

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
    """Batch recompute metrics for multiple datasets."""
    from app.services.category.export_utils import _recompute_dataset_fields
    from app.services.category.dataset_parsers import _normalize_marketplace, _normalize_category_keyword

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