from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Header, Query, Request, Response, UploadFile, status
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
    ShipmentScheduleListItem,
    ShipmentScheduleListResponse,
    ShipmentScheduleUpdate,
)
from app.services.audit_log_service import append_operation_audit_log, append_operation_view_log
from app.services import project_service, shipment_schedule_service

router = APIRouter(dependencies=[Depends(protected)])


def _date_text(value: object) -> str | None:
    if value is None:
        return None
    return str(value)


def _serialize_schedule_list_item(row: object, sku_count: int, total_quantity: int) -> ShipmentScheduleListItem:
    return ShipmentScheduleListItem(
        id=int(row.id),
        project_id=int(row.project_id),
        project_name=str(row.project_name_snapshot),
        country=str(row.country),
        shipment_no=str(row.shipment_no),
        tracking_no=row.tracking_no,
        warehouse_code=row.warehouse_code,
        forwarder_name=row.forwarder_name,
        shipping_method=str(row.shipping_method),
        created_date=_date_text(row.created_date),
        etd_date=_date_text(row.etd_date),
        eta_date=_date_text(row.eta_date),
        actual_inbound_date=_date_text(row.actual_inbound_date),
        shipment_status=str(row.shipment_status),
        remark=row.remark,
        sku_count=int(sku_count),
        total_quantity=int(total_quantity),
        logistics_unit_price=float(row.logistics_unit_price or 0),
        total_volume_m3=float(row.total_volume_m3 or 0),
        total_chargeable_weight_kg=float(row.total_chargeable_weight_kg or 0),
        logistics_total_price=float(row.logistics_total_price or 0),
        include_in_history_shipping_calc=bool(row.include_in_history_shipping_calc),
        updated_at=row.updated_at.isoformat(),
    )


def _build_shipment_schedule_detail(row: object, sku_count: int, total_quantity: int) -> ShipmentScheduleDetail:
    return ShipmentScheduleDetail(
        id=int(row.id),
        project_id=int(row.project_id),
        project_name=str(row.project_name_snapshot),
        country=str(row.country),
        shipment_no=str(row.shipment_no),
        tracking_no=row.tracking_no,
        warehouse_code=row.warehouse_code,
        forwarder_name=row.forwarder_name,
        shipping_method=str(row.shipping_method),
        created_date=_date_text(row.created_date),
        etd_date=_date_text(row.etd_date),
        eta_date=_date_text(row.eta_date),
        actual_inbound_date=_date_text(row.actual_inbound_date),
        remark=row.remark,
        shipment_status=str(row.shipment_status),
        sku_count=int(sku_count),
        total_quantity=int(total_quantity),
        logistics_unit_price=float(row.logistics_unit_price or 0),
        total_volume_m3=float(row.total_volume_m3 or 0),
        total_chargeable_weight_kg=float(row.total_chargeable_weight_kg or 0),
        logistics_total_price=float(row.logistics_total_price or 0),
        include_in_history_shipping_calc=bool(row.include_in_history_shipping_calc),
        items=[
            {
                'id': int(item.id),
                'item_date': _date_text(item.item_date),
                'sku': str(item.sku),
                'quantity': int(item.quantity),
                'remark': item.remark,
                'volume_m3': float(item.volume_m3 or 0),
                'actual_weight_kg': float(item.actual_weight_kg or 0),
                'volumetric_weight_kg': float(item.volumetric_weight_kg or 0),
                'chargeable_weight_kg': float(item.chargeable_weight_kg or 0),
                'estimated_logistics_cost': float(item.estimated_logistics_cost or 0),
                'average_logistics_unit_price': float(item.average_logistics_unit_price or 0),
            }
            for item in row.items
        ],
        updated_at=row.updated_at.isoformat(),
    )


def _get_shipment_schedule_detail_payload(
    *,
    schedule_id: int,
    db: Session,
    operator: str | None,
    is_admin: bool,
    request: Request | None = None,
) -> ShipmentScheduleDetail:
    row, sku_count, total_quantity = shipment_schedule_service.get_shipment_schedule_detail(db, schedule_id)
    project_service.ensure_project_access(
        db,
        int(row.project_id),
        operator=operator,
        is_admin=is_admin,
    )
    if request is not None:
        append_operation_view_log(
            db,
            action='shipment_schedules.detail.view',
            target_type='shipment_schedule',
            target_id=schedule_id,
            operator=operator,
            after={'shipment_no': row.shipment_no, 'sku_count': int(sku_count), 'total_quantity': int(total_quantity)},
            request=request,
        )
        db.commit()
    return _build_shipment_schedule_detail(row, sku_count, total_quantity)


