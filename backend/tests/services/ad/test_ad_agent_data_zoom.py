"""Tests for ad_agent data_zoom."""
from __future__ import annotations

import pytest

from app.services.ad_agent.data_zoom import extract_zoomed_data, ZOOM_EXTRACTORS


def test_extract_zoomed_data_known_dimension():
    data = {
        "ad_breakdown_by_type": {
            "ad_search_term_report": {"has_data": True, "top": []},
        }
    }
    hotspot = {"dimension": "search_term_waste"}
    result = extract_zoomed_data(data, hotspot)
    assert "ad_search_term_report" in result


def test_extract_zoomed_data_unknown_dimension_fallback():
    data = {"ad_breakdown_by_type": {"ad_budget_report": {}}}
    hotspot = {"dimension": "unknown_dim"}
    result = extract_zoomed_data(data, hotspot)
    assert "ad_breakdown_by_type" in result


def test_all_extractors_have_corresponding_dimension():
    from app.services.ad_agent.config_loader import load_registry
    registry = load_registry()
    dim_ids = set(registry.dimensions.keys())
    extractor_keys = set(ZOOM_EXTRACTORS.keys())
    missing = dim_ids - extractor_keys
    assert not missing, f"Missing zoom extractors for: {missing}"
