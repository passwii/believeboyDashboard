from datetime import date
from pathlib import Path
import warnings

import pandas as pd
from openpyxl import Workbook
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.api.v1.endpoints.product_analysis import list_product_analysis_pt1_details
from app.db.session import Base
from app.models import (
    AnalysisAdProductRow,
    AnalysisPaymentRow,
    AnalysisPT1Calculation,
    AnalysisPTSKUDetail,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    ExchangeRate,
    ProductCost,
    Project,
)
from app.services import product_analysis_source_service


def _seed_exchange_rates(db: Session) -> None:
    db.add_all(
        [
            ExchangeRate(currency='USD', currency_name='美元', year_month='2026-02', rate=1),
            ExchangeRate(currency='USD', currency_name='美元', year_month='2026-03', rate=1),
            ExchangeRate(currency='EUR', currency_name='欧元', year_month='2026-02', rate=1),
            ExchangeRate(currency='EUR', currency_name='欧元', year_month='2026-03', rate=1),
            ExchangeRate(currency='GBP', currency_name='英镑', year_month='2026-02', rate=1),
            ExchangeRate(currency='GBP', currency_name='英镑', year_month='2026-03', rate=1),
        ]
    )


def _write_business_csv(path: Path) -> None:
    path.write_text(
        '（子）ASIN,页面浏览量 - 总计,已订购商品数量,会话数 - 总计,已订购商品销售额\n'
        'ASIN1,100,10,90,US$120.00\n'
        'ASINX,50,5,40,US$55.00\n',
        encoding='utf-8',
    )


def _write_payment_csv(path: Path) -> None:
    lines = [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'h7',
        'type,sku,quantity,product sales,shipping credits,promotional rebates,other,selling fees,fba fees',
        'Order,SKU1,10,120,0,0,0,-18,-25',
        'Service Fee,,0,0,0,0,0,-9,0',
        'Order,SKU_UNMAPPED,3,30,0,0,0,-4,-6',
    ]
    path.write_text('\n'.join(lines), encoding='utf-8')


def _write_ad_xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.append(['广告SKU', '广告ASIN', '展示量', '点击量', '花费', '7天总销售额', '7天总销售量(#)'])
    ws.append(['SKU1', 'ASIN1', 200, 20, 12, 50, 5])
    ws.append(['SKU_UNMAPPED', 'ASINX', 100, 10, 5, 20, 2])
    wb.save(path)


def _write_inventory_txt(path: Path) -> None:
    path.write_text(
        'sku\tasin\tavailable\tinv-age-0-to-90-days\tinv-age-91-to-180-days\tinv-age-181-to-270-days\tinv-age-271-to-365-days\tinv-age-365-plus-days\trecommended-action\n'
        'SKU1\tASIN1\t0\t1\t0\t0\t0\t1\tliquidate\n',
        encoding='utf-8',
    )


def _write_inventory_txt_wrong_project(path: Path) -> None:
    path.write_text(
        'sku\tasin\tavailable\tinv-age-0-to-90-days\tinv-age-91-to-180-days\tinv-age-181-to-270-days\tinv-age-271-to-365-days\tinv-age-365-plus-days\trecommended-action\n'
        'OTHER1\tB000OTHER1\t10\t8\t1\t1\t0\t0\tCreateShippingPlan\n'
        'OTHER2\tB000OTHER2\t12\t9\t2\t1\t0\t0\tAdvertise listing\n'
        'OTHER3\tB000OTHER3\t14\t10\t2\t1\t1\t0\tLower price\n'
        'OTHER4\tB000OTHER4\t16\t11\t2\t2\t1\t0\tCreate Outlet deal\n'
        'OTHER5\tB000OTHER5\t18\t12\t3\t2\t1\t0\tEdit listing\n',
        encoding='utf-8',
    )


def _write_sales_txt(path: Path) -> None:
    path.write_text(
        'amazon-order-id\tpurchase-date\torder-status\tsku\tasin\tquantity\tcurrency\titem-price\n'
        '111-1\t2026-02-25T08:00:00+00:00\tPending\tSKU1\tASIN1\t1\tUSD\t10.00\n'
        '111-2\t2026-02-23T08:00:00+00:00\tPending\tSKU1\tASIN1\t1\tUSD\t11.00\n'
        '111-3\t2026-02-23T08:00:00+00:00\tShipped\tSKU1\tASIN1\t1\tUSD\t12.00\n'
        '111-4\t2026-02-24T08:00:00+00:00\tCancelled\tSKU1\tASIN1\t1\tUSD\t13.00\n',
        encoding='utf-8',
    )


