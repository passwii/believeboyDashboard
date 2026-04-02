import csv
from io import StringIO
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.models.product_cost import ProductCost
from app.models.project import Project
from app.schemas.product_cost import (
    ProductCostBulkCreate,
    ProductCostBulkUpsertResponse,
    ProductCostCreate,
    ProductCostFirstLegRecalculateRequest,
    ProductCostFirstLegRecalculateResponse,
    ProductCostImportResponse,
    ProductCostItem,
    ProductCostSortMove,
    ProductCostsPage,
    ProductCostUpdate,
    ProductCostUpsertResponse,
)
from app.services.audit_log_service import append_operation_audit_log, append_operation_view_log
from app.services import product_cost_service
from app.services.redis_service import invalidate_financial_series_cache

router = APIRouter(dependencies=[Depends(protected)])


def _serialize_product_cost(row: ProductCost | ProductCostItem) -> dict[str, object]:
    return {
        "id": int(row.id),
        "project_name": str(row.project_name),
        "sku": str(row.sku),
        "asin": str(row.asin),
        "fnsku": str(row.fnsku) if row.fnsku else None,
        "product_name": str(row.product_name) if row.product_name else None,
        "fob_unit_cost": float(row.fob_unit_cost),
        "first_leg_cost_rmb": float(row.first_leg_cost_rmb),
        "package_length_cm": float(row.package_length_cm),
        "package_width_cm": float(row.package_width_cm),
        "package_height_cm": float(row.package_height_cm),
        "weight_kg": float(row.weight_kg),
        "carton_length_cm": float(row.carton_length_cm),
        "carton_width_cm": float(row.carton_width_cm),
        "carton_height_cm": float(row.carton_height_cm),
        "carton_weight_kg": float(row.carton_weight_kg),
        "units_per_carton": int(row.units_per_carton),
        "currency": str(row.currency),
        "country": str(row.country),
        "sort_order": int(row.sort_order),
        "is_active": bool(row.is_active),
    }


def _get_project_id_by_name(db: Session, project_name: str) -> int | None:
    """Query project id by project_name. Returns None if not found."""
    row = (
        db.execute(select(Project.id).where(Project.project_name == project_name))
        .scalars()
        .first()
    )
    return int(row) if row is not None else None


def _invalidate_financial_cache(db: Session, project_name: str) -> None:
    """Invalidate monthly financial series cache for a project."""
    project_id = _get_project_id_by_name(db, project_name)
    if project_id is not None:
        invalidate_financial_series_cache(project_id)


