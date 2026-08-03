import csv
import uuid
from datetime import datetime, timezone
from io import BytesIO, StringIO
from pathlib import Path
from urllib.parse import quote

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
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_operator,
    protected,
)
from app.models.sku_info import SkuRecord
from app.models.project import Project
from app.schemas.sku_info import (
    BatchFnskuLabelDownloadRequest,
    BatchUpdateFactoryInfoRequest,
    BatchUpdateFactoryInfoResponse,
    FnskuLabelUploadResponse,
    ParseFactoryInfoRequest,
    ParseFactoryInfoResponse,
    SkuProductImageDeleteResponse,
    SkuProductImageUploadResponse,
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
    FnskuLabelsResponse,
    GetFnskuLabelsBySkusRequest,
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
from app.services.data.sku_info_batch import (
    batch_update_factory_info,
    get_sku_records_by_ids,
)
from app.services import project_service
from app.utils.country import get_country_label_cn
from app.utils.marketplace_url import build_marketplace_url

router = APIRouter(dependencies=[Depends(protected)])


def _content_disposition(filename: str) -> str:
    """构造 HTTP Content-Disposition 头，兼容非 ASCII 文件名（RFC 5987）。

    HTTP header value 必须 ASCII；含中文时直接 ``f'attachment; filename="{filename}"'``
    会被 Starlette 在 ``latin-1`` 编码下抛 UnicodeEncodeError。
    这里同时返回 ``filename=`` 兜底（ASCII 化文件名，老浏览器用）和
    ``filename*=UTF-8''<percent-encoded>``（RFC 5987，现代浏览器用）。
    """
    fallback = filename.encode("ascii", "replace").decode("ascii").replace("?", "_")
    encoded = quote(filename, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


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
        "sku_factory_info": row.sku_factory_info
        if hasattr(row, "sku_factory_info")
        else None,
        "sku_factory_info_updated_at": str(row.sku_factory_info_updated_at)
        if row.sku_factory_info_updated_at
        else None,
        "sku_factory_info_updated_by": str(row.sku_factory_info_updated_by)
        if row.sku_factory_info_updated_by
        else None,
        "fnsku_label_r2_key": getattr(row, "fnsku_label_r2_key", None),
        "fnsku_label_r2_url": getattr(row, "fnsku_label_r2_url", None),
        "product_image_r2_key": getattr(row, "product_image_r2_key", None),
        "product_image_r2_url": getattr(row, "product_image_r2_url", None),
        "product_image_thumbnail_r2_key": getattr(
            row, "product_image_thumbnail_r2_key", None
        ),
        "product_image_thumbnail_r2_url": getattr(
            row, "product_image_thumbnail_r2_url", None
        ),
        "product_image_uploaded_at": str(row.product_image_uploaded_at)
        if getattr(row, "product_image_uploaded_at", None)
        else None,
        "product_image_uploaded_by": getattr(row, "product_image_uploaded_by", None),
        "marketplace_url": build_marketplace_url(row.country, row.asin),
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
    db: Session = Depends(get_read_db_session),
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
        items=[SkuRecordItem(**_serialize_sku_record(row)) for row in rows],
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
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordUpsertResponse:
    row, action = upsert_sku_record(db, payload, payload.source_file)
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordItem:
    before_row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    row = move_sku_record_sort_order(db, sku_record_id, payload.direction)
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_read_db_session),
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
    # 统一命名规范：${项目}_${中文站点}-页面名-业务标识.csv
    # 与前端 frontend/app/dashboard/data-management/sku-info/page.tsx 的 handleExportCurrentFiltered 保持一致
    safe_project_name = (
        (project_name or "未选项目")
        .replace("\\", "-")
        .replace("/", "-")
        .replace(":", "-")
        .replace("*", "-")
        .replace("?", "-")
        .replace('"', "-")
        .replace("<", "-")
        .replace(">", "-")
        .replace("|", "-")
    )
    if not country or country.strip().lower() == "all":
        station_segment = "全部站点"
    else:
        station_segment = (
            get_country_label_cn(country)
            .replace("\\", "-")
            .replace("/", "-")
            .replace(":", "-")
            .replace("*", "-")
            .replace("?", "-")
            .replace('"', "-")
            .replace("<", "-")
            .replace(">", "-")
            .replace("|", "-")
        )
    tab_segment = "尺寸管理" if normalized_export_type == "dimension" else "成本管理"
    now = datetime.now()
    timestamp = now.strftime("%Y-%m-%d-%H-%M-%S")

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
            "单品长(inch)",
            "单品宽(inch)",
            "单品高(inch)",
            "单品重量(kg)",
            "单品重量(lb)",
            "外箱长(cm)",
            "外箱宽(cm)",
            "外箱高(cm)",
            "外箱长(inch)",
            "外箱宽(inch)",
            "外箱高(inch)",
            "外箱重量(kg)",
            "外箱重量(lb)",
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
                round(float(row.package_length_cm) / 2.54, 2),
                round(float(row.package_width_cm) / 2.54, 2),
                round(float(row.package_height_cm) / 2.54, 2),
                float(row.weight_kg),
                round(float(row.weight_kg) * 2.20462, 2),
                float(row.carton_length_cm),
                float(row.carton_width_cm),
                float(row.carton_height_cm),
                round(float(row.carton_length_cm) / 2.54, 2),
                round(float(row.carton_width_cm) / 2.54, 2),
                round(float(row.carton_height_cm) / 2.54, 2),
                float(row.carton_weight_kg),
                round(float(row.carton_weight_kg) * 2.20462, 2),
                int(row.units_per_carton),
            ]
            for row in rows
        ]
        filename = f"{safe_project_name}_{station_segment}-SKU信息-{tab_segment}批量修改模板-{timestamp}.csv"
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
        filename = f"{safe_project_name}_{station_segment}-SKU信息-{tab_segment}批量修改模板-{timestamp}.csv"

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
        headers={"Content-Disposition": _content_disposition(filename)},
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
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuRecordBulkUpsertResponse:
    items, source_file = read_sku_record_csv_file()
    rows, inserted, updated = bulk_upsert_sku_records(db, items, source_file)
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_read_db_session),
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_primary_db_session),
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
        updates=[
            {"id": sku_id, "sku_factory_info": payload.sku_factory_info}
            for sku_id in payload.sku_ids
        ],
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