def test_persist_product_analysis_sources_versioning_and_current(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        business = tmp_path / 'business.csv'
        payment = tmp_path / 'payment.csv'
        ad = tmp_path / 'ad.xlsx'
        inventory = tmp_path / 'inventory.txt'
        _write_business_csv(business)
        _write_payment_csv(payment)
        _write_ad_xlsx(ad)
        _write_inventory_txt(inventory)

        file_ids = {
            'business_report': 'business.csv',
            'payment_report': 'payment.csv',
            'ad_report': 'ad.xlsx',
            'inventory_report': 'inventory.txt',
        }
        resolved = {
            'business_report': str(business),
            'payment_report': str(payment),
            'ad_report': str(ad),
            'inventory_report': str(inventory),
        }

        outcomes = product_analysis_source_service.persist_product_analysis_sources(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            file_ids=file_ids,
            resolved_file_paths=resolved,
            created_by='operator@example.com',
        )
        assert all(item.success for item in outcomes)

        outcomes2 = product_analysis_source_service.persist_product_analysis_sources(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            file_ids=file_ids,
            resolved_file_paths=resolved,
            created_by='operator@example.com',
        )
        assert all(item.success for item in outcomes2)

        periodic_types = {'business_report', 'payment_report', 'ad_product_report'}
        for report_type in periodic_types:
            rows = db.execute(
                select(AnalysisSourceFile)
                .where(AnalysisSourceFile.report_type == report_type)
                .order_by(AnalysisSourceFile.version.asc())
            ).scalars().all()
            assert [row.version for row in rows] == [1, 2]
            assert rows[0].is_current is False
            assert rows[1].is_current is True
            assert rows[0].superseded_at is not None

        inventory_sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.report_type == 'inventory_report')
            .order_by(AnalysisSourceFile.version.asc())
        ).scalars().all()
        assert [row.version for row in inventory_sources] == [1, 2]
        assert inventory_sources[0].is_current is False
        assert inventory_sources[1].is_current is True


def test_source_rows_scope_filter_and_inventory_status(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        business = tmp_path / 'business.csv'
        payment = tmp_path / 'payment.csv'
        ad = tmp_path / 'ad.xlsx'
        inventory = tmp_path / 'inventory.txt'
        _write_business_csv(business)
        _write_payment_csv(payment)
        _write_ad_xlsx(ad)
        _write_inventory_txt(inventory)

        product_analysis_source_service.persist_product_analysis_sources(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            file_ids={
                'business_report': 'business.csv',
                'payment_report': 'payment.csv',
                'ad_report': 'ad.xlsx',
                'inventory_report': 'inventory.txt',
            },
            resolved_file_paths={
                'business_report': str(business),
                'payment_report': str(payment),
                'ad_report': str(ad),
                'inventory_report': str(inventory),
            },
        )

        payment_source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'payment_report')
        ).scalars().first()
        assert payment_source is not None

        _, rows_default, _ = product_analysis_source_service.get_source_rows(
            db,
            source_id=payment_source.id,
            page=1,
            page_size=50,
            include_excluded=False,
        )
        assert len(rows_default) == 1
        assert rows_default[0]['scope_status'] == 'included_product'

        _, rows_all, _ = product_analysis_source_service.get_source_rows(
            db,
            source_id=payment_source.id,
            page=1,
            page_size=50,
            include_excluded=True,
        )
        assert len(rows_all) == 3
        statuses = {row['scope_status'] for row in rows_all}
        assert statuses == {'included_product', 'excluded_store_level', 'excluded_unmapped'}

        snapshot = product_analysis_source_service.get_current_inventory_snapshot(db, project_id=1)
        assert snapshot is not None
        _, inventory_rows = snapshot
        assert len(inventory_rows) == 1
        assert inventory_rows[0]['stock_status'] == 'out_of_stock'
        assert inventory_rows[0]['aging_status'] == 'over_aged'


