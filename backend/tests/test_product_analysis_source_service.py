from pathlib import Path

from openpyxl import Workbook
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import (
    AnalysisAdRow,
    AnalysisPaymentRow,
    AnalysisPT1Calculation,
    AnalysisPTSKUDetail,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    ProductCost,
    Project,
)
from app.services import product_analysis_source_service


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
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                first_leg_unit_cost=1,
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

        periodic_types = {'business_report', 'payment_report', 'ad_report'}
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
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                first_leg_unit_cost=1,
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

        payment_rows = db.execute(select(AnalysisPaymentRow)).scalars().all()
        assert len(payment_rows) == 3
        ad_rows = db.execute(select(AnalysisAdRow)).scalars().all()
        assert len(ad_rows) == 2
        inventory_db_rows = db.execute(select(InventorySnapshotRow)).scalars().all()
        assert len(inventory_db_rows) == 1


def test_load_project_product_mapping_ignores_inactive_sku():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add(
            ProductCost(
                project_name='Demo',
                sku='SKU_ACTIVE',
                asin='ASIN_ACTIVE',
                first_leg_unit_cost=1,
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
                first_leg_unit_cost=1,
                fob_unit_cost=1,
                currency='USD',
                is_active=False,
            )
        )
        db.commit()

        known_skus, known_asins = product_analysis_source_service._load_project_product_mapping(db, 'Demo')
        assert known_skus == {'SKU_ACTIVE'}
        assert known_asins == {'ASIN_ACTIVE'}


def test_persist_daily_report_sources_sales_status_rule(tmp_path: Path):
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.commit()

        sales = tmp_path / 'sales.txt'
        ad = tmp_path / 'ad.xlsx'
        inventory = tmp_path / 'inventory.txt'
        _write_sales_txt(sales)
        _write_ad_xlsx(ad)
        _write_inventory_txt(inventory)

        outcomes = product_analysis_source_service.persist_daily_report_sources(
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
        assert sales_source.period_start_date.isoformat() == '2026-02-25'
        assert sales_source.period_end_date.isoformat() == '2026-02-25'

        sales_rows = db.execute(
            select(AnalysisSalesOrderRow).order_by(AnalysisSalesOrderRow.amazon_order_id.asc())
        ).scalars().all()
        assert len(sales_rows) == 4
        counted_by_order = {row.amazon_order_id: row.is_counted_sales for row in sales_rows}
        assert counted_by_order['111-1'] is True
        assert counted_by_order['111-2'] is False
        assert counted_by_order['111-3'] is True
        assert counted_by_order['111-4'] is False


def test_persist_product_analysis_pt1_calculation_versioning():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add(Project(project_name='Demo', sort_order=1, source_file='seed.csv'))
        db.add_all(
            [
                ProductCost(
                    project_name='Demo',
                    sku='SKU1',
                    asin='ASIN1',
                    first_leg_unit_cost=1,
                    fob_unit_cost=1,
                    currency='USD',
                    is_active=True,
                ),
                ProductCost(
                    project_name='Demo',
                    sku='SKU2',
                    asin='ASIN2',
                    first_leg_unit_cost=1,
                    fob_unit_cost=1,
                    currency='USD',
                    is_active=True,
                ),
                ProductCost(
                    project_name='Demo',
                    sku='SKU3',
                    asin='ASIN3',
                    first_leg_unit_cost=1,
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
