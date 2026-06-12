"""Product analysis - ad report DataFrame builders.

拆分自 product_analysis_source_service.py。
"""
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AdUploadFile, AdUploadPromotedProductRow, AnalysisSourceFile
from app.utils.parsers import parse_ad_rows

# CLAUDE.md 要求：手动核算读 C 表广告行时只算 scope_status='included_product'，
# excluded_store_level / excluded_unmapped 行不参与 sum。
AD_INCLUDED_PRODUCT_SCOPE = 'included_product'


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
    仅聚合 `scope_status='included_product'` 的行，与 CLAUDE.md 保持一致。
    """
    from pandas import DataFrame

    _empty_cols = ['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量']

    rows = db.execute(
        select(AdUploadPromotedProductRow)
        .where(
            AdUploadPromotedProductRow.source_file_id == c_source_id,
            AdUploadPromotedProductRow.scope_status == AD_INCLUDED_PRODUCT_SCOPE,
        )
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


def _build_ad_df_from_file(path: Path, *, known_skus: set[str], known_asins: set[str]):
    """从 xlsx 源文件直接构造广告 DataFrame（dry-run 预览用，不入库）。

    通过 utils.parsers.parse_ad_rows 解析（已用 known_skus/known_asins 做
    scope 分类），再按 SKU 求和。仅保留 included_product scope。
    """
    import pandas as pd

    _empty_cols = ['SKU', '广告展示量', '广告点击量', '广告花费', '广告销售额', '广告订单量']
    payloads, _total, _included = parse_ad_rows(path, -1, known_skus, known_asins)
    if not payloads:
        return pd.DataFrame(columns=_empty_cols)
    # 仅保留 included_product scope（与 _build_ad_df_from_c_source 行为一致）
    included_payloads = [p for p in payloads if p.get('scope_status') == AD_INCLUDED_PRODUCT_SCOPE]
    if not included_payloads:
        return pd.DataFrame(columns=_empty_cols)
    records = [
        {
            'SKU': p.get('sku') or '',
            '广告展示量': int(p.get('impressions') or 0),
            '广告点击量': int(p.get('clicks') or 0),
            '广告花费': float(p.get('spend') or 0),
            '广告销售额': float(p.get('sales_7d') or 0),
            '广告订单量': int(p.get('orders_7d') or 0),
        }
        for p in included_payloads
    ]
    return pd.DataFrame(records).groupby('SKU', as_index=False).sum(numeric_only=True)


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