def test_inventory_report_rejects_low_project_match_ratio(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        business = tmp_path / 'business.csv'
        payment = tmp_path / 'payment.csv'
        ad = tmp_path / 'ad.xlsx'
        inventory = tmp_path / 'inventory-wrong.txt'
        _write_business_csv(business)
        _write_payment_csv(payment)
        _write_ad_xlsx(ad)
        _write_inventory_txt_wrong_project(inventory)

        outcomes = product_analysis_source_service.persist_product_analysis_sources(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            file_ids={
                'business_report': 'business.csv',
                'payment_report': 'payment.csv',
                'ad_report': 'ad.xlsx',
                'inventory_report': 'inventory-wrong.txt',
            },
            resolved_file_paths={
                'business_report': str(business),
                'payment_report': str(payment),
                'ad_report': str(ad),
                'inventory_report': str(inventory),
            },
        )

        inventory_outcome = next(item for item in outcomes if item.report_type == 'inventory_report')
        assert inventory_outcome.success is False
        assert inventory_outcome.error_message is not None
        assert 'matched active SKU info' in inventory_outcome.error_message

        inventory_source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'inventory_report')
        ).scalars().first()
        assert inventory_source is not None
        assert inventory_source.ingestion_status == 'failed'
        assert inventory_source.is_current is False

        payment_rows = db.execute(select(AnalysisPaymentRow)).scalars().all()
        assert len(payment_rows) == 3
        ad_rows = db.execute(select(AnalysisAdProductRow)).scalars().all()
        assert len(ad_rows) == 2
        inventory_db_rows = db.execute(select(InventorySnapshotRow)).scalars().all()
        assert len(inventory_db_rows) == 0


def test_load_project_product_mapping_ignores_inactive_sku():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU_ACTIVE',
                asin='ASIN_ACTIVE',
                fob_unit_cost=1,
                currency='USD',
                is_active=True,
            )
        )
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU_INACTIVE',
                asin='ASIN_INACTIVE',
                fob_unit_cost=1,
                currency='USD',
                is_active=False,
            )
        )
        db.commit()

        known_skus, known_asins = product_analysis_source_service._load_project_product_mapping(db, 'Demo')
        assert known_skus == {'SKU_ACTIVE'}
        assert known_asins == {'ASIN_ACTIVE'}


def test_persist_single_date_report_sources_sales_status_rule(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.commit()

        sales = tmp_path / 'sales.txt'
        ad = tmp_path / 'ad.xlsx'
        inventory = tmp_path / 'inventory.txt'
        _write_sales_txt(sales)
        _write_ad_xlsx(ad)
        _write_inventory_txt(inventory)

        outcomes = product_analysis_source_service.persist_single_date_report_sources(
            db,
            project_name='Demo',
            report_date='2026-02-25',
            file_ids={
                'sales_report': 'sales.txt',
                'ad_report': 'ad.xlsx',
                'inventory_report': 'inventory.txt',
            },
            resolved_file_paths={
                'sales_report': str(sales),
                'ad_report': str(ad),
                'inventory_report': str(inventory),
            },
            created_by='operator@example.com',
        )
        assert all(item.success for item in outcomes)

        sales_source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'sales_report')
        ).scalars().first()
        assert sales_source is not None
        assert sales_source.report_date.isoformat() == '2026-02-25'
        assert sales_source.period_start_date.isoformat() == '2026-02-25'
        assert sales_source.period_end_date.isoformat() == '2026-02-25'

        sales_rows = db.execute(
            select(AnalysisSalesOrderRow).order_by(AnalysisSalesOrderRow.amazon_order_id.asc())
        ).scalars().all()
        assert len(sales_rows) == 4
        counted_by_order = {row.amazon_order_id: row.is_counted_sales for row in sales_rows}
        assert counted_by_order['111-1'] is True
        assert counted_by_order['111-2'] is True
        assert counted_by_order['111-3'] is True
        assert counted_by_order['111-4'] is False

        ad_source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'ad_product_report')
        ).scalars().first()
        assert ad_source is not None
        assert ad_source.report_date.isoformat() == '2026-02-25'
        assert ad_source.period_start_date.isoformat() == '2026-02-25'
        assert ad_source.period_end_date.isoformat() == '2026-02-25'

        ad_rows = db.execute(select(AnalysisAdProductRow)).scalars().all()
        assert len(ad_rows) == 2

        inventory_source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'inventory_report')
        ).scalars().first()
        assert inventory_source is not None
        inventory_rows = db.execute(select(InventorySnapshotRow)).scalars().all()
        assert len(inventory_rows) == 1


