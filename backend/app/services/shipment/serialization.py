"""Shipment schedule serialization helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

from app.schemas.shipment_schedule import (
    ShipmentScheduleDetail,
    ShipmentScheduleListItem,
)
from app.services.audit_log_service import append_operation_view_log
from app.services import project_service, infra as redis_service
from app.services.shipment.utils import date_text

if TYPE_CHECKING:
    from fastapi import Request


def serialize_schedule_list_item(
    row: object, sku_count: int, total_quantity: int
) -> ShipmentScheduleListItem:
    """Serialize a shipment schedule row into a list item schema."""
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
        created_date=date_text(row.created_date),
        etd_date=date_text(row.etd_date),
        eta_date=date_text(row.eta_date),
        actual_inbound_date=date_text(row.actual_inbound_date),
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
        shipment_batch=str(row.shipment_batch) if row.shipment_batch else None,
    )


def build_shipment_schedule_detail(
    row: object, sku_count: int, total_quantity: int
) -> ShipmentScheduleDetail:
    """Build a full detail response from a schedule row and its items."""
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
        created_date=date_text(row.created_date),
        etd_date=date_text(row.etd_date),
        eta_date=date_text(row.eta_date),
        actual_inbound_date=date_text(row.actual_inbound_date),
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
                "id": int(item.id),
                "item_date": date_text(item.item_date),
                "sku": str(item.sku),
                "quantity": int(item.quantity),
                "carton_count": item.carton_count,
                "remark": item.remark,
                "volume_m3": float(item.volume_m3 or 0),
                "actual_weight_kg": float(item.actual_weight_kg or 0),
                "volumetric_weight_kg": float(item.volumetric_weight_kg or 0),
                "chargeable_weight_kg": float(item.chargeable_weight_kg or 0),
                "estimated_logistics_cost": float(item.estimated_logistics_cost or 0),
                "average_logistics_unit_price": float(
                    item.average_logistics_unit_price or 0
                ),
            }
            for item in row.items
        ],
        updated_at=row.updated_at.isoformat(),
        shipment_batch=str(row.shipment_batch) if row.shipment_batch else None,
    )


def get_shipment_schedule_detail_payload(
    *,
    schedule_id: int,
    db: Session,
    operator: str | None,
    is_admin: bool,
    request: Request | None = None,
) -> ShipmentScheduleDetail:
    """Get detail payload with caching and audit logging.

    This function is kept here rather than in the endpoint because it
    composes serialization with caching and audit-log behaviour.
    """
    from app.services.shipment.schedule import get_shipment_schedule_detail  # lazy import to avoid circular

    cached = redis_service.get_shipment_schedule_detail_cache(schedule_id)
    if cached is not None:
        if request is not None:
            append_operation_view_log(
                db,
                action="shipment_schedules.detail.view",
                target_type="shipment_schedule",
                target_id=schedule_id,
                operator=operator,
                after={
                    "shipment_no": cached.get("shipment_no"),
                    "sku_count": len(cached.get("items", [])),
                    "total_quantity": sum(
                        item.get("quantity", 0) for item in cached.get("items", [])
                    ),
                    "source": "cache",
                },
                request=request,
            )
            db.commit()
        return ShipmentScheduleDetail(**cached)

    row, sku_count, total_quantity = get_shipment_schedule_detail(db, schedule_id)
    project_service.ensure_project_access(
        db,
        int(row.project_id),
        operator=operator,
        is_admin=is_admin,
    )
    detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
    redis_service.set_shipment_schedule_detail_cache(schedule_id, detail.model_dump())
    if request is not None:
        append_operation_view_log(
            db,
            action="shipment_schedules.detail.view",
            target_type="shipment_schedule",
            target_id=schedule_id,
            operator=operator,
            after={
                "shipment_no": row.shipment_no,
                "sku_count": int(sku_count),
                "total_quantity": int(total_quantity),
                "source": "database",
            },
            request=request,
        )
        db.commit()
    return detail


