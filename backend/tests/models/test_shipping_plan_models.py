from sqlalchemy import CheckConstraint, Integer, UniqueConstraint

from app.models import (
    ShippingPlanAllocation,
    ShippingPlanBatch,
    ShippingPlanItem,
    ShippingPlanSkuSetting,
)


def test_shipping_plan_tables_have_integer_primary_keys_and_scope_constraints():
    assert {
        ShippingPlanSkuSetting.__table__.primary_key.columns.id.type.__class__,
        ShippingPlanBatch.__table__.primary_key.columns.id.type.__class__,
        ShippingPlanItem.__table__.primary_key.columns.id.type.__class__,
        ShippingPlanAllocation.__table__.primary_key.columns.id.type.__class__,
    } == {Integer}

    setting_uniques = {
        tuple(column.name for column in constraint.columns)
        for constraint in ShippingPlanSkuSetting.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    item_uniques = {
        tuple(column.name for column in constraint.columns)
        for constraint in ShippingPlanItem.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    allocation_uniques = {
        tuple(column.name for column in constraint.columns)
        for constraint in ShippingPlanAllocation.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert ("project_id", "country", "sku") in setting_uniques
    assert ("batch_id", "sku") in item_uniques
    assert ("plan_item_id", "shipment_schedule_id") in allocation_uniques


def test_shipping_plan_quantities_and_growth_factor_have_database_checks():
    for model, check in (
        (ShippingPlanSkuSetting, "growth_factor >= 0"),
        (ShippingPlanItem, "quantity > 0"),
        (ShippingPlanAllocation, "quantity > 0"),
    ):
        assert any(
            check in str(constraint.sqltext)
            for constraint in model.__table__.constraints
            if isinstance(constraint, CheckConstraint)
        )


def test_deleting_plan_batch_or_shipment_schedule_cascades_allocations():
    item_foreign_key = next(iter(ShippingPlanItem.__table__.c.batch_id.foreign_keys))
    plan_allocation_foreign_key = next(
        iter(ShippingPlanAllocation.__table__.c.plan_item_id.foreign_keys)
    )
    shipment_allocation_foreign_key = next(
        iter(ShippingPlanAllocation.__table__.c.shipment_schedule_id.foreign_keys)
    )

    assert item_foreign_key.ondelete == "CASCADE"
    assert plan_allocation_foreign_key.ondelete == "CASCADE"
    assert shipment_allocation_foreign_key.ondelete == "CASCADE"
