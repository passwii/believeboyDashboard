from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from app.models import InventoryReplenishmentSetting, Project, SkuRecord
from app.services.inventory import replenishment


def test_shipping_baseline_uses_same_weighted_base_dms_and_not_safety_adjusted_value(db_session):
    project = Project(project_name="blf1286 shipping baseline", sort_order=0)
    db_session.add(project)
    db_session.flush()
    db_session.add_all(
        [
            SkuRecord(
                project_id=project.id,
                project_name=project.project_name,
                sku="SKU-A",
                asin="ASIN-A",
                country="US",
                is_active=True,
                sort_order=1,
            ),
            InventoryReplenishmentSetting(
                project_id=project.id,
                project_name=project.project_name,
                sku="SKU-A",
                country="US",
                safety_factor=Decimal("0.5"),
                shipping_days=31,
            ),
        ]
    )
    db_session.flush()

    with (
        patch.object(replenishment, "_aggregate_inventory_source_rows", return_value={"SKU-A": SimpleNamespace(available_qty=7)}),
        patch.object(replenishment, "_get_shipping_plan_inventory_source", return_value=SimpleNamespace(ingestion_status="success", report_date=date(2026, 10, 7), id=1)),
        patch.object(replenishment, "_load_sales_dms_map", side_effect=[{"SKU-A": Decimal(1)}, {"SKU-A": Decimal(2)}, {"SKU-A": Decimal(3)}, {"SKU-A": Decimal(4)}]),
    ):
        baseline = replenishment.load_shipping_plan_baseline(
            db_session, project_id=project.id, country="US", as_of_date=date(2026, 10, 8)
        )

    assert len(baseline.items) == 1
    item = baseline.items[0]
    assert item.sku == "SKU-A"
    assert item.available_inventory == 7
    assert item.base_dms == Decimal("2.8")
    assert item.base_dms != item.base_dms * Decimal("1.5")
    assert item.shipping_days == 31
    assert baseline.country == "US"


def test_shipping_baseline_keeps_missing_inventory_and_sales_as_unknown(db_session):
    project = Project(project_name="blf1286 shipping missing", sort_order=0)
    db_session.add(project)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku="SKU-MISSING",
            asin="ASIN-MISSING",
            country="US",
            is_active=True,
            sort_order=1,
        )
    )
    db_session.flush()

    with (
        patch.object(replenishment, "_aggregate_inventory_source_rows", return_value={}),
        patch.object(replenishment, "_load_sales_dms_map", return_value={}),
    ):
        baseline = replenishment.load_shipping_plan_baseline(
            db_session, project_id=project.id, country="US", as_of_date=date(2026, 10, 8)
        )

    assert len(baseline.items) == 1
    assert baseline.items[0].available_inventory is None
    assert baseline.items[0].base_dms is None
    assert baseline.items[0].inventory_snapshot_date is None
