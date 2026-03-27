import pytest
from datetime import date
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import ProductCost, Project
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.schemas.shipment_schedule import ShipmentScheduleUpdate
from app.services import shipment_schedule_service


def test_summarize_shipment_schedule_costs_ignores_history_calc_flag():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule_included = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-001',
            shipping_method='sea',
            shipment_status='completed',
            created_date=date(2026, 3, 1),
            logistics_total_price=100,
            total_chargeable_weight_kg=10,
            include_in_history_shipping_calc=True,
            source_type='manual',
        )
        schedule_excluded = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-002',
            shipping_method='sea',
            shipment_status='completed',
            created_date=date(2026, 3, 2),
            logistics_total_price=200,
            total_chargeable_weight_kg=20,
            include_in_history_shipping_calc=False,
            source_type='manual',
        )
        db.add_all([schedule_included, schedule_excluded])
        db.flush()

        db.add_all([
            ShipmentScheduleItem(
                shipment_schedule_id=schedule_included.id,
                project_id=project.id,
                shipment_no='SHP-001',
                sku='SKU-001',
                quantity=10,
            ),
            ShipmentScheduleItem(
                shipment_schedule_id=schedule_excluded.id,
                project_id=project.id,
                shipment_no='SHP-002',
                sku='SKU-002',
                quantity=20,
            ),
        ])
        db.commit()

        summary = shipment_schedule_service.summarize_shipment_schedule_costs(
            db,
            project_id=project.id,
            project_ids=[project.id],
            country=None,
            shipment_status='completed',
            shipping_method=None,
            shipment_no=None,
            created_date_from='2026-03-01',
            created_date_to='2026-03-31',
        )

        assert summary['shipment_count'] == 2
        assert summary['total_sku'] == 2
        assert summary['total_quantity'] == 30
        assert summary['total_chargeable_weight_kg'] == 30
        assert summary['total_logistics_cost'] == 300


def test_parse_shipment_items_csv_supports_utf8_bom():
    content = (
        'project_name,shipment_no,date,SKU,quantity,remark\n'
        '宝勒1店,SHP-001,2026-03-08,SKU-001,100,首批发货\n'
    ).encode('utf-8-sig')

    items = shipment_schedule_service.parse_shipment_items_csv(content)

    assert len(items) == 1
    assert items[0]['project_name'] == '宝勒1店'
    assert items[0]['shipment_no'] == 'SHP-001'
    assert items[0]['sku'] == 'SKU-001'
    assert items[0]['quantity'] == 100
    assert items[0]['remark'] == '首批发货'


def test_parse_shipment_items_csv_supports_gbk_from_excel():
    content = (
        'project_name,shipment_no,date,SKU,quantity,remark\n'
        '宝勒1店,SHP-001,2026-03-08,SKU-001,100,首批发货\n'
    ).encode('gb18030')

    items = shipment_schedule_service.parse_shipment_items_csv(content)

    assert len(items) == 1
    assert items[0]['project_name'] == '宝勒1店'
    assert items[0]['remark'] == '首批发货'


def test_parse_shipment_items_csv_supports_excel_date_formats():
    slash_content = (
        'project_name,shipment_no,date,SKU,quantity,remark\n'
        '宝勒1店,SHP-001,2026/3/8,SKU-001,100,\n'
    ).encode('utf-8')
    us_content = (
        'project_name,shipment_no,date,SKU,quantity,remark\n'
        '宝勒1店,SHP-001,3/8/2026,SKU-001,100,\n'
    ).encode('utf-8')
    datetime_content = (
        'project_name,shipment_no,date,SKU,quantity,remark\n'
        '宝勒1店,SHP-001,2026-03-08 00:00:00,SKU-001,100,\n'
    ).encode('utf-8')

    slash_items = shipment_schedule_service.parse_shipment_items_csv(slash_content)
    us_items = shipment_schedule_service.parse_shipment_items_csv(us_content)
    datetime_items = shipment_schedule_service.parse_shipment_items_csv(datetime_content)

    assert slash_items[0]['item_date'].isoformat() == '2026-03-08'
    assert us_items[0]['item_date'].isoformat() == '2026-03-08'
    assert datetime_items[0]['item_date'].isoformat() == '2026-03-08'


def test_parse_shipment_items_csv_rejects_unknown_encoding():
    content = b'\x80\x81\x82project_name,shipment_no,date,SKU,quantity,remark\n'

    with pytest.raises(Exception) as exc_info:
        shipment_schedule_service.parse_shipment_items_csv(content)

    assert 'CSV 编码必须为 UTF-8 或 GBK/ANSI' in str(exc_info.value)


