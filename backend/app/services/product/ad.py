"""Product analysis - ad report DataFrame builders.

拆分自 product_analysis_source_service.py。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AdUploadPromotedProductRow, AnalysisAdProductRow, AnalysisSourceFile


def _resolve_c_source_id_from_a_source_id(db: Session, *, a_source_id: int) -> int | None:
    """根据 A 表 AnalysisSourceFile.id 找到 C 表 AdUploadFile.id。

    通过 (project_id, country, period, version, is_current) 匹配。
    如果 A 表 source_id 不存在或 C 表没对应，返回 None。
    """
    a_src = db.get(AnalysisSourceFile, a_source_id)
    if a_src is None or a_src.report_type != 'ad_product_report':
        return None
    c_src = db.execute(
        select(AdUploadFile.id)
        .where(
            AdUploadFile.project_id == a_src.project_id,
            AdUploadFile.country == a_src.country,
            AdUploadFile.period_start_date == a_src.period_start_date,
            AdUploadFile.period_end_date == a_src.period_end_date,
            AdUploadFile.version == a_src.version,
            AdUploadFile.is_current == a_src.is_current,
            AdUploadFile.report_type == 'ad_promoted_product_report',
        )
    ).scalar_one_or_none()
    return c_src


def _build_ad_df_from_source(db: Session, *, source_id: int):
    # 优先从 C 表读 (ad_upload_promoted_product_rows)
    c_source_id = _resolve_c_source_id_from_a_source_id(db, a_source_id=source_id)
    if c_source_id is not None:
        rows = db.execute(
            select(AdUploadPromotedProductRow)
            .where(AdUploadPromotedProductRow.source_file_id == c_source_id)
            .order_by(AdUploadPromotedProductRow.source_row_no.asc())
        ).scalars().all()
        sku_attr = 'ad_sku'
    else:
        # 兜底：A 表 (用于还没迁入 C 表的旧数据)
        rows = db.execute(
            select(AnalysisAdProductRow)
            .where(AnalysisAdProductRow.source_file_id == source_id)
            .order_by(AnalysisAdProductRow.source_row_no.asc())
        ).scalars().all()
        sku_attr = 'sku'
    if not rows:
        from pandas import DataFrame
        return DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])
    records = [
        {
            'SKU': getattr(row, sku_attr) or '',
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