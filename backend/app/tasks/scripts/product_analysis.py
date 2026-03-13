from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any
import warnings

import numpy as np
import pandas as pd
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, Side
from openpyxl.utils import get_column_letter
from openpyxl.utils.dataframe import dataframe_to_rows
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import ProductCost
from app.services import exchange_rate_service


COUNTRY_ALIASES = {
    'US': 'US',
    'USA': 'US',
    '美国': 'US',
    '美国站': 'US',
    'DE': 'DE',
    'GERMANY': 'DE',
    '德国': 'DE',
    '德国站': 'DE',
    'UK': 'UK',
    'GB': 'UK',
    'UNITED KINGDOM': 'UK',
    '英国': 'UK',
    '英国站': 'UK',
}

PERCENT_COLUMNS = {
    '总转化',
    '广告点击率',
    '广告单占比',
    '广告转化率',
    'ACOS',
    'SP占比',
    '自然流量占比',
    '自然单转化',
    '成本占比',
    '头程占比',
    '配送费占比',
    '佣金占比',
    '总成本占比',
    '利润率',
    '退款率',
}


PAYMENT_REPORT_REQUIRED_COLUMNS = {
    'type',
    'sku',
    'quantity',
    'product sales',
    'shipping credits',
    'promotional rebates',
    'other',
    'selling fees',
    'fba fees',
}

PAYMENT_REPORT_COLUMN_ALIASES = {
    'type': ['type', 'typ'],
    'sku': ['sku'],
    'quantity': ['quantity', 'menge'],
    'product sales': ['product sales', 'umsaetze', 'umsätze'],
    'shipping credits': ['shipping credits', 'gutschrift fuer versandkosten', 'gutschrift für versandkosten'],
    'promotional rebates': ['promotional rebates', 'rabatte aus werbeaktionen'],
    'other': ['other', 'andere'],
    'selling fees': ['selling fees', 'verkaufsgebuehren', 'verkaufsgebühren'],
    'fba fees': ['fba fees', 'gebuehren zu versand durch amazon', 'gebühren zu versand durch amazon'],
}

PAYMENT_REPORT_TYPE_ALIASES = {
    'order': ['order', 'bestellung'],
    'refund': ['refund', 'erstattung'],
}

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = r"Workbook contains no default style, apply openpyxl's default"


def _safe_project_name(project_name: str) -> str:
    sanitized = ''.join(ch for ch in project_name.strip() if ch not in r'\\/:*?"<>|')
    return sanitized or 'unknown'


def _safe_div(numerator: pd.Series | float, denominator: pd.Series | float) -> pd.Series | float:
    if isinstance(numerator, pd.Series):
        den = denominator if isinstance(denominator, pd.Series) else pd.Series(denominator, index=numerator.index)
        return np.where(den == 0, 0, numerator / den)
    if denominator == 0:
        return 0
    return numerator / denominator


def _format_report_date(report_start_date: str, report_end_date: str) -> str:
    start = datetime.strptime(report_start_date, '%Y-%m-%d')
    end = datetime.strptime(report_end_date, '%Y-%m-%d')
    return f"{start.strftime('%Y%m%d')}-{end.strftime('%m%d')}"


