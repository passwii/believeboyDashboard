"""Tests for multi_pass hotspot parsing."""
from __future__ import annotations

import pytest

from app.services.ad_agent.multi_pass import _parse_hotspots


def test_parse_hotspots_from_fenced_code_block():
    raw = """Okay, here are the hotspots:

```json
[
  {"dimension": "search_term_waste", "severity": "high", "finding": "发现高花费零转化词", "key_metric": "$45.20"}
]
```

Hope this helps!"""
    hotspots = _parse_hotspots(raw)
    assert len(hotspots) == 1
    assert hotspots[0]["dimension"] == "search_term_waste"


def test_parse_hotspots_plain_json():
    raw = '[{"dimension": "budget_utilization", "severity": "medium", "finding": "预算过剩", "key_metric": "$120"}]'
    hotspots = _parse_hotspots(raw)
    assert len(hotspots) == 1


def test_parse_hotspots_invalid_returns_empty():
    raw = "No JSON here at all"
    hotspots = _parse_hotspots(raw)
    assert hotspots == []
