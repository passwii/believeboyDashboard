"""Tests for strategy planner."""
from __future__ import annotations

import pytest

from app.services.ad_agent.strategy_planner import plan_strategy
from app.services.ad_agent import DataProfile
from app.services.ad_agent.config_loader import RegistryConfig, DimensionDef


def make_test_data_profile() -> DataProfile:
    return DataProfile(
        available_dimensions=[
            {"dimension_id": "search_term_waste", "signal_strength": "strong", "name": "搜索词浪费", "highlights": []},
            {"dimension_id": "budget_utilization", "signal_strength": "moderate", "name": "预算利用", "highlights": []},
        ],
        skipped_dimensions=[],
        cross_dimension_signals=[],
        temporal_signals={"comparison_period_available": True},
        data_source_summary={
            "ad_search_term_report": {"signal": "strong"},
            "ad_budget_report": {"signal": "moderate"},
        },
    )


def test_plan_strategy_basic():
    registry = RegistryConfig()
    registry.dimensions["search_term_waste"] = DimensionDef(
        id="search_term_waste", name="搜索词浪费", level=1, priority=10,
        required_sources=["ad_search_term_report"], signal_threshold="moderate",
    )
    registry.dimensions["budget_utilization"] = DimensionDef(
        id="budget_utilization", name="预算利用", level=1, priority=9,
        required_sources=["ad_budget_report"], signal_threshold="moderate",
    )
    registry.dimensions["budget_reallocation"] = DimensionDef(
        id="budget_reallocation", name="预算再分配", level=2, priority=10,
        required_sources=["ad_search_term_report", "ad_budget_report"],
        depends_on=["search_term_waste", "budget_utilization"],
        signal_threshold="strong",
    )

    profile = make_test_data_profile()
    strategy = plan_strategy(profile, registry)

    assert len(strategy.primary_dimensions) == 2
    assert any(d["dimension_id"] == "search_term_waste" for d in strategy.primary_dimensions)


def test_plan_strategy_cross_analysis():
    registry = RegistryConfig()
    registry.dimensions["search_term_waste"] = DimensionDef(
        id="search_term_waste", name="搜索词浪费", level=1, priority=10,
        required_sources=["ad_search_term_report"], signal_threshold="moderate",
    )
    registry.dimensions["budget_utilization"] = DimensionDef(
        id="budget_utilization", name="预算利用", level=1, priority=9,
        required_sources=["ad_budget_report"], signal_threshold="moderate",
    )
    registry.dimensions["budget_reallocation"] = DimensionDef(
        id="budget_reallocation", name="预算再分配", level=2, priority=10,
        required_sources=["ad_search_term_report", "ad_budget_report"],
        depends_on=["search_term_waste", "budget_utilization"],
        signal_threshold="strong",
    )

    profile = make_test_data_profile()
    strategy = plan_strategy(profile, registry)

    # budget_reallocation requires strong signal, but budget is only moderate
    # so it should be skipped
    assert len(strategy.cross_analyses) == 0
    assert any(s["dimension_id"] == "budget_reallocation" for s in strategy.skipped)
