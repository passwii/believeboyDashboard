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