def test_replace_shipment_schedule_items_from_csv_rejects_unknown_sku():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-001',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
        )
        db.add(schedule)
        db.add(
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-EXISTS',
                asin='ASIN-001',
                fob_unit_cost=2,
                currency='USD',
                country='US',
                sort_order=1,
                is_active=True,
            )
        )
        db.commit()

        content = (
            'project_name,shipment_no,date,SKU,quantity,remark\n'
            '宝勒1店,SHP-001,2026-03-08,SKU-MISSING,100,\n'
        ).encode('utf-8')

        with pytest.raises(HTTPException) as exc_info:
            shipment_schedule_service.replace_shipment_schedule_items_from_csv(db, schedule.id, content, filename='items.csv')

        assert exc_info.value.status_code == 400
        assert 'SKU 信息' in str(exc_info.value.detail)
        assert '第 2 行 SKU: SKU-MISSING' in str(exc_info.value.detail)


def test_replace_shipment_schedule_items_from_csv_accepts_active_sku():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-001',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
        )
        db.add(schedule)
        db.add(
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-001',
                asin='ASIN-001',
                fob_unit_cost=2,
                currency='USD',
                country='US',
                sort_order=1,
                is_active=True,
            )
        )
        db.commit()

        content = (
            'project_name,shipment_no,date,SKU,quantity,remark\n'
            '宝勒1店,SHP-001,2026-03-08,SKU-001,100,首批发货\n'
        ).encode('utf-8')

        row, inserted, replaced, total_quantity = shipment_schedule_service.replace_shipment_schedule_items_from_csv(
            db, schedule.id, content, filename='items.csv'
        )

        assert row.id == schedule.id
        assert inserted == 1
        assert replaced == 0
        assert total_quantity == 100


def test_update_shipment_schedule_replaces_items_from_payload():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='DE',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-001',
            shipping_method='sea',
            shipment_status='draft',
            source_type='csv_import',
            source_file='old.csv',
        )
        db.add(schedule)
        db.flush()
        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=project.id,
                shipment_no='SHP-001',
                sku='SKU-OLD',
                quantity=20,
                source_type='csv_import',
                source_file='old.csv',
            )
        )
        db.add_all([
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-001',
                asin='ASIN-001',
                fob_unit_cost=2,
                currency='USD',
                country='DE',
                sort_order=1,
                is_active=True,
            ),
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-002',
                asin='ASIN-002',
                fob_unit_cost=3,
                currency='USD',
                country='DE',
                sort_order=2,
                is_active=True,
            ),
        ])
        db.commit()

        updated = shipment_schedule_service.update_shipment_schedule(
            db,
            schedule.id,
            ShipmentScheduleUpdate(
                project_id=project.id,
                country='DE',
                shipment_no='SHP-001',
                shipping_method='sea',
                shipment_status='draft',
                items=[
                    {'sku': 'SKU-001', 'quantity': 100, 'item_date': '2026-03-08', 'remark': '首批'},
                    {'sku': 'SKU-002', 'quantity': 60},
                ],
            ),
            operator='tester',
        )

        db.refresh(updated)
        assert updated.source_type == 'manual'
        assert updated.source_file is None
        assert updated.total_volume_m3 == 0
        assert updated.logistics_total_price == 0

        rows = db.execute(
            select(ShipmentScheduleItem)
            .where(ShipmentScheduleItem.shipment_schedule_id == schedule.id)
            .order_by(ShipmentScheduleItem.sku.asc())
        ).scalars().all()

        assert [(row.sku, row.quantity, row.source_type) for row in rows] == [
            ('SKU-001', 100, 'manual'),
            ('SKU-002', 60, 'manual'),
        ]
        assert rows[0].item_date.isoformat() == '2026-03-08'
        assert rows[0].remark == '首批'


def test_update_shipment_schedule_rejects_empty_items_payload():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='DE',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-EMPTY',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
        )
        db.add(schedule)
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            shipment_schedule_service.update_shipment_schedule(
                db,
                schedule.id,
                ShipmentScheduleUpdate(
                    project_id=project.id,
                    country='DE',
                    shipment_no='SHP-EMPTY',
                    shipping_method='sea',
                    shipment_status='draft',
                    items=[],
                ),
                operator='tester',
            )

        assert exc_info.value.status_code == 422
        assert 'SKU 明细不能为空' in str(exc_info.value.detail)


