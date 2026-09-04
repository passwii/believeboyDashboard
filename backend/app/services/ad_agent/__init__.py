"""
Ad Analysis Agent Pipeline
===========================

从"静态 prompt + 全量数据"升级为"可进化 Agent 系统"。

Pipeline:
  Layer 0 — DataProfiler:     数据探针，体检每种报表的信号强度
  Layer 1 — StrategyPlanner:  基于维度注册表 + 数据 profile 动态组装分析策略
  Layer 2 — PromptAssembler:  将策略转化为结构化 prompt（多轮 / 单轮）
  Layer 3 — EvolutionEngine:  分析后元数据提取 + 维度注册表自动进化

Usage:
    from app.services.ad_agent import run_ad_agent_pipeline

    result = run_ad_agent_pipeline(
        aggregated_data=agg_data,
        settings=settings,
        project_name="MyProject",
        country="US",
        date_range_start=start,
        date_range_end=end,
    )
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── 配置路径 ────────────────────────────────────────────────────────────────
_CONFIG_DIR = Path(__file__).parent / "config"
_DIMENSIONS_YAML = _CONFIG_DIR / "dimensions.yaml"


def get_dimensions_yaml_path() -> Path:
    return _DIMENSIONS_YAML


# ── 公共类型 ────────────────────────────────────────────────────────────────


@dataclass
class DataProfile:
    """Layer 0 输出：数据体检报告。"""

    available_dimensions: list[dict[str, Any]] = field(default_factory=list)
    skipped_dimensions: list[dict[str, Any]] = field(default_factory=list)
    cross_dimension_signals: list[str] = field(default_factory=list)
    temporal_signals: dict[str, Any] = field(default_factory=dict)
    data_source_summary: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "available_dimensions": self.available_dimensions,
            "skipped_dimensions": self.skipped_dimensions,
            "cross_dimension_signals": self.cross_dimension_signals,
            "temporal_signals": self.temporal_signals,
            "data_source_summary": self.data_source_summary,
        }


@dataclass
class AnalysisStrategy:
    """Layer 1 输出：分析策略。"""

    primary_dimensions: list[dict[str, Any]] = field(default_factory=list)
    cross_analyses: list[dict[str, Any]] = field(default_factory=list)
    temporal_analyses: list[dict[str, Any]] = field(default_factory=list)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    strategy_summary: str = ""
    estimated_passes: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "primary_dimensions": self.primary_dimensions,
            "cross_analyses": self.cross_analyses,
            "temporal_analyses": self.temporal_analyses,
            "skipped": self.skipped,
            "strategy_summary": self.strategy_summary,
            "estimated_passes": self.estimated_passes,
        }


@dataclass
class AnalysisResult:
    """最终输出。"""

    content: str = ""
    strategy_declaration: str = ""
    data_profile: DataProfile | None = None
    strategy: AnalysisStrategy | None = None
    evolution_metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "strategy_declaration": self.strategy_declaration,
            "data_profile": self.data_profile.to_dict() if self.data_profile else None,
            "strategy": self.strategy.to_dict() if self.strategy else None,
            "evolution_metadata": self.evolution_metadata,
        }
