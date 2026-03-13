from pathlib import Path
import warnings

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


def _write_min_payment_csv_with_variable_headers(path: Path) -> None:
    lines = [
        'Settlement Report',
        'Account Type: Standard',
        'Amazon Payments',
        '',
        'Generated At: 2026-03-10 10:00:00',
        'Marketplace: US',
        'Store: Demo',
        'Currency: USD',
        'Notes: export contains variable header rows',
        'type,sku,quantity,product sales,shipping credits,promotional rebates,other,selling fees,fba fees',
        'Order,SKU1,10,120,0,0,0,-18,-25',
        'Refund,SKU1,2,-20,0,0,-1,2,3',
        'Order,SKU2,5,55,0,0,0,-7,-9',
    ]
    path.write_text('\n'.join(lines), encoding='utf-8')


def _write_min_payment_csv_de(path: Path) -> None:
    lines = [
        'Einschließlich Transaktionen zu Amazon Marketplace, Versand durch Amazon und Amazon Webstore',
        'Alle Beträge in Euro sofern nicht anders gekennzeichnet',
        'Definitionen:',
        'Verkaufsgebühren: Beinhaltet variable Abschlussgebühren und Werbekostenerstattungen.',
        'Andere: Enthält Beträge zu Transaktionen, die nicht auf eine Bestellung bezogen sind.',
        'Noch eine Hinweiszeile',
        'Noch eine Hinweiszeile 2',
        '"Datum/Uhrzeit","Abrechnungsnummer","Typ","Bestellnummer","SKU","Beschreibung","Menge","Marketplace","Versand","Ort der Bestellung","Bundesland","Postleitzahl","Steuererhebungsmodell","Umsätze","Produktumsatzsteuer","Gutschrift für Versandkosten","Steuer auf Versandgutschrift","Gutschrift für Geschenkverpackung","Steuer auf Geschenkverpackungsgutschriften","Rabatte aus Werbeaktionen","Steuer auf Aktionsrabatte","Einbehaltene Steuer auf Marketplace","Verkaufsgebühren","Gebühren zu Versand durch Amazon","Andere Transaktionsgebühren","Andere","Gesamt"',
        '"04.03.2026 23:33:33 UTC","24844475272","Bestellung","306-9200824-4290705","SKU1","Produkt 1","1","amazon.de","Amazon","Berlin","","12047","","1.234,56","0","0","0","0","0","-12,34","0","0","-0,30","-3,95","0","0","1.217,97"',
        '"05.03.2026 10:00:00 UTC","24844475272","Erstattung","306-9200824-4290705","SKU1","Produkt 1","1","amazon.de","Amazon","Berlin","","12047","","-100,00","0","0","0","0","0","0","0","0","0,30","3,95","0","-1,00","-96,75"',
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
        lambda project_name, country, year_month=None: pd.DataFrame(
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
        lambda project_name, country, year_month=None: pd.DataFrame(
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


def test_product_analysis_script_supports_payment_report_with_variable_header_rows(monkeypatch, tmp_path: Path):
    business = tmp_path / 'business.csv'
    payment = tmp_path / 'payment-variable-header.csv'
    ad = tmp_path / 'ad.xlsx'

    _write_min_business_csv(business)
    _write_min_payment_csv_with_variable_headers(payment)
    _write_min_ad_xlsx(ad)

    monkeypatch.setattr(
        product_analysis,
        '_load_project_costs_df',
        lambda project_name, country, year_month=None: pd.DataFrame(
            [
                {'SKU': 'SKU1', 'ASIN': 'ASIN1', '头程单价': 2.0, 'FOB单价': 3.0},
                {'SKU': 'SKU2', 'ASIN': 'ASIN2', '头程单价': 1.5, 'FOB单价': 2.5},
            ]
        ),
    )

    result = product_analysis.run(
        str(business),
        str(tmp_path / 'out3'),
        {
            'project_name': 'Demo',
            'report_start_date': '2026-02-01',
            'report_end_date': '2026-02-07',
            'payment_report_path': str(payment),
            'ad_report_path': str(ad),
        },
    )

    wb = load_workbook(result['result_path'])
    ws = wb['产品分析']
    headers = [ws.cell(row=1, column=i).value for i in range(1, ws.max_column + 1)]
    idx_sku = headers.index('SKU')

    assert ws.cell(row=2, column=idx_sku + 1).value == 'SKU1'


def test_read_payment_report_supports_german_headers_and_decimal_format(tmp_path: Path):
    payment = tmp_path / 'payment-de.csv'
    _write_min_payment_csv_de(payment)

    df = product_analysis._read_payment_report(payment)

    assert list(df[['type', 'sku']].iloc[0]) == ['Order', 'SKU1']
    assert list(df[['type', 'sku']].iloc[1]) == ['Refund', 'SKU1']
    assert df.iloc[0]['quantity'] == 1
    assert df.iloc[0]['product sales'] == 1234.56
    assert df.iloc[0]['promotional rebates'] == -12.34
    assert df.iloc[0]['selling fees'] == -0.30
    assert df.iloc[0]['fba fees'] == -3.95
    assert df.iloc[1]['other'] == -1.0


def test_read_excel_without_style_warning_suppresses_known_openpyxl_warning(monkeypatch, tmp_path: Path):
    expected = pd.DataFrame([{'广告SKU': 'SKU1'}])

    def fake_read_excel(path, engine):
        warnings.warn(
            "Workbook contains no default style, apply openpyxl's default",
            UserWarning,
            stacklevel=1,
        )
        return expected

    monkeypatch.setattr(product_analysis.pd, 'read_excel', fake_read_excel)

    with warnings.catch_warnings(record=True) as captured:
        warnings.simplefilter('always')
        result = product_analysis._read_excel_without_style_warning(tmp_path / 'ad.xlsx')

    assert result.equals(expected)
    assert captured == []
