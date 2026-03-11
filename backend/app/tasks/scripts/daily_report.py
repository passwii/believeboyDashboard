from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment


def _safe_project_name(project_name: str) -> str:
    sanitized = ''.join(ch for ch in project_name.strip() if ch not in r'\\/:*?"<>|')
    return sanitized or 'unknown'


def _to_float(value: object) -> float:
    if value is None:
        return 0.0
    text = str(value).strip().replace(',', '')
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def _to_int(value: object) -> int:
    return int(_to_float(value))


def _load_tsv_rows(path: Path) -> list[dict[str, Any]]:
    with path.open('r', encoding='utf-8-sig', newline='') as fh:
        reader = csv.DictReader(fh, delimiter='\t')
        rows: list[dict[str, Any]] = []
        for row in reader:
            normalized = {}
            for key, value in row.items():
                normalized[(key or '').strip()] = value.strip() if isinstance(value, str) else value
            rows.append(normalized)
    return rows


def _load_excel_rows(path: Path) -> list[dict[str, Any]]:
    # Some Amazon-generated xlsx files have wrong worksheet dimension (for example "A1"),
    # which causes read_only iteration to only read one cell.
    wb = load_workbook(path, data_only=True, read_only=False)
    ws = wb.active
    iterator = ws.iter_rows(values_only=True)
    header_values = next(iterator, None)
    if not header_values:
        return []
    headers = [str(item).strip() if item is not None else '' for item in header_values]
    rows: list[dict[str, Any]] = []
    for row_values in iterator:
        row = {}
        for idx, value in enumerate(row_values):
            key = headers[idx] if idx < len(headers) else ''
            if key:
                row[key] = value
        rows.append(row)
    return rows


