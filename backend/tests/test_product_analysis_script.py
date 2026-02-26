from pathlib import Path

import pandas as pd
from openpyxl import Workbook, load_workbook

from app.tasks.scripts import product_analysis


def _write_min_business_csv(path: Path) -> None:
    path.write_text(
        '（子）ASIN,页面浏览量 - 总计 ,已订购商品数量,会话数 - 总计,已订购商品销售额\n'
        'ASIN1,100,10,90,US$120.00\n'
        'ASIN2,50,5,40,US$55.00\n',
        encoding='utf-8',
    )


def _write_min_payment_csv(path: Path) -> None:
    lines = [
        'header1',
        'header2',
        'header3',
        'header4',
        'header5',
        'header6',
        'header7',
        'type,sku,quantity,product sales,shipping credits,promotional rebates,other,selling fees,fba fees',
        'Order,SKU1,10,120,0,0,0,-18,-25',
        'Refund,SKU1,2,-20,0,0,-1,2,3',
        'Order,SKU2,5,55,0,0,0,-7,-9',
    ]
    path.write_text('\n'.join(lines), encoding='utf-8')


def _write_min_ad_xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.append(['广告SKU', '广告ASIN', '展示量', '点击量', '花费', '7天总销售额', '7天总销售量(#)'])
    ws.append(['SKU1', 'ASIN1', 200, 0, 12.0, 30.0, 3])  # 点击=0，验证广告转化率=0
    ws.append(['SKU2', 'ASIN2', 100, 10, 8.0, 25.0, 2])
    wb.save(path)


def _write_min_inventory_txt(path: Path) -> None:
    path.write_text(
        'sku\tasin\tavailable\tinv-age-0-to-90-days\tinv-age-91-to-180-days\tinv-age-181-to-270-days\tinv-age-271-to-365-days\tinv-age-365-plus-days\trecommended-action\n'
        'SKU1\tASIN1\t20\t10\t5\t3\t1\t1\tkeep\n'
        'SKU2\tASIN2\t9\t5\t2\t1\t1\t0\trestock\n',
        encoding='utf-8',
    )


def test_product_analysis_script_generates_main_sheet_without_inventory(monkeypatch, tmp_path: Path):
    business = tmp_path / 'business.csv'
    payment = tmp_path / 'payment.csv'
    ad = tmp_path / 'ad.xlsx'

    _write_min_business_csv(business)
    _write_min_payment_csv(payment)
    _write_min_ad_xlsx(ad)

    monkeypatch.setattr(
        product_analysis,
        '_load_project_costs_df',
        lambda project_name: pd.DataFrame(
            [
                {'SKU': 'SKU1', 'ASIN': 'ASIN1', '头程单价': 2.0, 'FOB单价': 3.0},
                {'SKU': 'SKU2', 'ASIN': 'ASIN2', '头程单价': 1.5, 'FOB单价': 2.5},
            ]
        ),
    )

    result = product_analysis.run(
        str(business),
        str(tmp_path / 'out'),
        {
            'project_name': 'Demo',
            'report_start_date': '2026-02-01',
            'report_end_date': '2026-02-07',
            'payment_report_path': str(payment),
            'ad_report_path': str(ad),
        },
    )

    out_path = Path(result['result_path'])
    assert out_path.exists()

    wb = load_workbook(out_path)
    assert wb.sheetnames == ['产品分析']

    ws = wb['产品分析']
    headers = [ws.cell(row=1, column=i).value for i in range(1, ws.max_column + 1)]
    row1 = [ws.cell(row=2, column=i).value for i in range(1, ws.max_column + 1)]
    row2 = [ws.cell(row=3, column=i).value for i in range(1, ws.max_column + 1)]

    idx_sku = headers.index('SKU')
    idx_ad_conv = headers.index('广告转化率')

    # SKU1 clicks=0 => 广告转化率必须为0
    sku_to_row = {row[idx_sku]: row for row in [row1, row2]}
    assert sku_to_row['SKU1'][idx_ad_conv] == 0

    # 最后一行是汇总
    assert ws.cell(row=ws.max_row, column=idx_sku + 1).value == '汇总'


def test_product_analysis_script_generates_inventory_sheet(monkeypatch, tmp_path: Path):
    business = tmp_path / 'business.csv'
    payment = tmp_path / 'payment.csv'
    ad = tmp_path / 'ad.xlsx'
    inventory = tmp_path / 'inventory.txt'

    _write_min_business_csv(business)
    _write_min_payment_csv(payment)
    _write_min_ad_xlsx(ad)
    _write_min_inventory_txt(inventory)

    monkeypatch.setattr(
        product_analysis,
        '_load_project_costs_df',
        lambda project_name: pd.DataFrame(
            [
                {'SKU': 'SKU1', 'ASIN': 'ASIN1', '头程单价': 2.0, 'FOB单价': 3.0},
                {'SKU': 'SKU2', 'ASIN': 'ASIN2', '头程单价': 1.5, 'FOB单价': 2.5},
            ]
        ),
    )

    result = product_analysis.run(
        str(business),
        str(tmp_path / 'out2'),
        {
            'project_name': 'Demo',
            'report_start_date': '2026-02-01',
            'report_end_date': '2026-02-07',
            'payment_report_path': str(payment),
            'ad_report_path': str(ad),
            'inventory_report_path': str(inventory),
        },
    )

    wb = load_workbook(result['result_path'])
    assert '库存详情' in wb.sheetnames
