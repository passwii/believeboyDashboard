from pathlib import Path

import pytest
from fastapi import HTTPException

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
