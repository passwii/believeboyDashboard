"""Export utilities for category research.

Handles export payload construction, file generation (CSV, PDF, Excel, ZIP),
and related utility functions.
"""

from __future__ import annotations

import csv
import hashlib
import json
from dataclasses import dataclass
from datetime import date
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any
import warnings
import zipfile

import pandas as pd
from slugify import slugify
from openpyxl import Workbook


@dataclass
class CategoryResearchExportPayload:
    """Export payload for category research data."""
    filename: str
    media_type: str
    content: bytes | None = None
    file_path: Path | None = None


# --- File Hashing ---

def _file_sha256(path: Path) -> str:
    """Calculate SHA256 hash of file."""
    sha256_hash = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b''):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


# --- CSV Generation ---

def _csv_bytes(headers: list[str], rows: list[list[Any]]) -> bytes:
    """Generate CSV bytes from headers and rows."""
    stream = StringIO()
    writer = csv.writer(stream)
    writer.writerow(headers)
    writer.writerows(rows)
    return stream.getvalue().encode('utf-8-sig')


def _build_product_csv_bytes(products: list) -> bytes:
    """Build CSV bytes from product list."""
    headers = [
        'product_row_id', 'source_row_no', 'asin', 'parent_asin', 'product_name',
        'brand', 'seller', 'price_usd', 'monthly_sales', 'monthly_revenue_usd',
        'rating', 'review_count', 'launch_date', 'listing_age_days', 'fba_fee_usd',
        'fulfillment_method', 'bbx_seller_attribute', 'variant_count',
        'has_main_image_video', 'is_climate_pledge_friendly', 'has_brand_store',
        'seller_country_region', 'is_amazon', 'is_new_90d',
        'extracted_dimensions', 'manual_dimensions', 'effective_dimensions',
    ]
    rows = [
        [
            int(item.id),
            int(item.source_row_no),
            item.asin or '',
            item.parent_asin or '',
            item.product_name or '',
            item.brand or '',
            item.seller or '',
            float(item.price_usd) if item.price_usd is not None else '',
            int(item.monthly_sales or 0),
            float(item.monthly_revenue_usd) if item.monthly_revenue_usd is not None else '',
            float(item.rating) if item.rating is not None else '',
            int(item.review_count or 0),
            item.launch_date.isoformat() if item.launch_date else '',
            int(item.listing_age_days) if item.listing_age_days is not None else '',
            float(item.fba_fee_usd) if item.fba_fee_usd is not None else '',
            item.fulfillment_method or '',
            item.bbx_seller_attribute or '',
            int(item.variant_count) if item.variant_count is not None else '',
            bool(item.has_main_image_video) if item.has_main_image_video is not None else '',
            bool(item.is_climate_pledge_friendly) if item.is_climate_pledge_friendly is not None else '',
            bool(item.has_brand_store) if item.has_brand_store is not None else '',
            item.seller_country_region or '',
            bool(item.is_amazon),
            bool(item.is_new_90d),
            _stringify_json(item.extracted_dimensions),
            _stringify_json(item.manual_dimensions),
            _stringify_json(_effective_dimensions(item)),
        ]
        for item in products
    ]
    return _csv_bytes(headers, rows)


def _build_trend_csv_bytes(trends: list) -> bytes:
    """Build CSV bytes from trend list."""
    headers = ['trend_row_id', 'asin', 'parent_asin', 'year_month', 'monthly_sales']
    rows = [
        [
            int(item.id),
            item.asin,
            item.parent_asin or '',
            item.year_month,
            int(item.monthly_sales or 0),
        ]
        for item in trends
    ]
    return _csv_bytes(headers, rows)


def _effective_dimensions(row) -> dict[str, str]:
    """Get effective dimensions for a row."""
    result = dict(row.extracted_dimensions or {})
    for key, value in (row.manual_dimensions or {}).items():
        if value:
            result[key] = value
        else:
            result.pop(key, None)
    return result


def _stringify_json(value: Any) -> str:
    """Convert value to JSON string."""
    if value is None:
        return ''
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


# --- Excel Generation ---


