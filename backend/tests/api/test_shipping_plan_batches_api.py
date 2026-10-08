from datetime import date

import pytest
from fastapi import HTTPException

from app.models import Project, SkuRecord
from app.schemas.shipping_plan import (
    ShippingPlanBatchCreate,
    ShippingPlanBatchUpdate,
    ShippingPlanItemInput,
)
from app.services.shipping_plan.service import create_plan_batch, update_plan_batch


def test_batch_requires_unique_skus_and_positive_quantities():
    with pytest.raises(ValueError):
        ShippingPlanBatchCreate(
            project_id=1,
            country="US",
            name="batch",
            expected_arrival_date=date(2026, 11, 1),
            items=[
                ShippingPlanItemInput(sku="DUP", quantity=1),
                ShippingPlanItemInput(sku="DUP", quantity=2),
            ],
        )
    with pytest.raises(ValueError):
        ShippingPlanItemInput(sku="SKU", quantity=0)


def test_batch_creation_validates_project_site_sku(db_session):
    project = Project(project_name="blf1286 Batch Create", sort_order=0)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku="SKU-BATCH",
            asin="ASIN-BATCH",
            country="US",
            is_active=True,
            sort_order=1,
        )
    )
    db_session.flush()
    batch = create_plan_batch(
        db_session,
        payload=ShippingPlanBatchCreate(
            project_id=project.id,
            country="US",
            name="Expected",
            expected_arrival_date=date(2026, 12, 1),
            items=[ShippingPlanItemInput(sku="SKU-BATCH", quantity=9)],
        ),
        operator="tester",
    )
    assert batch.status == "active"
    assert batch.items[0].quantity == 9

    with pytest.raises(HTTPException) as exc:
        create_plan_batch(
            db_session,
            payload=ShippingPlanBatchCreate(
                project_id=project.id,
                country="DE",
                name="Wrong country",
                expected_arrival_date=date(2026, 12, 1),
                items=[ShippingPlanItemInput(sku="SKU-BATCH", quantity=9)],
            ),
            operator="tester",
        )
    assert exc.value.status_code == 422


def test_batch_cannot_shrink_below_allocated_amount(db_session):
    from app.models import (
        ShipmentSchedule,
        ShippingPlanAllocation,
        ShippingPlanBatch,
        ShippingPlanItem,
    )

    project = Project(project_name="blf1286 Batch Allocated", sort_order=0)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku="SKU-LOCKED",
            asin="ASIN-LOCKED",
            country="US",
            is_active=True,
            sort_order=1,
        )
    )
    schedule = ShipmentSchedule(
        project_id=project.id,
        country="US",
        project_name_snapshot=project.project_name,
        shipment_no="BLF1286-BATCH-ALLOC-1",
        shipment_status="draft",
    )
    batch = ShippingPlanBatch(
        project_id=project.id,
        country="US",
        name="Allocated",
        expected_arrival_date=date(2026, 12, 1),
    )
    db_session.add_all([schedule, batch])
    db_session.flush()
    plan_item = ShippingPlanItem(batch_id=batch.id, sku="SKU-LOCKED", quantity=10)
    db_session.add(plan_item)
    db_session.flush()
    db_session.add(
        ShippingPlanAllocation(
            plan_item_id=plan_item.id,
            shipment_schedule_id=schedule.id,
            sku="SKU-LOCKED",
            quantity=6,
        )
    )
    db_session.flush()

    with pytest.raises(HTTPException) as exc:
        update_plan_batch(
            db_session,
            batch_id=batch.id,
            project_id=project.id,
            country="US",
            payload=ShippingPlanBatchUpdate(
                items=[ShippingPlanItemInput(sku="SKU-LOCKED", quantity=5)]
            ),
            operator="tester",
        )
    assert exc.value.status_code == 409
