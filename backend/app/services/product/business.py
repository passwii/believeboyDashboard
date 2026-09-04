"""Product analysis - business report DataFrame builders.

拆分自 product_analysis_source_service.py。
"""
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AnalysisBusinessRow
from app.utils.parsers import parse_business_rows

_BUSINESS_COLUMNS = ['ASIN', '页面浏览量', '总销量', '总访客', '总销售额']


def _build_business_df_from_source(db: Session, *, source_id: int):
    rows = db.execute(
        select(AnalysisBusinessRow)
        .where(AnalysisBusinessRow.source_file_id == source_id)
        .order_by(AnalysisBusinessRow.source_row_no.asc())
    ).scalars().all()
    if not rows:
        from pandas import DataFrame
        return DataFrame(columns=_BUSINESS_COLUMNS)
    records = [
        {
            'ASIN': row.asin or '',
            '页面浏览量': int(row.page_views or 0),
            '总销量': int(row.units_ordered or 0),
            '总访客': int(row.sessions or 0),
            '总销售额': float(row.ordered_sales_amount or 0),
        }
        for row in rows
    ]
    from pandas import DataFrame
    return DataFrame(records)


def _build_business_df_from_file(path: Path):
    """从源文件直接构造业务 DataFrame（不入库路径，dry-run 预览用）。

    利用 utils.parsers.parse_business_rows 解析 CSV，再用 source_file_id=-1
    占位（仅用于保持函数签名一致）。真正的数据从 df 转换而来。
    """
    import pandas as pd

    # parse_business_rows 需要 source_file_id，但这里我们不写库；用 sentinel 即可
    payloads, _total, _included = parse_business_rows(path, -1)
    if not payloads:
        return pd.DataFrame(columns=_BUSINESS_COLUMNS)
    records = [
        {
            'ASIN': p.get('asin') or '',
            '页面浏览量': int(p.get('page_views') or 0),
            '总销量': int(p.get('units_ordered') or 0),
            '总访客': int(p.get('sessions') or 0),
            '总销售额': float(p.get('ordered_sales_amount') or 0),
        }
        for p in payloads
    ]
    return pd.DataFrame(records)


def _build_business_df_from_sources(db: Session, *, source_ids: list[int]):
    if not source_ids:
        from pandas import DataFrame
        return DataFrame(columns=_BUSINESS_COLUMNS)
    frames = [_build_business_df_from_source(db, source_id=sid) for sid in source_ids]
    non_empty = [f for f in frames if not f.empty]
    if not non_empty:
        from pandas import DataFrame
        return DataFrame(columns=_BUSINESS_COLUMNS)
    from pandas import concat
    combined = concat(non_empty, ignore_index=True)
    return combined.groupby('ASIN', as_index=False).sum(numeric_only=True)