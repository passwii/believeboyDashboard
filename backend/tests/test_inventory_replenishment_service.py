from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import (
    AnalysisBusinessRow,
    AnalysisSourceFile,
    DailySalesOrder,
    DailySourceFile,
    InventorySnapshotRow,
    ProductCost,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.services import inventory_replenishment_service


def test_inventory_replenishment_analysis_aggregates_sources():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name='宝勒1店',
                    sku='SKU-001',
                    asin='ASIN-001',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=1,
                    is_active=True,
                ),
                ProductCost(
                    project_name='宝勒1店',
                    sku='SKU-002',
                    asin='ASIN-002',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=2,
                    is_active=True,
                ),
            ]
        )

        inventory_source = AnalysisSourceFile(
            project_id=project.id,
            report_type='inventory_report',
            snapshot_at=datetime(2026, 3, 8, tzinfo=UTC),
            version=1,
            is_current=True,
            upload_file_id='inventory-1',
            upload_file_path='/tmp/inventory.txt',
            stored_filename='inventory.txt',
            logical_filename='inventory.txt',
            storage_key='inventory.txt',
            original_filename='inventory.txt',
            ingestion_status='success',
        )
        business_30 = AnalysisSourceFile(
            project_id=project.id,
            report_type='business_report',
            period_start_date=date(2026, 2, 7),
            period_end_date=date(2026, 3, 8),
            version=1,
            is_current=True,
            upload_file_id='business-30',
            upload_file_path='/tmp/business30.csv',
            stored_filename='business30.csv',
            logical_filename='business30.csv',
            storage_key='business30.csv',
            original_filename='business30.csv',
            ingestion_status='success',
        )
        business_14 = AnalysisSourceFile(
            project_id=project.id,
            report_type='business_report',
            period_start_date=date(2026, 2, 23),
            period_end_date=date(2026, 3, 8),
            version=1,
            is_current=True,
            upload_file_id='business-14',
            upload_file_path='/tmp/business14.csv',
            stored_filename='business14.csv',
            logical_filename='business14.csv',
            storage_key='business14.csv',
            original_filename='business14.csv',
            ingestion_status='success',
        )
        business_7 = AnalysisSourceFile(
            project_id=project.id,
            report_type='business_report',
            period_start_date=date(2026, 3, 2),
            period_end_date=date(2026, 3, 8),
            version=1,
            is_current=True,
            upload_file_id='business-7',
            upload_file_path='/tmp/business7.csv',
            stored_filename='business7.csv',
            logical_filename='business7.csv',
            storage_key='business7.csv',
            original_filename='business7.csv',
            ingestion_status='success',
        )
        daily_source = DailySourceFile(
            project_id=project.id,
            report_type='sales_report',
            report_date=date(2026, 3, 7),
            version=1,
            is_current=True,
            upload_file_id='daily-1',
            upload_file_path='/tmp/daily.txt',
            stored_filename='daily.txt',
            logical_filename='daily.txt',
            storage_key='daily.txt',
            original_filename='daily.txt',
            ingestion_status='success',
        )
        db.add_all([inventory_source, business_30, business_14, business_7, daily_source])
        db.flush()

        db.add_all(
            [
                InventorySnapshotRow(
                    source_file_id=inventory_source.id,
                    source_row_no=1,
                    sku='SKU-001',
                    asin='ASIN-001',
                    available_qty=120,
                    age_0_90_qty=120,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    stock_status='in_stock',
                    aging_status='fresh',
                    raw_row={},
                ),
                AnalysisBusinessRow(
                    source_file_id=business_30.id,
                    source_row_no=1,
                    asin='ASIN-001',
                    page_views=0,
                    units_ordered=90,
                    sessions=0,
                    ordered_sales_amount=0,
                    raw_row={},
                ),
                AnalysisBusinessRow(
                    source_file_id=business_14.id,
                    source_row_no=1,
                    asin='ASIN-001',
                    page_views=0,
                    units_ordered=56,
                    sessions=0,
                    ordered_sales_amount=0,
                    raw_row={},
                ),
                AnalysisBusinessRow(
                    source_file_id=business_7.id,
                    source_row_no=1,
                    asin='ASIN-001',
                    page_views=0,
                    units_ordered=35,
                    sessions=0,
                    ordered_sales_amount=0,
                    raw_row={},
                ),
                DailySalesOrder(
                    source_file_id=daily_source.id,
                    source_row_no=1,
                    amazon_order_id='ORDER-1',
                    purchase_at_utc=datetime(2026, 3, 7, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 7, 8, 0, 0),
                    purchase_date_pt=date(2026, 3, 7),
                    order_status='Shipped',
                    sku='SKU-001',
                    asin='ASIN-001',
                    quantity=9,
                    item_price=0,
                    currency='USD',
                    is_counted_sales=True,
                    status_rule_version=1,
                    raw_row={},
                ),
            ]
        )

        schedule = ShipmentSchedule(
            project_id=project.id,
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-001',
            shipping_method='sea',
            shipment_status='in_transit',
            source_type='manual',
        )
        db.add(schedule)
        db.flush()
        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=project.id,
                shipment_no='SHP-001',
                item_date=date(2026, 3, 8),
                sku='SKU-001',
                quantity=60,
                source_type='manual',
            )
        )
        db.commit()

        items, summary, total, has_next = inventory_replenishment_service.list_inventory_replenishment_analysis(
            db,
            project_id=project.id,
            country='US',
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            page=1,
            page_size=20,
        )

        assert total == 2
        assert has_next is False
        assert summary['sku_count'] == 2
        row = next(item for item in items if item['sku'] == 'SKU-001')
        assert row['available_inventory'] == 120
        assert row['in_transit_quantity'] == 60
        assert row['dms_30'] == 3.0
        assert row['dms_14'] == 4.0
        assert row['dms_7'] == 5.0
        assert row['dms_3'] == 3.0
        assert row['base_dms'] == 3.9
        assert row['weighted_dms'] == 4.68
        assert row['risk_status'] in {'未来健康', '滞销风险', '断货风险'}


