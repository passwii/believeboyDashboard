from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ShippingPlanAllocation


def shipment_item_replacement_conflicts(
    db: Session,
    *,
    schedule_id: int,
    items: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Return SKU allocations that a proposed schedule-item replacement would break."""
    requested: dict[str, int] = {}
    for item in items:
        sku = str(item["sku"])
        if item.get("quantity") is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"第 {int(item['row_no'])} 行无法确定 quantity，"
                    "不能安全校验货件关联"
                ),
            )
        requested[sku] = requested.get(sku, 0) + int(item["quantity"])

    rows = db.execute(
        select(ShippingPlanAllocation.sku, func.sum(ShippingPlanAllocation.quantity))
        .where(ShippingPlanAllocation.shipment_schedule_id == schedule_id)
        .group_by(ShippingPlanAllocation.sku)
    ).all()
    return [
        {
            "sku": sku,
            "allocated_quantity": int(allocated),
            "replacement_quantity": requested.get(sku, 0),
        }
        for sku, allocated in rows
        if requested.get(sku, 0) < int(allocated)
    ]
