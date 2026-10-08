from datetime import date

import pytest
from fastapi import HTTPException

from app.models import (
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
    ShippingPlanAllocation,
    SkuRecord,
)
from app.schemas.shipping_plan import (
    ShippingPlanAllocationCreate,
    ShippingPlanBatchCreate,
    ShippingPlanItemInput,
)
from app.services.shipping_plan.service import (
    cancel_plan_batch,
    create_or_add_allocation,
    create_plan_batch,
    delete_allocation,
    list_plan_batches,
)


def _seed_scope(db_session):
    project = Project(project_name="blf1286 Plan Allocation", sort_order=0)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku="SKU-ALLOC",
            asin="ASIN-ALLOC",
            country="US",
            is_active=True,
            sort_order=1,
        )
    )
    schedule = ShipmentSchedule(
        project_id=project.id,
        country="US",
        project_name_snapshot=project.project_name,
        shipment_no="BLF1286-ALLOC-1",
        shipment_status="draft",
    )
    db_session.add(schedule)
    db_session.flush()
    db_session.add(
        ShipmentScheduleItem(
            shipment_schedule_id=schedule.id,
            project_id=project.id,
            shipment_no=schedule.shipment_no,
            sku="SKU-ALLOC",
            quantity=10,
            item_date=date(2026, 10, 8),
            average_logistics_unit_price=0,
        )
    )
    batch = create_plan_batch(
        db_session,
        payload=ShippingPlanBatchCreate(
            project_id=project.id,
            country="US",
            name="Expected batch",
            expected_arrival_date=date(2026, 11, 1),
            items=[ShippingPlanItemInput(sku="SKU-ALLOC", quantity=8)],
        ),
        operator="tester",
    )
    db_session.flush()
    return project, schedule, batch, batch.items[0]


def test_duplicate_allocation_returns_conflict_and_keeps_original_quantity(db_session):
    project, schedule, batch, plan_item = _seed_scope(db_session)
    payload = ShippingPlanAllocationCreate(
        plan_item_id=plan_item.id, shipment_schedule_id=schedule.id, quantity=3
    )

    first = create_or_add_allocation(
        db_session, payload=payload, project_id=project.id, country="US"
    )
    assert first["plan_item_remaining_quantity"] == 5
    with pytest.raises(HTTPException) as exc:
        create_or_add_allocation(
            db_session, payload=payload, project_id=project.id, country="US"
        )

    assert exc.value.status_code == 409
    allocation = db_session.query(ShippingPlanAllocation).one()
    assert allocation.quantity == 3
    batches = list_plan_batches(db_session, project_id=project.id, country="US")
    assert batches["items"][0]["items"][0]["remaining_quantity"] == 5


def test_allocation_rejects_plan_and_shipment_overallocation(db_session):
    project, schedule, batch, plan_item = _seed_scope(db_session)
    create_or_add_allocation(
        db_session,
        payload=ShippingPlanAllocationCreate(
            plan_item_id=plan_item.id, shipment_schedule_id=schedule.id, quantity=8
        ),
        project_id=project.id,
        country="US",
    )

    with pytest.raises(HTTPException) as exc:
        create_or_add_allocation(
            db_session,
            payload=ShippingPlanAllocationCreate(
                plan_item_id=plan_item.id, shipment_schedule_id=schedule.id, quantity=1
            ),
            project_id=project.id,
            country="US",
        )

    assert exc.value.status_code == 409


def test_cancelling_batch_keeps_allocated_shipment_and_unlink_restores_plan_balance(db_session):
    project, schedule, batch, plan_item = _seed_scope(db_session)
    result = create_or_add_allocation(
        db_session,
        payload=ShippingPlanAllocationCreate(
            plan_item_id=plan_item.id, shipment_schedule_id=schedule.id, quantity=4
        ),
        project_id=project.id,
        country="US",
    )
    cancel_plan_batch(
        db_session,
        batch_id=batch.id,
        project_id=project.id,
        country="US",
        operator="tester",
    )
    assert result["allocation"].quantity == 4

    delete_allocation(
        db_session,
        allocation_id=result["allocation"].id,
        project_id=project.id,
        country="US",
    )
    assert db_session.query(ShippingPlanAllocation).count() == 0
    assert plan_item.quantity == 8