def test_upsert_inventory_replenishment_setting_updates_row():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.commit()

        created = inventory_replenishment_service.upsert_inventory_replenishment_setting(
            db,
            project_id=project.id,
            sku='SKU-001',
            country='US',
            asin='ASIN-001',
            production_lead_days=18,
            shipping_days=22,
            safety_factor=0.15,
            operator='tester',
        )
        db.commit()

        updated = inventory_replenishment_service.upsert_inventory_replenishment_setting(
            db,
            project_id=project.id,
            sku='SKU-001',
            country='US',
            asin='ASIN-001',
            production_lead_days=20,
            shipping_days=25,
            safety_factor=0.25,
            operator='tester',
        )
        db.commit()

        assert created.id == updated.id
        assert updated.production_lead_days == 20
        assert updated.shipping_days == 25
        assert updated.safety_factor == Decimal('0.25')


def test_inventory_replenishment_analysis_lists_all_active_skus_for_project_name_variants():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='Demo Store', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name=' demo store ',
                    sku='SKU-001',
                    asin='ASIN-001',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=1,
                    is_active=True,
                ),
                ProductCost(
                    project_name='DEMO STORE',
                    sku='SKU-002',
                    asin='ASIN-002',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=2,
                    is_active=True,
                ),
                ProductCost(
                    project_name='Demo Store',
                    sku='SKU-003',
                    asin='ASIN-003',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=3,
                    is_active=False,
                ),
            ]
        )
        db.commit()

        items, summary, total, has_next = inventory_replenishment_service.list_inventory_replenishment_analysis(
            db,
            project_id=project.id,
            country='US',
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            page=1,
            page_size=20,
        )

        assert has_next is False
        assert total == 2
        assert summary['sku_count'] == 2
        assert [item['sku'] for item in items] == ['SKU-001', 'SKU-002']


def test_inventory_replenishment_analysis_preserves_product_cost_sort_order():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='Order Demo', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name='Order Demo',
                    sku='SKU-B',
                    asin='ASIN-B',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=2,
                    is_active=True,
                ),
                ProductCost(
                    project_name='Order Demo',
                    sku='SKU-A',
                    asin='ASIN-A',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=1,
                    is_active=True,
                ),
            ]
        )
        db.commit()

        items, summary, total, has_next = inventory_replenishment_service.list_inventory_replenishment_analysis(
            db,
            project_id=project.id,
            country='US',
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            page=1,
            page_size=20,
        )

        assert has_next is False
        assert total == 2
        assert summary['sku_count'] == 2
        assert [item['sku'] for item in items] == ['SKU-A', 'SKU-B']


