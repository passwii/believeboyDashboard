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

from app.api.deps import get_db_session, get_request_is_admin, get_request_operator, protected
from app.models.sku_info import SkuRecord
from app.models.project import Project
from app.schemas.sku_info import (
    BatchUpdateFactoryInfoRequest,
    BatchUpdateFactoryInfoResponse,
    ParseFactoryInfoRequest,
    ParseFactoryInfoResponse,
    SkuRecordBulkCreate,
    SkuRecordBulkUpsertResponse,
    SkuRecordCreate,
    SkuRecordFirstLegRecalculateRequest,
    SkuRecordFirstLegRecalculateResponse,
    SkuRecordImportResponse,
    SkuRecordItem,
    SkuRecordSortMove,
    SkuRecordsPage,
    SkuRecordUpdate,
    SkuRecordUpsertResponse,
)
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)
from app.services.data.sku_info import (
    bulk_upsert_sku_records,
    delete_sku_record,
    import_sku_records,
    list_sku_records,
    list_sku_records_all,
    move_sku_record_sort_order,
    parse_sku_record_csv,
    read_sku_record_csv_file,
    recalculate_first_leg_costs,
    update_sku_record_by_id,
    upsert_sku_record,
)
from app.services.infra import invalidate_financial_series_cache
from app.services.shipment import sync_first_leg_cost_from_shipment_summary
from app.services.ai.factory_info_parser import parse_factory_info_sync
from app.services.data.sku_info_batch import batch_update_factory_info, get_sku_records_by_ids
from app.services import project_service

router = APIRouter(dependencies=[Depends(protected)])


def _serialize_sku_record(row: SkuRecord | SkuRecordItem) -> dict[str, object]:
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
        "sku_factory_info": row.sku_factory_info if hasattr(row, 'sku_factory_info') else None,
        "sku_factory_info_updated_at": str(row.sku_factory_info_updated_at) if row.sku_factory_info_updated_at else None,
        "sku_factory_info_updated_by": str(row.sku_factory_info_updated_by) if row.sku_factory_info_updated_by else None,
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