def test_persist_single_business_source_sets_report_date(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        business = tmp_path / 'business.csv'
        _write_business_csv(business)

        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name='Demo',
            report_type='business_report',
            upload_file_id='business.csv',
            upload_file_path=str(business),
            report_date='2026-02-25',
            report_start_date='2026-02-25',
            report_end_date='2026-02-25',
            created_by='operator@example.com',
        )

        assert outcome.success is True
        source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'business_report')
        ).scalars().one()
        assert source.report_date == date(2026, 2, 25)
        assert source.period_start_date == date(2026, 2, 25)
        assert source.period_end_date == date(2026, 2, 25)


def test_persist_single_ad_product_source_sets_report_date_for_single_day_period(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        ad = tmp_path / 'ad.xlsx'
        _write_ad_xlsx(ad)

        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name='Demo',
            report_type='ad_product_report',
            upload_file_id='ad.xlsx',
            upload_file_path=str(ad),
            report_start_date='2026-02-25',
            report_end_date='2026-02-25',
            created_by='operator@example.com',
        )

        assert outcome.success is True
        source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'ad_product_report')
        ).scalars().one()
        assert source.report_date == date(2026, 2, 25)
        assert source.period_start_date == date(2026, 2, 25)
        assert source.period_end_date == date(2026, 2, 25)


