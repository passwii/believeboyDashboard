from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import ProductCost
from app.schemas.product_cost import ProductCostCreate, ProductCostUpdate
from app.services import product_cost_service


def test_read_product_cost_csv_file_success(tmp_path: Path):
    csv_path = tmp_path / 'BLF_Basic_Info.csv'
    csv_path.write_text(
        'project_name,SKU,ASIN,FOB单价\n'
        '宝勒1店,SKU-001,B000000001,3.4\n',
        encoding='utf-8',
    )

    items, source_file = product_cost_service.read_product_cost_csv_file(csv_path)

    assert source_file == 'BLF_Basic_Info.csv'
    assert len(items) == 1
    assert items[0].project_name == '宝勒1店'
    assert items[0].sku == 'SKU-001'
    assert items[0].asin == 'B000000001'


def test_read_product_cost_csv_file_missing():
    with pytest.raises(HTTPException) as exc:
        product_cost_service.read_product_cost_csv_file(Path('/tmp/not-exist.csv'))

    assert exc.value.status_code == 500
    assert 'CSV 文件不存在' in str(exc.value.detail)


def test_upsert_product_cost_assigns_incremental_sort_order():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        row1, action1 = product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=2,
                currency='USD',
            ),
        )
        row2, action2 = product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(
                project_name='Demo',
                sku='SKU2',
                asin='ASIN2',
                fob_unit_cost=2,
                currency='USD',
            ),
        )
        row3, action3 = product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(
                project_name='Other',
                sku='SKU1',
                asin='ASIN9',
                fob_unit_cost=2,
                currency='USD',
            ),
        )
        db.commit()

        assert action1 == 'inserted'
        assert action2 == 'inserted'
        assert action3 == 'inserted'
        assert row1.sort_order == 1
        assert row2.sort_order == 2
        assert row3.sort_order == 1


def test_update_product_cost_by_id_updates_sort_order():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        row, _ = product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fob_unit_cost=2,
                currency='USD',
            ),
        )
        db.commit()

        updated = product_cost_service.update_product_cost_by_id(
            db,
            row.id,
            ProductCostUpdate(
                sku='SKU1',
                asin='ASIN1',
                fnsku='FNSKU-1',
                fob_unit_cost=2.34,
                package_length_cm=12.5,
                package_width_cm=6.2,
                package_height_cm=3.1,
                weight_kg=0.876,
                carton_length_cm=40,
                carton_width_cm=30,
                carton_height_cm=20,
                carton_weight_kg=9.888,
                units_per_carton=12,
                currency='USD',
                sort_order=10,
                is_active=True,
            ),
        )
        db.commit()

        assert updated.sort_order == 10
        assert float(updated.fob_unit_cost) == 2.34
        assert updated.fnsku == 'FNSKU-1'
        assert float(updated.weight_kg) == 0.876
        assert updated.units_per_carton == 12


def test_move_product_cost_sort_order_swaps_with_neighbor():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        for idx in range(1, 4):
            db.add(
                ProductCost(
                    project_name='Demo',
                    sku=f'SKU{idx}',
                    asin=f'ASIN{idx}',
                    fob_unit_cost=2,
                    currency='USD',
                    sort_order=idx,
                    is_active=True,
                )
            )
        db.commit()

        middle = db.execute(select(ProductCost).where(ProductCost.sku == 'SKU2')).scalars().first()
        assert middle is not None
        moved = product_cost_service.move_product_cost_sort_order(db, middle.id, 'up')
        db.commit()

        ordered = db.execute(
            select(ProductCost).where(ProductCost.project_name == 'Demo').order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())
        ).scalars().all()
        assert moved.sort_order == 1
        assert [row.sku for row in ordered] == ['SKU2', 'SKU1', 'SKU3']


def test_recalculate_first_leg_costs_uses_chargeable_weight():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        row, _ = product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                package_length_cm=30,
                package_width_cm=20,
                package_height_cm=10,
                weight_kg=0.5,
                fob_unit_cost=2,
                currency='USD',
            ),
        )
        db.commit()

        updated = product_cost_service.recalculate_first_leg_costs(
            db,
            project_name='Demo',
            unit_price_per_kg_rmb=6,
        )
        db.commit()

        refreshed = db.execute(select(ProductCost).where(ProductCost.id == row.id)).scalars().one()
        assert updated == 1
        assert float(refreshed.first_leg_cost_rmb) == 6.0


def test_parse_product_cost_csv_allows_empty_asin():
    items = product_cost_service.parse_product_cost_csv(
        'project_name,SKU,ASIN,FNSKU,FOB单价,国家\nDemo,SKU1,,,2.5,US\n'.encode('utf-8')
    )

    assert len(items) == 1
    assert items[0].project_name == 'Demo'
    assert items[0].sku == 'SKU1'
    assert items[0].asin == ''


def test_import_product_costs_update_only_overwrites_filled_fields():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        row, _ = product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(
                project_name='Demo',
                sku='SKU1',
                asin='ASIN1',
                fnsku='FNSKU1',
                fob_unit_cost=2.5,
                package_length_cm=10,
                country='US',
            ),
        )
        db.commit()

        rows, inserted, updated, skipped = product_cost_service.import_product_costs(
            db,
            [
                ProductCostCreate(
                    project_name='Demo',
                    sku='SKU1',
                    asin='',
                    fnsku='',
                    fob_unit_cost=3.8,
                    country='US',
                )
            ],
            import_mode='update',
            source_file='test.csv',
        )
        db.commit()

        refreshed = db.execute(select(ProductCost).where(ProductCost.id == row.id)).scalars().one()
        assert len(rows) == 1
        assert inserted == 0
        assert updated == 1
        assert skipped == 0
        assert refreshed.asin == 'ASIN1'
        assert refreshed.fnsku == 'FNSKU1'
        assert float(refreshed.fob_unit_cost) == 3.8
        assert float(refreshed.package_length_cm) == 10


def test_import_product_costs_create_skips_existing_rows():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        product_cost_service.upsert_product_cost(
            db,
            ProductCostCreate(project_name='Demo', sku='SKU1', asin='ASIN1', country='US', fob_unit_cost=2),
        )
        db.commit()

        _, inserted, updated, skipped = product_cost_service.import_product_costs(
            db,
            [ProductCostCreate(project_name='Demo', sku='SKU1', asin='', country='US', fob_unit_cost=5)],
            import_mode='create',
            source_file='test.csv',
        )
        db.commit()

        assert inserted == 0
        assert updated == 0
        assert skipped == 1
