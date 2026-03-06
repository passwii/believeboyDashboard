from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.category_research import (
    CategoryResearchManualDimensionUpsertRequest,
    CategoryResearchManualDimensionUpsertResponse,
    CategoryResearchBatchRecomputeResponse,
    CategoryResearchDatasetItem,
    CategoryResearchImportResponse,
    CategoryResearchMarketTrendPoint,
    CategoryResearchMarketTrendResponse,
    CategoryResearchOverviewResponse,
    CategoryResearchProductRow,
    CategoryResearchProductsResponse,
    CategoryResearchRecomputeResponse,
    CategoryResearchTrendPoint,
    CategoryResearchTrendResponse,
)
from app.services import category_research_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/category-research/datasets/import', response_model=CategoryResearchImportResponse)
def import_category_research_dataset(
    file: UploadFile = File(...),
    marketplace: str = Form(default='US'),
    category_keyword_en: str = Form(...),
    category_name_zh: str = Form(...),
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
) -> CategoryResearchImportResponse:
    try:
        dataset = category_research_service.import_category_research_dataset(
            db,
            settings=settings,
            marketplace=marketplace,
            category_keyword_en=category_keyword_en,
            category_name_zh=category_name_zh,
            upload_file=file,
            created_by=operator,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchImportResponse(
        dataset_id=dataset.id,
        version=dataset.version,
        is_current=dataset.is_current,
        row_count_products=dataset.row_count_products,
        row_count_trends=dataset.row_count_trends,
        quality_warnings=dataset.quality_warnings if isinstance(dataset.quality_warnings, dict) else {},
    )


@router.get('/category-research/datasets', response_model=list[CategoryResearchDatasetItem])
def list_category_research_datasets(
    marketplace: str | None = Query(default=None),
    category_keyword_en: str | None = Query(default=None),
    current_only: bool = Query(default=True),
    include_history: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> list[CategoryResearchDatasetItem]:
    effective_current_only = False if include_history else current_only
    rows = category_research_service.list_datasets(
        db,
        marketplace=marketplace,
        category_keyword_en=category_keyword_en,
        current_only=effective_current_only,
    )
    return [_to_dataset_item(item) for item in rows]


@router.get('/category-research/datasets/{dataset_id:int}', response_model=CategoryResearchOverviewResponse)
def get_category_research_dataset(
    dataset_id: int,
    price_band_standard: str | None = Query(default='default'),
    price_band_breaks: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
) -> CategoryResearchOverviewResponse:
    try:
        payload = category_research_service.get_dataset_overview(
            db,
            dataset_id,
            price_band_standard=price_band_standard,
            price_band_breaks=price_band_breaks,
        )
    except ValueError as exc:
        if str(exc) == 'Dataset not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchOverviewResponse(
        dataset=_to_dataset_item(payload['dataset']),
        kpis=payload['kpis'],
        brand_sales_share=payload['brand_sales_share'],
        listing_age_distribution=payload['listing_age_distribution'],
        fulfillment_distribution=payload['fulfillment_distribution'],
        fixed_price_bands=payload['fixed_price_bands'],
        quantile_price_bands=payload['quantile_price_bands'],
        price_stats=payload['price_stats'],
        price_sales_correlation=payload['price_sales_correlation'],
        fba_fee_distribution=payload['fba_fee_distribution'],
        price_sales_points=payload['price_sales_points'],
        available_asins=payload['available_asins'],
        advanced_metrics=payload['advanced_metrics'],
    )


@router.post('/category-research/datasets/{dataset_id:int}/recompute', response_model=CategoryResearchRecomputeResponse)
def recompute_category_research_dataset(
    dataset_id: int,
    db: Session = Depends(get_db_session),
) -> CategoryResearchRecomputeResponse:
    try:
        dataset = category_research_service.recompute_dataset_from_history(db, dataset_id)
    except ValueError as exc:
        if str(exc) == 'Dataset not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchRecomputeResponse(
        dataset_id=dataset.id,
        row_count_products=dataset.row_count_products,
        row_count_trends=dataset.row_count_trends,
        quality_warnings=dataset.quality_warnings if isinstance(dataset.quality_warnings, dict) else {},
    )


@router.post('/category-research/datasets/recompute', response_model=CategoryResearchBatchRecomputeResponse)
def recompute_category_research_datasets(
    marketplace: str | None = Query(default=None),
    category_keyword_en: str | None = Query(default=None),
    include_history: bool = Query(default=True),
    db: Session = Depends(get_db_session),
) -> CategoryResearchBatchRecomputeResponse:
    try:
        payload = category_research_service.recompute_datasets_from_history(
            db,
            marketplace=marketplace,
            category_keyword_en=category_keyword_en,
            include_history=include_history,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchBatchRecomputeResponse(
        matched=payload['matched'],
        recomputed=payload['recomputed'],
        dataset_ids=payload['dataset_ids'],
    )


@router.get('/category-research/datasets/{dataset_id:int}/products', response_model=CategoryResearchProductsResponse)
def list_category_research_products(
    dataset_id: int,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=100, ge=1, le=500),
    brand: str | None = Query(default=None),
    fulfillment_method: str | None = Query(default=None),
    price_band: str | None = Query(default=None),
    price_band_standard: str | None = Query(default='default'),
    price_band_breaks: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
) -> CategoryResearchProductsResponse:
    try:
        rows, has_next = category_research_service.list_dataset_products(
            db,
            dataset_id=dataset_id,
            page=page,
            page_size=page_size,
            brand=brand,
            fulfillment_method=fulfillment_method,
            price_band=price_band,
            price_band_standard=price_band_standard,
            price_band_breaks=price_band_breaks,
        )
    except ValueError as exc:
        if str(exc) == 'Dataset not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchProductsResponse(
        dataset_id=dataset_id,
        page=page,
        page_size=page_size,
        has_next=has_next,
        rows=[_to_product_row(item) for item in rows],
    )