def test_parse_shipment_schedules_csv_supports_excel_date_formats():
    content = (
        'project_name,country,shipment_no,shipping_method,shipment_status,created_date,etd_date,eta_date,actual_inbound_date\n'
        '宝勒1店,US,SHP-100,sea,draft,2026/3/8,3/10/2026,2026-03-20 00:00:00,2026/3/25\n'
    ).encode('utf-8-sig')

    rows = shipment_schedule_service.parse_shipment_schedules_csv(content)

    assert len(rows) == 1
    assert rows[0]['project_name'] == '宝勒1店'
    assert rows[0]['country'] == 'US'
    assert rows[0]['shipment_no'] == 'SHP-100'
    assert rows[0]['created_date'].isoformat() == '2026-03-08'
    assert rows[0]['etd_date'].isoformat() == '2026-03-10'
    assert rows[0]['eta_date'].isoformat() == '2026-03-20'
    assert rows[0]['actual_inbound_date'].isoformat() == '2026-03-25'


def test_import_shipment_schedules_from_csv_creates_rows():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        db.add(Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv'))
        db.commit()

        content = (
            'project_name,country,shipment_no,shipping_method,shipment_status,created_date,remark\n'
            '宝勒1店,DE,SHP-200,sea,draft,2026-03-08,首批导入\n'
        ).encode('gb18030')

        rows = shipment_schedule_service.import_shipment_schedules_from_csv(
            db,
            content,
            filename='shipment-batch.csv',
            operator='tester',
        )
        db.commit()

        saved = db.query(ShipmentSchedule).filter(ShipmentSchedule.shipment_no == 'SHP-200').one()
        assert len(rows) == 1
        assert saved.project_name_snapshot == '宝勒1店'
        assert saved.country == 'DE'
        assert saved.shipping_method == 'sea'
        assert saved.shipment_status == 'draft'
        assert saved.source_type == 'csv_import'
        assert saved.source_file == 'shipment-batch.csv'
        assert saved.created_by == 'tester'
        assert saved.remark == '首批导入'
        assert saved.actual_inbound_date is None


def test_import_shipment_schedules_from_csv_rejects_duplicate_shipment_no():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()
        db.add(
            ShipmentSchedule(
                project_id=project.id,
                country='US',
                project_name_snapshot=project.project_name,
                shipment_no='SHP-300',
                shipping_method='sea',
                shipment_status='draft',
                source_type='manual',
            )
        )
        db.commit()

        content = (
            'project_name,country,shipment_no,shipping_method,shipment_status\n'
            '宝勒1店,US,SHP-300,sea,draft\n'
        ).encode('utf-8')

        with pytest.raises(HTTPException) as exc_info:
            shipment_schedule_service.import_shipment_schedules_from_csv(db, content, filename='shipment-batch.csv')

        assert exc_info.value.status_code == 409
        assert 'SHP-300' in str(exc_info.value.detail)


def test_calculate_shipment_schedule_costs_persists_schedule_and_item_metrics():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-CAL-001',
            shipping_method='air',
            shipment_status='draft',
            source_type='manual',
        )
        db.add(schedule)
        db.flush()

        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=project.id,
                shipment_no='SHP-CAL-001',
                sku='SKU-001',
                quantity=10,
                source_type='manual',
            )
        )
        db.add(
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-001',
                asin='ASIN-001',
                fob_unit_cost=2,
                currency='CNY',
                country='US',
                sort_order=1,
                is_active=True,
                package_length_cm=20,
                package_width_cm=10,
                package_height_cm=6,
                weight_kg=0.2,
            )
        )
        db.commit()

        row, sku_count, total_quantity = shipment_schedule_service.calculate_shipment_schedule_costs(
            db,
            schedule.id,
            logistics_unit_price=8.5,
        )
        db.commit()

        assert sku_count == 1
        assert total_quantity == 10
        assert float(row.logistics_unit_price) == pytest.approx(8.5)
        assert float(row.total_volume_m3) == pytest.approx(0.012, abs=1e-4)
        assert float(row.total_chargeable_weight_kg) == pytest.approx(2.0, abs=1e-3)
        assert float(row.logistics_total_price) == pytest.approx(17.0, abs=1e-2)

        saved_item = db.query(ShipmentScheduleItem).filter(ShipmentScheduleItem.shipment_schedule_id == schedule.id).one()
        assert float(saved_item.volume_m3) == pytest.approx(0.012, abs=1e-4)
        assert float(saved_item.actual_weight_kg) == pytest.approx(2.0, abs=1e-3)
        assert float(saved_item.volumetric_weight_kg) == pytest.approx(2.0, abs=1e-3)
        assert float(saved_item.chargeable_weight_kg) == pytest.approx(2.0, abs=1e-3)
        assert float(saved_item.estimated_logistics_cost) == pytest.approx(17.0, abs=1e-2)
        assert float(saved_item.average_logistics_unit_price) == pytest.approx(1.7, abs=1e-4)


