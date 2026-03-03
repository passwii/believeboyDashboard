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
        'project_name,SKU,ASIN,头程单价,FOB单价\n'
        '宝勒1店,SKU-001,B000000001,1.2,3.4\n',
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
                first_leg_unit_cost=1,
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
                first_leg_unit_cost=1,
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
                first_leg_unit_cost=1,
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
                first_leg_unit_cost=1,
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
                first_leg_unit_cost=1.23,
                fob_unit_cost=2.34,
                currency='USD',
                sort_order=10,
                is_active=True,
            ),
        )
        db.commit()

        assert updated.sort_order == 10
        assert float(updated.first_leg_unit_cost) == 1.23


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
                    first_leg_unit_cost=1,
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