# ---------------------------------------------------------------------------
# FNSKU Label PDF Upload / Download / Batch Download
# ---------------------------------------------------------------------------


@router.post(
    "/sku-info/{sku_record_id}/fnsku-label", response_model=FnskuLabelUploadResponse
)
def upload_fnsku_label(
    sku_record_id: int,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> FnskuLabelUploadResponse:
    """上传单个 SKU 的 FNSKU 标签 PDF。如已有旧标签则替换。上传时自动验证 PDF 中的 FNSKU。"""
    import uuid as _uuid
    import io

    from app.core.config import get_settings
    from app.services.r2_service import upload_bytes_to_r2, delete_file_from_r2
    from app.services.upload_service import _safe_project_folder_name
    from app.services.fnsku_label_verifier import verify_fnsku_label

    settings = get_settings()
    if not settings.r2_enabled:
        raise HTTPException(status_code=503, detail="R2 存储未配置")

    # 查找记录
    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="SKU 记录不存在")

    # 验证文件类型
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")

    # 读取内容并验证大小
    content = file.file.read()
    max_size = 20 * 1024 * 1024  # 20MB
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail="文件大小不能超过 20MB")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="文件为空")

    # FNSKU 验证：从 PDF 提取 FNSKU 并与数据库对比
    verification = verify_fnsku_label(content, row.fnsku)

    # 删除旧文件
    if row.fnsku_label_r2_key:
        try:
            delete_file_from_r2(settings, row.fnsku_label_r2_key)
        except Exception:
            pass  # 旧文件删除失败不阻塞上传

    # 生成 R2 key
    project_slug = _safe_project_folder_name(row.project_name)
    unique_id = _uuid.uuid4().hex
    safe_sku = row.sku.replace("/", "_").replace("\\", "_").replace(" ", "_")
    filename = f"{unique_id}_{safe_sku}.pdf"

    # 上传到 R2
    result = upload_bytes_to_r2(
        settings=settings,
        data=content,
        filename=filename,
        project_slug=project_slug,
        file_type="fnsku-labels",
        content_type="application/pdf",
    )

    # 更新数据库
    row.fnsku_label_r2_key = result["key"]
    row.fnsku_label_r2_url = result["url"]

    append_operation_audit_log(
        db,
        action="sku_info.upload_fnsku_label",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        after={
            "sku": row.sku,
            "fnsku_label_r2_key": result["key"],
            "file_size": len(content),
            "fnsku_verified": verification["verified"],
            "fnsku_found_in_pdf": verification["fnsku_found"],
        },
        request=request,
    )
    db.commit()

    return FnskuLabelUploadResponse(
        sku_record_id=sku_record_id,
        fnsku_label_r2_key=result["key"],
        fnsku_label_r2_url=result["url"],
        fnsku_verified=verification["verified"],
        fnsku_found_in_pdf=verification["fnsku_found"],
        fnsku_verification_message=verification["message"],
    )