def _read_excel_without_style_warning(path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore', message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING, category=UserWarning)
        return pd.read_excel(path, engine='openpyxl')


def _load_workbook_without_style_warning(path: Path) -> Workbook:
    with warnings.catch_warnings():
        warnings.filterwarnings('ignore', message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING, category=UserWarning)
        return load_workbook(path)


def _read_business_report(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path, encoding='utf-8-sig')
    df.columns = [str(col).strip() for col in df.columns]

    aliases = {
        'ASIN': ['（子）ASIN', '(子)ASIN', '子ASIN', 'ASIN'],
        '页面浏览量': ['页面浏览量 - 总计', '页面浏览量-总计', 'Page Views - Total'],
        '总销量': ['已订购商品数量', 'Ordered Product Sales Units', 'Units Ordered'],
        '总访客': ['会话数 - 总计', '会话数-总计', 'Sessions - Total'],
        '总销售额': ['已订购商品销售额', 'Ordered Product Sales', 'Ordered Product Sales Amount'],
    }

    mapped: dict[str, str] = {}
    for target, candidates in aliases.items():
        for candidate in candidates:
            if candidate in df.columns:
                mapped[target] = candidate
                break

    missing = [key for key in aliases.keys() if key not in mapped]
    if missing:
        raise ValueError(f'Business report missing required columns: {missing}')

    result = df[[mapped['ASIN'], mapped['页面浏览量'], mapped['总销量'], mapped['总访客'], mapped['总销售额']]].copy()
    result.columns = ['ASIN', '页面浏览量', '总销量', '总访客', '总销售额']

    result['总销售额'] = (
        result['总销售额']
        .astype(str)
        .str.replace(r'[^0-9.\-]', '', regex=True)
        .replace('', '0')
        .astype(float)
    )
    result['页面浏览量'] = pd.to_numeric(result['页面浏览量'], errors='coerce').fillna(0)
    result['总销量'] = pd.to_numeric(result['总销量'], errors='coerce').fillna(0)
    result['总访客'] = pd.to_numeric(result['总访客'], errors='coerce').fillna(0)

    return result


def _read_ad_report(path: Path) -> pd.DataFrame:
    df = _read_excel_without_style_warning(path)
    df.columns = [str(col).strip() for col in df.columns]

    required = ['广告SKU', '展示量', '点击量', '花费', '7天总销售额', '7天总销售量(#)']
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f'Ad report missing required columns: {missing}')

    grouped = df[required].copy().groupby('广告SKU', as_index=False).sum()
    grouped.rename(
        columns={
            '广告SKU': 'SKU',
            '展示量': '广告展示量',
            '点击量': '广告点击量',
            '花费': '广告花费',
            '7天总销售额': '广告销售额',
            '7天总销售量(#)': '广告订单量',
        },
        inplace=True,
    )

    grouped['广告展示量'] = pd.to_numeric(grouped['广告展示量'], errors='coerce').fillna(0)
    grouped['广告点击量'] = pd.to_numeric(grouped['广告点击量'], errors='coerce').fillna(0)
    grouped['广告花费'] = pd.to_numeric(grouped['广告花费'], errors='coerce').fillna(0)
    grouped['广告销售额'] = pd.to_numeric(grouped['广告销售额'], errors='coerce').fillna(0)
    grouped['广告订单量'] = pd.to_numeric(grouped['广告订单量'], errors='coerce').fillna(0)

    return grouped


def _normalize_payment_token(value: str) -> str:
    return ' '.join(
        str(value)
        .strip()
        .strip('"')
        .lower()
        .replace('\ufeff', '')
        .replace('ä', 'ae')
        .replace('ö', 'oe')
        .replace('ü', 'ue')
        .replace('ß', 'ss')
        .split()
    )


def _match_payment_columns(columns: list[str]) -> tuple[dict[str, str], str] | None:
    normalized_columns = {_normalize_payment_token(column): column for column in columns}
    mapped: dict[str, str] = {}

    for standard_name, aliases in PAYMENT_REPORT_COLUMN_ALIASES.items():
        for alias in aliases:
            source_name = normalized_columns.get(_normalize_payment_token(alias))
            if source_name:
                mapped[standard_name] = source_name
                break

    if PAYMENT_REPORT_REQUIRED_COLUMNS - set(mapped.keys()):
        return None

    locale = 'de' if any(_normalize_payment_token(col) == 'typ' for col in columns) else 'en'
    return mapped, locale