def test_inventory_replenishment_analysis_filters_base_skus_by_country():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='Country Demo', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name='Country Demo',
                    sku='SKU-US',
                    asin='ASIN-US',
                    fob_unit_cost=2,
                    currency='USD',
                    country='US',
                    sort_order=1,
                    is_active=True,
                ),
                ProductCost(
                    project_name='Country Demo',
                    sku='SKU-DE',
                    asin='ASIN-DE',
                    fob_unit_cost=2,
                    currency='EUR',
                    country='DE',
                    sort_order=2,
                    is_active=True,
                ),
            ]
        )
        db.commit()

        items, summary, total, has_next = inventory_replenishment_service.list_inventory_replenishment_analysis(
            db,
            project_id=project.id,
            country='DE',
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            page=1,
            page_size=20,
        )

        assert has_next is False
        assert total == 1
        assert summary['sku_count'] == 1
        assert items[0]['sku'] == 'SKU-DE'
        assert items[0]['country'] == 'DE'


def test_inventory_replenishment_analysis_filters_sources_by_country():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='Country Source Demo', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add(ProductCost(
            project_name='Country Source Demo',
            sku='SKU-DE',
            asin='ASIN-DE',
            fob_unit_cost=2,
            currency='EUR',
            country='DE',
            sort_order=1,
            is_active=True,
        ))

        inventory_source_us = AnalysisSourceFile(
            project_id=project.id,
            report_type='inventory_report',
            country='US',
            snapshot_at=datetime(2026, 3, 8, tzinfo=UTC),
            version=1,
            is_current=True,
            upload_file_id='inventory-us',
            upload_file_path='/tmp/inventory-us.txt',
            stored_filename='inventory-us.txt',
            logical_filename='inventory-us.txt',
            storage_key='inventory-us.txt',
            original_filename='inventory-us.txt',
            ingestion_status='success',
        )
        inventory_source_de = AnalysisSourceFile(
            project_id=project.id,
            report_type='inventory_report',
            country='DE',
            snapshot_at=datetime(2026, 3, 8, tzinfo=UTC),
            version=1,
            is_current=True,
            upload_file_id='inventory-de',
            upload_file_path='/tmp/inventory-de.txt',
            stored_filename='inventory-de.txt',
            logical_filename='inventory-de.txt',
            storage_key='inventory-de.txt',
            original_filename='inventory-de.txt',
            ingestion_status='success',
        )
        daily_source_us = DailySourceFile(
            project_id=project.id,
            report_type='sales_report',
            country='US',
            report_date=date(2026, 3, 8),
            version=1,
            is_current=True,
            upload_file_id='daily-us',
            upload_file_path='/tmp/daily-us.txt',
            stored_filename='daily-us.txt',
            logical_filename='daily-us.txt',
            storage_key='daily-us.txt',
            original_filename='daily-us.txt',
            ingestion_status='success',
        )
        daily_source_de = DailySourceFile(
            project_id=project.id,
            report_type='sales_report',
            country='DE',
            report_date=date(2026, 3, 8),
            version=1,
            is_current=True,
            upload_file_id='daily-de',
            upload_file_path='/tmp/daily-de.txt',
            stored_filename='daily-de.txt',
            logical_filename='daily-de.txt',
            storage_key='daily-de.txt',
            original_filename='daily-de.txt',
            ingestion_status='success',
        )
        db.add_all([inventory_source_us, inventory_source_de, daily_source_us, daily_source_de])
        db.flush()

        db.add_all(
            [
                InventorySnapshotRow(
                    source_file_id=inventory_source_us.id,
                    source_row_no=1,
                    sku='SKU-DE',
                    asin='ASIN-DE',
                    available_qty=999,
                    age_0_90_qty=0,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    recommended_action=None,
                    stock_status='in_stock',
                    aging_status='fresh',
                    raw_row={},
                ),
                InventorySnapshotRow(
                    source_file_id=inventory_source_de.id,
                    source_row_no=1,
                    sku='SKU-DE',
                    asin='ASIN-DE',
                    available_qty=12,
                    age_0_90_qty=0,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    recommended_action=None,
                    stock_status='in_stock',
                    aging_status='fresh',
                    raw_row={},
                ),
                DailySalesOrder(
                    source_file_id=daily_source_us.id,
                    source_row_no=1,
                    amazon_order_id='ORDER-US',
                    purchase_at_utc=datetime(2026, 3, 7, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 7, 8, 0, 0),
                    purchase_date_pt=date(2026, 3, 7),
                    order_status='Shipped',
                    sku='SKU-DE',
                    asin='ASIN-DE',
                    quantity=99,
                    item_price=0,
                    currency='USD',
                    is_counted_sales=True,
                    status_rule_version=1,
                    raw_row={},
                ),
                DailySalesOrder(
                    source_file_id=daily_source_de.id,
                    source_row_no=1,
                    amazon_order_id='ORDER-DE',
                    purchase_at_utc=datetime(2026, 3, 7, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 7, 8, 0, 0),
                    purchase_date_pt=date(2026, 3, 7),
                    order_status='Shipped',
                    sku='SKU-DE',
                    asin='ASIN-DE',
                    quantity=6,
                    item_price=0,
                    currency='EUR',
                    is_counted_sales=True,
                    status_rule_version=1,
                    raw_row={},
                ),
            ]
        )
        db.commit()

        items, summary, total, has_next = inventory_replenishment_service.list_inventory_replenishment_analysis(
            db,
            project_id=project.id,
            country='DE',
            keyword=None,
            risk_status=None,
            in_transit_only=False,
            page=1,
            page_size=20,
        )

        assert has_next is False
        assert total == 1
        assert summary['sku_count'] == 1
        assert items[0]['available_inventory'] == 12
        assert items[0]['dms_3'] == 2.0