@router.get("/sku-info", response_model=ProductCostsPage)
@router.get("/product-costs", response_model=ProductCostsPage, include_in_schema=False)
def list_product_costs(
    request: Request,
    project_name: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    country: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostsPage:
    rows, total, has_next = product_cost_service.list_product_costs(
        db,
        project_name,
        sku,
        asin,
        country,
        is_active,
        page,
        page_size,
        include_total=include_total,
    )
    append_operation_view_log(
        db,
        action='sku_info.list',
        target_type='product_cost',
        operator=operator,
        after={
            'page': page,
            'page_size': page_size,
            'project_name': project_name,
            'sku': sku,
            'asin': asin,
            'country': country,
            'is_active': is_active,
            'count': len(rows),
            'total': total,
        },
        request=request,
    )
    db.commit()
    return ProductCostsPage(
        items=[
            ProductCostItem(
                id=row.id,
                project_name=row.project_name,
                sku=row.sku,
                asin=row.asin,
                fnsku=row.fnsku,
                product_name=row.product_name,
                fob_unit_cost=float(row.fob_unit_cost),
                first_leg_cost_rmb=float(row.first_leg_cost_rmb),
                package_length_cm=float(row.package_length_cm),
                package_width_cm=float(row.package_width_cm),
                package_height_cm=float(row.package_height_cm),
                weight_kg=float(row.weight_kg),
                carton_length_cm=float(row.carton_length_cm),
                carton_width_cm=float(row.carton_width_cm),
                carton_height_cm=float(row.carton_height_cm),
                carton_weight_kg=float(row.carton_weight_kg),
                units_per_carton=int(row.units_per_carton),
                currency=row.currency,
                country=row.country,
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


@router.post("/sku-info", response_model=ProductCostUpsertResponse)
@router.post(
    "/product-costs", response_model=ProductCostUpsertResponse, include_in_schema=False
)
def create_or_update_product_cost(
    payload: ProductCostCreate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostUpsertResponse:
    row, action = product_cost_service.upsert_product_cost(
        db, payload, payload.source_file
    )
    snapshot = _serialize_product_cost(row)
    append_operation_audit_log(
        db,
        action="sku_info.upsert",
        target_type="product_cost",
        target_id=row.id,
        operator=operator,
        after=snapshot,
        request=request,
    )
    _invalidate_financial_cache(db, payload.project_name)
    db.commit()
    return ProductCostUpsertResponse(
        item=ProductCostItem(**snapshot),
        action=action,
    )


@router.post("/sku-info/bulk", response_model=ProductCostImportResponse)
@router.post(
    "/product-costs/bulk",
    response_model=ProductCostImportResponse,
    include_in_schema=False,
)
def bulk_create_or_update_product_costs(
    payload: ProductCostBulkCreate,
    request: Request,
    import_mode: str = Query(default="create"),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostImportResponse:
    rows, inserted, updated, skipped = product_cost_service.import_product_costs(
        db,
        payload.items,
        import_mode=import_mode,
        source_file=payload.source_file,
    )
    project_names = {row.project_name for row in rows}
    append_operation_audit_log(
        db,
        action="sku_info.bulk_upsert",
        target_type="product_cost",
        operator=operator,
        after={
            "import_mode": import_mode,
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "total": inserted + updated,
        },
        request=request,
    )
    for project_name in project_names:
        _invalidate_financial_cache(db, project_name)
    db.commit()
    return ProductCostImportResponse(
        inserted=inserted, updated=updated, skipped=skipped, total=inserted + updated
    )


@router.patch("/sku-info/{product_cost_id}", response_model=ProductCostItem)
@router.patch(
    "/product-costs/{product_cost_id}",
    response_model=ProductCostItem,
    include_in_schema=False,
)
def update_product_cost(
    product_cost_id: int,
    payload: ProductCostUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostItem:
    before_row = (
        db.execute(select(ProductCost).where(ProductCost.id == product_cost_id))
        .scalars()
        .first()
    )
    row = product_cost_service.update_product_cost_by_id(
        db, product_cost_id, payload, payload.source_file
    )
    after = _serialize_product_cost(row)
    append_operation_audit_log(
        db,
        action="sku_info.update",
        target_type="product_cost",
        target_id=product_cost_id,
        operator=operator,
        before=_serialize_product_cost(before_row) if before_row is not None else None,
        after=after,
        request=request,
    )
    _invalidate_financial_cache(db, row.project_name)
    db.commit()
    return ProductCostItem(**after)


@router.post("/sku-info/{product_cost_id}/move", response_model=ProductCostItem)
@router.post(
    "/product-costs/{product_cost_id}/move",
    response_model=ProductCostItem,
    include_in_schema=False,
)
def move_product_cost(
    product_cost_id: int,
    payload: ProductCostSortMove,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostItem:
    before_row = (
        db.execute(select(ProductCost).where(ProductCost.id == product_cost_id))
        .scalars()
        .first()
    )
    row = product_cost_service.move_product_cost_sort_order(
        db, product_cost_id, payload.direction
    )
    after = _serialize_product_cost(row)
    append_operation_audit_log(
        db,
        action="sku_info.move_sort",
        target_type="product_cost",
        target_id=product_cost_id,
        operator=operator,
        before=_serialize_product_cost(before_row) if before_row is not None else None,
        after=after,
        request=request,
    )
    db.commit()
    return ProductCostItem(**after)


@router.post("/sku-info/import-csv", response_model=ProductCostBulkUpsertResponse)
@router.post(
    "/product-costs/import-csv",
    response_model=ProductCostBulkUpsertResponse,
    include_in_schema=False,
)
def import_product_costs_from_csv(
    request: Request,
    import_mode: str = Query(default="create"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostImportResponse:
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )

    ext = Path(file.filename).suffix.lower()
    if ext != ".csv":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .csv file is supported",
        )

    content = file.file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 文件为空"
        )

    items = product_cost_service.parse_product_cost_csv(content)
    _, inserted, updated, skipped = product_cost_service.import_product_costs(
        db,
        items,
        import_mode=import_mode,
        source_file=file.filename,
    )
    append_operation_audit_log(
        db,
        action="sku_info.import_csv",
        target_type="product_cost",
        operator=operator,
        after={
            "filename": file.filename,
            "import_mode": import_mode,
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "total": inserted + updated,
        },
        request=request,
    )
    db.commit()
    return ProductCostImportResponse(
        inserted=inserted, updated=updated, skipped=skipped, total=inserted + updated
    )


@router.get("/sku-info/export")
def export_product_costs_csv(
    request: Request,
    project_name: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    country: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    export_type: str = Query(default="update"),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> Response:
    rows = product_cost_service.list_product_costs_all(
        db,
        project_name=project_name,
        sku=sku,
        asin=asin,
        country=country,
        is_active=is_active,
    )

    normalized_export_type = export_type.strip().lower()
    if normalized_export_type == "dimension":
        headers = [
            "project_name",
            "SKU",
            "ASIN(可留空)",
            "FNSKU(可留空)",
            "品名(可留空)",
            "国家",
            "单品长(cm)",
            "单品宽(cm)",
            "单品高(cm)",
            "单品重量(kg)",
            "外箱长(cm)",
            "外箱宽(cm)",
            "外箱高(cm)",
            "外箱重量(kg)",
            "装箱数量",
        ]
        csv_rows = [
            [
                row.project_name,
                row.sku,
                row.asin or "",
                row.fnsku or "",
                row.product_name or "",
                row.country,
                float(row.package_length_cm),
                float(row.package_width_cm),
                float(row.package_height_cm),
                float(row.weight_kg),
                float(row.carton_length_cm),
                float(row.carton_width_cm),
                float(row.carton_height_cm),
                float(row.carton_weight_kg),
                int(row.units_per_carton),
            ]
            for row in rows
        ]
        filename = "sku-info-dimension-update-export.csv"
    else:
        headers = [
            "project_name",
            "SKU",
            "ASIN(可留空)",
            "FNSKU(可留空)",
            "品名(可留空)",
            "FOB单价(RMB)",
            "国家",
        ]
        csv_rows = [
            [
                row.project_name,
                row.sku,
                row.asin or "",
                row.fnsku or "",
                row.product_name or "",
                float(row.fob_unit_cost),
                row.country,
            ]
            for row in rows
        ]
        filename = "sku-info-cost-update-export.csv"

    append_operation_audit_log(
        db,
        action='sku_info.export',
        target_type='product_cost',
        operator=operator,
        after={
            'project_name': project_name,
            'sku': sku,
            'asin': asin,
            'country': country,
            'is_active': is_active,
            'export_type': normalized_export_type,
            'count': len(rows),
            'filename': filename,
        },
        request=request,
    )
    db.commit()

    stream = StringIO()
    writer = csv.writer(stream)
    writer.writerow(headers)
    writer.writerows(csv_rows)
    content = "\ufeff" + stream.getvalue()
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/sku-info/import-blf-basic-info", response_model=ProductCostBulkUpsertResponse
)
@router.post(
    "/product-costs/import-blf-basic-info",
    response_model=ProductCostBulkUpsertResponse,
    include_in_schema=False,
)
def import_default_blf_basic_info(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostBulkUpsertResponse:
    items, source_file = product_cost_service.read_product_cost_csv_file()
    rows, inserted, updated = product_cost_service.bulk_upsert_product_costs(
        db, items, source_file
    )
    project_names = {row.project_name for row in rows}
    append_operation_audit_log(
        db,
        action="sku_info.import_default_file",
        target_type="product_cost",
        operator=operator,
        after={
            "filename": source_file,
            "inserted": inserted,
            "updated": updated,
            "total": inserted + updated,
        },
        request=request,
    )
    for project_name in project_names:
        _invalidate_financial_cache(db, project_name)
    db.commit()
    return ProductCostBulkUpsertResponse(
        inserted=inserted, updated=updated, total=inserted + updated
    )


@router.post(
    "/sku-info/recalculate-first-leg-costs",
    response_model=ProductCostFirstLegRecalculateResponse,
)
def recalculate_first_leg_costs(
    payload: ProductCostFirstLegRecalculateRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductCostFirstLegRecalculateResponse:
    updated = product_cost_service.recalculate_first_leg_costs(
        db,
        project_name=payload.project_name,
        unit_price_per_kg_rmb=payload.unit_price_per_kg_rmb,
        sku=payload.sku,
        asin=payload.asin,
        country=payload.country,
        is_active=payload.is_active,
    )
    append_operation_audit_log(
        db,
        action="sku_info.recalculate_first_leg_costs",
        target_type="product_cost",
        operator=operator,
        after={
            "project_name": payload.project_name,
            "unit_price_per_kg_rmb": payload.unit_price_per_kg_rmb,
            "sku": payload.sku,
            "asin": payload.asin,
            "country": payload.country,
            "is_active": payload.is_active,
            "updated": updated,
        },
        request=request,
    )
    db.commit()
    return ProductCostFirstLegRecalculateResponse(
        updated=updated, unit_price_per_kg_rmb=payload.unit_price_per_kg_rmb
    )
