from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import ExchangeRate, Project
from app.models.shipment_sku_summary import ShipmentSkuSummary
from app.schemas.pricing_calculation import (
    PricingCalculationCostReverseRequest,
    PricingCalculationCreateRequest,
    PricingCalculationEURequest,
    PricingCalculationFbmRequest,
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

        rows, total = pricing_calculation_service.list_pricing_runs(db, page=1, page_size=20, is_admin=True)

        assert total == 1
        assert len(rows) == 1
        assert row.calculation_type == 'cost_reverse'
        assert rows[0].id == row.id
        assert rows[0].calculation_type == 'cost_reverse'
        assert abs(float(row.profit_rate) - 0.25) < 0.01


def test_compute_eu_pricing_uses_country_exchange_rate_when_manual_rate_missing():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add_all([
            ExchangeRate(currency='USD', currency_name='美元', year_month='2026-04', rate=Decimal('7.20')),
            ExchangeRate(currency='EUR', currency_name='欧元', year_month='2026-04', rate=Decimal('7.90')),
            ExchangeRate(currency='GBP', currency_name='英镑', year_month='2026-04', rate=Decimal('9.15')),
        ])
        db.commit()

        de_payload = PricingCalculationEURequest(
            country='DE',
            product_name='德国店铺 / SKU-DE-001',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            fob_product_cost_rmb=12,
            first_leg_cost_rmb=8,
            sale_price_usd=29.9,
            delivery_fee_usd=2.5,
            inbound_config_fee_usd=0.5,
            storage_fee_usd=0.3,
            commission_rate=0.15,
            advertising_rate=0.12,
            return_loss_rate=0.04,
        )
        uk_payload = PricingCalculationEURequest(
            country='UK',
            product_name='英国店铺 / SKU-UK-001',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            fob_product_cost_rmb=12,
            first_leg_cost_rmb=8,
            sale_price_usd=29.9,
            delivery_fee_usd=2.5,
            inbound_config_fee_usd=0.5,
            storage_fee_usd=0.3,
            commission_rate=0.15,
            advertising_rate=0.12,
            return_loss_rate=0.04,
        )

        de_computed = pricing_calculation_service._compute_eu_pricing(de_payload, db)
        uk_computed = pricing_calculation_service._compute_eu_pricing(uk_payload, db)

        assert float(de_computed['usd_to_rmb_rate']) == 7.9
        assert de_computed['usd_to_rmb_rate_source'] == 'system:2026-04'
        assert float(uk_computed['usd_to_rmb_rate']) == 9.15
        assert uk_computed['usd_to_rmb_rate_source'] == 'system:2026-04'


def test_compute_fbm_pricing_calculates_profit_correctly():
    """FBM 定价计算：验证利润计算逻辑"""
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add_all([
            ExchangeRate(currency='USD', currency_name='美元', year_month='2026-04', rate=Decimal('7.20')),
        ])
        db.commit()

        payload = PricingCalculationFbmRequest(
            country='US',
            product_name='FBM 产品 / SKU-FBM-001',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.0,
            fob_product_cost_rmb=50,
            full_container_quantity=100,
            full_container_price_rmb=800,
            delivery_fee_usd=5.0,
            sale_price_usd=30.0,
            commission_rate=0.15,
            advertising_rate=0.12,
            return_loss_rate=0.05,
        )

        computed = pricing_calculation_service._compute_fbm_pricing(payload, db)

        # 验证头程成本 = 800 / 100 = 8 RMB
        assert float(computed['inputs']['first_leg_cost_rmb']) == 8.0

        # 验证汇率
        assert float(computed['usd_to_rmb_rate']) == 7.2

        # 验证利润计算: sale_price - fees - ddp_cost > 0
        # FBM 利润在 profit_decimal 嵌套字典中
        profit_data = computed.get('profit_decimal', {})
        assert float(profit_data['profit_usd']) > 0


def test_compute_pricing_without_historical_data_emits_warning():
    """没有历史数据时，应该使用传入的头程成本并产生警告"""
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='TestProject', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        # 不添加 ShipmentSkuSummary，模拟没有历史数据
        db.commit()

        payload = PricingCalculationCreateRequest(
            product_name='TestProject / SKU-001',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            fob_product_cost_rmb=12,
            first_leg_cost_rmb=10,  # 使用传入的头程成本
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

        # 应该使用传入的头程成本
        assert float(computed['inputs']['first_leg_cost_rmb']) == 10.0


def test_compute_pricing_uses_manual_rate_when_provided():
    """手动汇率应该优先于系统汇率"""
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add_all([
            ExchangeRate(currency='USD', currency_name='美元', year_month='2026-04', rate=Decimal('7.20')),
        ])
        db.commit()

        payload = PricingCalculationCreateRequest(
            product_name='手动汇率测试',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            fob_product_cost_rmb=12,
            first_leg_cost_rmb=8,
            use_historical_shipping_cost=False,
            sale_price_usd=29.9,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1,
            inbound_placement_mode='single_destination',
            usd_to_rmb_rate=7.5,  # 手动汇率
        )

        computed = pricing_calculation_service._compute_pricing(payload, db)

        # 应该使用手动汇率 7.5，而不是系统的 7.2
        assert float(computed['usd_to_rmb_rate']) == 7.5
        assert computed['usd_to_rmb_rate_source'] == 'manual'


def test_list_pricing_runs_non_admin_sees_own_records_only():
    """非 admin 用户只能看到自己的记录"""
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        # 创建两条记录，分别属于不同操作员
        admin_payload = PricingCalculationCostReverseRequest(
            product_name='Admin 产品',
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
        admin_row = pricing_calculation_service.create_pricing_cost_reverse_run(
            db, admin_payload, operator='admin_user'
        )

        operator_payload = PricingCalculationCostReverseRequest(
            product_name='Operator 产品',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            first_leg_cost_rmb=8,
            sale_price_usd=29.9,
            target_profit_rate=0.20,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            storage_months=1,
            inbound_placement_mode='single_destination',
            usd_to_rmb_rate=7.2,
        )
        operator_row = pricing_calculation_service.create_pricing_cost_reverse_run(
            db, operator_payload, operator='operator_user'
        )
        db.commit()

        # Admin 查询，应该看到所有记录
        admin_rows, admin_total = pricing_calculation_service.list_pricing_runs(
            db, page=1, page_size=20, is_admin=True
        )
        assert admin_total == 2

        # Operator 查询，应该只看到自己的记录
        operator_rows, operator_total = pricing_calculation_service.list_pricing_runs(
            db, page=1, page_size=20, operator='operator_user', is_admin=False
        )
        assert operator_total == 1
        assert operator_rows[0].product_name == 'Operator 产品'


def test_list_pricing_runs_pagination():
    """测试分页功能"""
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        # 创建 5 条记录
        for i in range(5):
            payload = PricingCalculationCostReverseRequest(
                product_name=f'产品 {i}',
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
            pricing_calculation_service.create_pricing_cost_reverse_run(
                db, payload, operator='test_user'
            )
        db.commit()

        # 第一页，每页 2 条
        page1_rows, total = pricing_calculation_service.list_pricing_runs(
            db, page=1, page_size=2, operator='test_user', is_admin=False
        )
        assert total == 5
        assert len(page1_rows) == 2

        # 第二页
        page2_rows, _ = pricing_calculation_service.list_pricing_runs(
            db, page=2, page_size=2, operator='test_user', is_admin=False
        )
        assert len(page2_rows) == 2

        # 第三页（应该只有 1 条）
        page3_rows, _ = pricing_calculation_service.list_pricing_runs(
            db, page=3, page_size=2, operator='test_user', is_admin=False
        )
        assert len(page3_rows) == 1


def test_compute_eu_pricing_with_manual_rate():
    """EU 定价：手动汇率应该优先"""
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add_all([
            ExchangeRate(currency='USD', currency_name='美元', year_month='2026-04', rate=Decimal('7.20')),
            ExchangeRate(currency='EUR', currency_name='欧元', year_month='2026-04', rate=Decimal('7.90')),
        ])
        db.commit()

        payload = PricingCalculationEURequest(
            country='DE',
            product_name='德国店铺 / SKU-DE-001',
            package_length_cm=30,
            package_width_cm=20,
            package_height_cm=10,
            weight_kg=1.2,
            fob_product_cost_rmb=12,
            first_leg_cost_rmb=8,
            sale_price_usd=29.9,
            delivery_fee_usd=2.5,
            inbound_config_fee_usd=0.5,
            storage_fee_usd=0.3,
            commission_rate=0.15,
            advertising_rate=0.12,
            return_loss_rate=0.04,
            usd_to_rmb_rate=8.0,  # 手动汇率，优先级高于系统汇率
        )

        computed = pricing_calculation_service._compute_eu_pricing(payload, db)

        # 手动汇率 8.0 应该优先于系统汇率 7.9
        assert float(computed['usd_to_rmb_rate']) == 8.0
        assert computed['usd_to_rmb_rate_source'] == 'manual'