def test_list_shipment_fba_box_details_supports_multiple_shipment_nos():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        first_schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='FBA-001',
            warehouse_code='LAX9',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
        )
        second_schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='FBA-002',
            warehouse_code='ONT8',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
        )
        db.add_all([first_schedule, second_schedule])
        db.flush()

        db.add_all([
            ShipmentScheduleItem(
                shipment_schedule_id=first_schedule.id,
                project_id=project.id,
                shipment_no='FBA-001',
                sku='SKU-001',
                quantity=24,
                source_type='manual',
            ),
            ShipmentScheduleItem(
                shipment_schedule_id=second_schedule.id,
                project_id=project.id,
                shipment_no='FBA-002',
                sku='SKU-002',
                quantity=12,
                source_type='manual',
            ),
        ])
        db.add_all([
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-001',
                asin='ASIN-001',
                fnsku='FNSKU-001',
                fob_unit_cost=2,
                currency='USD',
                country='US',
                sort_order=1,
                is_active=True,
                units_per_carton=12,
                carton_length_cm=40,
                carton_width_cm=30,
                carton_height_cm=20,
                carton_weight_kg=8,
            ),
            ProductCost(
                project_name='宝勒1店',
                sku='SKU-002',
                asin='ASIN-002',
                fnsku='FNSKU-002',
                fob_unit_cost=3,
                currency='USD',
                country='US',
                sort_order=2,
                is_active=True,
                units_per_carton=6,
                carton_length_cm=35,
                carton_width_cm=25,
                carton_height_cm=18,
                carton_weight_kg=6,
            ),
        ])
        db.commit()

        rows, items = shipment_schedule_service.list_shipment_fba_box_details(
            db,
            shipment_nos=['FBA-001', 'FBA-002'],
        )

        assert [row.shipment_no for row in rows] == ['FBA-001', 'FBA-002']
        assert [item['shipment_no'] for item in items] == ['FBA-001', 'FBA-002']
        assert items[0]['project_name'] == '宝勒1店'
        assert items[0]['country'] == 'US'
        assert items[0]['carton_count'] == 2
        assert items[1]['carton_count'] == 2


def test_list_shipment_fba_box_details_rejects_missing_shipment_no():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.commit()

        with pytest.raises(HTTPException) as exc_info:
            shipment_schedule_service.list_shipment_fba_box_details(
                db,
                shipment_nos=['FBA-404'],
            )

        assert exc_info.value.status_code == 404
        assert 'FBA-404' in str(exc_info.value.detail)


def test_update_shipment_schedule_persists_history_calc_flag():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-HISTORY-001',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
            include_in_history_shipping_calc=True,
        )
        db.add(schedule)
        db.commit()

        payload = ShipmentScheduleUpdate(
            project_id=project.id,
            country='US',
            shipment_no='SHP-HISTORY-001-UPDATED',
            tracking_no=None,
            warehouse_code=None,
            forwarder_name=None,
            shipping_method='sea',
            created_date=None,
            etd_date=None,
            eta_date=None,
            actual_inbound_date=None,
            logistics_unit_price=0,
            include_in_history_shipping_calc=False,
            remark=None,
            shipment_status='draft',
            source_file=None,
        )
        row = shipment_schedule_service.update_shipment_schedule(db, schedule.id, payload, operator='tester')
        db.commit()

        assert row.shipment_no == 'SHP-HISTORY-001-UPDATED'
        assert row.include_in_history_shipping_calc is False


