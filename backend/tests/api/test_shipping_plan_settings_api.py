from decimal import Decimal

import pytest

from app.models import Project, ShippingPlanSkuSetting, SkuRecord
from app.services.shipping_plan.service import upsert_growth_factor


def test_growth_factor_defaults_in_schema_and_negative_values_are_rejected():
    from app.schemas.shipping_plan import ShippingPlanGrowthFactorUpdate

    payload = ShippingPlanGrowthFactorUpdate(
        project_id=1, country="US", growth_factor="1.0"
    )
    assert payload.growth_factor == Decimal("1.0")
    with pytest.raises(ValueError):
        ShippingPlanGrowthFactorUpdate(
            project_id=1, country="US", growth_factor="-0.01"
        )


def test_growth_factor_is_upserted_by_project_country_and_sku(db_session):
    project = Project(project_name="blf1286 Growth Factor", sort_order=0)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku="SKU-GROWTH",
            asin="ASIN-GROWTH",
            country="US",
            is_active=True,
            sort_order=1,
        )
    )
    db_session.flush()

    setting = upsert_growth_factor(
        db_session,
        project_id=project.id,
        country="US",
        sku="SKU-GROWTH",
        growth_factor=Decimal("1.2500"),
        operator="tester",
    )
    db_session.flush()
    assert setting.growth_factor == Decimal("1.2500")
    assert setting.updated_by == "tester"

    updated = upsert_growth_factor(
        db_session,
        project_id=project.id,
        country="US",
        sku="SKU-GROWTH",
        growth_factor=Decimal(0),
        operator="tester",
    )
    assert updated.id == setting.id
    assert updated.growth_factor == Decimal("0.0000")
    assert db_session.query(ShippingPlanSkuSetting).filter_by(project_id=project.id).count() == 1
