from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.schemas.product_cost import (
    ProductCostBulkCreate,
    ProductCostBulkUpsertResponse,
    ProductCostCreate,
    ProductCostItem,
    ProductCostSortMove,
    ProductCostsPage,
    ProductCostUpdate,
    ProductCostUpsertResponse,
)
from app.services import product_cost_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/product-costs', response_model=ProductCostsPage)
def list_product_costs(
    project_name: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> ProductCostsPage:
    rows, total, has_next = product_cost_service.list_product_costs(
        db,
        project_name,
        sku,
        asin,
        is_active,
        page,
        page_size,
        include_total=include_total,
    )
    return ProductCostsPage(
        items=[
            ProductCostItem(
                id=row.id,
                project_name=row.project_name,
                sku=row.sku,
                asin=row.asin,
                first_leg_unit_cost=float(row.first_leg_unit_cost),
                fob_unit_cost=float(row.fob_unit_cost),
                currency=row.currency,
                sort_order=int(row.sort_order),
                is_active=bool(row.is_active),
            )
            for row in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )


@router.post('/product-costs', response_model=ProductCostUpsertResponse)
def create_or_update_product_cost(
    payload: ProductCostCreate,
    db: Session = Depends(get_db_session),
) -> ProductCostUpsertResponse:
    row, action = product_cost_service.upsert_product_cost(db, payload, payload.source_file)
    db.commit()
    return ProductCostUpsertResponse(
        item=ProductCostItem(
            id=row.id,
            project_name=row.project_name,
            sku=row.sku,
            asin=row.asin,
            first_leg_unit_cost=float(row.first_leg_unit_cost),
            fob_unit_cost=float(row.fob_unit_cost),
            currency=row.currency,
            sort_order=int(row.sort_order),
            is_active=bool(row.is_active),
        ),
        action=action,
    )


@router.post('/product-costs/bulk', response_model=ProductCostBulkUpsertResponse)
def bulk_create_or_update_product_costs(
    payload: ProductCostBulkCreate,
    db: Session = Depends(get_db_session),
) -> ProductCostBulkUpsertResponse:
    _, inserted, updated = product_cost_service.bulk_upsert_product_costs(db, payload.items, payload.source_file)
    db.commit()
    return ProductCostBulkUpsertResponse(inserted=inserted, updated=updated, total=inserted + updated)


@router.patch('/product-costs/{product_cost_id}', response_model=ProductCostItem)
def update_product_cost(
    product_cost_id: int,
    payload: ProductCostUpdate,
    db: Session = Depends(get_db_session),
) -> ProductCostItem:
    row = product_cost_service.update_product_cost_by_id(db, product_cost_id, payload, payload.source_file)
    db.commit()
    return ProductCostItem(
        id=row.id,
        project_name=row.project_name,
        sku=row.sku,
        asin=row.asin,
        first_leg_unit_cost=float(row.first_leg_unit_cost),
        fob_unit_cost=float(row.fob_unit_cost),
        currency=row.currency,
        sort_order=int(row.sort_order),
        is_active=bool(row.is_active),
    )


@router.post('/product-costs/{product_cost_id}/move', response_model=ProductCostItem)
def move_product_cost(
    product_cost_id: int,
    payload: ProductCostSortMove,
    db: Session = Depends(get_db_session),
) -> ProductCostItem:
    row = product_cost_service.move_product_cost_sort_order(db, product_cost_id, payload.direction)
    db.commit()
    return ProductCostItem(
        id=row.id,
        project_name=row.project_name,
        sku=row.sku,
        asin=row.asin,
        first_leg_unit_cost=float(row.first_leg_unit_cost),
        fob_unit_cost=float(row.fob_unit_cost),
        currency=row.currency,
        sort_order=int(row.sort_order),
        is_active=bool(row.is_active),
    )


@router.post('/product-costs/import-csv', response_model=ProductCostBulkUpsertResponse)
def import_product_costs_from_csv(
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
) -> ProductCostBulkUpsertResponse:
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
    return ProductCostBulkUpsertResponse(inserted=inserted, updated=updated, total=inserted + updated)


@router.post('/product-costs/import-blf-basic-info', response_model=ProductCostBulkUpsertResponse)
def import_default_blf_basic_info(
    db: Session = Depends(get_db_session),
) -> ProductCostBulkUpsertResponse:
    items, source_file = product_cost_service.read_product_cost_csv_file()
    _, inserted, updated = product_cost_service.bulk_upsert_product_costs(db, items, source_file)
    db.commit()
    return ProductCostBulkUpsertResponse(inserted=inserted, updated=updated, total=inserted + updated)
