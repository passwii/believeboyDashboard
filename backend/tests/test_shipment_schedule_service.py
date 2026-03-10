import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import ProductCost, Project
from app.models.shipment_schedule import ShipmentSchedule
from app.services import shipment_schedule_service


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
                first_leg_unit_cost=1,
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
        assert 'SKU Cost' in str(exc_info.value.detail)
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
                first_leg_unit_cost=1,
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
