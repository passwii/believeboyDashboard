"""Product analysis - ad report DataFrame builders.

拆分自 product_analysis_source_service.py。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AdUploadPromotedProductRow, AnalysisSourceFile


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
    from pandas import DataFrame

    _empty_cols = ['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量']

    c_source_id = _resolve_c_source_id_from_a_source_id(db, a_source_id=source_id)
    if c_source_id is None:
        return DataFrame(columns=_empty_cols)

    return _build_ad_df_from_c_source(db, c_source_id=c_source_id)


def _build_ad_df_from_c_source(db: Session, *, c_source_id: int):
    """直接从 C 表 (ad_upload_promoted_product_rows) 读取广告数据。

    用于已知是 C 表 ID 的场景 (新迁移到 C 表后的调用方)。
    """
    from pandas import DataFrame

    _empty_cols = ['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量']

    rows = db.execute(
        select(AdUploadPromotedProductRow)
        .where(AdUploadPromotedProductRow.source_file_id == c_source_id)
        .order_by(AdUploadPromotedProductRow.source_row_no.asc())
    ).scalars().all()
    if not rows:
        return DataFrame(columns=_empty_cols)
    records = [
        {
            'SKU': (row.ad_sku or ''),
            '广告展示量': int(row.impressions or 0),
            '广告点击量': int(row.clicks or 0),
            '广告花费': float(row.spend or 0),
            '广告销售额': float(row.sales_7d or 0),
            '广告订单量': int(row.orders_7d or 0),
        }
        for row in rows
    ]
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


def _build_ad_df_from_c_sources(db: Session, *, c_source_ids: list[int]):
    """批量从 C 表读取广告数据。"""
    if not c_source_ids:
        from pandas import DataFrame
        return DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])
    frames = [_build_ad_df_from_c_source(db, c_source_id=sid) for sid in c_source_ids]
    non_empty = [f for f in frames if not f.empty]
    if not non_empty:
        from pandas import DataFrame
        return DataFrame(columns=[
            'SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量',
        ])
    from pandas import concat
    combined = concat(non_empty, ignore_index=True)
    return combined.groupby('SKU', as_index=False).sum(numeric_only=True)