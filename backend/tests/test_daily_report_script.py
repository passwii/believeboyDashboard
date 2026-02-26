from __future__ import annotations

import zipfile
from pathlib import Path

from openpyxl import Workbook, load_workbook

from app.tasks.scripts import daily_report


def _write_sales_tsv(path: Path) -> None:
    path.write_text(
        '\t'.join(
            [
                'amazon-order-id',
                'order-status',
                'sku',
                'asin',
                'quantity',
                'item-price',
            ]
        )
        + '\n'
        + '\t'.join(['OID-1', 'Shipped', 'SKU1', 'ASIN-AD', '2', '39.98'])
        + '\n'
        + '\t'.join(['OID-2', 'Pending', 'SKU2', 'ASIN-FALLBACK', '1', '19.99'])
        + '\n',
        encoding='utf-8',
    )


def _write_inventory_tsv(path: Path) -> None:
    path.write_text(
        'sku\tasin\tavailable\n'
        'SKU1\tASIN-AD\t10\n'
        'SKU2\tASIN-FALLBACK\t8\n',
        encoding='utf-8',
    )


def _write_ad_xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.append(['广告SKU', '广告ASIN', '展示量', '点击量', '花费', '7天总销售量(#)'])
    ws.append(['SKU1', 'ASIN-AD', 100, 5, 10.5, 2])
    wb.save(path)


def _force_dimension_a1(path: Path) -> None:
    with zipfile.ZipFile(path, 'r') as zf:
        files = {name: zf.read(name) for name in zf.namelist()}

    sheet_name = 'xl/worksheets/sheet1.xml'
    sheet_xml = files[sheet_name].decode('utf-8').replace('dimension ref="A1:F2"', 'dimension ref="A1"')
    files[sheet_name] = sheet_xml.encode('utf-8')

    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, content in files.items():
            zf.writestr(name, content)


def test_daily_report_reads_ad_xlsx_even_with_wrong_dimension(tmp_path: Path):
    sales = tmp_path / 'sales.txt'
    inventory = tmp_path / 'inventory.txt'
    ad = tmp_path / 'ad.xlsx'

    _write_sales_tsv(sales)
    _write_inventory_tsv(inventory)
    _write_ad_xlsx(ad)
    _force_dimension_a1(ad)

    result = daily_report.run(
        str(sales),
        str(tmp_path / 'out'),
        {
            'project_name': 'Demo',
            'report_date': '2026-02-25',
            'resolved_file_paths': {
                'sales_report': str(sales),
                'ad_report': str(ad),
                'inventory_report': str(inventory),
            },
        },
    )

    ws = load_workbook(result['result_path'], data_only=True).active
    headers = [ws.cell(row=1, column=i).value for i in range(1, ws.max_column + 1)]
    idx_sku = headers.index('SKU') + 1
    idx_asin = headers.index('ASIN') + 1
    idx_impression = headers.index('曝光量') + 1
    idx_clicks = headers.index('点击量') + 1
    idx_cost = headers.index('广告花费') + 1

    rows = {ws.cell(row=r, column=idx_sku).value: r for r in range(2, ws.max_row + 1)}
    sku1 = rows['SKU1']

    assert ws.cell(row=sku1, column=idx_asin).value == 'ASIN-AD'
    assert ws.cell(row=sku1, column=idx_impression).value == 100
    assert ws.cell(row=sku1, column=idx_clicks).value == 5
    assert ws.cell(row=sku1, column=idx_cost).value == 10.5


def test_daily_report_falls_back_asin_from_sales_or_inventory(tmp_path: Path):
    sales = tmp_path / 'sales2.txt'
    inventory = tmp_path / 'inventory2.txt'
    ad = tmp_path / 'ad2.xlsx'

    _write_sales_tsv(sales)
    _write_inventory_tsv(inventory)
    _write_ad_xlsx(ad)

    result = daily_report.run(
        str(sales),
        str(tmp_path / 'out2'),
        {
            'project_name': 'Demo',
            'report_date': '2026-02-25',
            'resolved_file_paths': {
                'sales_report': str(sales),
                'ad_report': str(ad),
                'inventory_report': str(inventory),
            },
        },
    )

    ws = load_workbook(result['result_path'], data_only=True).active
    headers = [ws.cell(row=1, column=i).value for i in range(1, ws.max_column + 1)]
    idx_sku = headers.index('SKU') + 1
    idx_asin = headers.index('ASIN') + 1

    rows = {ws.cell(row=r, column=idx_sku).value: r for r in range(2, ws.max_row + 1)}
    assert ws.cell(row=rows['SKU2'], column=idx_asin).value == 'ASIN-FALLBACK'