@router.get('/shipment-schedules', response_model=ShipmentScheduleListResponse)
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
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ShipmentScheduleListResponse:
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
    append_operation_view_log(
        db,
        action='shipment_schedules.list',
        target_type='shipment_schedule',
        operator=operator,
        after={
            'project_id': project_id,
            'country': country,
            'shipment_status': shipment_status,
            'shipping_method': shipping_method,
            'shipment_no': shipment_no,
            'page': page,
            'page_size': page_size,
            'count': len(rows),
            'total': total,
        },
        request=request,
    )
    db.commit()
    return ShipmentScheduleListResponse(
        items=[_serialize_schedule_list_item(row, sku_count, total_quantity) for row, sku_count, total_quantity in rows],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )


@router.get('/shipment-schedules/cost-summary', response_model=ShipmentScheduleCostSummary)
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
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ShipmentScheduleCostSummary:
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
    append_operation_view_log(
        db,
        action='shipment_schedules.cost_summary.view',
        target_type='shipment_schedule',
        operator=operator,
        after={
            'project_id': project_id,
            'country': country,
            'shipment_status': shipment_status,
            'shipping_method': shipping_method,
            'shipment_no': shipment_no,
        },
        request=request,
    )
    db.commit()
    return ShipmentScheduleCostSummary(**summary)


@router.get('/shipment-schedules/sku-summary', response_model=ShipmentSkuSummaryResponse)
def list_shipment_sku_summary(
    request: Request,
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    include_only_history_calc: bool = Query(default=True),
    shipment_status: str | None = Query(default='completed'),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ShipmentSkuSummaryResponse:
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
        include_only_history_calc=include_only_history_calc,
        shipment_status=shipment_status,
    )
    append_operation_view_log(
        db,
        action='shipment_schedules.sku_summary.view',
        target_type='shipment_schedule',
        operator=operator,
        after={
            'project_id': project_id,
            'country': country,
            'shipment_status': shipment_status,
            'include_only_history_calc': include_only_history_calc,
            'count': len(rows),
        },
        request=request,
    )
    db.commit()
    return ShipmentSkuSummaryResponse(
        items=[ShipmentSkuSummaryItem(**row) for row in rows]
    )


