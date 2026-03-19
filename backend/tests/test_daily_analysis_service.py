from datetime import UTC, date, datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import AnalysisAdProductRow, AnalysisSalesOrderRow, AnalysisSourceFile, InventorySnapshotRow, Project
from app.services import daily_analysis_service


def test_build_daily_analysis_aggregates_summary_and_detail_rows():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='日报项目', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        sales_source = AnalysisSourceFile(
            project_id=project.id,
            report_type='sales_report',
            country='US',
            report_date=date(2026, 3, 10),
            period_start_date=date(2026, 3, 10),
            period_end_date=date(2026, 3, 10),
            version=1,
            is_current=True,
            upload_file_id='sales-1',
            upload_file_path='/tmp/sales-1.txt',
            stored_filename='sales-1.txt',
            logical_filename='sales-1.txt',
            storage_key='sales-1.txt',
            original_filename='sales-1.txt',
            ingestion_status='success',
        )
        ad_source = AnalysisSourceFile(
            project_id=project.id,
            report_type='ad_product_report',
            country='US',
            report_date=date(2026, 3, 10),
            period_start_date=date(2026, 3, 10),
            period_end_date=date(2026, 3, 10),
            version=1,
            is_current=True,
            upload_file_id='ad-1',
            upload_file_path='/tmp/ad-1.xlsx',
            stored_filename='ad-1.xlsx',
            logical_filename='ad-1.xlsx',
            storage_key='ad-1.xlsx',
            original_filename='ad-1.xlsx',
            ingestion_status='success',
        )
        inventory_old = AnalysisSourceFile(
            project_id=project.id,
            report_type='inventory_report',
            country='US',
            report_date=date(2026, 3, 10),
            snapshot_at=datetime(2026, 3, 10, 8, 0, tzinfo=UTC),
            version=1,
            is_current=False,
            upload_file_id='inventory-old',
            upload_file_path='/tmp/inventory-old.txt',
            stored_filename='inventory-old.txt',
            logical_filename='inventory-old.txt',
            storage_key='inventory-old.txt',
            original_filename='inventory-old.txt',
            ingestion_status='success',
        )
        inventory_new = AnalysisSourceFile(
            project_id=project.id,
            report_type='inventory_report',
            country='US',
            report_date=date(2026, 3, 10),
            snapshot_at=datetime(2026, 3, 10, 18, 0, tzinfo=UTC),
            version=2,
            is_current=True,
            upload_file_id='inventory-new',
            upload_file_path='/tmp/inventory-new.txt',
            stored_filename='inventory-new.txt',
            logical_filename='inventory-new.txt',
            storage_key='inventory-new.txt',
            original_filename='inventory-new.txt',
            ingestion_status='success',
        )
        db.add_all([sales_source, ad_source, inventory_old, inventory_new])
        db.flush()

        db.add_all(
            [
                AnalysisSalesOrderRow(
                    source_file_id=sales_source.id,
                    source_row_no=1,
                    amazon_order_id='ORDER-1',
                    purchase_at_utc=datetime(2026, 3, 10, 1, 0, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 9, 17, 0),
                    purchase_date_pt=date(2026, 3, 9),
                    order_status='Shipped',
                    sku='SKU-1',
                    asin='ASIN-1',
                    quantity=3,
                    item_price=30,
                    currency='USD',
                    is_counted_sales=True,
                    status_rule_version=1,
                    raw_row={},
                ),
                AnalysisSalesOrderRow(
                    source_file_id=sales_source.id,
                    source_row_no=2,
                    amazon_order_id='ORDER-2',
                    purchase_at_utc=datetime(2026, 3, 10, 2, 0, tzinfo=UTC),
                    purchase_at_pt=datetime(2026, 3, 9, 18, 0),
                    purchase_date_pt=date(2026, 3, 9),
                    order_status='Cancelled',
                    sku='SKU-2',
                    asin='ASIN-2',
                    quantity=10,
                    item_price=100,
                    currency='USD',
                    is_counted_sales=False,
                    status_rule_version=1,
                    raw_row={},
                ),
                AnalysisAdProductRow(
                    source_file_id=ad_source.id,
                    source_row_no=1,
                    sku='SKU-1',
                    asin='ASIN-1',
                    impressions=100,
                    clicks=5,
                    spend=12.5,
                    sales_7d=0,
                    orders_7d=2,
                    scope_status='included_product',
                    scope_reason=None,
                    raw_row={},
                ),
                AnalysisAdProductRow(
                    source_file_id=ad_source.id,
                    source_row_no=2,
                    sku='SKU-X',
                    asin='ASIN-X',
                    impressions=50,
                    clicks=0,
                    spend=3,
                    sales_7d=0,
                    orders_7d=1,
                    scope_status='included_product',
                    scope_reason=None,
                    raw_row={},
                ),
                InventorySnapshotRow(
                    source_file_id=inventory_old.id,
                    source_row_no=1,
                    sku='SKU-1',
                    asin='ASIN-1',
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
                    source_file_id=inventory_new.id,
                    source_row_no=1,
                    sku='SKU-1',
                    asin='ASIN-1',
                    available_qty=20,
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
            ]
        )
        db.commit()

        payload = daily_analysis_service.build_daily_analysis(
            db,
            project_id=project.id,
            country='US',
            start_date='2026-03-10',
            end_date='2026-03-10',
        )

        assert payload['console']['summary_days'] == 1
        assert payload['console']['sales_source_days'] == 1
        assert payload['console']['ad_source_days'] == 1
        assert payload['console']['inventory_source_days'] == 1
        assert payload['console']['missing_dates'] == []
        assert payload['console']['latest_inventory_date'] == '2026-03-10'

        summary_row = payload['summary_rows'][0]
        assert summary_row['date'] == '2026-03-10'
        assert summary_row['order_qty'] == 3
        assert summary_row['sales_amount'] == 30.0
        assert summary_row['impressions'] == 150
        assert summary_row['clicks'] == 5
        assert summary_row['cpc'] == 3.1
        assert summary_row['ad_spend'] == 15.5
        assert summary_row['ad_orders'] == 3
        assert summary_row['available_qty'] == 20

        detail_rows = payload['detail_rows']
        assert len(detail_rows) == 2
        assert detail_rows[0]['sku'] == 'SKU-1'
        assert detail_rows[0]['available_qty'] == 20
        assert detail_rows[1]['sku'] == 'SKU-X'
        assert detail_rows[1]['sales_amount'] == 0.0


def test_build_daily_analysis_prefers_inventory_report_date_over_snapshot_timestamp():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='日报项目', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        inventory_source = AnalysisSourceFile(
            project_id=project.id,
            report_type='inventory_report',
            country='US',
            report_date=date(2026, 3, 17),
            snapshot_at=datetime(2026, 3, 18, 1, 0, tzinfo=UTC),
            version=1,
            is_current=True,
            upload_file_id='inventory-1',
            upload_file_path='/tmp/inventory-1.txt',
            stored_filename='inventory-1.txt',
            logical_filename='inventory-1.txt',
            storage_key='inventory-1.txt',
            original_filename='inventory-1.txt',
            ingestion_status='success',
        )
        db.add(inventory_source)
        db.flush()

        db.add(
            InventorySnapshotRow(
                source_file_id=inventory_source.id,
                source_row_no=1,
                sku='SKU-1',
                asin='ASIN-1',
                available_qty=25,
                age_0_90_qty=0,
                age_91_180_qty=0,
                age_181_270_qty=0,
                age_271_365_qty=0,
                age_365_plus_qty=0,
                recommended_action=None,
                stock_status='in_stock',
                aging_status='fresh',
                raw_row={},
            )
        )
        db.commit()

        payload = daily_analysis_service.build_daily_analysis(
            db,
            project_id=project.id,
            country='US',
            start_date='2026-03-17',
            end_date='2026-03-17',
        )

        assert payload['console']['inventory_source_days'] == 1
        assert payload['console']['latest_inventory_date'] == '2026-03-17'
        assert payload['console']['missing_dates'] == ['2026-03-17']
        assert payload['available_dates']['inventory_report'] == ['2026-03-17']
        assert payload['summary_rows'][0]['date'] == '2026-03-17'
        assert payload['summary_rows'][0]['available_qty'] == 25


def test_build_daily_analysis_marks_missing_dates():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='日报项目', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.commit()

        payload = daily_analysis_service.build_daily_analysis(
            db,
            project_id=project.id,
            country='US',
            start_date='2026-03-10',
            end_date='2026-03-11',
        )

        assert payload['summary_rows'] == []
        assert payload['detail_rows'] == []
        assert payload['console']['missing_dates'] == ['2026-03-10', '2026-03-11']


def test_build_daily_analysis_uses_global_latest_dates_for_availability_console():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='日报项目', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add_all(
            [
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type='sales_report',
                    country='US',
                    report_date=date(2026, 3, 10),
                    period_start_date=date(2026, 3, 10),
                    period_end_date=date(2026, 3, 10),
                    version=1,
                    is_current=True,
                    upload_file_id='sales-10',
                    upload_file_path='/tmp/sales-10.txt',
                    stored_filename='sales-10.txt',
                    logical_filename='sales-10.txt',
                    storage_key='sales-10.txt',
                    original_filename='sales-10.txt',
                    ingestion_status='success',
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type='sales_report',
                    country='US',
                    report_date=date(2026, 3, 18),
                    period_start_date=date(2026, 3, 18),
                    period_end_date=date(2026, 3, 18),
                    version=1,
                    is_current=True,
                    upload_file_id='sales-18',
                    upload_file_path='/tmp/sales-18.txt',
                    stored_filename='sales-18.txt',
                    logical_filename='sales-18.txt',
                    storage_key='sales-18.txt',
                    original_filename='sales-18.txt',
                    ingestion_status='success',
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type='ad_product_report',
                    country='US',
                    report_date=date(2026, 3, 17),
                    period_start_date=date(2026, 3, 17),
                    period_end_date=date(2026, 3, 17),
                    version=1,
                    is_current=True,
                    upload_file_id='ad-17',
                    upload_file_path='/tmp/ad-17.xlsx',
                    stored_filename='ad-17.xlsx',
                    logical_filename='ad-17.xlsx',
                    storage_key='ad-17.xlsx',
                    original_filename='ad-17.xlsx',
                    ingestion_status='success',
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type='inventory_report',
                    country='US',
                    report_date=date(2026, 3, 19),
                    snapshot_at=datetime(2026, 3, 19, 8, 0, tzinfo=UTC),
                    version=1,
                    is_current=True,
                    upload_file_id='inventory-19',
                    upload_file_path='/tmp/inventory-19.txt',
                    stored_filename='inventory-19.txt',
                    logical_filename='inventory-19.txt',
                    storage_key='inventory-19.txt',
                    original_filename='inventory-19.txt',
                    ingestion_status='success',
                ),
            ]
        )
        db.commit()

        payload = daily_analysis_service.build_daily_analysis(
            db,
            project_id=project.id,
            country='US',
            start_date='2026-03-10',
            end_date='2026-03-10',
        )

        assert payload['console']['sales_source_days'] == 0
        assert payload['console']['ad_source_days'] == 0
        assert payload['console']['inventory_source_days'] == 0
        assert payload['console']['missing_dates'] == ['2026-03-10']
        assert payload['console']['latest_sales_date'] == '2026-03-18'
        assert payload['console']['latest_ad_date'] == '2026-03-17'
        assert payload['console']['latest_inventory_date'] == '2026-03-19'


def test_build_daily_analysis_uses_inventory_report_date_for_availability_console():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='日报项目', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        db.add(
            AnalysisSourceFile(
                project_id=project.id,
                report_type='inventory_report',
                country='US',
                report_date=date(2026, 2, 26),
                snapshot_at=datetime(2026, 3, 19, 8, 0, tzinfo=UTC),
                version=1,
                is_current=True,
                upload_file_id='inventory-1',
                upload_file_path='/tmp/inventory-1.txt',
                stored_filename='inventory-1.txt',
                logical_filename='inventory-1.txt',
                storage_key='inventory-1.txt',
                original_filename='inventory-1.txt',
                ingestion_status='success',
            )
        )
        db.commit()

        payload = daily_analysis_service.build_daily_analysis(
            db,
            project_id=project.id,
            country='US',
            start_date='2026-03-10',
            end_date='2026-03-10',
        )

        assert payload['console']['latest_inventory_date'] == '2026-02-26'