def test_persist_single_inventory_source_sets_report_date(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        inventory = tmp_path / 'inventory.txt'
        _write_inventory_txt(inventory)

        outcome = product_analysis_source_service.persist_single_analysis_source(
            db,
            project_name='Demo',
            report_type='inventory_report',
            upload_file_id='inventory.txt',
            upload_file_path=str(inventory),
            report_date='2026-03-17',
            created_by='operator@example.com',
        )

        assert outcome.success is True
        source = db.execute(
            select(AnalysisSourceFile).where(AnalysisSourceFile.report_type == 'inventory_report')
        ).scalars().one()
        assert source.report_date == date(2026, 3, 17)


def test_get_current_inventory_snapshot_uses_latest_source_within_date_range():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add(Project(id=1, project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.flush()

        older = AnalysisSourceFile(
            project_id=1,
            report_type='inventory_report',
            country='US',
            report_date=date(2026, 3, 15),
            snapshot_at=date(2026, 3, 15),
            version=1,
            is_current=False,
            upload_file_id='inventory-older.txt',
            upload_file_path='/tmp/inventory-older.txt',
            stored_filename='inventory-older.txt',
            logical_filename='inventory-older.txt',
            storage_key='inventory-older.txt',
            ingestion_status='success',
            row_count_total=1,
            row_count_included=1,
        )
        newer = AnalysisSourceFile(
            project_id=1,
            report_type='inventory_report',
            country='US',
            report_date=date(2026, 3, 18),
            snapshot_at=date(2026, 3, 18),
            version=1,
            is_current=True,
            upload_file_id='inventory-newer.txt',
            upload_file_path='/tmp/inventory-newer.txt',
            stored_filename='inventory-newer.txt',
            logical_filename='inventory-newer.txt',
            storage_key='inventory-newer.txt',
            ingestion_status='success',
            row_count_total=1,
            row_count_included=1,
        )
        out_of_range_current = AnalysisSourceFile(
            project_id=1,
            report_type='inventory_report',
            country='US',
            report_date=date(2026, 3, 20),
            snapshot_at=date(2026, 3, 20),
            version=1,
            is_current=True,
            upload_file_id='inventory-current.txt',
            upload_file_path='/tmp/inventory-current.txt',
            stored_filename='inventory-current.txt',
            logical_filename='inventory-current.txt',
            storage_key='inventory-current.txt',
            ingestion_status='success',
            row_count_total=1,
            row_count_included=1,
        )
        db.add_all([older, newer, out_of_range_current])
        db.flush()

        db.add_all(
            [
                InventorySnapshotRow(
                    source_file_id=older.id,
                    source_row_no=1,
                    sku='SKU1',
                    asin='ASIN1',
                    available_qty=5,
                    age_0_90_qty=5,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    recommended_action='keep',
                    stock_status='in_stock',
                    aging_status='fresh',
                    raw_row={'sku': 'SKU1'},
                ),
                InventorySnapshotRow(
                    source_file_id=newer.id,
                    source_row_no=1,
                    sku='SKU1',
                    asin='ASIN1',
                    available_qty=9,
                    age_0_90_qty=9,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    recommended_action='keep',
                    stock_status='in_stock',
                    aging_status='fresh',
                    raw_row={'sku': 'SKU1'},
                ),
                InventorySnapshotRow(
                    source_file_id=out_of_range_current.id,
                    source_row_no=1,
                    sku='SKU1',
                    asin='ASIN1',
                    available_qty=99,
                    age_0_90_qty=99,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    recommended_action='keep',
                    stock_status='in_stock',
                    aging_status='fresh',
                    raw_row={'sku': 'SKU1'},
                ),
            ]
        )
        db.commit()

        payload = product_analysis_source_service.get_current_inventory_snapshot(
            db,
            project_id=1,
            country='US',
            start_date=date(2026, 3, 10),
            end_date=date(2026, 3, 18),
        )

        assert payload is not None
        source, rows = payload
        assert source.report_date == date(2026, 3, 18)
        assert rows[0]['available_qty'] == 9


def test_persist_sales_report_by_purchase_date_splits_into_multiple_report_dates(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                currency='USD',
                source_file='seed.csv',
            )
        )
        db.commit()

        sales = tmp_path / 'sales.txt'
        _write_sales_txt(sales)

        outcome = product_analysis_source_service.persist_sales_report_by_purchase_date(
            db,
            project_name='Demo',
            upload_file_id='sales.txt',
            upload_file_path=str(sales),
            created_by='operator@example.com',
        )

        assert outcome['success'] is True
        assert outcome['report_start_date'] == '2026-02-23'
        assert outcome['report_end_date'] == '2026-02-25'
        assert outcome['days_persisted'] == 3

        sales_sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.report_type == 'sales_report')
            .order_by(AnalysisSourceFile.report_date.asc())
        ).scalars().all()
        assert [row.report_date.isoformat() for row in sales_sources] == ['2026-02-23', '2026-02-24', '2026-02-25']
        assert all(row.period_start_date == row.report_date for row in sales_sources)
        assert all(row.period_end_date == row.report_date for row in sales_sources)
        assert [row.row_count_total for row in sales_sources] == [2, 1, 1]
        assert [row.row_count_included for row in sales_sources] == [1, 0, 0]

        sales_rows = db.execute(
            select(AnalysisSalesOrderRow).order_by(AnalysisSalesOrderRow.amazon_order_id.asc())
        ).scalars().all()
        assert len(sales_rows) == 4
        counted_by_order = {row.amazon_order_id: row.is_counted_sales for row in sales_rows}
        assert counted_by_order['111-1'] is False
        assert counted_by_order['111-2'] is False
        assert counted_by_order['111-3'] is True
        assert counted_by_order['111-4'] is False


def test_persist_single_date_report_sources_separates_country_sources(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.commit()

        sales = tmp_path / 'sales.txt'
        ad = tmp_path / 'ad.xlsx'
        inventory = tmp_path / 'inventory.txt'
        _write_sales_txt(sales)
        _write_ad_xlsx(ad)
        _write_inventory_txt(inventory)

        for country in ('US', 'DE'):
            outcomes = product_analysis_source_service.persist_single_date_report_sources(
                db,
                project_name='Demo',
                report_date='2026-02-25',
                country=country,
                file_ids={
                    'sales_report': 'sales.txt',
                    'ad_report': 'ad.xlsx',
                    'inventory_report': 'inventory.txt',
                },
                resolved_file_paths={
                    'sales_report': str(sales),
                    'ad_report': str(ad),
                    'inventory_report': str(inventory),
                },
            )
            assert all(item.success for item in outcomes)

        sales_sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.report_type == 'sales_report')
            .order_by(AnalysisSourceFile.country.asc(), AnalysisSourceFile.id.asc())
        ).scalars().all()
        assert [row.country for row in sales_sources] == ['DE', 'US']
        assert all(row.is_current is True for row in sales_sources)

        ad_sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.report_type == 'ad_product_report')
            .order_by(AnalysisSourceFile.country.asc(), AnalysisSourceFile.id.asc())
        ).scalars().all()
        assert [row.country for row in ad_sources] == ['DE', 'US']
        assert all(row.is_current is True for row in ad_sources)

        inventory_sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.report_type == 'inventory_report')
            .order_by(AnalysisSourceFile.country.asc(), AnalysisSourceFile.id.asc())
        ).scalars().all()
        assert [row.country for row in inventory_sources] == ['DE', 'US']
        assert all(row.is_current is True for row in inventory_sources)