def _aggregate_sales(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    allowed_status = {'Pending', 'Shipped', 'Unshipped'}
    grouped: dict[str, dict[str, Any]] = {}

    for row in rows:
        status = str(row.get('order-status', '')).strip()
        if status not in allowed_status:
            continue
        sku = str(row.get('sku', '')).strip()
        if not sku:
            continue
        asin = str(row.get('asin', '')).strip()
        bucket = grouped.setdefault(sku, {'SKU': sku, 'ASIN': asin, '订单量': 0, '销售额': 0.0})
        if not bucket.get('ASIN') and asin:
            bucket['ASIN'] = asin
        bucket['订单量'] += _to_int(row.get('quantity'))
        bucket['销售额'] += _to_float(row.get('item-price'))

    return grouped


def _aggregate_ads(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        sku = str(row.get('广告SKU', '')).strip()
        if not sku:
            continue
        asin = str(row.get('广告ASIN', '')).strip()
        bucket = grouped.setdefault(
            sku,
            {'SKU': sku, 'ASIN': asin, '曝光量': 0, '点击量': 0, '广告花费': 0.0, '广告订单': 0},
        )
        if not bucket.get('ASIN') and asin:
            bucket['ASIN'] = asin
        bucket['曝光量'] += _to_int(row.get('展示量'))
        bucket['点击量'] += _to_int(row.get('点击量'))
        bucket['广告花费'] += _to_float(row.get('花费'))
        bucket['广告订单'] += _to_int(row.get('7天总销售量(#)'))

    total_clicks = sum(item['点击量'] for item in grouped.values())
    for item in grouped.values():
        if total_clicks > 0 and item['点击量'] > 0:
            item['单次点击花费'] = item['广告花费'] / item['点击量']
        elif total_clicks > 0:
            item['单次点击花费'] = 0.0
        else:
            item['单次点击花费'] = 0.0
    return grouped


def _aggregate_inventory(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        sku = str(row.get('sku', '')).strip()
        if not sku:
            continue
        asin = str(row.get('asin', '')).strip()
        bucket = grouped.setdefault(sku, {'SKU': sku, 'ASIN': asin, '可售库存': 0})
        if not bucket.get('ASIN') and asin:
            bucket['ASIN'] = asin
        bucket['可售库存'] += _to_int(row.get('available'))
    return grouped


def _resolve_report_paths(input_path: str, params: dict) -> tuple[Path, Path, Path]:
    resolved = params.get('resolved_file_paths')
    resolved_paths = resolved if isinstance(resolved, dict) else {}

    sales_raw = (
        resolved_paths.get('sales_report')
        or params.get('sales_report_path')
        or params.get('fba_sales_report_path')
        or input_path
    )
    ad_raw = resolved_paths.get('ad_report') or params.get('ad_report_path')
    inventory_raw = (
        resolved_paths.get('inventory_report')
        or params.get('inventory_report_path')
        or params.get('fba_report_path')
    )

    if not sales_raw or not ad_raw or not inventory_raw:
        raise ValueError('Missing report paths, expected sales/ad/inventory reports')

    sales_path = Path(str(sales_raw))
    ad_path = Path(str(ad_raw))
    inventory_path = Path(str(inventory_raw))
    for path in (sales_path, ad_path, inventory_path):
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f'Report file not found: {path}')
    return sales_path, ad_path, inventory_path


def _build_overview_rows(
    report_date: str,
    country: str,
    sales: dict[str, dict[str, Any]],
    ads: dict[str, dict[str, Any]],
    inventory: dict[str, dict[str, Any]],
) -> list[list[Any]]:
    columns = [
        '日期(US)',
        '国家站点',
        'SKU',
        'ASIN',
        '订单量',
        '销售额',
        '曝光量',
        '点击量',
        '单次点击花费',
        '广告花费',
        '广告订单',
        '可售库存',
    ]

    all_skus = sorted(set(sales.keys()) | set(ads.keys()) | set(inventory.keys()))
    rows: list[list[Any]] = [columns]

    for sku in all_skus:
        s = sales.get(sku, {})
        a = ads.get(sku, {})
        i = inventory.get(sku, {})
        order_qty = int(s.get('订单量', 0))
        sales_amount = float(s.get('销售额', 0.0))
        impression = int(a.get('曝光量', 0))
        clicks = int(a.get('点击量', 0))
        cpc = round(float(a.get('单次点击花费', 0.0)), 2)
        ad_cost = round(float(a.get('广告花费', 0.0)), 2)
        ad_orders = int(a.get('广告订单', 0))
        stock = int(i.get('可售库存', 0))
        asin = str(
            a.get('ASIN')
            or s.get('ASIN')
            or i.get('ASIN')
            or ''
        ).strip()

        rows.append(
            [
                report_date,
                country,
                sku,
                asin,
                order_qty,
                sales_amount,
                impression,
                clicks,
                cpc,
                ad_cost,
                ad_orders,
                stock,
            ]
        )
    return rows


def _load_template_or_create() -> Workbook:
    backend_root = Path(__file__).resolve().parents[3]
    template = backend_root / 'storage' / 'model-file' / 'daily_template.xlsx'
    if template.exists():
        return load_workbook(template)
    wb = Workbook()
    wb.active.title = '日报'
    return wb


def run(input_path: str, output_dir: str, params: dict) -> dict:
    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)

    project_name = _safe_project_name(str(params.get('project_name', 'unknown')))
    country = str(params.get('country', 'US')).strip().upper() or 'US'
    report_date = str(params.get('report_date', datetime.utcnow().date().isoformat()))
    sales_path, ad_path, inventory_path = _resolve_report_paths(input_path, params)

    sales_rows = _load_tsv_rows(sales_path)
    ad_rows = _load_excel_rows(ad_path)
    inventory_rows = _load_tsv_rows(inventory_path)

    sales = _aggregate_sales(sales_rows)
    ads = _aggregate_ads(ad_rows)
    inventory = _aggregate_inventory(inventory_rows)
    overview_rows = _build_overview_rows(report_date, country, sales, ads, inventory)

    wb = _load_template_or_create()
    ws = wb.active
    for row_idx, row in enumerate(overview_rows, start=1):
        for col_idx, value in enumerate(row, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            cell.alignment = Alignment(horizontal='center', vertical='center')

    filename = f'{project_name}_Daily_Report_{report_date}.xlsx'
    result_path = output_root / filename
    wb.save(result_path)

    return {
        'result_path': str(result_path.resolve()),
        'filename': filename,
        'message': 'Daily report generated',
    }
