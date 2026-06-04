"""Tests for ad_agent DataProfiler."""
from __future__ import annotations

import pytest

from app.services.ad_agent.data_profiler import profile_data
from app.services.ad_agent.config_loader import DimensionDef, RegistryConfig


def make_registry() -> RegistryConfig:
    """Build a minimal registry with one dimension."""
    config = RegistryConfig()
    config.dimensions["search_term_waste"] = DimensionDef(
        id="search_term_waste",
        name="搜索词浪费识别",
        level=1,
        priority=10,
        required_sources=["ad_search_term_report"],
        optional_sources=["ad_campaign_report"],
        signal_threshold="moderate",
        analysis_prompt_hint="分析搜索词",
    )
    config.data_source_registry = {
        "ad_search_term_report": {"label": "搜索词"},
        "ad_campaign_report": {"label": "Campaign"},
    }
    config.auxiliary_sources = {}
    return config


def test_profile_data_caches_highlights():
    """Highlights must be collected from cache, not by re-assessing."""
    aggregated_data = {
        "ad_breakdown_by_type": {
            "ad_search_term_report": {
                "has_data": True,
                "label": "搜索词",
                "summary": {"spend": 100.0, "sales_7d": 50.0, "orders_7d": 2, "roas": 0.5},
                "top": [
                    {"search_term": "bag", "spend": 50.0, "orders_7d": 0},
                    {"search_term": "box", "spend": 50.0, "orders_7d": 2},
                ],
            },
            "ad_campaign_report": {
                "has_data": False,
                "label": "Campaign",
                "summary": {},
                "top": [],
            },
        }
    }
    registry = make_registry()
    profile = profile_data(aggregated_data, registry)

    # Assert available dimensions has correct highlights
    assert len(profile.available_dimensions) == 1
    dim = profile.available_dimensions[0]
    highlights = dim["highlights"]
    assert any("总花费" in h for h in highlights)
    assert any("ROAS" in h for h in highlights)