def test_persist_product_analysis_pt1_calculation_versioning():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add_all(
            [
                ProductCost(
                    project_name='Demo',
                    sku='SKU1',
                    asin='ASIN1',
                    fob_unit_cost=1,
                    currency='USD',
                    is_active=True,
                ),
                ProductCost(
                    project_name='Demo',
                    sku='SKU2',
                    asin='ASIN2',
                    fob_unit_cost=1,
                    currency='USD',
                    is_active=True,
                ),
                ProductCost(
                    project_name='Demo',
                    sku='SKU3',
                    asin='ASIN3',
                    fob_unit_cost=1,
                    currency='USD',
                    is_active=True,
                ),
            ]
        )
        db.commit()

        first = product_analysis_source_service.persist_product_analysis_pt1_calculation(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            pt1={
                'row_count': 2,
                'summary': {'SKU': '汇总', '总销量': 10, '利润': 50.5},
                'details': [
                    {
                        '日期': '20260201-0207',
                        'SKU': 'SKU1',
                        'ASIN': 'ASIN1',
                        '总销量': 6,
                        '总销售额': 120,
                        '页面浏览量': 100,
                        '总访客': 90,
                        '广告展示量': 1000,
                        '广告点击量': 80,
                        '广告订单量': 5,
                        '广告花费': 20,
                        '广告销售额': 70,
                        '实际销售额': 118,
                        '实际销售量': 6,
                        '实际退款额': 2,
                        '实际退款量': 1,
                        '利润': 50.5,
                        '利润率': 0.42,
                    },
                    {
                        '日期': '20260201-0207',
                        'SKU': 'SKU2',
                        'ASIN': 'ASIN2',
                        '总销量': 4,
                        '总销售额': 90,
                        '页面浏览量': 80,
                        '总访客': 75,
                        '广告展示量': 700,
                        '广告点击量': 40,
                        '广告订单量': 2,
                        '广告花费': 10,
                        '广告销售额': 30,
                        '实际销售额': 88,
                        '实际销售量': 4,
                        '实际退款额': 1,
                        '实际退款量': 0,
                        '利润': 30.3,
                        '利润率': 0.34,
                    },
                ],
            },
            result_file_path='/tmp/result-v1.xlsx',
            calculation_version=1,
        )
        db.commit()

        second = product_analysis_source_service.persist_product_analysis_pt1_calculation(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            pt1={
                'row_count': 3,
                'summary': {'SKU': '汇总', '总销量': 12, '利润': 80.8},
                'details': [
                    {
                        '日期': '20260201-0207',
                        'SKU': 'SKU1',
                        'ASIN': 'ASIN1',
                        '总销量': 8,
                        '总销售额': 180,
                        '页面浏览量': 160,
                        '总访客': 140,
                        '广告展示量': 1400,
                        '广告点击量': 110,
                        '广告订单量': 7,
                        '广告花费': 25,
                        '广告销售额': 90,
                        '实际销售额': 175,
                        '实际销售量': 8,
                        '实际退款额': 3,
                        '实际退款量': 1,
                        '利润': 80.8,
                        '利润率': 0.46,
                    },
                    {
                        '日期': '20260201-0207',
                        'SKU': 'SKU2',
                        'ASIN': 'ASIN2',
                        '总销量': 4,
                        '总销售额': 92,
                        '页面浏览量': 82,
                        '总访客': 76,
                        '广告展示量': 720,
                        '广告点击量': 42,
                        '广告订单量': 3,
                        '广告花费': 12,
                        '广告销售额': 35,
                        '实际销售额': 90,
                        '实际销售量': 4,
                        '实际退款额': 1,
                        '实际退款量': 0,
                        '利润': 31.1,
                        '利润率': 0.35,
                    },
                    {
                        '日期': '20260201-0207',
                        'SKU': 'SKU3',
                        'ASIN': 'ASIN3',
                        '总销量': 0,
                        '总销售额': 0,
                        '页面浏览量': 30,
                        '总访客': 29,
                        '广告展示量': 100,
                        '广告点击量': 4,
                        '广告订单量': 0,
                        '广告花费': 1,
                        '广告销售额': 0,
                        '实际销售额': 0,
                        '实际销售量': 0,
                        '实际退款额': 0,
                        '实际退款量': 0,
                        '利润': -1,
                        '利润率': 0,
                    },
                ],
            },
            result_file_path='/tmp/result-v2.xlsx',
            calculation_version=1,
        )
        db.commit()

        rows = db.execute(
            select(AnalysisPT1Calculation)
            .order_by(AnalysisPT1Calculation.version.asc())
        ).scalars().all()
        assert len(rows) == 2
        assert first.version == 1
        assert second.version == 2
        assert rows[0].is_current is False
        assert rows[0].superseded_at is not None
        assert rows[1].is_current is True
        assert rows[1].summary_row['总销量'] == 12

        detail_rows = db.execute(
            select(AnalysisPTSKUDetail)
            .where(AnalysisPTSKUDetail.pt1_calculation_id == second.id)
            .order_by(AnalysisPTSKUDetail.source_row_no.asc())
        ).scalars().all()
        assert len(detail_rows) == 3
        assert float(detail_rows[0].actual_sales_amount) == 175.0
        assert float(detail_rows[0].ad_spend) == 25.0
        assert detail_rows[0].sku == 'SKU1'

        weekly_rows = product_analysis_source_service.list_weekly_product_analysis_from_details(
            db,
            project_id=1,
            start_date=None,
            end_date=None,
            current_only=True,
        )
        assert len(weekly_rows) == 1
        assert weekly_rows[0]['id'] == second.id
        assert weekly_rows[0]['total_units'] == 12
        assert weekly_rows[0]['total_sales'] == 265.0
        assert weekly_rows[0]['total_ad_spend'] == 38.0


