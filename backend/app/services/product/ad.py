"""Product analysis - ad report DataFrame builders.

拆分自 product_analysis_source_service.py。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisAdProductRow


def _build_ad_df_from_source(db: Session, *, source_id: int):
    rows = db.execute(
        select(AnalysisAdProductRow)
        .where(AnalysisAdProductRow.source_file_id == source_id)
        .order_by(AnalysisAdProductRow.source_row_no.asc())
    ).scalars().all()
    if not rows:
        from pandas import DataFrame
        return DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])
    records = [
        {
            'SKU': row.sku or '',
            '广告展示量': int(row.impressions or 0),
            '广告点击量': int(row.clicks or 0),
            '广告花费': float(row.spend or 0),
            '广告销售额': float(row.sales_7d or 0),
            '广告订单量': int(row.orders_7d or 0),
        }
        for row in rows
    ]
    from pandas import DataFrame
    df = DataFrame(records).groupby('SKU', as_index=False).sum(numeric_only=True)
    return df


def _build_ad_df_from_sources(db: Session, *, source_ids: list[int]):
    if not source_ids:
        from pandas import DataFrame
        return DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])
    frames = [_build_ad_df_from_source(db, source_id=sid) for sid in source_ids]
    non_empty = [f for f in frames if not f.empty]
    if not non_empty:
        from pandas import DataFrame
        return DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])
    from pandas import concat
    combined = concat(non_empty, ignore_index=True)
    return combined.groupby('SKU', as_index=False).sum(numeric_only=True)