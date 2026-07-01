"""Orders Summary service for the external API.

Returns deduplicated real orders/sales data for TACoS calculation.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import List, Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile
from app.utils.math_utils import round_money


def _select_current_sales_file_ids(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
) -> List[int]:
    """Select current sales report file IDs for the given window.

    Uses the same multi-version selection pattern as ad endpoints:
    - MAX(version) per (project_id, report_type, country, report_date)
    - Only is_current=true, ingestion_status='success'
    - Filter by report_date in window (with NULL fallback to period overlap)
    """
    latest_versions = (
        select(
            AnalysisSourceFile.project_id.label("project_id"),
            AnalysisSourceFile.report_type.label("report_type"),
            AnalysisSourceFile.country.label("country"),
            AnalysisSourceFile.report_date.label("report_date"),
            func.max(AnalysisSourceFile.version).label("max_version"),
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.ingestion_status == "success",
            or_(
                AnalysisSourceFile.report_date.between(date_from, date_to),
                and_(
                    AnalysisSourceFile.report_date.is_(None),
                    AnalysisSourceFile.period_start_date <= date_to,
                    AnalysisSourceFile.period_end_date >= date_from,
                ),
            ),
        )
        .group_by(
            AnalysisSourceFile.project_id,
            AnalysisSourceFile.report_type,
            AnalysisSourceFile.country,
            AnalysisSourceFile.report_date,
        )
        .subquery()
    )

    stmt = (
        select(AnalysisSourceFile.id)
        .join(
            latest_versions,
            and_(
                AnalysisSourceFile.project_id == latest_versions.c.project_id,
                AnalysisSourceFile.report_type == latest_versions.c.report_type,
                AnalysisSourceFile.country == latest_versions.c.country,
                AnalysisSourceFile.report_date == latest_versions.c.report_date,
                AnalysisSourceFile.version == latest_versions.c.max_version,
            ),
        )
    )

    return list(db.execute(stmt).scalars().all())


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
    file_ids = _select_current_sales_file_ids(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
    )

    if not file_ids:
        return [], {
            "total_orders": 0,
            "total_quantity": 0,
            "total_sales_amount": 0.0,
            "currency": None,
            "fba_orders": 0,
            "fbm_orders": 0,
        }

    # Build base query joining order rows with source file (for project_name)
    base_stmt = (
        select(AnalysisSalesOrderRow, AnalysisSourceFile.project_id)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .where(
            AnalysisSalesOrderRow.source_file_id.in_(file_ids),
            AnalysisSalesOrderRow.is_counted_sales.is_(True),
        )
    )

    # Apply order_status filter
    if not include_cancelled:
        base_stmt = base_stmt.where(AnalysisSalesOrderRow.order_status != "Cancelled")

    # Apply pending filter (if needed - pending typically means Pending/Unshipped)
    if not include_pending:
        base_stmt = base_stmt.where(AnalysisSalesOrderRow.order_status != "Pending")

    # Get project name for response (we'll need to join Project table)
    from app.models import Project
    base_stmt = base_stmt.join(
        Project, Project.id == AnalysisSourceFile.project_id
    ).add_columns(Project.project_name)

    # Apply pagination
    base_stmt = base_stmt.limit(limit).offset(offset)

    rows = db.execute(base_stmt).all()

    # Serialize
    serialized = [
        _serialize_order_row(row, project_name)
        for row, _, project_name in rows
    ]

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