"""退货分析的共享读查询。

独立成模块的原因：`analysis.py` 已 1600+ 行，且同一个「当前生效退货行」
查询曾被三处各写一份（fallback / snapshot / Agent raw），Agent 那份漏了
``is_current`` 过滤导致口径漂移。这里收敛成唯一真相源，分析路径与新端点
都必须调它 —— 唯一的例外是 Agent R3（``query_return_analysis_raw``），
它有分页/排序参数与 PII 剥离契约，另行评估。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from app.models import AnalysisReturnRow, AnalysisSourceFile


def query_current_return_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
) -> list[AnalysisReturnRow]:
    """当前生效版本的退货原始行（退货分析口径唯一真相源）。

    过滤条件与 ``build_return_analysis()`` 的 fallback 路径逐字一致：只取
    ``is_current`` 的 ``return_report`` 源文件下、``return_date`` 落在
    ``[start_date, end_date]`` 区间的行。

    排序 ``return_date ASC, id ASC``：让原始数据导出可复现（分析路径下游
    自行聚合/排序，不受影响）。
    """
    query = (
        db.query(AnalysisReturnRow)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,
            AnalysisReturnRow.return_date >= date.fromisoformat(start_date),
            AnalysisReturnRow.return_date <= date.fromisoformat(end_date),
        )
    )
    if sku:
        query = query.filter(AnalysisReturnRow.sku == sku)

    return (
        query.order_by(
            AnalysisReturnRow.return_date.asc(),
            AnalysisReturnRow.id.asc(),
        )
        .all()
    )


__all__ = ["query_current_return_rows"]
