from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.shipment_schedule import (
    ShipmentItemsImportResponse,
    ShipmentScheduleCreate,
    ShipmentScheduleDetail,
    ShipmentScheduleListItem,
    ShipmentScheduleListResponse,
    ShipmentScheduleUpdate,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services import shipment_schedule_service

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
        shipment_no=str(row.shipment_no),
        tracking_no=row.tracking_no,
        warehouse_code=row.warehouse_code,
        supplier_name=row.supplier_name,
        forwarder_name=row.forwarder_name,
        shipping_method=str(row.shipping_method),
        created_date=_date_text(row.created_date),
        etd_date=_date_text(row.etd_date),
        eta_date=_date_text(row.eta_date),
        expected_inbound_start_date=_date_text(row.expected_inbound_start_date),
        expected_inbound_end_date=_date_text(row.expected_inbound_end_date),
        shipment_status=str(row.shipment_status),
        stat_date=_date_text(row.stat_date),
        forwarder_update=row.forwarder_update,
        remark=row.remark,
        sku_count=int(sku_count),
        total_quantity=int(total_quantity),
        updated_at=row.updated_at.isoformat(),
    )


@router.get('/shipment-schedules', response_model=ShipmentScheduleListResponse)
def list_shipment_schedules(
    project_id: int | None = Query(default=None, gt=0),
    shipment_status: str | None = Query(default=None),
    shipping_method: str | None = Query(default=None),
    shipment_no: str | None = Query(default=None),
    etd_from: str | None = Query(default=None),
    etd_to: str | None = Query(default=None),
    eta_from: str | None = Query(default=None),
    eta_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> ShipmentScheduleListResponse:
    rows, total, has_next = shipment_schedule_service.list_shipment_schedules(
        db,
        project_id=project_id,
        shipment_status=shipment_status,
        shipping_method=shipping_method,
        shipment_no=shipment_no,
        etd_from=etd_from,
        etd_to=etd_to,
        eta_from=eta_from,
        eta_to=eta_to,
        page=page,
        page_size=page_size,
        include_total=include_total,
    )
    return ShipmentScheduleListResponse(
        items=[_serialize_schedule_list_item(row, sku_count, total_quantity) for row, sku_count, total_quantity in rows],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )


@router.get('/shipment-schedules/{schedule_id}', response_model=ShipmentScheduleDetail)
def get_shipment_schedule_detail(
    schedule_id: int,
    db: Session = Depends(get_db_session),
) -> ShipmentScheduleDetail:
    row, sku_count, total_quantity = shipment_schedule_service.get_shipment_schedule_detail(db, schedule_id)
    return ShipmentScheduleDetail(
        id=int(row.id),
        project_id=int(row.project_id),
        project_name=str(row.project_name_snapshot),
        shipment_no=str(row.shipment_no),
        tracking_no=row.tracking_no,
        warehouse_code=row.warehouse_code,
        supplier_name=row.supplier_name,
        forwarder_name=row.forwarder_name,
        shipping_method=str(row.shipping_method),
        created_date=_date_text(row.created_date),
        etd_date=_date_text(row.etd_date),
        eta_date=_date_text(row.eta_date),
        expected_inbound_start_date=_date_text(row.expected_inbound_start_date),
        expected_inbound_end_date=_date_text(row.expected_inbound_end_date),
        booking_note=row.booking_note,
        forwarder_update=row.forwarder_update,
        remark=row.remark,
        shipment_status=str(row.shipment_status),
        stat_date=_date_text(row.stat_date),
        sku_count=int(sku_count),
        total_quantity=int(total_quantity),
        items=[
            {
                'id': int(item.id),
                'item_date': _date_text(item.item_date),
                'sku': str(item.sku),
                'quantity': int(item.quantity),
                'remark': item.remark,
            }
            for item in row.items
        ],
        updated_at=row.updated_at.isoformat(),
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
    return get_shipment_schedule_detail(schedule_id=row.id, db=db)


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
    return get_shipment_schedule_detail(schedule_id=row.id, db=db)


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