@router.get('/shipment-schedules/fba-box-details', response_model=ShipmentFbaBoxDetailResponse)
def list_shipment_fba_box_details(
    request: Request,
    shipment_no: Annotated[list[str], Query(min_length=1)],
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ShipmentFbaBoxDetailResponse:
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
    append_operation_view_log(
        db,
        action='shipment_schedules.fba_box_details.view',
        target_type='shipment_schedule',
        operator=operator,
        after={'shipment_nos': shipment_no, 'count': len(items)},
        request=request,
    )
    db.commit()
    return ShipmentFbaBoxDetailResponse(
        project_ids=[int(row.project_id) for row in rows],
        project_names=[str(row.project_name_snapshot) for row in rows],
        countries=[str(row.country) for row in rows],
        shipment_nos=[str(row.shipment_no) for row in rows],
        items=[ShipmentFbaBoxDetailItem(**item) for item in items],
    )


@router.get('/shipment-schedules/{schedule_id}', response_model=ShipmentScheduleDetail)
def get_shipment_schedule_detail(
    schedule_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ShipmentScheduleDetail:
    return _get_shipment_schedule_detail_payload(
        schedule_id=schedule_id,
        request=request,
        db=db,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.post('/shipment-schedules', response_model=ShipmentScheduleDetail)
def create_shipment_schedule(
    payload: ShipmentScheduleCreate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentScheduleDetail:
    row = shipment_schedule_service.create_shipment_schedule(db, payload, operator=operator)
    append_operation_audit_log(
        db,
        action='shipment_schedules.create',
        target_type='shipment_schedule',
        target_id=row.id,
        operator=operator,
        after={'shipment_no': row.shipment_no, 'project_id': row.project_id, 'status': row.shipment_status},
        request=request,
    )
    db.commit()
    return _get_shipment_schedule_detail_payload(
        schedule_id=row.id,
        request=request,
        db=db,
        operator=operator,
        is_admin=False,
    )


@router.post('/shipment-schedules/import-csv', response_model=ShipmentSchedulesImportResponse)
def import_shipment_schedules_csv(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentSchedulesImportResponse:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')
    if Path(file.filename).suffix.lower() != '.csv':
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Only .csv file is supported')

    content = file.file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 文件为空')

    rows = shipment_schedule_service.import_shipment_schedules_from_csv(
        db,
        content,
        filename=file.filename,
        operator=operator,
    )
    append_operation_audit_log(
        db,
        action='shipment_schedules.import_csv',
        target_type='shipment_schedule',
        target_id=rows[0].id if rows else None,
        operator=operator,
        after={
            'filename': file.filename,
            'inserted': len(rows),
            'shipment_nos': [row.shipment_no for row in rows[:50]],
        },
        request=request,
    )
    db.commit()
    return ShipmentSchedulesImportResponse(inserted=len(rows), shipment_nos=[str(row.shipment_no) for row in rows])


@router.patch('/shipment-schedules/{schedule_id}', response_model=ShipmentScheduleDetail)
def update_shipment_schedule(
    schedule_id: int,
    payload: ShipmentScheduleUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentScheduleDetail:
    row = shipment_schedule_service.update_shipment_schedule(db, schedule_id, payload, operator=operator)
    append_operation_audit_log(
        db,
        action='shipment_schedules.update',
        target_type='shipment_schedule',
        target_id=row.id,
        operator=operator,
        after={'shipment_no': row.shipment_no, 'project_id': row.project_id, 'status': row.shipment_status},
        request=request,
    )
    db.commit()
    return _get_shipment_schedule_detail_payload(
        schedule_id=row.id,
        request=request,
        db=db,
        operator=operator,
        is_admin=False,
    )


@router.delete('/shipment-schedules/{schedule_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_shipment_schedule(
    schedule_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> Response:
    if not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='仅管理员可删除船期批次')

    row = shipment_schedule_service.delete_shipment_schedule(db, schedule_id)
    append_operation_audit_log(
        db,
        action='shipment_schedules.delete',
        target_type='shipment_schedule',
        target_id=row.id,
        operator=operator,
        before={'shipment_no': row.shipment_no, 'project_id': row.project_id, 'status': row.shipment_status},
        request=request,
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post('/shipment-schedules/{schedule_id}/items/import-csv', response_model=ShipmentItemsImportResponse)
def import_shipment_schedule_items_csv(
    schedule_id: int,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentItemsImportResponse:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')
    if Path(file.filename).suffix.lower() != '.csv':
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Only .csv file is supported')

    content = file.file.read()
    if not content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 文件为空')

    row, inserted, replaced, total_quantity = shipment_schedule_service.replace_shipment_schedule_items_from_csv(
        db,
        schedule_id,
        content,
        filename=file.filename,
    )
    append_operation_audit_log(
        db,
        action='shipment_schedules.import_items_csv',
        target_type='shipment_schedule',
        target_id=row.id,
        operator=operator,
        after={
            'shipment_no': row.shipment_no,
            'filename': file.filename,
            'inserted': inserted,
            'replaced': replaced,
            'total_quantity': total_quantity,
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


@router.post('/shipment-schedules/{schedule_id}/costs/calculate', response_model=ShipmentScheduleDetail)
def calculate_shipment_schedule_costs(
    schedule_id: int,
    payload: ShipmentCostCalculateRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShipmentScheduleDetail:
    row, sku_count, total_quantity = shipment_schedule_service.calculate_shipment_schedule_costs(
        db,
        schedule_id,
        logistics_unit_price=payload.logistics_unit_price,
    )
    append_operation_audit_log(
        db,
        action='shipment_schedules.calculate_costs',
        target_type='shipment_schedule',
        target_id=row.id,
        operator=operator,
        after={
            'shipment_no': row.shipment_no,
            'logistics_unit_price': float(row.logistics_unit_price or 0),
            'total_volume_m3': float(row.total_volume_m3 or 0),
            'total_chargeable_weight_kg': float(row.total_chargeable_weight_kg or 0),
            'logistics_total_price': float(row.logistics_total_price or 0),
            'sku_count': sku_count,
            'total_quantity': total_quantity,
        },
        request=request,
    )
    db.commit()
    return _get_shipment_schedule_detail_payload(
        schedule_id=row.id,
        request=request,
        db=db,
        operator=operator,
        is_admin=False,
    )