@router.post(
    '/category-research/datasets/{dataset_id:int}/dimensions/manual-upsert',
    response_model=CategoryResearchManualDimensionUpsertResponse,
)
def upsert_category_research_manual_dimensions(
    dataset_id: int,
    payload: CategoryResearchManualDimensionUpsertRequest,
    db: Session = Depends(get_db_session),
) -> CategoryResearchManualDimensionUpsertResponse:
    try:
        result = category_research_service.upsert_manual_dimensions(
            db,
            dataset_id=dataset_id,
            items=[item.model_dump() for item in payload.items],
        )
    except ValueError as exc:
        if str(exc) == 'Dataset not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchManualDimensionUpsertResponse(
        dataset_id=int(result['dataset_id']),
        updated_count=int(result['updated_count']),
    )


@router.get('/category-research/datasets/{dataset_id:int}/trend', response_model=CategoryResearchTrendResponse)
def get_category_research_asin_trend(
    dataset_id: int,
    asin: str = Query(..., min_length=1),
    db: Session = Depends(get_db_session),
) -> CategoryResearchTrendResponse:
    try:
        rows = category_research_service.list_dataset_trend_points(db, dataset_id=dataset_id, asin=asin)
    except ValueError as exc:
        if str(exc) == 'Dataset not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    normalized = asin.strip().upper()
    return CategoryResearchTrendResponse(
        dataset_id=dataset_id,
        asin=normalized,
        points=[CategoryResearchTrendPoint(year_month=item.year_month, monthly_sales=item.monthly_sales) for item in rows],
    )


@router.get('/category-research/datasets/{dataset_id:int}/market-trend', response_model=CategoryResearchMarketTrendResponse)
def get_category_research_market_trend(
    dataset_id: int,
    months: int = Query(default=24, ge=1, le=60),
    db: Session = Depends(get_db_session),
) -> CategoryResearchMarketTrendResponse:
    try:
        points = category_research_service.get_dataset_market_trend_points(
            db,
            dataset_id=dataset_id,
            months=months,
        )
    except ValueError as exc:
        if str(exc) == 'Dataset not found':
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return CategoryResearchMarketTrendResponse(
        dataset_id=dataset_id,
        months=months,
        points=[CategoryResearchMarketTrendPoint(**item) for item in points],
    )


def _to_dataset_item(row) -> CategoryResearchDatasetItem:
    data_date = row.data_date
    return CategoryResearchDatasetItem(
        id=row.id,
        marketplace=row.marketplace,
        category_keyword_en=row.category_keyword_en,
        category_name_zh=row.category_name_zh,
        version=row.version,
        is_current=row.is_current,
        superseded_at=row.superseded_at,
        upload_file_id=row.upload_file_id,
        upload_file_path=row.upload_file_path,
        original_filename=row.original_filename,
        stored_filename=row.stored_filename,
        file_size_bytes=row.file_size_bytes,
        file_sha256=row.file_sha256,
        ingestion_status=row.ingestion_status,
        ingestion_error=row.ingestion_error,
        data_date=data_date,
        data_year=data_date.year if data_date else None,
        data_month=data_date.month if data_date else None,
        data_day=data_date.day if data_date else None,
        row_count_products=row.row_count_products,
        row_count_trends=row.row_count_trends,
        quality_warnings=row.quality_warnings if isinstance(row.quality_warnings, dict) else {},
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_product_row(row) -> CategoryResearchProductRow:
    extracted_dimensions = category_research_service.normalize_dimension_map(row.extracted_dimensions)
    manual_dimensions = category_research_service.normalize_dimension_map(row.manual_dimensions)
    effective_dimensions = category_research_service.effective_dimensions(row)
    return CategoryResearchProductRow(
        id=row.id,
        source_row_no=row.source_row_no,
        asin=row.asin,
        parent_asin=row.parent_asin,
        product_name=row.product_name,
        brand=row.brand,
        seller=row.seller,
        price_usd=float(row.price_usd) if row.price_usd is not None else None,
        monthly_sales=row.monthly_sales,
        monthly_revenue_usd=float(row.monthly_revenue_usd) if row.monthly_revenue_usd is not None else None,
        rating=float(row.rating) if row.rating is not None else None,
        review_count=row.review_count,
        launch_date=row.launch_date,
        listing_age_days=row.listing_age_days,
        fba_fee_usd=float(row.fba_fee_usd) if row.fba_fee_usd is not None else None,
        fulfillment_method=row.fulfillment_method,
        bbx_seller_attribute=row.bbx_seller_attribute,
        variant_count=row.variant_count,
        has_main_image_video=row.has_main_image_video,
        is_climate_pledge_friendly=row.is_climate_pledge_friendly,
        has_brand_store=row.has_brand_store,
        seller_country_region=row.seller_country_region,
        is_amazon=row.is_amazon,
        is_new_90d=row.is_new_90d,
        extracted_dimensions=extracted_dimensions,
        manual_dimensions=manual_dimensions,
        effective_dimensions=effective_dimensions,
    )
