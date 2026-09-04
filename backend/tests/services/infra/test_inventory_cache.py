"""inventory_cache 补货缓存 key 结构 + 项目级失效测试（BLF-633）。

BLF-633 修复：补货分析设置写路径补 Redis 缓存失效。本文件锁定三件事：
1. key 含 ``project:{id}`` 段（get/set 同构）——失效可按项目收敛；
2. ``invalidate_inventory_replenishment_cache(project_id)`` 只清该项目缓存，
   不清其他项目（避免写设置/快照时跨项目缓存击穿）；
3. 不传 project_id 时回退全量清空（兼容旧调用）。
用内存 store 替换 cache_get/cache_set/cache_delete_pattern，不依赖本地 Redis。
"""

from __future__ import annotations

import fnmatch

import pytest

from app.services.infra import inventory_cache as ic


@pytest.fixture
def memory_store(monkeypatch):
    """内存版 Redis 三件套：cache_get / cache_set / cache_delete_pattern。"""
    store: dict[str, str] = {}

    def fake_get(key: str):
        return store.get(key)

    def fake_set(key: str, value, ttl: int = 300) -> None:
        store[key] = value

    def fake_delete_pattern(pattern: str) -> int:
        keys = [k for k in store if fnmatch.fnmatch(k, pattern)]
        for k in keys:
            del store[k]
        return len(keys)

    monkeypatch.setattr(ic, "cache_get", fake_get)
    monkeypatch.setattr(ic, "cache_set", fake_set)
    monkeypatch.setattr(ic, "cache_delete_pattern", fake_delete_pattern)
    return store


def _set(project_id: int, marker: str) -> None:
    """写一条补货缓存（固定参数组合，data 带 marker 便于断言）。"""
    ic.set_inventory_replenishment_cache(
        project_id, "US", None, None, False, 1, 50, {"marker": marker}
    )


def _get(project_id: int):
    return ic.get_inventory_replenishment_cache(
        project_id, "US", None, None, False, 1, 50
    )


class TestKeyStructure:
    def test_key_contains_project_segment(self, memory_store):
        _set(1, "p1")
        keys = list(memory_store)
        assert len(keys) == 1
        assert keys[0].startswith(f"{ic.INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:1:")

    def test_get_set_roundtrip(self, memory_store):
        _set(1, "p1")
        assert _get(1) == {"marker": "p1"}

    def test_different_projects_produce_different_keys(self, memory_store):
        _set(1, "p1")
        _set(2, "p2")
        assert len(memory_store) == 2


class TestInvalidate:
    def test_project_scoped_invalidation(self, memory_store):
        _set(1, "p1")
        _set(2, "p2")
        deleted = ic.invalidate_inventory_replenishment_cache(project_id=1)
        assert deleted == 1
        assert _get(1) is None, "项目 1 缓存应被清空"
        assert _get(2) == {"marker": "p2"}, "项目 2 缓存不应受影响"

    def test_invalidate_all_without_project_id(self, memory_store):
        _set(1, "p1")
        _set(2, "p2")
        deleted = ic.invalidate_inventory_replenishment_cache()
        assert deleted == 2
        assert _get(1) is None
        assert _get(2) is None

    def test_invalidate_missing_project_is_noop(self, memory_store):
        _set(1, "p1")
        deleted = ic.invalidate_inventory_replenishment_cache(project_id=999)
        assert deleted == 0
        assert _get(1) == {"marker": "p1"}

    def test_extended_params_share_project_scope(self, memory_store):
        """带新参数（inventory_state/action/order_by/detail 等）的 key 同样被项目级清空。"""
        ic.set_inventory_replenishment_cache(
            1,
            "US",
            None,
            None,
            False,
            1,
            50,
            {"marker": "ext"},
            inventory_state="critical",
            replenishment_action="REPLENISH_NOW",
            order_by="sku",
            order_dir="desc",
            detail="summary",
            report_date="2026-08-01",
        )
        deleted = ic.invalidate_inventory_replenishment_cache(project_id=1)
        assert deleted == 1
        assert (
            ic.get_inventory_replenishment_cache(
                1,
                "US",
                None,
                None,
                False,
                1,
                50,
                inventory_state="critical",
                replenishment_action="REPLENISH_NOW",
                order_by="sku",
                order_dir="desc",
                detail="summary",
                report_date="2026-08-01",
            )
            is None
        )
