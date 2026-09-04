"""Tests for ad_agent config_loader."""
from __future__ import annotations

from app.services.ad_agent.config_loader import load_registry


def test_load_registry_has_dimensions():
    registry = load_registry()
    assert len(registry.dimensions) > 0
    assert len(registry.get_dimensions_by_level(1)) > 0


def test_all_dimensions_have_required_sources():
    registry = load_registry()
    for dim_id, dim in registry.dimensions.items():
        assert dim.required_sources, f"Dimension {dim_id} has no required_sources"


def test_load_registry_reads_prompt_from_file():
    """Prompt files in prompts/ should override YAML analysis_prompt_hint."""
    registry = load_registry()
    dim = registry.get_dimension("search_term_waste")
    assert dim is not None
    # The .md file contains "搜索词浪费识别" in the header
    assert "搜索词浪费识别" in dim.analysis_prompt_hint or "分析目标" in dim.analysis_prompt_hint
