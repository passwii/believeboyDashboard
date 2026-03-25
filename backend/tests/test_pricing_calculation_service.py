from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import Project
from app.models.shipment_sku_summary import ShipmentSkuSummary
from app.schemas.pricing_calculation import (
    PricingCalculationCostReverseRequest,
    PricingCalculationCreateRequest,
)
from app.services import pricing_calculation_service


def test_compute_pricing_prefers_historical_shipping_cost_from_summary():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add(
            ShipmentSkuSummary(
                project_id=project.id,
                project_name_snapshot=project.project_name,
                sku='SKU-001',
                shipment_count=3,
                total_quantity=120,
                total_chargeable_weight_kg=80,
                total_logistics_cost=360,
                average_logistics_unit_price=3,
            )
        )
        db.commit()

        payload = PricingCalculationCreateRequest(
            product_name='宝勒1店 / SKU-001',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            fob_product_cost_rmb=12,
            first_leg_cost_rmb=99,
            project_id=project.id,
            sku='SKU-001',
            use_historical_shipping_cost=True,
            sale_price_usd=29.9,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1,
            inbound_placement_mode='single_destination',
            usd_to_rmb_rate=7.2,
        )

        computed = pricing_calculation_service._compute_pricing(payload, db)

        assert float(computed['inputs']['first_leg_cost_rmb']) == 3.0
        assert '头程历史加权成本' not in computed['warnings']


def test_create_cost_reverse_run_persists_single_cost_reverse_record():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        payload = PricingCalculationCostReverseRequest(
            product_name='成本倒推产品',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            first_leg_cost_rmb=8,
            sale_price_usd=29.9,
            target_profit_rate=0.25,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1,
            inbound_placement_mode='single_destination',
            usd_to_rmb_rate=7.2,
        )

        row = pricing_calculation_service.create_pricing_cost_reverse_run(db, payload)
        db.commit()
        db.refresh(row)

        rows, total = pricing_calculation_service.list_pricing_runs(db, page=1, page_size=20)

        assert total == 1
        assert len(rows) == 1
        assert row.calculation_type == 'cost_reverse'
        assert rows[0].id == row.id
        assert rows[0].calculation_type == 'cost_reverse'
        assert abs(float(row.profit_rate) - 0.25) < 0.01