def test_pt1_details_sorted_by_product_cost_sort_order():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU_B',
                asin='ASIN_B',
                fob_unit_cost=1,
                currency='USD',
                sort_order=1,
                is_active=True,
            )
        )
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU_A',
                asin='ASIN_A',
                fob_unit_cost=1,
                currency='USD',
                sort_order=2,
                is_active=True,
            )
        )
        db.flush()

        pt1 = AnalysisPT1Calculation(
            project_id=1,
            project_name='Demo',
            report_start_date=date(2026, 2, 1),
            report_end_date=date(2026, 2, 7),
            version=1,
            is_current=True,
            row_count=2,
            summary_row={},
            calculation_version=1,
        )
        db.add(pt1)
        db.flush()

        db.add(
            AnalysisPTSKUDetail(
                pt1_calculation_id=pt1.id,
                source_row_no=1,
                sku='SKU_A',
                asin='ASIN_A',
                raw_row={'SKU': 'SKU_A'},
            )
        )
        db.add(
            AnalysisPTSKUDetail(
                pt1_calculation_id=pt1.id,
                source_row_no=2,
                sku='SKU_B',
                asin='ASIN_B',
                raw_row={'SKU': 'SKU_B'},
            )
        )
        db.commit()

        payload = list_product_analysis_pt1_details(pt1.id, page=1, page_size=100, db=db)
        assert payload['has_next'] is False
        assert [item['sku'] for item in payload['rows']] == ['SKU_B', 'SKU_A']
        assert [item['sku_sort_order'] for item in payload['rows']] == [1, 2]


