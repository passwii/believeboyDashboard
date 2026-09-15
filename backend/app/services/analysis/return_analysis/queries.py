"""退货分析的共享读查询。

独立成模块的原因：`analysis.py` 已 1600+ 行，且同一个「当前生效退货行」
查询曾被三处各写一份（fallback / snapshot / Agent raw），Agent 那份漏了
``is_current`` 过滤导致口径漂移。这里收敛成唯一真相源，分析路径与新端点
都必须调它 —— 唯一的例外是 Agent R3（``query_return_analysis_raw``），
它有分页/排序参数与 PII 剥离契约，另行评估。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import func, select
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
    limit: int | None = None,
) -> list[AnalysisReturnRow]:
    """当前生效版本的退货原始行（退货分析口径唯一真相源）。

    过滤条件与 ``build_return_analysis()`` 的 fallback 路径逐字一致：只取
    ``is_current`` 的 ``return_report`` 源文件下、``return_date`` 落在
    ``[start_date, end_date]`` 区间的行。

    排序 ``return_date ASC, id ASC``：让原始数据导出结果确定可复现。它不改动
    任何聚合数值，但会决定 ``feedback_rows`` 的先后（连带 ``summary_text`` 采样的
    那条典型反馈），以及原因/处理方式/状态分布并列计数时的先后 —— 排序并非
    无副作用。

    ``limit`` 为 ``None`` 时不加 LIMIT（分析路径的正确性依赖全量行做聚合，
    故两处分析调用点**都不传**）；只有原始行端点会传 ``MAX_RAW_ROWS + 1``，
    把「读多少」也一起收口 —— 否则上限只挡响应、不挡 DB 读取。
    """
    conditions = [
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.country == country,
        AnalysisSourceFile.report_type == "return_report",
        AnalysisSourceFile.is_current.is_(True),
        AnalysisReturnRow.return_date >= date.fromisoformat(start_date),
        AnalysisReturnRow.return_date <= date.fromisoformat(end_date),
    ]
    if sku:
        conditions.append(AnalysisReturnRow.sku == sku)

    return list(
        db.execute(
            select(AnalysisReturnRow)
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
            )
            .where(*conditions)
            .order_by(
                AnalysisReturnRow.return_date.asc(),
                AnalysisReturnRow.id.asc(),
            )
            # ``limit=None`` 是 SQLAlchemy 的 no-op（不加 LIMIT），
            # 所以单次绑定即可兼顾「无限制」与「MAX_RAW_ROWS + 1」。
            .limit(limit)
        )
        .scalars()
        .all()
    )


__all__ = ["query_current_return_rows", "query_return_data_span"]


def query_return_data_span(
    db: Session,
    *,
    project_id: int,
    country: str,
) -> tuple[date | None, date | None]:
    """当前生效退货报表的数据跨度 ``(min_return_date, max_return_date)``。

    与 :func:`query_current_return_rows` 同一过滤层（``return_report`` +
    ``is_current``），不受调用方窗口限制——它回答的是「这个店到底有哪段
    时间范围的退货数据」，供调用方判断某个窗口的数字是否可信。

    用途（BLF-1078 P1-5）：区分「真的零退货」与「没数据」。例如犀牛
    2025-01-01~2025-12-31 有 8690 件销售、报 0.0% 退货率，但它的退货数据自
    2026-03-28 才开始——该窗口完全落在跨度之前，退货率应返回 ``null`` 而不是
    被误读为「表现完美」。

    Returns:
        ``(None, None)`` 表示该店没有任何当前生效的退货数据。
    """
    row = (
        db.execute(
            select(
                func.min(AnalysisReturnRow.return_date),
                func.max(AnalysisReturnRow.return_date),
            )
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
            )
            .where(
                AnalysisReturnRow.project_id == project_id,
                AnalysisReturnRow.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.is_current.is_(True),
            )
        ).first()
    )
    if row is None:
        return None, None
    return row[0], row[1]