def _detect_payment_report_structure(path: Path) -> tuple[int, str, dict[str, str], str]:
    raw_bytes = path.read_bytes()
    decoded_text = None
    for encoding in ('utf-8-sig', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be'):
        try:
            decoded_text = raw_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded_text is None:
        decoded_text = raw_bytes.decode('latin1')

    for line_no, raw_line in enumerate(decoded_text.splitlines()):
        line = raw_line.strip()
        if not line:
            continue
        for delimiter in (',', '\t', ';'):
            columns = [part.strip().strip('"') for part in raw_line.split(delimiter)]
            matched = _match_payment_columns(columns)
            if matched is not None:
                column_mapping, locale = matched
                return line_no, delimiter, column_mapping, locale
    raise ValueError('Payment report missing required columns in header row')


def _parse_localized_number(value: Any, locale: str) -> float:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0.0
    text = str(value).strip()
    if not text or text.lower() in {'nan', 'none', 'null'}:
        return 0.0

    negative = text.startswith('(') and text.endswith(')')
    cleaned = ''.join(ch for ch in text if ch.isdigit() or ch in {',', '.', '-'})
    if not cleaned or cleaned in {'-', ',', '.', '-.', '-,'}:
        return 0.0

    if locale == 'de':
        cleaned = cleaned.replace('.', '').replace(',', '.')
    else:
        if ',' in cleaned and '.' in cleaned:
            cleaned = cleaned.replace(',', '')
        elif ',' in cleaned:
            cleaned = cleaned.replace(',', '')

    number = float(cleaned)
    return -number if negative and number > 0 else number


def _normalize_payment_type(value: Any) -> str:
    normalized = _normalize_payment_token(str(value or ''))
    for canonical, aliases in PAYMENT_REPORT_TYPE_ALIASES.items():
        if normalized in {_normalize_payment_token(alias) for alias in aliases}:
            return canonical.title()
    return str(value or '').strip()


def _read_payment_report(path: Path) -> pd.DataFrame:
    skiprows, delimiter, column_mapping, locale = _detect_payment_report_structure(path)
    df = pd.read_csv(
        path,
        encoding='utf-8-sig',
        sep=delimiter,
        skiprows=skiprows,
        engine='python',
        dtype=str,
    )
    df.columns = [str(col).strip() for col in df.columns]
    df.rename(columns={source: target for target, source in column_mapping.items()}, inplace=True)

    required = PAYMENT_REPORT_REQUIRED_COLUMNS
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f'Payment report missing required columns: {missing}')

    for col in ['quantity', 'product sales', 'shipping credits', 'promotional rebates', 'other', 'selling fees', 'fba fees']:
        df[col] = df[col].map(lambda value: _parse_localized_number(value, locale))

    df['sku'] = df['sku'].fillna('').astype(str).str.strip()
    df['type'] = df['type'].map(_normalize_payment_type)
    return df


def _normalize_country(value: str | None) -> str:
    normalized = (value or '').strip().upper()
    if not normalized:
        return 'US'
    mapped = COUNTRY_ALIASES.get(normalized, normalized)
    if mapped not in {'US', 'DE', 'UK'}:
        raise ValueError('country must be one of: US, DE, UK')
    return mapped