def test_recompute_weekly_product_analysis_from_history_uses_latest_product_costs(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        _seed_exchange_rates(db)
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=1,
                first_leg_cost_rmb=1,
                currency='USD',
                is_active=True,
                country='US',
            )
        )
        db.commit()

        business = tmp_path / 'business.csv'
        payment = tmp_path / 'payment.csv'
        ad = tmp_path / 'ad.xlsx'
        _write_business_csv(business)
        _write_payment_csv(payment)
        _write_ad_xlsx(ad)

        product_analysis_source_service.persist_product_analysis_sources(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            file_ids={
                'business_report': 'business.csv',
                'payment_report': 'payment.csv',
                'ad_report': 'ad.xlsx',
            },
            resolved_file_paths={
                'business_report': str(business),
                'payment_report': str(payment),
                'ad_report': str(ad),
            },
        )
        product_analysis_source_service.persist_product_analysis_pt1_calculation(
            db,
            project_name='Demo',
            report_start_date='2026-02-01',
            report_end_date='2026-02-07',
            pt1={
                'row_count': 1,
                'summary': {'SKU': '汇总', '产品FOB': 10, '销售头程': 10, '总成本': 63, '利润': 45},
                'details': [
                    {
                        '日期': '20260201-0207',
                        'SKU': 'SKU1',
                        'ASIN': 'ASIN1',
                        '总销量': 10,
                        '总销售额': 120,
                        '页面浏览量': 100,
                        '总访客': 90,
                        '广告展示量': 200,
                        '广告点击量': 20,
                        '广告订单量': 5,
                        '广告花费': 12,
                        '广告销售额': 50,
                        '产品FOB': 10,
                        '销售头程': 10,
                        'FBA配送费': 25,
                        '平台佣金': 18,
                        '总成本': 63,
                        '利润': 45,
                        '实际销售额': 120,
                        '实际销售量': 10,
                        '实际退款额': 0,
                        '实际退款量': 0,
                        '利润率': 0.375,
                    }
                ],
            },
        )
        db.commit()

        cost_row = db.execute(select(ProductCost).where(ProductCost.sku == 'SKU1')).scalars().one()
        cost_row.fob_unit_cost = 3
        cost_row.first_leg_cost_rmb = 2
        db.commit()

        payload = product_analysis_source_service.recompute_weekly_product_analysis_from_history(
            db,
            project_id=1,
            country='US',
        )
        db.commit()

        assert payload['recomputed'] == 1
        assert payload['periods'][0]['version'] == 2

        pt1_rows = db.execute(select(AnalysisPT1Calculation).order_by(AnalysisPT1Calculation.version.asc())).scalars().all()
        assert len(pt1_rows) == 2
        assert pt1_rows[0].is_current is False
        assert pt1_rows[1].is_current is True
        assert pt1_rows[1].summary_row['产品FOB'] == 30.0
        assert pt1_rows[1].summary_row['销售头程'] == 20.0
        assert pt1_rows[1].summary_row['总成本'] == 93.0
        assert pt1_rows[1].summary_row['利润'] == 15.0

        detail_rows = db.execute(
            select(AnalysisPTSKUDetail).where(AnalysisPTSKUDetail.pt1_calculation_id == pt1_rows[1].id)
        ).scalars().all()
        assert len(detail_rows) == 1
        assert detail_rows[0].raw_row['产品FOB'] == 30.0
        assert detail_rows[0].raw_row['销售头程'] == 20.0
        assert detail_rows[0].raw_row['总成本'] == 93.0


def test_parse_transaction_at_handles_pst_and_pdt():
    parsed_pst = product_analysis_source_service._parse_transaction_at({'date/time': 'Mar 7, 2026 6:58:21 AM PST'})
    parsed_pdt = product_analysis_source_service._parse_transaction_at({'date/time': 'Mar 8, 2026 4:52:59 AM PDT'})

    assert parsed_pst is not None
    assert parsed_pdt is not None
    assert parsed_pst.isoformat() == '2026-03-07T14:58:21+00:00'
    assert parsed_pdt.isoformat() == '2026-03-08T11:52:59+00:00'


def test_read_excel_without_style_warning_suppresses_known_openpyxl_warning(monkeypatch, tmp_path: Path):
    expected = pd.DataFrame([{'广告SKU': 'SKU1'}])

    def fake_read_excel(path, engine):
        warnings.warn(
            "Workbook contains no default style, apply openpyxl's default",
            UserWarning,
            stacklevel=1,
        )
        return expected

    monkeypatch.setattr(product_analysis_source_service.pd, 'read_excel', fake_read_excel)

    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        result = product_analysis_source_service._read_excel_without_style_warning(tmp_path / 'ad.xlsx')

    assert result.equals(expected)
    assert captured == []
