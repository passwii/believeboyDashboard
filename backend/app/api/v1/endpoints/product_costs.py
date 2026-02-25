from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.core.config import get_settings
from app.schemas.product_cost import (
    ProductCostBulkCreate,
    ProductCostBulkUpsertResponse,
    ProductCostCreate,
    ProductCostItem,
    ProductCostsPage,
    ProductCostUpsertResponse,
)
from app.services import product_cost_cache_service, product_cost_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/product-costs', response_model=ProductCostsPage)
def list_product_costs(
    project_name: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> ProductCostsPage:
    settings = get_settings()
    cache_key = product_cost_cache_service.build_list_cache_key(
        project_name=project_name,
        sku=sku,
        asin=asin,
        page=page,
        page_size=page_size,
        include_total=include_total,
    )
    cached_payload = product_cost_cache_service.get_cached_list_response(settings, cache_key)
    if cached_payload:
        return ProductCostsPage(**cached_payload)

    rows, total, has_next = product_cost_service.list_product_costs(
        db,
        project_name,
        sku,
        asin,
        page,
        page_size,
        include_total,
    )
    items = [
        ProductCostItem(
            id=row.id,
            project_name=row.project_name,
            sku=row.sku,
            asin=row.asin,
            first_leg_unit_cost=float(row.first_leg_unit_cost),
            fob_unit_cost=float(row.fob_unit_cost),
            currency=row.currency,
        )
        for row in rows
    ]
    payload = ProductCostsPage(items=items, page=page, page_size=page_size, total=total, has_next=has_next)
    product_cost_cache_service.set_cached_list_response(settings, cache_key, payload.model_dump())
    return payload


@router.post('/product-costs', response_model=ProductCostUpsertResponse)
def create_or_update_product_cost(
    payload: ProductCostCreate,
    db: Session = Depends(get_db_session),
) -> ProductCostUpsertResponse:
    settings = get_settings()
    row, action = product_cost_service.upsert_product_cost(db, payload, payload.source_file)
    db.commit()
    product_cost_cache_service.invalidate_list_cache(settings)
    return ProductCostUpsertResponse(
        item=ProductCostItem(
            id=row.id,
            project_name=row.project_name,
            sku=row.sku,
            asin=row.asin,
            first_leg_unit_cost=float(row.first_leg_unit_cost),
            fob_unit_cost=float(row.fob_unit_cost),
            currency=row.currency,
        ),
        action=action,
    )


@router.post('/product-costs/bulk', response_model=ProductCostBulkUpsertResponse)
def bulk_create_or_update_product_costs(
    payload: ProductCostBulkCreate,
    db: Session = Depends(get_db_session),
) -> ProductCostBulkUpsertResponse:
    settings = get_settings()
    _, inserted, updated = product_cost_service.bulk_upsert_product_costs(db, payload.items, payload.source_file)
    db.commit()
    product_cost_cache_service.invalidate_list_cache(settings)
    return ProductCostBulkUpsertResponse(inserted=inserted, updated=updated, total=inserted + updated)


@router.post('/product-costs/import-csv', response_model=ProductCostBulkUpsertResponse)
def import_product_costs_from_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
) -> ProductCostBulkUpsertResponse:
    settings = get_settings()
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    ext = Path(file.filename).suffix.lower()
    if ext != '.csv':
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Only .csv file is supported')

    content = file.file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 文件为空')

    items = product_cost_service.parse_product_cost_csv(content)
    _, inserted, updated = product_cost_service.bulk_upsert_product_costs(db, items, file.filename)
    db.commit()
    product_cost_cache_service.invalidate_list_cache(settings)
    return ProductCostBulkUpsertResponse(inserted=inserted, updated=updated, total=inserted + updated)


@router.post('/product-costs/import-blf-basic-info', response_model=ProductCostBulkUpsertResponse)
def import_default_blf_basic_info(
    db: Session = Depends(get_db_session),
) -> ProductCostBulkUpsertResponse:
    settings = get_settings()
    items, source_file = product_cost_service.read_product_cost_csv_file()
    _, inserted, updated = product_cost_service.bulk_upsert_product_costs(db, items, source_file)
    db.commit()
    product_cost_cache_service.invalidate_list_cache(settings)
    return ProductCostBulkUpsertResponse(inserted=inserted, updated=updated, total=inserted + updated)
