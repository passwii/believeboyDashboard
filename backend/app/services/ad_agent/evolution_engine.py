"""
Layer 3 — Evolution Engine (进化引擎)
=======================================

分析完成后，提取元数据并存储，用于：
1. 追踪每次分析覆盖了哪些维度、信号强度如何
2. 识别维度信号强度的长期趋势
3. 为维度注册表的自动进化提供数据基础
4. 支持 Prompt 版本化管理

设计为可选层：即使不启用进化功能，Pipeline 也能正常运行。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


@dataclass
class AnalysisRunMetadata:
    """单次分析运行的元数据。"""

    run_id: str = ""
    timestamp: str = ""
    project_id: int = 0
    project_name: str = ""
    country: str = ""
    date_range_start: str = ""
    date_range_end: str = ""

    # 策略信息
    dimensions_analyzed: list[dict[str, Any]] = field(default_factory=list)
    cross_analyses_performed: list[str] = field(default_factory=list)
    temporal_analyses_performed: list[str] = field(default_factory=list)
    dimensions_skipped: list[dict[str, Any]] = field(default_factory=list)

    # 数据信号
    data_source_signals: dict[str, str] = field(default_factory=dict)

    # 质量信号（由分析后处理填充）
    quality_signals: list[str] = field(default_factory=list)
    prompt_version: str = "v2"
    user_feedback: str | None = None
    insight_id: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "timestamp": self.timestamp,
            "project_id": self.project_id,
            "project_name": self.project_name,
            "country": self.country,
            "date_range_start": self.date_range_start,
            "date_range_end": self.date_range_end,
            "dimensions_analyzed": self.dimensions_analyzed,
            "cross_analyses_performed": self.cross_analyses_performed,
            "temporal_analyses_performed": self.temporal_analyses_performed,
            "dimensions_skipped": self.dimensions_skipped,
            "data_source_signals": self.data_source_signals,
            "quality_signals": self.quality_signals,
            "prompt_version": self.prompt_version,
            "user_feedback": self.user_feedback,
        }


def extract_run_metadata(
    *,
    insight_id: int | None = None,
    project_id: int = 0,
    project_name: str = "",
    country: str = "",
    date_range_start: str = "",
    date_range_end: str = "",
    data_profile: Any = None,
    strategy: Any = None,
    content: str = "",
) -> AnalysisRunMetadata:
    """从分析结果中提取运行元数据。"""
    now = datetime.now()
    run_id = f"ad_analysis_{now.strftime('%Y%m%d_%H%M%S')}_{project_id}"

    metadata = AnalysisRunMetadata(
        run_id=run_id,
        timestamp=now.isoformat(),
        insight_id=insight_id,
        project_id=project_id,
        project_name=project_name,
        country=country,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
    )

    # 从 DataProfile 提取
    if data_profile:
        metadata.data_source_signals = {
            k: v.get("signal", "empty")
            for k, v in (data_profile.data_source_summary or {}).items()
        }

    # 从 AnalysisStrategy 提取
    if strategy:
        metadata.dimensions_analyzed = [
            {
                "dimension_id": d.get("dimension_id", ""),
                "name": d.get("name", ""),
                "level": d.get("level", 1),
                "signal_strength": d.get("signal_strength", "unknown"),
            }
            for d in (strategy.primary_dimensions or [])
        ]
        metadata.cross_analyses_performed = [
            d.get("name", "") for d in (strategy.cross_analyses or [])
        ]
        metadata.temporal_analyses_performed = [
            d.get("name", "") for d in (strategy.temporal_analyses or [])
        ]
        metadata.dimensions_skipped = [
            {
                "dimension_id": d.get("dimension_id", ""),
                "name": d.get("name", ""),
                "reason": d.get("reason", ""),
            }
            for d in (strategy.skipped or [])
        ]

    # 从输出内容提取质量信号
    if content:
        quality_signals: list[str] = []
        if "```" in content:
            quality_signals.append("输出包含图表")
        if "|" in content and "---" in content:
            quality_signals.append("输出包含表格")
        if "建议" in content or "行动" in content:
            quality_signals.append("输出包含建议")
        if len(content) > 2000:
            quality_signals.append(f"输出长度 {len(content)} 字符（详细）")
        elif len(content) > 500:
            quality_signals.append(f"输出长度 {len(content)} 字符（中等）")
        else:
            quality_signals.append(f"输出长度 {len(content)} 字符（简短）")
        metadata.quality_signals = quality_signals

    return metadata


def evolve_dimension_weights(
    accumulated_runs: list[AnalysisRunMetadata],
    _current_registry: Any,
) -> dict[str, Any]:
    """基于累积的分析运行数据，计算维度优先级调整建议。

    返回:
        {
            "suggestions": [
                {"dimension_id": "...", "action": "lower_priority", "reason": "..."},
                ...
            ],
            "dimension_health": {dim_id: {run_count, avg_signal, ...}}
        }
    """
    if not accumulated_runs:
        return {"suggestions": [], "dimension_health": {}}

    # 统计每个维度的运行历史
    dim_history: dict[str, list[dict[str, Any]]] = {}
    for run in accumulated_runs:
        for dim in run.dimensions_analyzed:
            did = dim.get("dimension_id", "")
            if did not in dim_history:
                dim_history[did] = []
            dim_history[did].append({
                "run_id": run.run_id,
                "signal": dim.get("signal_strength", "unknown"),
            })

    suggestions: list[dict[str, Any]] = []
    dimension_health: dict[str, Any] = {}

    for dim_id, history in dim_history.items():
        run_count = len(history)
        signal_counts: dict[str, int] = {}
        for h in history:
            sig = h["signal"]
            signal_counts[sig] = signal_counts.get(sig, 0) + 1

        empty_ratio = signal_counts.get("empty", 0) / max(run_count, 1)
        strong_ratio = signal_counts.get("strong", 0) / max(run_count, 1)

        dimension_health[dim_id] = {
            "run_count": run_count,
            "signal_distribution": signal_counts,
            "empty_ratio": round(empty_ratio, 2),
            "strong_ratio": round(strong_ratio, 2),
        }

        # 连续 5 次空信号 → 建议降权
        recent_5 = history[-5:]
        if len(recent_5) >= 5 and all(h["signal"] == "empty" for h in recent_5):
            suggestions.append({
                "dimension_id": dim_id,
                "action": "lower_priority",
                "reason": f"近 {len(recent_5)} 次分析均无数据，建议降低优先级",
            })

        # 连续 3 次 strong → 建议升权
        recent_3 = history[-3:]
        if len(recent_3) >= 3 and all(h["signal"] == "strong" for h in recent_3):
            suggestions.append({
                "dimension_id": dim_id,
                "action": "raise_priority",
                "reason": f"近 {len(recent_3)} 次分析信号稳定强，建议提升优先级",
            })

    # 统计被跳过最多的维度
    skip_counts: dict[str, int] = {}
    for run in accumulated_runs:
        for skip in run.dimensions_skipped:
            did = skip.get("dimension_id", "")
            skip_counts[did] = skip_counts.get(did, 0) + 1

    for did, count in skip_counts.items():
        if count >= 5:
            suggestions.append({
                "dimension_id": did,
                "action": "review_config",
                "reason": f"已被跳过 {count} 次，建议检查数据源配置或降低阈值",
            })

    return {
        "suggestions": suggestions,
        "dimension_health": dimension_health,
    }


# ── 内存中的运行历史（上限 100 条，防止无界增长）────────────────────────────
from collections import deque

_run_history: deque[AnalysisRunMetadata] = deque(maxlen=100)


def record_run(metadata: AnalysisRunMetadata, skip_if_db: bool = False) -> None:
    """记录一次分析运行。"""
    if skip_if_db:
        return
    _run_history.append(metadata)
    logger.info(
        "Recorded analysis run %s: %d dimensions analyzed, %d skipped",
        metadata.run_id,
        len(metadata.dimensions_analyzed),
        len(metadata.dimensions_skipped),
    )


def get_run_history(limit: int = 50) -> list[AnalysisRunMetadata]:
    """获取最近的分析运行历史。"""
    return _run_history[-limit:]


def get_evolution_report() -> dict[str, Any]:
    """生成进化报告。"""
    return evolve_dimension_weights(_run_history, None)


# ── 数据库持久化 ────────────────────────────────────────────────────────────


def record_run_to_db(db: Session, metadata: AnalysisRunMetadata) -> None:
    """Record a run to the database with savepoint isolation.

    Uses a nested transaction (savepoint) so that failure here does not
    pollute the outer session transaction.
    """
    from app.models.ad_agent_run import AdAgentRun
    from app.models.ad_agent_dimension_health import AdAgentDimensionHealth

    nested = db.begin_nested()
    try:
        run_row = AdAgentRun(
            run_id=metadata.run_id,
            insight_id=metadata.insight_id,
            project_id=metadata.project_id,
            project_name=metadata.project_name,
            country=metadata.country,
            date_range_start=metadata.date_range_start if metadata.date_range_start else None,
            date_range_end=metadata.date_range_end if metadata.date_range_end else None,
            dimensions_analyzed=json.dumps(metadata.dimensions_analyzed, ensure_ascii=False),
            cross_analyses_performed=json.dumps(metadata.cross_analyses_performed, ensure_ascii=False),
            temporal_analyses_performed=json.dumps(metadata.temporal_analyses_performed, ensure_ascii=False),
            dimensions_skipped=json.dumps(metadata.dimensions_skipped, ensure_ascii=False),
            data_source_signals=json.dumps(metadata.data_source_signals, ensure_ascii=False),
            quality_signals=json.dumps(metadata.quality_signals, ensure_ascii=False),
            prompt_version=metadata.prompt_version,
            user_feedback=metadata.user_feedback,
        )
        db.add(run_row)

        for dim in metadata.dimensions_analyzed:
            db.add(AdAgentDimensionHealth(
                dimension_id=dim.get("dimension_id", ""),
                run_id=metadata.run_id,
                signal_strength=dim.get("signal_strength", "unknown"),
                was_analyzed=True,
            ))

        for skip in metadata.dimensions_skipped:
            db.add(AdAgentDimensionHealth(
                dimension_id=skip.get("dimension_id", ""),
                run_id=metadata.run_id,
                signal_strength="empty",
                was_analyzed=False,
                skip_reason=skip.get("reason", ""),
            ))

        db.commit()
        logger.info(
            "Persisted run %s to DB: %d dimensions, %d skipped",
            metadata.run_id,
            len(metadata.dimensions_analyzed),
            len(metadata.dimensions_skipped),
        )
    except Exception:
        nested.rollback()
        raise


def get_run_history_from_db(db: Session, project_id: int | None = None, limit: int = 50) -> list[dict[str, Any]]:
    """Get run history from the database."""
    from app.models.ad_agent_run import AdAgentRun

    query = db.query(AdAgentRun).order_by(AdAgentRun.created_at.desc())
    if project_id is not None:
        query = query.filter(AdAgentRun.project_id == project_id)
    rows = query.limit(limit).all()

    return [
        {
            "run_id": r.run_id,
            "project_id": r.project_id,
            "project_name": r.project_name,
            "country": r.country,
            "date_range_start": str(r.date_range_start) if r.date_range_start else None,
            "date_range_end": str(r.date_range_end) if r.date_range_end else None,
            "dimensions_analyzed": json.loads(r.dimensions_analyzed),
            "dimensions_skipped": json.loads(r.dimensions_skipped),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
