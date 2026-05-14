"""Product analysis - internal shared utilities.

仅供本包子模块导入，不对外暴露。
"""
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisSalesOrderRow,
    InventorySnapshotRow,
    Project,
)
from app.utils.country import normalize_country as _normalize_country
from app.utils.persist_helpers import next_version as _next_version
from app.utils.utils import (
    build_logical_filename as _build_logical_filename,
    build_storage_key as _build_storage_key,
    parse_yyyy_mm_dd as _parse_yyyy_mm_dd,
    project_slug as _project_slug,
    sha256_file as _sha256_file,
    to_raw_row as _to_raw_row,
)


def _get_project_by_name(db: Session, project_name: str) -> Project:
    """Look up a Project by name. Raises ValueError if not found."""
    normalized = (project_name or '').strip()
    if not normalized:
        raise ValueError('project_name is required')
    project = db.execute(select(Project).where(Project.project_name == normalized)).scalars().first()
    if project is None:
        raise ValueError(f'Project not found: {normalized}')
    return project


def _get_row_model(report_type: str):
    """Return the SQLAlchemy model class for a given report type."""
    if report_type == 'business_report':
        return AnalysisBusinessRow
    if report_type == 'payment_report':
        return AnalysisPaymentRow
    if report_type == 'ad_product_report':
        return AnalysisAdProductRow
    if report_type == 'inventory_report':
        return InventorySnapshotRow
    if report_type == 'sales_report':
        return AnalysisSalesOrderRow
    raise ValueError(f'Unsupported report_type: {report_type}')


def _serialize_row(report_type: str, row: Any) -> dict[str, Any]:
    """Serialize a DB row to dict for API response."""
    if report_type == 'business_report':
        return {
            'source_row_no': row.source_row_no, 'asin': row.asin,
            'page_views': row.page_views, 'units_ordered': row.units_ordered,
            'sessions': row.sessions,
            'ordered_sales_amount': float(row.ordered_sales_amount or 0),
            'raw_row': row.raw_row,
        }
    if report_type == 'payment_report':
        return {
            'source_row_no': row.source_row_no, 'transaction_at': row.transaction_at,
            'transaction_type': row.transaction_type, 'order_id': row.order_id,
            'sku': row.sku, 'asin': row.asin, 'quantity': row.quantity,
            'product_sales': float(row.product_sales or 0),
            'shipping_credits': float(row.shipping_credits or 0),
            'promotional_rebates': float(row.promotional_rebates or 0),
            'other_amount': float(row.other_amount or 0),
            'selling_fees': float(row.selling_fees or 0),
            'fba_fees': float(row.fba_fees or 0),
            'total_amount': float(row.total_amount or 0),
            'scope_status': row.scope_status, 'scope_reason': row.scope_reason,
            'raw_row': row.raw_row,
        }
    if report_type == 'ad_product_report':
        return {
            'source_row_no': row.source_row_no, 'sku': row.sku, 'asin': row.asin,
            'impressions': row.impressions, 'clicks': row.clicks,
            'spend': float(row.spend or 0), 'sales_7d': float(row.sales_7d or 0),
            'orders_7d': row.orders_7d,
            'scope_status': row.scope_status, 'scope_reason': row.scope_reason,
            'raw_row': row.raw_row,
        }
    if report_type == 'inventory_report':
        return {
            'source_row_no': row.source_row_no, 'sku': row.sku, 'asin': row.asin,
            'available_qty': row.available_qty,
            'age_0_90_qty': row.age_0_90_qty, 'age_91_180_qty': row.age_91_180_qty,
            'age_181_270_qty': row.age_181_270_qty,
            'age_271_365_qty': row.age_271_365_qty, 'age_365_plus_qty': row.age_365_plus_qty,
            'recommended_action': row.recommended_action,
            'stock_status': row.stock_status, 'aging_status': row.aging_status,
            'raw_row': row.raw_row,
        }
    if report_type == 'sales_report':
        return {
            'source_row_no': row.source_row_no, 'amazon_order_id': row.amazon_order_id,
            'purchase_at_utc': row.purchase_at_utc, 'purchase_at_pt': row.purchase_at_pt,
            'purchase_date_pt': row.purchase_date_pt, 'order_status': row.order_status,
            'sku': row.sku, 'asin': row.asin, 'quantity': row.quantity,
            'item_price': float(row.item_price or 0),
            'shipping_price': float(row.shipping_price or 0),
            'currency': row.currency, 'is_counted_sales': row.is_counted_sales,
            'status_rule_version': row.status_rule_version,
            'raw_row': row.raw_row,
        }
    raise ValueError(f'Unsupported report_type: {report_type}')


_serialize_row_func = _serialize_row


def _is_full_iso_week(start_date, end_date):
    """检查日期范围是否为完整的 ISO 周（周一到周日）。"""
    if (end_date - start_date).days != 6:
        return False
    if start_date.weekday() != 0:
        return False
    if end_date.weekday() != 6:
        return False
    iso_start = start_date.isocalendar()
    iso_end = end_date.isocalendar()
    return iso_start[0] == iso_end[0] and iso_start[1] == iso_end[1]


def _is_single_full_week(start_date, end_date):
    """是否恰好为单独一个完整 ISO 周（Mon-Sun）。"""
    return _is_full_iso_week(start_date, end_date)