def _load_project_costs_df(project_name: str, country: str, year_month: str | None = None) -> pd.DataFrame:
    db = SessionLocal()
    try:
        stmt = select(ProductCost).where(
            ProductCost.project_name == project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
        rows = db.execute(stmt).scalars().all()
    finally:
        db.close()

    if not rows:
        raise ValueError(f'No active product_costs found for project_name={project_name}, country={country}')

    resolved_year_month = year_month or datetime.now().strftime('%Y-%m')
    data = []
    for row in rows:
        fob_cost, _ = exchange_rate_service.convert_rmb_to_target_currency(
            row.fob_unit_cost or 0,
            country=country,
            year_month=resolved_year_month,
            db=db,
        )
        first_leg_cost, _ = exchange_rate_service.convert_rmb_to_target_currency(
            row.first_leg_cost_rmb or 0,
            country=country,
            year_month=resolved_year_month,
            db=db,
        )
        data.append(
            {
                'SKU': row.sku,
                'ASIN': row.asin,
                '头程单价': float(first_leg_cost),
                'FOB单价': float(fob_cost),
            }
        )
    return pd.DataFrame(data)


def _build_payment_aggregate(df_payment: pd.DataFrame) -> pd.DataFrame:
    df_order_and_refund = df_payment.loc[df_payment['type'].isin(['Order', 'Refund'])]
    df_orders = df_payment.loc[df_payment['type'] == 'Order']
    df_refunds = df_payment.loc[df_payment['type'] == 'Refund']

    sale_refund_amz_fee = df_order_and_refund.groupby('sku', as_index=False).agg(
        {
            'selling fees': lambda x: round(x.mul(-1).sum(), 2),
            'fba fees': lambda x: round(x.mul(-1).sum(), 2),
        }
    )

    sale_group = df_orders.groupby('sku', as_index=False).agg(
        {
            'quantity': 'sum',
            'product sales': lambda x: round(x.sum(), 2),
            'shipping credits': lambda x: round(x.sum(), 2),
            'promotional rebates': lambda x: round(x.sum(), 2),
        }
    )
    sale_group['sale total'] = sale_group['product sales'] + sale_group['shipping credits'] + sale_group['promotional rebates']
    sale_group = sale_group.rename(columns={'quantity': '实际销售量', 'sale total': '实际销售额'})
    sale_group = sale_group.drop(columns=['product sales', 'shipping credits', 'promotional rebates'])

    refund_group = df_refunds.groupby('sku', as_index=False).agg(
        {
            'quantity': lambda x: abs(x.sum()),
            'product sales': lambda x: round(x.sum(), 2),
            'shipping credits': lambda x: round(x.sum(), 2),
            'promotional rebates': lambda x: round(x.sum(), 2),
            'other': lambda x: round(x.sum(), 2),
        }
    )
    refund_group['refund total'] = abs(
        refund_group['product sales']
        + refund_group['shipping credits']
        + refund_group['promotional rebates']
        + refund_group['other']
    )
    refund_group = refund_group.rename(columns={'quantity': '实际退款量', 'refund total': '实际退款额'})
    refund_group = refund_group.drop(columns=['product sales', 'shipping credits', 'promotional rebates', 'other'])

    merged = pd.merge(sale_group, refund_group, on='sku', how='left')
    merged = pd.merge(merged, sale_refund_amz_fee, on='sku', how='left')
    merged.rename(columns={'sku': 'SKU', 'selling fees': '平台佣金', 'fba fees': 'FBA配送费'}, inplace=True)
    return merged


def _build_overview(
    project_name: str,
    report_date: str,
    df_cost: pd.DataFrame,
    df_business: pd.DataFrame,
    df_ad: pd.DataFrame,
    df_payment: pd.DataFrame,
) -> pd.DataFrame:
    df_merge = pd.merge(df_cost, df_ad, on='SKU', how='left')
    df_merge = pd.merge(df_merge, df_business, on='ASIN', how='left')
    df_merge = pd.merge(df_merge, df_payment, on='SKU', how='left')

    numeric_cols = [
        '广告展示量',
        '广告点击量',
        '广告花费',
        '广告销售额',
        '广告订单量',
        '页面浏览量',
        '总销量',
        '总访客',
        '总销售额',
        '实际销售量',
        '实际销售额',
        '实际退款量',
        '实际退款额',
        '平台佣金',
        'FBA配送费',
        '头程单价',
        'FOB单价',
    ]
    for col in numeric_cols:
        if col in df_merge.columns:
            df_merge[col] = pd.to_numeric(df_merge[col], errors='coerce').fillna(0)

    df_merge['日期'] = report_date

    df_merge['总转化'] = _safe_div(df_merge['总销量'], df_merge['页面浏览量'])

    df_merge['广告点击率'] = _safe_div(df_merge['广告点击量'], df_merge['广告展示量'])
    df_merge['广告单占比'] = _safe_div(df_merge['广告订单量'], df_merge['总销量'])
    df_merge['广告转化率'] = _safe_div(df_merge['广告订单量'], df_merge['广告点击量'])
    df_merge['CPC'] = _safe_div(df_merge['广告花费'], df_merge['广告点击量'])
    df_merge['ACOS'] = _safe_div(df_merge['广告花费'], df_merge['广告销售额'])
    df_merge['SP占比'] = _safe_div(df_merge['广告花费'], df_merge['总销售额'])

    df_merge['自然流量'] = df_merge['页面浏览量'] - df_merge['广告点击量']
    df_merge['自然流量占比'] = _safe_div(df_merge['自然流量'], df_merge['页面浏览量'])
    df_merge['自然单'] = df_merge['总销量'] - df_merge['广告订单量']
    df_merge['自然单转化'] = _safe_div(df_merge['自然单'], df_merge['自然流量'])

    df_merge['产品FOB'] = df_merge['实际销售量'] * df_merge['FOB单价']
    df_merge['销售头程'] = df_merge['实际销售量'] * df_merge['头程单价']

    df_merge['成本占比'] = _safe_div(df_merge['产品FOB'], df_merge['实际销售额'])
    df_merge['头程占比'] = _safe_div(df_merge['销售头程'], df_merge['实际销售额'])
    df_merge['配送费占比'] = _safe_div(df_merge['FBA配送费'], df_merge['实际销售额'])
    df_merge['佣金占比'] = _safe_div(df_merge['平台佣金'], df_merge['实际销售额'])

    df_merge['总成本'] = df_merge['产品FOB'] + df_merge['销售头程'] + df_merge['FBA配送费'] + df_merge['平台佣金']
    df_merge['总成本占比'] = _safe_div(df_merge['总成本'], df_merge['实际销售额'])

    df_merge['利润'] = df_merge['实际销售额'] - df_merge['总成本'] - df_merge['广告花费'] - df_merge['实际退款额']
    df_merge['利润率'] = _safe_div(df_merge['利润'], df_merge['实际销售额'])

    df_merge['平均售价'] = _safe_div(df_merge['实际销售额'], df_merge['实际销售量'])
    df_merge['退款率'] = _safe_div(df_merge['实际退款额'], df_merge['实际销售额'])

    column_order = [
        '日期',
        'SKU',
        'ASIN',
        '总销量',
        '总销售额',
        '页面浏览量',
        '总访客',
        '总转化',
        '广告展示量',
        '广告点击量',
        '广告点击率',
        '广告订单量',
        '广告单占比',
        '广告转化率',
        '广告花费',
        '广告销售额',
        'CPC',
        'ACOS',
        'SP占比',
        '自然流量',
        '自然流量占比',
        '自然单',
        '自然单转化',
        '产品FOB',
        '成本占比',
        '销售头程',
        '头程占比',
        'FBA配送费',
        '配送费占比',
        '平台佣金',
        '佣金占比',
        '总成本',
        '总成本占比',
        '利润',
        '利润率',
        '实际销售额',
        '实际销售量',
        '实际退款额',
        '实际退款量',
        '平均售价',
        '退款率',
    ]
    overview = df_merge[column_order].copy()
    overview = overview.fillna(0)

    # Int-like columns
    for col in ['总销量', '页面浏览量', '总访客', '广告展示量', '广告点击量', '广告订单量', '自然流量', '自然单', '实际销售量', '实际退款量']:
        overview[col] = pd.to_numeric(overview[col], errors='coerce').fillna(0).astype(int)

    # monetary/decimal columns
    for col in ['总销售额', '广告花费', '广告销售额', 'CPC', '产品FOB', '销售头程', 'FBA配送费', '平台佣金', '总成本', '利润', '实际销售额', '实际退款额', '平均售价']:
        overview[col] = pd.to_numeric(overview[col], errors='coerce').fillna(0).round(2)

    return overview


def _append_summary_row(df_overview: pd.DataFrame, report_date: str) -> pd.DataFrame:
    sum_columns = {
        '总销量',
        '总销售额',
        '页面浏览量',
        '总访客',
        '广告展示量',
        '广告点击量',
        '广告订单量',
        '广告花费',
        '广告销售额',
        '自然流量',
        '自然单',
        '产品FOB',
        '实际销售额',
        '实际销售量',
        '实际退款额',
        '实际退款量',
        '销售头程',
        'FBA配送费',
        '平台佣金',
        '总成本',
        '利润',
    }

    summary: dict[str, Any] = {}
    for col in df_overview.columns:
        summary[col] = float(df_overview[col].sum()) if col in sum_columns else 0

    summary['日期'] = report_date
    summary['SKU'] = '汇总'
    summary['ASIN'] = '汇总'
    summary['自然流量'] = summary['页面浏览量'] - summary['广告点击量']
    summary['自然单'] = summary['总销量'] - summary['广告订单量']

    summary['总转化'] = _safe_div(summary['总销量'], summary['页面浏览量'])
    summary['广告点击率'] = _safe_div(summary['广告点击量'], summary['广告展示量'])
    summary['广告单占比'] = _safe_div(summary['广告订单量'], summary['总销量'])
    summary['广告转化率'] = _safe_div(summary['广告订单量'], summary['广告点击量'])
    summary['CPC'] = _safe_div(summary['广告花费'], summary['广告点击量'])
    summary['ACOS'] = _safe_div(summary['广告花费'], summary['广告销售额'])
    summary['SP占比'] = _safe_div(summary['广告花费'], summary['总销售额'])
    summary['自然流量占比'] = _safe_div(summary['自然流量'], summary['页面浏览量'])
    summary['自然单转化'] = _safe_div(summary['自然单'], summary['自然流量'])

    summary['成本占比'] = _safe_div(summary['产品FOB'], summary['实际销售额'])
    summary['头程占比'] = _safe_div(summary['销售头程'], summary['实际销售额'])
    summary['配送费占比'] = _safe_div(summary['FBA配送费'], summary['实际销售额'])
    summary['佣金占比'] = _safe_div(summary['平台佣金'], summary['实际销售额'])
    summary['总成本占比'] = _safe_div(summary['总成本'], summary['实际销售额'])
    summary['利润率'] = _safe_div(summary['利润'], summary['实际销售额'])
    summary['退款率'] = _safe_div(summary['实际退款额'], summary['实际销售额'])
    summary['平均售价'] = _safe_div(summary['实际销售额'], summary['实际销售量'])

    return pd.concat([df_overview, pd.DataFrame([summary])], ignore_index=True)


def _to_python_scalar(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    return value


def _build_pt1_payload(df_overview: pd.DataFrame) -> dict[str, Any]:
    if df_overview.empty:
        return {'row_count': 0, 'summary': {}, 'details': []}
    summary = {str(k): _to_python_scalar(v) for k, v in df_overview.iloc[-1].to_dict().items()}
    details = [
        {str(k): _to_python_scalar(v) for k, v in row.items()}
        for row in df_overview.iloc[:-1].to_dict(orient='records')
    ]
    return {
        'row_count': len(details),
        'summary': summary,
        'details': details,
    }


def _load_template_or_create() -> Workbook:
    backend_root = Path(__file__).resolve().parents[3]
    template = backend_root / 'storage' / 'model-file' / 'product_analysis_template.xlsx'
    if template.exists():
        return _load_workbook_without_style_warning(template)
    wb = Workbook()
    wb.active.title = '产品分析'
    return wb


def _apply_sheet_data(ws, df: pd.DataFrame, bold_last_row: bool = True) -> None:
    thin = Side(style='thin', color='000000')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    center = Alignment(horizontal='center', vertical='center')

    if ws.max_row > 1:
        ws.delete_rows(2, ws.max_row - 1)

    for r_idx, row in enumerate(dataframe_to_rows(df, index=False, header=True), 1):
        for c_idx, value in enumerate(row, 1):
            cell = ws.cell(row=r_idx, column=c_idx, value=value)
            cell.alignment = center
            cell.border = border
            header = str(df.columns[c_idx - 1]) if c_idx - 1 < len(df.columns) else ''
            if header in PERCENT_COLUMNS and r_idx > 1:
                cell.number_format = '0.00%'

    # keep width readable
    for col_idx in range(1, ws.max_column + 1):
        letter = get_column_letter(col_idx)
        ws.column_dimensions[letter].width = max(ws.column_dimensions[letter].width or 0, 12)

    if bold_last_row and ws.max_row >= 2:
        for cell in ws[ws.max_row]:
            cell.font = Font(bold=True)


def _build_inventory_sheet(workbook: Workbook, inventory_path: Path, df_overview: pd.DataFrame) -> None:
    try:
        inv_df = pd.read_csv(inventory_path, sep='\t', encoding='utf-8-sig')
    except Exception:
        return

    inv_df.columns = [str(col).strip() for col in inv_df.columns]

    keep_cols = [
        'sku',
        'asin',
        'available',
        'inv-age-0-to-90-days',
        'inv-age-91-to-180-days',
        'inv-age-181-to-270-days',
        'inv-age-271-to-365-days',
        'inv-age-365-plus-days',
        'recommended-action',
    ]
    existing = [col for col in keep_cols if col in inv_df.columns]
    if not existing:
        return

    inv_df = inv_df[existing].copy()
    inv_df.rename(
        columns={
            'sku': 'SKU',
            'asin': 'ASIN',
            'available': '可售库存',
            'inv-age-0-to-90-days': '0-90天',
            'inv-age-91-to-180-days': '91-180天',
            'inv-age-181-to-270-days': '181-270天',
            'inv-age-271-to-365-days': '271-365天',
            'inv-age-365-plus-days': '365+天',
            'recommended-action': '库存建议',
        },
        inplace=True,
    )

    sales_df = df_overview[df_overview['SKU'] != '汇总'][['SKU', '总销量']].copy()
    sales_df.rename(columns={'总销量': '本周销量'}, inplace=True)

    inv_df = pd.merge(inv_df, sales_df, on='SKU', how='left')
    inv_df['本周销量'] = pd.to_numeric(inv_df['本周销量'], errors='coerce').fillna(0)

    order = ['SKU', 'ASIN', '本周销量', '可售库存', '0-90天', '91-180天', '181-270天', '271-365天', '365+天', '库存建议']
    order = [col for col in order if col in inv_df.columns]
    inv_df = inv_df[order]

    numeric_cols = [col for col in ['本周销量', '可售库存', '0-90天', '91-180天', '181-270天', '271-365天', '365+天'] if col in inv_df.columns]
    for col in numeric_cols:
        inv_df[col] = pd.to_numeric(inv_df[col], errors='coerce').fillna(0)

    summary = {col: '' for col in inv_df.columns}
    summary['SKU'] = '汇总行'
    for col in numeric_cols:
        summary[col] = inv_df[col].sum()
    inv_df = pd.concat([inv_df, pd.DataFrame([summary])], ignore_index=True)

    if '库存详情' in workbook.sheetnames:
        del workbook['库存详情']
    ws = workbook.create_sheet('库存详情')
    _apply_sheet_data(ws, inv_df, bold_last_row=True)


def _resolve_report_paths(input_path: str, params: dict) -> tuple[Path, Path, Path, Path | None]:
    resolved = params.get('resolved_file_paths') if isinstance(params.get('resolved_file_paths'), dict) else {}

    business_raw = resolved.get('business_report') or params.get('business_report_path') or input_path
    payment_raw = resolved.get('payment_report') or params.get('payment_report_path')
    ad_raw = resolved.get('ad_report') or params.get('ad_report_path')
    inventory_raw = resolved.get('inventory_report') or params.get('inventory_report_path')

    if not business_raw or not payment_raw or not ad_raw:
        raise ValueError('Missing required report paths (business/payment/ad)')

    business_path = Path(str(business_raw))
    payment_path = Path(str(payment_raw))
    ad_path = Path(str(ad_raw))

    for path in [business_path, payment_path, ad_path]:
        if not path.exists() or not path.is_file():
            raise FileNotFoundError(f'Report file not found: {path}')

    inventory_path = None
    if inventory_raw:
        candidate = Path(str(inventory_raw))
        if candidate.exists() and candidate.is_file():
            inventory_path = candidate

    return business_path, payment_path, ad_path, inventory_path


def run(input_path: str, output_dir: str, params: dict) -> dict:
    project_name = _safe_project_name(str(params.get('project_name', 'unknown')))
    report_start_date = str(params.get('report_start_date', '')).strip()
    report_end_date = str(params.get('report_end_date', '')).strip()
    country = _normalize_country(str(params.get('country', 'US')))

    if not report_start_date or not report_end_date:
        raise ValueError('Missing report_start_date/report_end_date')

    start = datetime.strptime(report_start_date, '%Y-%m-%d')
    end = datetime.strptime(report_end_date, '%Y-%m-%d')
    if start > end:
        raise ValueError('report_start_date cannot be greater than report_end_date')

    report_date = _format_report_date(report_start_date, report_end_date)

    business_path, payment_path, ad_path, inventory_path = _resolve_report_paths(input_path, params)

    df_cost = _load_project_costs_df(project_name, country, report_end_date[:7])
    df_business = _read_business_report(business_path)
    df_ad = _read_ad_report(ad_path)
    df_payment_raw = _read_payment_report(payment_path)
    df_payment = _build_payment_aggregate(df_payment_raw)

    df_overview = _build_overview(project_name, report_date, df_cost, df_business, df_ad, df_payment)
    df_overview = _append_summary_row(df_overview, report_date)

    wb = _load_template_or_create()
    ws = wb.active
    ws.title = '产品分析'
    _apply_sheet_data(ws, df_overview)

    if inventory_path:
        _build_inventory_sheet(wb, inventory_path, df_overview)

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)

    filename = f'{project_name}_Product_Analysis_{report_date}.xlsx'
    result_path = output_root / filename
    wb.save(result_path)

    return {
        'result_path': str(result_path.resolve()),
        'filename': filename,
        'message': 'Product analysis report generated',
        'pt1': _build_pt1_payload(df_overview),
        'country': country,
    }
