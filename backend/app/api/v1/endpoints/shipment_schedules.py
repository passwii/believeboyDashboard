from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Header,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.shipment_schedule import (
    ShipmentCostCalculateRequest,
    ShipmentFbaBoxDetailItem,
    ShipmentFbaBoxDetailResponse,
    ShipmentItemsImportResponse,
    ShipmentScheduleCostSummary,
    ShipmentScheduleCreate,
    ShipmentScheduleDetail,
    ShipmentSkuSummaryItem,
    ShipmentSkuSummaryResponse,
    ShipmentSchedulesImportResponse,
    ShipmentScheduleListResponse,
    ShipmentScheduleUpdate,
)
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)
from app.services import project_service
from app.services import shipment as shipment_schedule_service
from app.services import infra as redis_service
from app.services.shipment.serialization import (
    serialize_schedule_list_item,
    get_shipment_schedule_detail_payload,
)
from app.services.shipment.utils import date_text

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/shipment-schedules", response_model=ShipmentScheduleListResponse)
def list_shipment_schedules(
    request: Request,
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    shipment_status: str | None = Query(default=None),
    shipping_method: str | None = Query(default=None),
    shipment_no: list[str] | None = Query(default=None),
    created_date_from: str | None = Query(default=None),
    created_date_to: str | None = Query(default=None),
    etd_from: str | None = Query(default=None),
    etd_to: str | None = Query(default=None),
    eta_from: str | None = Query(default=None),
    eta_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentScheduleListResponse:
    cached = redis_service.get_shipment_schedule_list_cache(
        project_id=project_id,
        country=country,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
        etd_from=etd_from,
        etd_to=etd_to,
        eta_from=eta_from,
        eta_to=eta_to,
        page=page,
        page_size=page_size,
        include_total=include_total,
    )
    if cached is not None:
        append_operation_view_log(
            db,
            action="shipment_schedules.list",
            target_type="shipment_schedule",
            operator=operator,
            after={
                "project_id": project_id,
                "country": country,
                "shipment_status": shipment_status,
                "shipping_method": shipping_method,
                "shipment_no": shipment_no,
                "page": page,
                "page_size": page_size,
                "count": len(cached.get("items", [])),
                "total": cached.get("total"),
                "source": "cache",
            },
            request=request,
        )
        db.commit()
        return ShipmentScheduleListResponse(**cached)

    if project_id is not None:
        project_service.ensure_project_access(
            db,
            project_id,
            operator=operator,
            is_admin=bool(is_admin),
        )
    accessible_project_ids = project_service.list_accessible_project_ids(
        db,
        operator=operator,
        is_admin=bool(is_admin),
    )
    rows, total, has_next = shipment_schedule_service.list_shipment_schedules(
        db,
        project_id=project_id,
        project_ids=accessible_project_ids,
        country=country,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_no=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
        etd_from=etd_from,
        etd_to=etd_to,
        eta_from=eta_from,
        eta_to=eta_to,
        page=page,
        page_size=page_size,
        include_total=include_total,
    )
    response = ShipmentScheduleListResponse(
        items=[
            serialize_schedule_list_item(row, sku_count, total_quantity)
            for row, sku_count, total_quantity in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )
    redis_service.set_shipment_schedule_list_cache(
        project_id=project_id,
        country=country,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
        etd_from=etd_from,
        etd_to=etd_to,
        eta_from=eta_from,
        eta_to=eta_to,
        page=page,
        page_size=page_size,
        include_total=include_total,
        data=response.model_dump(),
    )
    append_operation_view_log(
        db,
        action="shipment_schedules.list",
        target_type="shipment_schedule",
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "shipment_status": shipment_status,
            "shipping_method": shipping_method,
            "shipment_no": shipment_no,
            "page": page,
            "page_size": page_size,
            "count": len(rows),
            "total": total,
            "source": "database",
        },
        request=request,
    )
    db.commit()
    return response


@router.get(
    "/shipment-schedules/cost-summary", response_model=ShipmentScheduleCostSummary
)
def summarize_shipment_schedule_costs(
    request: Request,
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    shipment_status: str | None = Query(default=None),
    shipping_method: str | None = Query(default=None),
    shipment_no: list[str] | None = Query(default=None),
    created_date_from: str | None = Query(default=None),
    created_date_to: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentScheduleCostSummary:
    cached = redis_service.get_shipment_schedule_cost_summary_cache(
        project_id=project_id,
        country=country,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
    )
    if cached is not None:
        append_operation_view_log(
            db,
            action="shipment_schedules.cost_summary.view",
            target_type="shipment_schedule",
            operator=operator,
            after={
                "project_id": project_id,
                "country": country,
                "shipment_status": shipment_status,
                "shipping_method": shipping_method,
                "shipment_no": shipment_no,
                "source": "cache",
            },
            request=request,
        )
        db.commit()
        return ShipmentScheduleCostSummary(**cached)

    if project_id is not None:
        project_service.ensure_project_access(
            db,
            project_id,
            operator=operator,
            is_admin=bool(is_admin),
        )
    accessible_project_ids = project_service.list_accessible_project_ids(
        db,
        operator=operator,
        is_admin=bool(is_admin),
    )
    summary = shipment_schedule_service.summarize_shipment_schedule_costs(
        db,
        project_id=project_id,
        project_ids=accessible_project_ids,
        country=country,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_no=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
    )
    redis_service.set_shipment_schedule_cost_summary_cache(
        project_id=project_id,
        country=country,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
        data=summary,
    )
    append_operation_view_log(
        db,
        action="shipment_schedules.cost_summary.view",
        target_type="shipment_schedule",
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "shipment_status": shipment_status,
            "shipping_method": shipping_method,
            "shipment_no": shipment_no,
            "source": "database",
        },
        request=request,
    )
    db.commit()
    return ShipmentScheduleCostSummary(**summary)


@router.get(
    "/shipment-schedules/sku-summary", response_model=ShipmentSkuSummaryResponse
)
def list_shipment_sku_summary(
    request: Request,
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    include_only_history_calc: bool = Query(default=True),
    shipment_status: str | None = Query(default="completed,in_transit"),
    shipment_no: Annotated[list[str] | None, Query()] = None,
    created_date_from: str | None = Query(default=None),
    created_date_to: str | None = Query(default=None),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentSkuSummaryResponse:
    has_extra_filters = (
        bool(shipment_no) or bool(created_date_from) or bool(created_date_to)
    )
    effective_include_history = (
        False if has_extra_filters else include_only_history_calc
    )

    cached = redis_service.get_shipment_sku_summary_cache(
        project_id=project_id,
        country=country,
        include_only_history_calc=effective_include_history,
        shipment_status=shipment_status,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
    )
    if cached is not None:
        append_operation_view_log(
            db,
            action="shipment_schedules.sku_summary.view",
            target_type="shipment_schedule",
            operator=operator,
            after={
                "project_id": project_id,
                "country": country,
                "shipment_status": shipment_status,
                "include_only_history_calc": effective_include_history,
                "shipment_nos": shipment_no,
                "created_date_from": created_date_from,
                "created_date_to": created_date_to,
                "count": len(cached),
                "source": "cache",
            },
            request=request,
        )
        db.commit()
        return ShipmentSkuSummaryResponse(
            items=[ShipmentSkuSummaryItem(**row) for row in cached]
        )

    if project_id is not None:
        project_service.ensure_project_access(
            db,
            project_id,
            operator=operator,
            is_admin=bool(is_admin),
        )
    accessible_project_ids = project_service.list_accessible_project_ids(
        db,
        operator=operator,
        is_admin=bool(is_admin),
    )
    rows = shipment_schedule_service.list_shipment_sku_summary(
        db,
        project_id=project_id,
        project_ids=accessible_project_ids,
        country=country,
        include_only_history_calc=effective_include_history,
        shipment_status=shipment_status,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
    )
    redis_service.set_shipment_sku_summary_cache(
        project_id=project_id,
        country=country,
        include_only_history_calc=effective_include_history,
        shipment_status=shipment_status,
        data=rows,
        shipment_nos=shipment_no,
        created_date_from=created_date_from,
        created_date_to=created_date_to,
    )
    append_operation_view_log(
        db,
        action="shipment_schedules.sku_summary.view",
        target_type="shipment_schedule",
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "shipment_status": shipment_status,
            "include_only_history_calc": effective_include_history,
            "shipment_nos": shipment_no,
            "created_date_from": created_date_from,
            "created_date_to": created_date_to,
            "count": len(rows),
            "source": "database",
        },
        request=request,
    )
    db.commit()
    return ShipmentSkuSummaryResponse(
        items=[ShipmentSkuSummaryItem(**row) for row in rows]
    )


@router.get(
    "/shipment-schedules/fba-box-details", response_model=ShipmentFbaBoxDetailResponse
)
def list_shipment_fba_box_details(
    request: Request,
    shipment_no: Annotated[list[str], Query(min_length=1)],
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentFbaBoxDetailResponse:
    cached = redis_service.get_shipment_fba_box_details_cache(shipment_no)
    if cached is not None:
        append_operation_view_log(
            db,
            action="shipment_schedules.fba_box_details.view",
            target_type="shipment_schedule",
            operator=operator,
            after={
                "shipment_nos": shipment_no,
                "count": len(cached.get("items", [])),
                "source": "cache",
            },
            request=request,
        )
        db.commit()
        return ShipmentFbaBoxDetailResponse(**cached)

    rows, items = shipment_schedule_service.list_shipment_fba_box_details(
        db,
        shipment_nos=shipment_no,
    )
    for row in rows:
        project_service.ensure_project_access(
            db,
            int(row.project_id),
            operator=operator,
            is_admin=bool(is_admin),
        )
    response = ShipmentFbaBoxDetailResponse(
        project_ids=[int(row.project_id) for row in rows],
        project_names=[str(row.project_name_snapshot) for row in rows],
        countries=[str(row.country) for row in rows],
        shipment_nos=[str(row.shipment_no) for row in rows],
        items=[ShipmentFbaBoxDetailItem(**item) for item in items],
    )
    redis_service.set_shipment_fba_box_details_cache(shipment_no, response.model_dump())
    append_operation_view_log(
        db,
        action="shipment_schedules.fba_box_details.view",
        target_type="shipment_schedule",
        operator=operator,
        after={"shipment_nos": shipment_no, "count": len(items), "source": "database"},
        request=request,
    )
    db.commit()
    return response


@router.get("/shipment-schedules/{schedule_id}", response_model=ShipmentScheduleDetail)
def get_shipment_schedule_detail(
    schedule_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentScheduleDetail:
    return get_shipment_schedule_detail_payload(
        schedule_id=schedule_id,
        request=request,
        db=db,
        operator=operator,
        is_admin=is_admin,
    )


@router.post("/shipment-schedules", response_model=ShipmentScheduleDetail)
def create_shipment_schedule(
    payload: ShipmentScheduleCreate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentScheduleDetail:
    row = shipment_schedule_service.create_shipment_schedule(
        db, payload, operator=operator
    )
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)
    append_operation_audit_log(
        db,
        action="shipment_schedules.create",
        target_type="shipment_schedule",
        target_id=row.id,
        operator=operator,
        after={
            "shipment_no": row.shipment_no,
            "project_id": row.project_id,
            "status": row.shipment_status,
        },
        request=request,
    )
    db.commit()
    return get_shipment_schedule_detail_payload(
        schedule_id=row.id,
        request=request,
        db=db,
        operator=operator,
        is_admin=False,
    )


@router.post(
    "/shipment-schedules/import-csv", response_model=ShipmentSchedulesImportResponse
)
def import_shipment_schedules_csv(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentSchedulesImportResponse:
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )
    if Path(file.filename).suffix.lower() != ".csv":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .csv file is supported",
        )

    content = file.file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 文件为空"
        )

    rows = shipment_schedule_service.import_shipment_schedules_from_csv(
        db,
        content,
        filename=file.filename,
        operator=operator,
    )
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    for pid in {r.project_id for r in rows}:
        redis_service.invalidate_shipment_in_transit_qty_cache(pid)
        redis_service.invalidate_daily_analysis_cache(pid)
    append_operation_audit_log(
        db,
        action="shipment_schedules.import_csv",
        target_type="shipment_schedule",
        target_id=rows[0].id if rows else None,
        operator=operator,
        after={
            "filename": file.filename,
            "inserted": len(rows),
            "shipment_nos": [row.shipment_no for row in rows[:50]],
        },
        request=request,
    )
    db.commit()
    return ShipmentSchedulesImportResponse(
        inserted=len(rows), shipment_nos=[str(row.shipment_no) for row in rows]
    )


@router.patch(
    "/shipment-schedules/{schedule_id}", response_model=ShipmentScheduleDetail
)
def update_shipment_schedule(
    schedule_id: int,
    payload: ShipmentScheduleUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentScheduleDetail:
    row = shipment_schedule_service.update_shipment_schedule(
        db, schedule_id, payload, operator=operator
    )
    redis_service.invalidate_shipment_schedule_detail_cache(schedule_id)
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)
    append_operation_audit_log(
        db,
        action="shipment_schedules.update",
        target_type="shipment_schedule",
        target_id=row.id,
        operator=operator,
        after={
            "shipment_no": row.shipment_no,
            "project_id": row.project_id,
            "status": row.shipment_status,
        },
        request=request,
    )
    db.commit()
    return get_shipment_schedule_detail_payload(
        schedule_id=row.id,
        request=request,
        db=db,
        operator=operator,
        is_admin=is_admin,
    )


@router.delete(
    "/shipment-schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_shipment_schedule(
    schedule_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> Response:
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可删除船期批次"
        )

    row = shipment_schedule_service.delete_shipment_schedule(db, schedule_id)
    redis_service.invalidate_shipment_schedule_detail_cache(schedule_id)
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)
    append_operation_audit_log(
        db,
        action="shipment_schedules.delete",
        target_type="shipment_schedule",
        target_id=row.id,
        operator=operator,
        before={
            "shipment_no": row.shipment_no,
            "project_id": row.project_id,
            "status": row.shipment_status,
        },
        request=request,
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/shipment-schedules/{schedule_id}/items/import-csv",
    response_model=ShipmentItemsImportResponse,
)
def import_shipment_schedule_items_csv(
    schedule_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentItemsImportResponse:
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )
    if Path(file.filename).suffix.lower() != ".csv":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .csv file is supported",
        )

    content = file.file.read()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 文件为空"
        )

    row, inserted, replaced, total_quantity = (
        shipment_schedule_service.replace_shipment_schedule_items_from_csv(
            db,
            schedule_id,
            content,
            filename=file.filename,
        )
    )
    redis_service.invalidate_shipment_schedule_detail_cache(schedule_id)
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)
    append_operation_audit_log(
        db,
        action="shipment_schedules.import_items_csv",
        target_type="shipment_schedule",
        target_id=row.id,
        operator=operator,
        after={
            "shipment_no": row.shipment_no,
            "filename": file.filename,
            "inserted": inserted,
            "replaced": replaced,
            "total_quantity": total_quantity,
        },
        request=request,
    )
    db.commit()
    return ShipmentItemsImportResponse(
        shipment_schedule_id=int(row.id),
        shipment_no=str(row.shipment_no),
        inserted=inserted,
        replaced=replaced,
        total_quantity=total_quantity,
    )