@router.get("/sku-info", response_model=SkuRecordsPage)
@router.get("/product-costs", response_model=SkuRecordsPage, include_in_schema=False)
def _list_sku_records_endpoint(
    request: Request,
    project_name: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    asin: str | None = Query(default=None),
    country: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10000, ge=1, le=100000),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> SkuRecordsPage:
    managed_project_ids = project_service.list_accessible_project_ids(
        db,
        operator=operator,
        is_admin=bool(is_admin),
    )

    rows, total, has_next = list_sku_records(
        db,
        project_name,
        sku,
        asin,
        country,
        is_active,
        page,
        page_size,
        include_total=include_total,
        managed_project_ids=managed_project_ids,
    )
    append_operation_view_log(
        db,
        action="sku_info.list",
        target_type="sku_info",
        operator=operator,
        after={
            "page": page,
            "page_size": page_size,
            "project_name": project_name,
            "sku": sku,
            "asin": asin,
            "country": country,
            "is_active": is_active,
            "count": len(rows),
            "total": total,
        },
        request=request,
    )
    db.commit()
    return SkuRecordsPage(
        items=[
            SkuRecordItem(
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
                sku_factory_info=row.sku_factory_info,
                sku_factory_info_updated_at=row.sku_factory_info_updated_at,
                sku_factory_info_updated_by=row.sku_factory_info_updated_by,
            )
            for row in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )


@router.post("/sku-info", response_model=SkuRecordUpsertResponse)
@router.post(
    "/product-costs", response_model=SkuRecordUpsertResponse, include_in_schema=False
)
def create_or_update_sku_record(
    payload: SkuRecordCreate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordUpsertResponse:
    row, action = upsert_sku_record(
        db, payload, payload.source_file
    )
    snapshot = _serialize_sku_record(row)
    append_operation_audit_log(
        db,
        action="sku_info.upsert",
        target_type="sku_info",
        target_id=row.id,
        operator=operator,
        after=snapshot,
        request=request,
    )
    _invalidate_financial_cache(db, payload.project_name)
    db.commit()
    return SkuRecordUpsertResponse(
        item=SkuRecordItem(**snapshot),
        action=action,
    )


@router.post("/sku-info/bulk", response_model=SkuRecordImportResponse)
@router.post(
    "/product-costs/bulk",
    response_model=SkuRecordImportResponse,
    include_in_schema=False,
)
def bulk_create_or_update_sku_records(
    payload: SkuRecordBulkCreate,
    request: Request,
    import_mode: str = Query(default="create"),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordImportResponse:
    rows, inserted, updated, skipped = import_sku_records(
        db,
        payload.items,
        import_mode=import_mode,
        source_file=payload.source_file,
    )
    project_names = {row.project_name for row in rows}
    append_operation_audit_log(
        db,
        action="sku_info.bulk_upsert",
        target_type="sku_info",
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
    return SkuRecordImportResponse(
        inserted=inserted, updated=updated, skipped=skipped, total=inserted + updated
    )


@router.patch("/sku-info/{sku_record_id}", response_model=SkuRecordItem)
@router.patch(
    "/product-costs/{sku_record_id}",
    response_model=SkuRecordItem,
    include_in_schema=False,
)
def update_sku_record(
    sku_record_id: int,
    payload: SkuRecordUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordItem:
    before_row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    row = update_sku_record_by_id(
        db, sku_record_id, payload, payload.source_file, operator=operator
    )
    after = _serialize_sku_record(row)
    append_operation_audit_log(
        db,
        action="sku_info.update",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        before=_serialize_sku_record(before_row) if before_row is not None else None,
        after=after,
        request=request,
    )
    _invalidate_financial_cache(db, row.project_name)
    db.commit()
    return SkuRecordItem(**after)


@router.delete("/sku-info/{sku_record_id}", status_code=status.HTTP_204_NO_CONTENT)
@router.delete(
    "/product-costs/{sku_record_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    include_in_schema=False,
)
def delete_sku_record_endpoint(
    sku_record_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> Response:
    before_row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not before_row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="SKU 成本记录不存在"
        )
    delete_sku_record(db, sku_record_id)
    append_operation_audit_log(
        db,
        action="sku_info.delete",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        before=_serialize_sku_record(before_row),
        request=request,
    )
    _invalidate_financial_cache(db, before_row.project_name)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sku-info/{sku_record_id}/move", response_model=SkuRecordItem)
@router.post(
    "/product-costs/{sku_record_id}/move",
    response_model=SkuRecordItem,
    include_in_schema=False,
)
def move_sku_record(
    sku_record_id: int,
    payload: SkuRecordSortMove,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordItem:
    before_row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    row = move_sku_record_sort_order(
        db, sku_record_id, payload.direction
    )
    after = _serialize_sku_record(row)
    append_operation_audit_log(
        db,
        action="sku_info.move_sort",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        before=_serialize_sku_record(before_row) if before_row is not None else None,
        after=after,
        request=request,
    )
    db.commit()
    return SkuRecordItem(**after)


@router.post("/sku-info/import-csv", response_model=SkuRecordBulkUpsertResponse)
@router.post(
    "/product-costs/import-csv",
    response_model=SkuRecordBulkUpsertResponse,
    include_in_schema=False,
)
def import_sku_records_from_csv(
    request: Request,
    import_mode: str = Query(default="create"),
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordImportResponse:
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

    items = parse_sku_record_csv(content)
    rows, inserted, updated, skipped = import_sku_records(
        db,
        items,
        import_mode=import_mode,
        source_file=file.filename,
    )
    project_names = {row.project_name for row in rows}
    append_operation_audit_log(
        db,
        action="sku_info.import_csv",
        target_type="sku_info",
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
    for project_name in project_names:
        _invalidate_financial_cache(db, project_name)
    db.commit()
    return SkuRecordImportResponse(
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
    is_admin: bool = Depends(get_request_is_admin),
) -> Response:
    managed_project_ids = project_service.list_accessible_project_ids(
        db,
        operator=operator,
        is_admin=bool(is_admin),
    )

    rows = list_sku_records_all(
        db,
        project_name=project_name,
        sku=sku,
        asin=asin,
        country=country,
        is_active=is_active,
        managed_project_ids=managed_project_ids,
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
        action="sku_info.export",
        target_type="sku_info",
        operator=operator,
        after={
            "project_name": project_name,
            "sku": sku,
            "asin": asin,
            "country": country,
            "is_active": is_active,
            "export_type": normalized_export_type,
            "count": len(rows),
            "filename": filename,
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
    "/sku-info/import-blf-basic-info", response_model=SkuRecordBulkUpsertResponse
)
@router.post(
    "/product-costs/import-blf-basic-info",
    response_model=SkuRecordBulkUpsertResponse,
    include_in_schema=False,
)
def import_default_blf_basic_info(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordBulkUpsertResponse:
    items, source_file = read_sku_record_csv_file()
    rows, inserted, updated = bulk_upsert_sku_records(
        db, items, source_file
    )
    project_names = {row.project_name for row in rows}
    append_operation_audit_log(
        db,
        action="sku_info.import_default_file",
        target_type="sku_info",
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
    return SkuRecordBulkUpsertResponse(
        inserted=inserted, updated=updated, total=inserted + updated
    )


@router.post(
    "/sku-info/recalculate-first-leg-costs",
    response_model=SkuRecordFirstLegRecalculateResponse,
)
def recalculate_first_leg_costs_endpoint(
    payload: SkuRecordFirstLegRecalculateRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordFirstLegRecalculateResponse:
    updated = recalculate_first_leg_costs(
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
        target_type="sku_info",
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
    _invalidate_financial_cache(db, payload.project_name)
    db.commit()
    return SkuRecordFirstLegRecalculateResponse(
        updated=updated, unit_price_per_kg_rmb=payload.unit_price_per_kg_rmb
    )


@router.get(
    "/sku-info/sync-first-leg-from-shipment",
)
def sync_first_leg_cost_from_shipment(
    project_id: int | None = Query(default=None),
    sku: str | None = Query(default=None),
    country: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> dict:
    """
    将历史出运汇总得到的历史加权物流单价（average_logistics_unit_price）
    同步到 product_costs.first_leg_cost_rmb。

    - 仅同步 is_active=True 的 product_cost 记录
    - 仅同步 average_logistics_unit_price > 0 的 shipment summary 记录
    - 与 product_costs.first_leg_cost_rmb 值相同的记录不会被更新

    可指定 project_id / sku / country 进行局部同步，不指定则同步全部。
    """
    updated = sync_first_leg_cost_from_shipment_summary(
        db,
        project_id=project_id,
        sku=sku,
        country=country,
    )
    if project_id is not None:
        invalidate_financial_series_cache(project_id)
    db.commit()
    return {"updated": updated}


@router.post(
    "/sku-info/batch-parse-factory-info",
    response_model=ParseFactoryInfoResponse,
)
def parse_factory_info_endpoint(
    payload: ParseFactoryInfoRequest,
    request: Request,
    db: Session = Depends(get_db_session),
) -> ParseFactoryInfoResponse:
    """
    使用 AI 将自然语言描述解析为产品属性 JSON。
    """
    from app.core.config import get_settings

    settings = get_settings()
    result = parse_factory_info_sync(payload.description, settings)

    if result is None:
        return ParseFactoryInfoResponse(result={}, raw="")

    import json
    return ParseFactoryInfoResponse(
        result=result,
        raw=json.dumps(result, ensure_ascii=False),
    )


@router.post(
    "/sku-info/batch-update-factory-info",
    response_model=BatchUpdateFactoryInfoResponse,
)
def batch_update_factory_info_endpoint(
    payload: BatchUpdateFactoryInfoRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> BatchUpdateFactoryInfoResponse:
    """
    批量更新 SKU 的产品属性。
    """
    # 验证 SKU 存在
    existing = get_sku_records_by_ids(db, payload.sku_ids)
    if len(existing) != len(payload.sku_ids):
        found_ids = {r.id for r in existing}
        missing = [id for id in payload.sku_ids if id not in found_ids]
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"部分 SKU 不存在: {missing}",
        )

    updated = batch_update_factory_info(
        db,
        updates=[{"id": sku_id, "sku_factory_info": payload.sku_factory_info} for sku_id in payload.sku_ids],
        operator=operator,
    )

    # 记录审计日志
    append_operation_audit_log(
        db,
        action="sku_info.batch_update_factory_info",
        target_type="sku_info",
        operator=operator,
        after={
            "sku_ids": payload.sku_ids,
            "sku_factory_info": payload.sku_factory_info,
            "updated": updated,
        },
        request=request,
    )
    db.commit()

    return BatchUpdateFactoryInfoResponse(
        updated=updated[0],
        sku_ids=payload.sku_ids,
    )
