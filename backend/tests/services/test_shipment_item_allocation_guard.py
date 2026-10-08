from datetime import date

import pytest
from fastapi import HTTPException

from app.models import (
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
    ShippingPlanAllocation,
    ShippingPlanBatch,
    ShippingPlanItem,
    SkuRecord,
)
from app.services.shipment.item import replace_shipment_schedule_items


def _seed_allocation(db_session):
    project = Project(project_name="blf1286 Allocation Guard", sort_order=0)
    db_session.add(project)
    db_session.flush()
    schedule = ShipmentSchedule(
        project_id=project.id,
        country="US",
        project_name_snapshot=project.project_name,
        shipment_no="BLF1286-GUARD-1",
        shipment_status="in_transit",
    )
    db_session.add(schedule)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku="SKU-GUARD",
            asin="ASIN-GUARD",
            country="US",
            is_active=True,
            sort_order=1,
        )
    )
    db_session.add(
        ShipmentScheduleItem(
            shipment_schedule_id=schedule.id,
            project_id=project.id,
            shipment_no=schedule.shipment_no,
            sku="SKU-GUARD",
            quantity=10,
            item_date=date(2026, 10, 8),
            average_logistics_unit_price=0,
        )
    )
    batch = ShippingPlanBatch(
        project_id=project.id,
        country="US",
        name="BLF1286 planned",
        expected_arrival_date=date(2026, 11, 1),
        status="active",
    )
    db_session.add(batch)
    db_session.flush()
    plan_item = ShippingPlanItem(batch_id=batch.id, sku="SKU-GUARD", quantity=8)
    db_session.add(plan_item)
    db_session.flush()
    db_session.add(
        ShippingPlanAllocation(
            plan_item_id=plan_item.id,
            shipment_schedule_id=schedule.id,
            sku="SKU-GUARD",
            quantity=6,
        )
    )
    db_session.flush()
    return schedule


def _replacement(*, sku="SKU-GUARD", quantity=10):
    return [
        {
            "sku": sku,
            "quantity": quantity,
            "carton_count": None,
            "row_no": 1,
            "item_date": date(2026, 10, 8),
            "remark": None,
        }
    ]


def test_item_replacement_rejects_removing_allocated_sku(db_session):
    schedule = _seed_allocation(db_session)

    with pytest.raises(HTTPException) as exc:
        replace_shipment_schedule_items(
            db_session, schedule, [], source_type="manual"
        )

    assert exc.value.status_code == 409
    assert db_session.query(ShipmentScheduleItem).filter_by(shipment_schedule_id=schedule.id).one().sku == "SKU-GUARD"


def test_item_replacement_rejects_quantity_below_allocated_amount(db_session):
    schedule = _seed_allocation(db_session)

    with pytest.raises(HTTPException) as exc:
        replace_shipment_schedule_items(
            db_session, schedule, _replacement(quantity=5), source_type="manual"
        )

    assert exc.value.status_code == 409
    assert db_session.query(ShipmentScheduleItem).filter_by(shipment_schedule_id=schedule.id).one().quantity == 10


def test_item_replacement_allows_quantity_at_or_above_allocated_amount(db_session):
    schedule = _seed_allocation(db_session)
    result = replace_shipment_schedule_items(
        db_session, schedule, _replacement(quantity=7), source_type="manual"
    )
    db_session.flush()

    assert result == 7
    assert db_session.query(ShipmentScheduleItem).filter_by(shipment_schedule_id=schedule.id).one().quantity == 7