@router.post(
    "/sku-info/{sku_record_id}/product-image",
    response_model=SkuProductImageUploadResponse,
)
def upload_product_image(
    sku_record_id: int,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuProductImageUploadResponse:
    """上传或替换指定 SKU 的产品图（自动生成 1920x1920 主图 + 320x320 缩略图）。"""
    from app.core.config import get_settings
    from app.services.r2_service import upload_bytes_to_r2, delete_file_from_r2
    from app.services.upload_service import _safe_project_folder_name

    settings = get_settings()
    if not settings.r2_enabled:
        raise HTTPException(status_code=503, detail="R2 存储未配置")

    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="SKU 记录不存在")

    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400, detail="仅支持 JPG / PNG / WebP / GIF 图片"
        )

    content = file.file.read()
    max_size = 10 * 1024 * 1024  # 10MB
    if len(content) > max_size:
        raise HTTPException(status_code=400, detail="文件大小不能超过 10MB")
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="文件为空")

    try:
        image = Image.open(BytesIO(content))
        image = ImageOps.exif_transpose(image)
        image.load()
    except UnidentifiedImageError:
        raise HTTPException(status_code=400, detail="图片内容无法识别") from None

    image = image.convert("RGB")
    image.thumbnail((1920, 1920))

    thumb_image = ImageOps.fit(
        image.copy(),
        (320, 320),
        method=Image.Resampling.LANCZOS,
        centering=(0.5, 0.5),
    )

    image_id = uuid.uuid4().hex
    main_name = f"{image_id}.webp"
    thumb_name = f"{image_id}_thumb.webp"

    main_buf = BytesIO()
    image.save(main_buf, format="WEBP", quality=82, method=6)
    main_bytes = main_buf.getvalue()

    thumb_buf = BytesIO()
    thumb_image.save(thumb_buf, format="WEBP", quality=72, method=6)
    thumb_bytes = thumb_buf.getvalue()

    if row.product_image_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_r2_key)
        except Exception:
            pass
    if row.product_image_thumbnail_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_thumbnail_r2_key)
        except Exception:
            pass

    project_slug = _safe_project_folder_name(row.project_name)
    main_result = upload_bytes_to_r2(
        settings=settings,
        data=main_bytes,
        filename=main_name,
        project_slug=project_slug,
        file_type="product-images",
        content_type="image/webp",
    )
    thumb_result = upload_bytes_to_r2(
        settings=settings,
        data=thumb_bytes,
        filename=thumb_name,
        project_slug=project_slug,
        file_type="product-thumbs",
        content_type="image/webp",
    )

    row.product_image_r2_key = main_result["key"]
    row.product_image_r2_url = main_result["url"]
    row.product_image_thumbnail_r2_key = thumb_result["key"]
    row.product_image_thumbnail_r2_url = thumb_result["url"]
    row.product_image_uploaded_at = datetime.now(timezone.utc)
    row.product_image_uploaded_by = operator

    append_operation_audit_log(
        db,
        action="sku_info.upload_product_image",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        after={
            "sku": row.sku,
            "product_image_r2_key": main_result["key"],
            "product_image_thumbnail_r2_key": thumb_result["key"],
            "file_size": len(content),
        },
        request=request,
    )
    db.commit()

    return SkuProductImageUploadResponse(
        sku_record_id=sku_record_id,
        product_image_r2_key=main_result["key"],
        product_image_r2_url=main_result["url"],
        product_image_thumbnail_r2_key=thumb_result["key"],
        product_image_thumbnail_r2_url=thumb_result["url"],
        uploaded_at=row.product_image_uploaded_at.isoformat(),
    )


@router.delete(
    "/sku-info/{sku_record_id}/product-image",
    response_model=SkuProductImageDeleteResponse,
)
def delete_product_image(
    sku_record_id: int,
    request: Request = None,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> SkuProductImageDeleteResponse:
    """删除指定 SKU 的产品图（清空 R2 对象 + DB 字段）。"""
    from app.core.config import get_settings
    from app.services.r2_service import delete_file_from_r2

    settings = get_settings()

    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="SKU 记录不存在")

    if row.product_image_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_r2_key)
        except Exception:
            pass
    if row.product_image_thumbnail_r2_key:
        try:
            delete_file_from_r2(settings, row.product_image_thumbnail_r2_key)
        except Exception:
            pass

    row.product_image_r2_key = None
    row.product_image_r2_url = None
    row.product_image_thumbnail_r2_key = None
    row.product_image_thumbnail_r2_url = None
    row.product_image_uploaded_at = None
    row.product_image_uploaded_by = None

    append_operation_audit_log(
        db,
        action="sku_info.delete_product_image",
        target_type="sku_info",
        target_id=sku_record_id,
        operator=operator,
        after={"sku": row.sku},
        request=request,
    )
    db.commit()

    return SkuProductImageDeleteResponse(
        sku_record_id=sku_record_id,
        deleted=True,
    )