@router.post(
    "/shipment-schedules/{schedule_id}/costs/calculate",
    response_model=ShipmentScheduleDetail,
)
def calculate_shipment_schedule_costs(
    schedule_id: int,
    payload: ShipmentCostCalculateRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ShipmentScheduleDetail:
    row, sku_count, total_quantity = (
        shipment_schedule_service.calculate_shipment_schedule_costs(
            db,
            schedule_id,
            logistics_unit_price=payload.logistics_unit_price,
        )
    )
    redis_service.invalidate_shipment_schedule_detail_cache(schedule_id)
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)
    append_operation_audit_log(
        db,
        action="shipment_schedules.calculate_costs",
        target_type="shipment_schedule",
        target_id=row.id,
        operator=operator,
        after={
            "shipment_no": row.shipment_no,
            "logistics_unit_price": float(row.logistics_unit_price or 0),
            "total_volume_m3": float(row.total_volume_m3 or 0),
            "total_chargeable_weight_kg": float(row.total_chargeable_weight_kg or 0),
            "logistics_total_price": float(row.logistics_total_price or 0),
            "sku_count": sku_count,
            "total_quantity": total_quantity,
        },
        request=request,
    )
    db.commit()
    return get_shipment_schedule_detail_payload(
        schedule_id=row.id,
        request=request,
        db=db,
        operator=operator,
        is_admin=is_admin,
    )