def _build_analysis_workbook_bytes(
    dataset,
    overview: dict[str, Any],
    products: list,
    trends: list,
) -> bytes:
    """Build analysis Excel workbook."""
    wb = Workbook()
    wb.remove(wb.active)

    _add_summary_sheet(wb, dataset, overview)
    _add_kpi_sheet(wb, overview)
    _add_brand_sheet(wb, overview)
    _add_price_band_sheet(wb, overview)
    _add_product_sheet(wb, products)
    _add_trend_sheet(wb, trends)
    _add_metrics_sheet(wb, overview)

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _add_summary_sheet(wb: Workbook, dataset, overview: dict[str, Any]) -> None:
    """Add summary sheet to workbook."""
    from openpyxl.styles import Font, Alignment

    ws = wb.create_sheet('摘要')
    metrics = overview.get('advanced_metrics', {})
    growth = metrics.get('market_growth', {})
    seasonality = metrics.get('seasonality', {})
    brand = metrics.get('brand_monopoly', {})
    seller = metrics.get('seller_monopoly', {})
    china = metrics.get('china_seller_competition', {})
    new_product = metrics.get('new_product_opportunity', {})
    quality = metrics.get('data_quality', {})

    rows_data = [
        ['调研分析摘要', dataset.category_name_zh, dataset.marketplace, f'V{int(dataset.version)}'],
        [''],
        ['核心指标'],
        ['样本数', int(overview.get('kpis', {}).get('sample_count', 0))],
        ['品牌数', int(overview.get('kpis', {}).get('brand_count', 0))],
        ['平均价格', f"${float(overview.get('kpis', {}).get('average_price_usd', 0)):.2f}"],
        ['总月销量', int(overview.get('kpis', {}).get('total_monthly_sales', 0))],
        ['Amazon占比', f"{float(overview.get('kpis', {}).get('amazon_share', 0)) * 100:.1f}%"],
        [''],
        ['进入判断'],
        ['增长层级', growth.get('growth_tier', growth.get('growth_level', '-'))],
        ['季节性', seasonality.get('seasonality_tier', seasonality.get('seasonality_level', '-'))],
        ['建议入场月', ', '.join(seasonality.get('recommended_entry_months', []))],
        ['新品机会', new_product.get('opportunity_level', '-')],
        [''],
        ['竞争与风险'],
        ['品牌CR3', f"{float(brand.get('brand_cr3', 0)) * 100:.1f}%"],
        ['卖家CR3', f"{float(seller.get('seller_cr3', 0)) * 100:.1f}%"],
        ['中国卖家销量占比', f"{float(china.get('china_seller_sales_share', 0)) * 100:.1f}%"],
        ['数据质量分', f"{float(quality.get('score', 0)):.1f}"],
    ]

    for row_idx, row_data in enumerate(rows_data, start=1):
        for col_idx, value in enumerate(row_data, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            if row_idx == 1:
                cell.font = Font(bold=True, size=14)

    ws.column_dimensions['A'].width = 20
    ws.column_dimensions['B'].width = 30


def _add_kpi_sheet(wb: Workbook, overview: dict[str, Any]) -> None:
    """Add KPI sheet to workbook."""
    ws = wb.create_sheet('KPI')
    kpis = overview.get('kpis', {})
    for row_idx, (key, value) in enumerate(kpis.items(), start=1):
        ws.cell(row=row_idx, column=1, value=key)
        ws.cell(row=row_idx, column=2, value=value)


def _add_brand_sheet(wb: Workbook, overview: dict[str, Any]) -> None:
    """Add brand analysis sheet."""
    ws = wb.create_sheet('品牌分析')
    brand_shares = overview.get('brand_sales_share', [])
    ws.append(['品牌', '月销量', '份额'])
    for item in brand_shares:
        ws.append([item.get('brand', ''), item.get('monthly_sales', 0), f"{float(item.get('share', 0)) * 100:.2f}%"])


def _add_price_band_sheet(wb: Workbook, overview: dict[str, Any]) -> None:
    """Add price band analysis sheet."""
    ws = wb.create_sheet('价格带分析')
    bands = overview.get('price_band_opportunities', [])
    ws.append(['价格带', '样本数', '月销量', '销量占比', '平均评分'])
    for item in bands:
        ws.append([
            item.get('label', ''),
            item.get('count', 0),
            item.get('monthly_sales', 0),
            f"{float(item.get('sales_share', 0)) * 100:.2f}%",
            f"{float(item.get('average_rating', 0)):.2f}",
        ])


def _add_product_sheet(wb: Workbook, products: list) -> None:
    """Add product details sheet."""
    ws = wb.create_sheet('产品明细')
    if products:
        headers = ['ASIN', '品牌', '卖家', '价格', '月销量', '评分', '评论数']
        ws.append(headers)
        for item in products[:500]:
            ws.append([
                item.asin or '',
                item.brand or '',
                item.seller or '',
                float(item.price_usd) if item.price_usd else '',
                int(item.monthly_sales or 0),
                float(item.rating) if item.rating else '',
                int(item.review_count or 0),
            ])


def _add_trend_sheet(wb: Workbook, trends: list) -> None:
    """Add trend details sheet."""
    ws = wb.create_sheet('趋势明细')
    if trends:
        headers = ['ASIN', '年月', '月销量']
        ws.append(headers)
        for item in trends[:1000]:
            ws.append([
                item.asin or '',
                item.year_month or '',
                int(item.monthly_sales or 0),
            ])


def _add_metrics_sheet(wb: Workbook, overview: dict[str, Any]) -> None:
    """Add metric definitions sheet."""
    ws = wb.create_sheet('指标定义')
    metrics = overview.get('advanced_metrics', {})
    definitions = metrics.get('metric_definitions', [])
    ws.append(['指标', '名称', '公式', '阈值', '解释'])
    for item in definitions:
        ws.append([
            item.get('key', ''),
            item.get('name', ''),
            item.get('formula_text', ''),
            ', '.join(item.get('thresholds', [])),
            item.get('interpretation_template', ''),
        ])


# --- PDF Generation ---


def _has_reportlab() -> bool:
    """Check if reportlab is available."""
    try:
        from reportlab.lib.pagesizes import A4
        return True
    except ImportError:
        return False


def _require_reportlab():
    """Require reportlab or raise error."""
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        from reportlab.pdfbase.pdfmetrics import registerFont
        from reportlab.pdfgen import canvas
        return A4, UnicodeCIDFont, registerFont, canvas
    except ImportError as exc:
        raise ValueError('PDF 导出依赖未安装，请先在 backend 环境安装 reportlab==4.4.1') from exc


def _build_summary_pdf_bytes(dataset, overview: dict[str, Any]) -> bytes:
    """Build summary PDF bytes."""
    A4, UnicodeCIDFont, registerFont, canvas = _require_reportlab()
    from reportlab.lib.units import mm

    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4

    lines = _pdf_text_lines(dataset, overview)
    y = height - 20 * mm

    for line in lines:
        if y < 20 * mm:
            c.showPage()
            y = height - 20 * mm

        if line == '':
            y -= 6
            continue

        if line.startswith('一、') or line.startswith('二、') or line.startswith('三、') or line.startswith('四、') or line.startswith('五、'):
            y -= 8
            c.setFont('Helvetica-Bold', 12)
        elif line.startswith(('1.', '2.', '3.', '4.', '5.')):
            c.setFont('Helvetica', 9)
            y -= 5
        else:
            c.setFont('Helvetica', 10)

        c.drawString(20 * mm, y, line[:80])
        y -= 14

    c.save()
    return buffer.getvalue()


def _pdf_text_lines(dataset, overview: dict[str, Any]) -> list[str]:
    """Generate PDF text lines."""
    metrics = overview['advanced_metrics']
    growth = metrics['market_growth']
    seasonality = metrics['seasonality']
    brand_monopoly = metrics['brand_monopoly']
    seller_monopoly = metrics['seller_monopoly']
    china = metrics['china_seller_competition']
    new_product = metrics['new_product_opportunity']
    quality = metrics['data_quality']

    lines: list[str] = [
        f"调研分析摘要 | {dataset.category_name_zh} | {dataset.marketplace} | V{int(dataset.version)}",
        f"关键词: {dataset.category_keyword_en}",
        f"数据日期: {dataset.data_date.isoformat() if dataset.data_date else '-'}",
        f"样本产品: {int(dataset.row_count_products or 0)} | 趋势样本: {int(dataset.row_count_trends or 0)}",
        "",
        "一、核心指标",
        f"样本数: {int(overview['kpis']['sample_count'])}",
        f"品牌数: {int(overview['kpis']['brand_count'])}",
        f"平均价格: ${float(overview['kpis']['average_price_usd']):.2f}",
        f"总月销量: {int(overview['kpis']['total_monthly_sales'])}",
        f"Amazon 占比: {float(overview['kpis']['amazon_share']) * 100:.1f}%",
        "",
        "二、进入判断",
        f"增长层级: {growth.get('growth_tier', growth.get('growth_level', '-'))} | 最近 12M vs 前 12M: {float(growth['last12_vs_prev12_growth']) * 100:.1f}%",
        f"季节性层级: {seasonality.get('seasonality_tier', seasonality.get('seasonality_level', '-'))} | 旺季前三月销量占比: {float(seasonality['peak3_month_sales_share']) * 100:.1f}%",
        f"建议入场月: {', '.join(seasonality.get('recommended_entry_months', [])) or '-'}",
        f"新品机会: {new_product.get('opportunity_level', '-')} | 新品销量占比: {float(new_product['new_product_sales_share']) * 100:.1f}%",
        "",
        "三、竞争与风险",
        f"品牌集中度: CR3 {float(brand_monopoly['brand_cr3']) * 100:.1f}% | 风险 {brand_monopoly.get('risk_level', '-')}",
        f"卖家集中度: CR3 {float(seller_monopoly['seller_cr3']) * 100:.1f}% | 风险 {seller_monopoly.get('risk_level', '-')}",
        f"中国卖家销量占比: {float(china['china_seller_sales_share']) * 100:.1f}% | 风险 {china.get('risk_level', '-')}",
        f"数据质量分: {float(quality['score']):.1f} | 综述: {quality.get('summary', '') or '-'}",
        "",
        "四、建议动作",
    ]

    actions = metrics.get('action_recommendations', [])[:5]
    if actions:
        for index, item in enumerate(actions, start=1):
            validations = ', '.join(item.get('required_validation', [])) or '-'
            lines.append(f"{index}. [{item.get('priority', '-')}] {item.get('action', '')}")
            lines.append(f"   原因: {item.get('why', '')}")
            lines.append(f"   先验证: {validations}")
    else:
        lines.append("1. 当前无自动建议动作，请结合市场节奏、品牌集中度和价格带机会手动判断。")

    lines.extend(["", "五、补充说明"])

    top_bands = metrics.get('price_band_opportunities', [])[:3]
    if top_bands:
        for item in top_bands:
            lines.append(
                f"机会价格带 {item.get('label', '-')}: 月销量 {int(item.get('monthly_sales', 0))} | 销量占比 {float(item.get('sales_share', 0.0)) * 100:.1f}%"
            )

    top_brands = overview.get('brand_sales_share', [])[:3]
    if top_brands:
        lines.append("头部品牌:")
        for item in top_brands:
            lines.append(
                f"- {item.get('brand', '-')}: 月销量 {int(item.get('monthly_sales', 0))} | 占比 {float(item.get('share', 0.0)) * 100:.1f}%"
            )

    return lines


# --- ZIP Bundle Generation ---


def _build_export_bundle_zip_bytes(
    settings,
    dataset,
    overview: dict[str, Any],
    products: list,
    trends: list,
) -> bytes:
    """Build export bundle ZIP bytes."""
    from app.services.category.export_utils import (
        _resolve_dataset_raw_file_path,
        _build_summary_pdf_bytes,
        _build_analysis_workbook_bytes,
        _build_product_csv_bytes,
        _build_trend_csv_bytes,
        _dataset_base_slug,
    )

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        try:
            raw_path = _resolve_dataset_raw_file_path(settings, dataset)
            if raw_path.exists():
                zf.write(raw_path, f'{_dataset_base_slug(dataset)}-raw.xlsx')
        except FileNotFoundError:
            pass

        if _has_reportlab():
            pdf_bytes = _build_summary_pdf_bytes(dataset, overview)
            zf.writestr(f'{_dataset_base_slug(dataset)}-summary.pdf', pdf_bytes)

        workbook_bytes = _build_analysis_workbook_bytes(dataset, overview, products, trends)
        zf.writestr(f'{_dataset_base_slug(dataset)}-analysis.xlsx', workbook_bytes)

        product_csv = _build_product_csv_bytes(products)
        zf.writestr(f'{_dataset_base_slug(dataset)}-products.csv', product_csv)

        trend_csv = _build_trend_csv_bytes(trends)
        zf.writestr(f'{_dataset_base_slug(dataset)}-trends.csv', trend_csv)

    return buffer.getvalue()


# --- Export Utilities ---


def _export_is_available(settings, dataset, export_key: str) -> bool:
    """Check if export type is available."""
    if export_key in {'summary_pdf', 'export_bundle_zip'} and not _has_reportlab():
        return False
    if export_key != 'raw_xlsx':
        return True
    try:
        raw_path = _resolve_dataset_raw_file_path(settings, dataset)
    except FileNotFoundError:
        return False
    return raw_path.exists() and raw_path.is_file()


def _resolve_dataset_raw_file_path(settings, dataset) -> Path:
    """Resolve raw file path for dataset."""
    from app.services.upload_service import resolve_upload_file_path

    file_path = Path(str(dataset.upload_file_path or '')).expanduser()
    if file_path.exists() and file_path.is_file():
        return file_path
    folder_name = f'category-research-{dataset.marketplace}-{dataset.category_keyword_en}'
    return resolve_upload_file_path(settings, folder_name, 'category_research_xlsx', str(dataset.upload_file_id))


def _dataset_base_slug(dataset) -> str:
    """Generate base slug for dataset filenames."""
    keyword_slug = slugify(dataset.category_keyword_en or '')[:60] or 'category-research'
    return f'category-research-{dataset.marketplace.lower()}-{keyword_slug}-v{int(dataset.version)}'


def _export_filename(dataset, export_key: str, *, original_filename: str | None = None) -> str:
    """Generate export filename."""
    base = _dataset_base_slug(dataset)
    if export_key == 'raw_xlsx':
        original = Path(original_filename or '').name
        if original:
            return original
        return f'{base}-raw.xlsx'
    if export_key == 'summary_pdf':
        return f'{base}-summary.pdf'
    if export_key == 'analysis_workbook':
        return f'{base}-analysis.xlsx'
    if export_key == 'product_details_csv':
        return f'{base}-products.csv'
    if export_key == 'trend_details_csv':
        return f'{base}-trends.csv'
    if export_key == 'export_bundle_zip':
        return f'{base}-bundle.zip'
    return f'{base}-{slugify(export_key) or "export"}.bin'


def _list_all_dataset_products(db, *, dataset_id: int) -> list:
    """List all products for a dataset."""
    from sqlalchemy import select
    from app.models import CategoryResearchProductDetail

    return list(
        db.execute(
            select(CategoryResearchProductDetail)
            .where(CategoryResearchProductDetail.dataset_id == dataset_id)
            .order_by(
                CategoryResearchProductDetail.monthly_sales.desc(),
                CategoryResearchProductDetail.id.asc(),
            )
        ).scalars().all()
    )


def _list_all_dataset_trends(db, *, dataset_id: int) -> list:
    """List all trends for a dataset."""
    from sqlalchemy import select
    from app.models import CategoryResearchSalesTrend

    return list(
        db.execute(
            select(CategoryResearchSalesTrend)
            .where(CategoryResearchSalesTrend.dataset_id == dataset_id)
            .order_by(
                CategoryResearchSalesTrend.asin.asc(),
                CategoryResearchSalesTrend.year_month.asc(),
                CategoryResearchSalesTrend.id.asc(),
            )
        ).scalars().all()
    )


def _recompute_dataset_fields(db, dataset) -> None:
    """Recompute dataset computed fields."""
    from app.models import CategoryResearchProductDetail, CategoryResearchSalesTrend
    from sqlalchemy import func, select

    product_count = db.execute(
        select(func.count())
        .select_from(CategoryResearchProductDetail)
        .where(CategoryResearchProductDetail.dataset_id == dataset.id)
    ).scalar()

    trend_count = db.execute(
        select(func.count())
        .select_from(CategoryResearchSalesTrend)
        .where(CategoryResearchSalesTrend.dataset_id == dataset.id)
    ).scalar()

    invalid_price = db.execute(
        select(func.count())
        .select_from(CategoryResearchProductDetail)
        .where(
            CategoryResearchProductDetail.dataset_id == dataset.id,
            CategoryResearchProductDetail.price_usd.is_(None),
        )
    ).scalar()

    missing_fba = db.execute(
        select(func.count())
        .select_from(CategoryResearchProductDetail)
        .where(
            CategoryResearchProductDetail.dataset_id == dataset.id,
            CategoryResearchProductDetail.fba_fee_usd.is_(None),
        )
    ).scalar()

    warnings = dict(dataset.quality_warnings or {})
    warnings['invalid_price_count'] = invalid_price or 0
    warnings['missing_fba_fee_count'] = missing_fba or 0

    dataset.row_count_products = product_count
    dataset.row_count_trends = trend_count
    dataset.quality_warnings = warnings