@router.get("/sku-info/{sku_record_id}/fnsku-label/download")
def download_fnsku_label(
    sku_record_id: int,
    db: Session = Depends(get_read_db_session),
) -> Response:
    """下载单个 SKU 的 FNSKU 标签 PDF。"""
    import io

    from app.core.config import get_settings
    from app.services.r2_service import get_r2_client

    settings = get_settings()

    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="SKU 记录不存在")
    if not row.fnsku_label_r2_key:
        raise HTTPException(status_code=404, detail="该 SKU 暂无 FNSKU 标签")

    # 从 R2 下载到内存
    client = get_r2_client(settings)
    buffer = io.BytesIO()
    client.download_fileobj(settings.r2_bucket_name, row.fnsku_label_r2_key, buffer)
    buffer.seek(0)

    safe_sku = row.sku.replace("/", "_").replace("\\", "_")
    filename = f"{safe_sku}-fnsku-label.pdf"

    return Response(
        content=buffer.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@router.post("/sku-info/fnsku-labels/batch-download")
def batch_download_fnsku_labels(
    payload: BatchFnskuLabelDownloadRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> Response:
    """批量下载 FNSKU 标签，返回 ZIP 文件。"""
    import io
    import zipfile

    from app.core.config import get_settings
    from app.services.r2_service import get_r2_client

    settings = get_settings()

    # 查找所有匹配记录
    rows = (
        db.execute(select(SkuRecord).where(SkuRecord.id.in_(payload.sku_record_ids)))
        .scalars()
        .all()
    )

    if not rows:
        raise HTTPException(status_code=404, detail="未找到匹配的 SKU 记录")

    # 过滤有标签的记录
    labeled_rows = [r for r in rows if r.fnsku_label_r2_key]
    if not labeled_rows:
        raise HTTPException(status_code=400, detail="所选 SKU 均无 FNSKU 标签")

    skipped = len(rows) - len(labeled_rows)

    # 从 R2 下载并打包
    client = get_r2_client(settings)
    zip_buffer = io.BytesIO()
    seen_filenames: dict[str, int] = {}

    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for row in labeled_rows:
            safe_sku = row.sku.replace("/", "_").replace("\\", "_")
            entry_name = f"{safe_sku}-fnsku-label.pdf"

            # 处理重名：加项目名前缀
            if entry_name in seen_filenames:
                seen_filenames[entry_name] += 1
                safe_project = (
                    row.project_name.replace("/", "_")
                    .replace("\\", "_")
                    .replace(" ", "_")
                )
                entry_name = f"{safe_project}_{safe_sku}-fnsku-label.pdf"
            else:
                seen_filenames[entry_name] = 1

            pdf_buffer = io.BytesIO()
            try:
                client.download_fileobj(
                    settings.r2_bucket_name, row.fnsku_label_r2_key, pdf_buffer
                )
                pdf_buffer.seek(0)
                zf.writestr(entry_name, pdf_buffer.getvalue())
            except Exception:
                continue  # 跳过下载失败的文件

    zip_buffer.seek(0)

    append_operation_audit_log(
        db,
        action="sku_info.batch_download_fnsku_labels",
        target_type="sku_info",
        operator=operator,
        after={
            "requested": len(payload.sku_record_ids),
            "downloaded": len(labeled_rows),
            "skipped": skipped,
        },
        request=request,
    )
    db.commit()

    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="fnsku-labels.zip"',
            "X-Downloaded-Count": str(len(labeled_rows)),
            "X-Skipped-Count": str(skipped),
        },
    )


@router.post("/sku-info/fnsku-labels/by-skus")
def get_fnsku_labels_by_skus(
    payload: GetFnskuLabelsBySkusRequest,
    db: Session = Depends(get_primary_db_session),
) -> FnskuLabelsResponse:
    """通过项目名称和 SKU 列表获取 FNSKU 标签信息（包含 R2 key）。"""
    rows = (
        db.execute(
            select(SkuRecord).where(
                SkuRecord.project_name == payload.project_name,
                SkuRecord.sku.in_(payload.skus),
            )
        )
        .scalars()
        .all()
    )

    return FnskuLabelsResponse(
        sku_records=[
            {"id": row.id, "sku": row.sku, "fnsku_label_r2_key": row.fnsku_label_r2_key}
            for row in rows
        ]
    )
