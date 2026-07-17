"""Orders Summary service for the external API.

Returns deduplicated real orders/sales data for TACoS calculation.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, Project
from app.services.sales_query import counted_sales_where
from app.utils.math_utils import round_money


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _serialize_order_row(row: AnalysisSalesOrderRow, project_name: str) -> dict:
    """Serialize an AnalysisSalesOrderRow to dict for response."""
    fulfillment_channel = (row.raw_row or {}).get("fulfillment_channel", "")
    if fulfillment_channel == "Amazon":
        fulfillment_label = "FBA（亚马逊配送）"
    elif fulfillment_channel == "Merchant":
        fulfillment_label = "FBM（自发货配送）"
    else:
        fulfillment_label = fulfillment_channel or "—"

    return {
        "amazon_order_id": row.amazon_order_id,
        "purchase_date_pt": row.purchase_date_pt.isoformat() if row.purchase_date_pt else "",
        "order_status": row.order_status,
        "fulfillment_channel": fulfillment_channel or "—",
        "fulfillment_label": fulfillment_label,
        "sku": row.sku,
        "asin": row.asin,
        "product_name": (row.raw_row or {}).get("product_name"),
        "quantity": row.quantity,
        "item_price": _to_float(row.item_price),
        "shipping_price": _to_float(row.shipping_price),
        "currency": row.currency,
        "country": row.country,
        "is_counted_sales": row.is_counted_sales,
    }


def query_orders_summary(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    include_cancelled: bool = False,
    include_pending: bool = True,
    aggregate: bool = True,
    limit: int = 50000,
    offset: int = 0,
) -> tuple[List[dict], dict]:
    """Query deduplicated orders summary for a project in a date window.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code (e.g., 'US')
        date_from: Start date (inclusive)
        date_to: End date (inclusive)
        include_cancelled: If False, exclude order_status='Cancelled'
        include_pending: If True, include pending orders
        aggregate: If True, also return aggregate totals
        limit: Max rows to return
        offset: Pagination offset

    Returns:
        Tuple of (order_rows_list, aggregate_dict)
    """
    # BEL-348: 直接按行过滤（不再依赖 source_file 版本选择），避免整文件版本
    # 把更全的旧版本覆盖掉导致丢单。
    base_stmt = select(AnalysisSalesOrderRow).where(
        *counted_sales_where(
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
            include_pending=include_pending,
            include_cancelled=include_cancelled,
        )
    )

    # Apply pagination
    base_stmt = base_stmt.limit(limit).offset(offset)

    rows = db.execute(base_stmt).scalars().all()

    # Serialize（project_name 由 row.project_id 关联，此处懒加载取，保持响应结构不变）
    _project_name = db.execute(
        select(Project.project_name).where(Project.id == project_id)
    ).scalar_one_or_none()
    serialized = [_serialize_order_row(row, _project_name or "") for row in rows]

    # Compute aggregates
    aggregate_data = {
        "total_orders": len(serialized),
        "total_quantity": sum(r["quantity"] for r in serialized),
        "total_sales_amount": round_money(sum(Decimal(str(r["item_price"])) * r["quantity"] for r in serialized)),
        "currency": serialized[0]["currency"] if serialized else None,
        "fba_orders": sum(1 for r in serialized if r["fulfillment_channel"] == "Amazon"),
        "fbm_orders": sum(1 for r in serialized if r["fulfillment_channel"] == "Merchant"),
    }

    return serialized, aggregate_data