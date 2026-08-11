"""BLF-633: 补货分析缓存 key 项目级收敛契约测试。

- get/set 构造的 key 带 ``project:{id}`` 段，且两者一致；
- invalidate(project_id) 只清该项目（pattern 项目级）；
- invalidate(None) 清全部（兼容全量清空场景）。
"""

from __future__ import annotations


def _ic():
    from app.services.infra import inventory_cache

    return inventory_cache


def test_set_key_contains_project_segment(monkeypatch):
    ic = _ic()
    captured: dict[str, str] = {}

    monkeypatch.setattr(
        ic, "cache_set", lambda key, data, ttl: captured.update(key=key)
    )
    ic.set_inventory_replenishment_cache(123, "US", None, None, False, 1, 50, {"x": 1})

    assert captured["key"].startswith(
        f"{ic.INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:123:"
    )


def test_get_key_matches_set_key(monkeypatch):
    """get 与 set 必须构造相同 key（否则缓存永远 miss）。"""
    ic = _ic()
    keys: dict[str, str] = {}

    monkeypatch.setattr(
        ic, "cache_set", lambda key, data, ttl: keys.setdefault("set", key)
    )
    monkeypatch.setattr(
        ic, "cache_get", lambda key: keys.setdefault("get", key) or None
    )
    kwargs = dict(
        country="US",
        keyword="kw",
        risk_status="断货风险",
        in_transit_only=True,
        page=2,
        page_size=50,
        inventory_state="critical",
        replenishment_action="REPLENISH_NOW",
        order_by="sku",
        order_dir="desc",
        detail="summary",
        report_date="2026-08-01",
    )
    ic.set_inventory_replenishment_cache(123, data={"x": 1}, **kwargs)
    ic.get_inventory_replenishment_cache(123, **kwargs)

    assert keys["set"] == keys["get"]
    assert ":project:123:" in keys["get"]


def test_invalidate_scoped_by_project(monkeypatch):
    ic = _ic()
    patterns: list[str] = []

    monkeypatch.setattr(ic, "cache_delete_pattern", lambda p: patterns.append(p) or 0)
    ic.invalidate_inventory_replenishment_cache(123)

    assert patterns == [f"{ic.INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:123:*"]


def test_invalidate_none_clears_all(monkeypatch):
    ic = _ic()
    patterns: list[str] = []

    monkeypatch.setattr(ic, "cache_delete_pattern", lambda p: patterns.append(p) or 0)
    ic.invalidate_inventory_replenishment_cache()

    assert patterns == [f"{ic.INVENTORY_REPLENISHMENT_KEY_PREFIX}:*"]


def test_invalidate_project_does_not_touch_other_projects(monkeypatch):
    """项目级失效只作用于该项目，不误伤其他项目。"""
    ic = _ic()
    patterns: list[str] = []

    monkeypatch.setattr(ic, "cache_delete_pattern", lambda p: patterns.append(p) or 0)
    ic.invalidate_inventory_replenishment_cache(1)
    ic.invalidate_inventory_replenishment_cache(2)

    assert patterns == [
        f"{ic.INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:1:*",
        f"{ic.INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:2:*",
    ]
