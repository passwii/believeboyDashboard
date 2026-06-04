"""
从 YAML 加载维度注册表配置。
提供解析后的维度定义、数据源映射、全局策略等。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


@dataclass
class DimensionDef:
    """单个维度的定义。"""

    id: str
    name: str
    level: int
    priority: int
    required_sources: list[str]
    optional_sources: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    auxiliary_required: list[str] = field(default_factory=list)
    requires_comparison: bool = False
    description: str = ""
    analysis_prompt_hint: str = ""
    signal_threshold: str = "moderate"
    output_artifacts: list[str] = field(default_factory=list)


@dataclass
class RegistryConfig:
    """完整的维度注册表配置。"""

    version: str = "0.0.0"
    dimensions: dict[str, DimensionDef] = field(default_factory=dict)
    data_source_registry: dict[str, Any] = field(default_factory=dict)
    auxiliary_sources: dict[str, Any] = field(default_factory=dict)
    global_strategy: dict[str, Any] = field(default_factory=dict)

    def get_dimension(self, dim_id: str) -> DimensionDef | None:
        return self.dimensions.get(dim_id)

    def get_dimensions_by_level(self, level: int) -> list[DimensionDef]:
        return [d for d in self.dimensions.values() if d.level == level]

    def get_all_level1_ids(self) -> list[str]:
        return [d.id for d in self.dimensions.values() if d.level == 1]


def _load_dimension_prompt(dim_id: str, config_dir: Path) -> str:
    """Load analysis prompt from .md file if exists, else return empty."""
    prompt_path = config_dir / "prompts" / f"{dim_id}.md"
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8")
    return ""


def load_registry(path: Path | None = None) -> RegistryConfig:
    """加载并解析维度注册表 YAML。"""
    if path is None:
        from app.services.ad_agent import get_dimensions_yaml_path
        path = get_dimensions_yaml_path()

    if not path.exists():
        logger.warning("Dimensions YAML not found at %s, using empty registry", path)
        return RegistryConfig()

    with open(path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    config = RegistryConfig(
        version=raw.get("version", "0.0.0"),
        data_source_registry=raw.get("data_source_registry", {}),
        auxiliary_sources=raw.get("auxiliary_sources", {}),
        global_strategy=raw.get("global_strategy", {}),
    )

    config_dir = path.parent
    for dim_id, dim_data in raw.get("dimensions", {}).items():
        prompt_from_file = _load_dimension_prompt(dim_id, config_dir)
        # 如果文件存在则使用文件内容，否则使用 YAML 中的内嵌内容（向后兼容）
        analysis_hint = prompt_from_file or dim_data.get("analysis_prompt_hint", "")
        config.dimensions[dim_id] = DimensionDef(
            id=dim_id,
            name=dim_data.get("name", dim_id),
            level=dim_data.get("level", 1),
            priority=dim_data.get("priority", 5),
            required_sources=dim_data.get("required_sources", []),
            optional_sources=dim_data.get("optional_sources", []),
            depends_on=dim_data.get("depends_on", []),
            auxiliary_required=dim_data.get("auxiliary_required", []),
            requires_comparison=dim_data.get("requires_comparison", False),
            description=dim_data.get("description", ""),
            analysis_prompt_hint=analysis_hint,
            signal_threshold=dim_data.get("signal_threshold", "moderate"),
            output_artifacts=dim_data.get("output_artifacts", []),
        )

    logger.info(
        "Loaded dimension registry v%s: %d dimensions (%d L1, %d L2, %d L3)",
        config.version,
        len(config.dimensions),
        len(config.get_dimensions_by_level(1)),
        len(config.get_dimensions_by_level(2)),
        len(config.get_dimensions_by_level(3)),
    )
    return config
