"""DB-backed payment report DataFrame builders.

Builds pandas DataFrames from AnalysisPaymentRow DB records
for product analysis consumption.
"""
from __future__ import annotations

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisPaymentRow

_PAYMENT_COLUMNS = [
    "type",
    "sku",
    "quantity",
    "product sales",
    "shipping credits",
    "promotional rebates",
    "other",
    "selling fees",
    "fba fees",
]


def build_df_from_source(db: Session, *, source_id: int) -> pd.DataFrame:
    """Build a payment DataFrame from a single source file.

    Args:
        db: Database session.
        source_id: AnalysisSourceFile id.

    Returns:
        DataFrame with standardized payment columns.
    """
    rows = (
        db.execute(
            select(AnalysisPaymentRow)
            .where(AnalysisPaymentRow.source_file_id == source_id)
            .order_by(AnalysisPaymentRow.source_row_no.asc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return pd.DataFrame(columns=_PAYMENT_COLUMNS)
    records = [
        {
            "type": row.transaction_type,
            "sku": row.sku or "",
            "quantity": int(row.quantity or 0),
            "product sales": float(row.product_sales or 0),
            "shipping credits": float(row.shipping_credits or 0),
            "promotional rebates": float(row.promotional_rebates or 0),
            "other": float(row.other_amount or 0),
            "selling fees": float(row.selling_fees or 0),
            "fba fees": float(row.fba_fees or 0),
        }
        for row in rows
    ]
    return pd.DataFrame(records)


def build_df_from_sources(db: Session, *, source_ids: list[int]) -> pd.DataFrame:
    """Build a merged payment DataFrame from multiple source files.

    Args:
        db: Database session.
        source_ids: List of AnalysisSourceFile ids.

    Returns:
        Concatenated DataFrame of all sources.
    """
    if not source_ids:
        return pd.DataFrame(columns=_PAYMENT_COLUMNS)
    frames = [build_df_from_source(db, source_id=sid) for sid in source_ids]
    non_empty = [f for f in frames if not f.empty]
    if not non_empty:
        return pd.DataFrame(columns=_PAYMENT_COLUMNS)
    return pd.concat(non_empty, ignore_index=True)