def test_upsert_inventory_replenishment_setting_separates_country_rows():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='Country Demo', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.commit()

        us_row = inventory_replenishment_service.upsert_inventory_replenishment_setting(
            db,
            project_id=project.id,
            sku='SKU-001',
            country='US',
            asin='ASIN-US',
            production_lead_days=20,
            shipping_days=25,
            safety_factor=0.2,
            operator='tester',
        )
        de_row = inventory_replenishment_service.upsert_inventory_replenishment_setting(
            db,
            project_id=project.id,
            sku='SKU-001',
            country='DE',
            asin='ASIN-DE',
            production_lead_days=30,
            shipping_days=35,
            safety_factor=0.3,
            operator='tester',
        )
        db.commit()

        assert us_row.id != de_row.id
        assert us_row.country == 'US'
        assert de_row.country == 'DE'


def test_normalize_weighted_dms_keeps_missing_windows_unscaled():
    result = inventory_replenishment_service._normalize_weighted_dms(
        Decimal('3'),
        Decimal('4'),
        Decimal('5'),
        None,
    )

    assert result == Decimal('3.0')


def test_load_daily_dms_map_uses_lagged_three_day_window():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='Lag Demo', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        source = DailySourceFile(
            project_id=project.id,
            report_type='sales_report',
            report_date=date(2026, 3, 8),
            version=1,
            is_current=True,
            upload_file_id='daily-lag',
            upload_file_path='/tmp/daily-lag.txt',
            stored_filename='daily-lag.txt',
            logical_filename='daily-lag.txt',
            storage_key='daily-lag.txt',
            original_filename='daily-lag.txt',
            ingestion_status='success',
        )
        db.add(source)
        db.flush()

        db.add_all(
            [
                DailySalesOrder(
                    source_file_id=source.id,
                    source_row_no=1,
                    amazon_order_id='ORDER-IN',
                    purchase_at_utc=datetime(2026, 3, 7, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 7, 8, 0, 0),
                    purchase_date_pt=date(2026, 3, 7),
                    order_status='Shipped',
                    sku='SKU-001',
                    asin='ASIN-001',
                    quantity=6,
                    item_price=0,
                    currency='USD',
                    is_counted_sales=True,
                    status_rule_version=1,
                    raw_row={},
                ),
                DailySalesOrder(
                    source_file_id=source.id,
                    source_row_no=2,
                    amazon_order_id='ORDER-OUT',
                    purchase_at_utc=datetime(2026, 3, 8, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 8, 8, 0, 0),
                    purchase_date_pt=date(2026, 3, 8),
                    order_status='Shipped',
                    sku='SKU-001',
                    asin='ASIN-001',
                    quantity=9,
                    item_price=0,
                    currency='USD',
                    is_counted_sales=True,
                    status_rule_version=1,
                    raw_row={},
                ),
            ]
        )
        db.commit()

        dms_map = inventory_replenishment_service._load_daily_dms_map(db, project.id, 'US', date(2026, 3, 9))

        assert dms_map['SKU-001'] == Decimal('2')