def test_list_shipment_sku_summary_uses_completed_and_history_calc_flag():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        included = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-SUM-001',
            shipping_method='sea',
            shipment_status='completed',
            source_type='manual',
            include_in_history_shipping_calc=True,
        )
        excluded = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-SUM-002',
            shipping_method='sea',
            shipment_status='completed',
            source_type='manual',
            include_in_history_shipping_calc=False,
        )
        db.add_all([included, excluded])
        db.flush()

        db.add_all(
            [
                ShipmentScheduleItem(
                    shipment_schedule_id=included.id,
                    project_id=project.id,
                    shipment_no=included.shipment_no,
                    sku='SKU-001',
                    quantity=10,
                    chargeable_weight_kg=2,
                    estimated_logistics_cost=17,
                    average_logistics_unit_price=1.7,
                    source_type='manual',
                ),
                ShipmentScheduleItem(
                    shipment_schedule_id=excluded.id,
                    project_id=project.id,
                    shipment_no=excluded.shipment_no,
                    sku='SKU-001',
                    quantity=5,
                    chargeable_weight_kg=1,
                    estimated_logistics_cost=9,
                    average_logistics_unit_price=1.8,
                    source_type='manual',
                ),
            ]
        )
        db.commit()

        rows = shipment_schedule_service.list_shipment_sku_summary(
            db,
            project_id=project.id,
            include_only_history_calc=True,
            shipment_status='completed',
        )

        assert len(rows) == 1
        assert rows[0]['country'] == 'US'
        assert rows[0]['sku'] == 'SKU-001'
        assert rows[0]['shipment_count'] == 1
        assert rows[0]['total_quantity'] == 10
        assert rows[0]['total_logistics_cost'] == pytest.approx(17.0)
        assert rows[0]['average_logistics_unit_price'] == pytest.approx(1.7)


def test_delete_shipment_schedule_removes_schedule_and_items():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        schedule = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-DEL-001',
            shipping_method='sea',
            shipment_status='draft',
            source_type='manual',
        )
        db.add(schedule)
        db.flush()

        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=project.id,
                shipment_no='SHP-DEL-001',
                sku='SKU-001',
                quantity=10,
                source_type='manual',
            )
        )
        db.commit()

        deleted = shipment_schedule_service.delete_shipment_schedule(db, schedule.id)
        db.commit()

        assert deleted.id == schedule.id
        assert db.get(ShipmentSchedule, schedule.id) is None
        remaining_items = db.query(ShipmentScheduleItem).filter(ShipmentScheduleItem.shipment_schedule_id == schedule.id).all()
        assert remaining_items == []


def test_list_shipment_sku_summary_supports_multiple_status_filters():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name='宝勒1店', sort_order=1, source_file='seed.csv')
        db.add(project)
        db.flush()

        completed = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-COMPLETED-001',
            shipping_method='sea',
            shipment_status='completed',
            include_in_history_shipping_calc=True,
            source_type='manual',
        )
        in_transit = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-TRANSIT-001',
            shipping_method='sea',
            shipment_status='in_transit',
            include_in_history_shipping_calc=True,
            source_type='manual',
        )
        draft = ShipmentSchedule(
            project_id=project.id,
            country='US',
            project_name_snapshot='宝勒1店',
            shipment_no='SHP-DRAFT-001',
            shipping_method='sea',
            shipment_status='draft',
            include_in_history_shipping_calc=True,
            source_type='manual',
        )
        db.add_all([completed, in_transit, draft])
        db.flush()

        db.add_all(
            [
                ShipmentScheduleItem(
                    shipment_schedule_id=completed.id,
                    project_id=project.id,
                    shipment_no=completed.shipment_no,
                    sku='SKU-001',
                    quantity=10,
                    chargeable_weight_kg=2,
                    estimated_logistics_cost=17,
                    average_logistics_unit_price=1.7,
                    source_type='manual',
                ),
                ShipmentScheduleItem(
                    shipment_schedule_id=in_transit.id,
                    project_id=project.id,
                    shipment_no=in_transit.shipment_no,
                    sku='SKU-001',
                    quantity=20,
                    chargeable_weight_kg=3,
                    estimated_logistics_cost=33,
                    average_logistics_unit_price=1.65,
                    source_type='manual',
                ),
                ShipmentScheduleItem(
                    shipment_schedule_id=draft.id,
                    project_id=project.id,
                    shipment_no=draft.shipment_no,
                    sku='SKU-001',
                    quantity=99,
                    chargeable_weight_kg=9,
                    estimated_logistics_cost=99,
                    average_logistics_unit_price=1.0,
                    source_type='manual',
                ),
            ]
        )
        db.commit()

        rows = shipment_schedule_service.list_shipment_sku_summary(
            db,
            project_id=project.id,
            include_only_history_calc=True,
            shipment_status='completed,in_transit',
        )

        assert len(rows) == 1
        assert rows[0]['country'] == 'US'
        assert rows[0]['sku'] == 'SKU-001'
        assert rows[0]['shipment_count'] == 2
        assert rows[0]['total_quantity'] == 30
        assert rows[0]['total_chargeable_weight_kg'] == pytest.approx(5.0)
        assert rows[0]['total_logistics_cost'] == pytest.approx(50.0)
        assert rows[0]['average_logistics_unit_price'] == pytest.approx(50 / 30, rel=1e-4)
