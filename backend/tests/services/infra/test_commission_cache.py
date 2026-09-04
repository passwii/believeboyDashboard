"""commission_cache 域缓存层测试（BLF-665 子 #2 阶段 2-A）。

验证 4 个 commission 域（records / ratio_overrides / role_assignments / summary）
的 get/set 往返 + invalidate 整域清空。用内存 store 替换 cache 三件套，不依赖 Redis。
"""

from __future__ import annotations

import pytest

from app.services.infra import commission_cache as cc


@pytest.fixture
def memory_store(monkeypatch):
    import fnmatch

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

    # 模块 import 时已绑定函数引用，须在模块级替换（与 test_inventory_cache 同模式）
    monkeypatch.setattr(cc, "cache_get", fake_get)
    monkeypatch.setattr(cc, "cache_set", fake_set)
    monkeypatch.setattr(cc, "cache_delete_pattern", fake_delete_pattern)
    return store


class TestCommissionRecords:
    def test_roundtrip(self, memory_store):
        cc.set_commission_records_cache("2026-07", "US", None, False, {"items": [1]})
        assert cc.get_commission_records_cache("2026-07", "US", None, False) == {
            "items": [1]
        }

    def test_different_person_produces_different_keys(self, memory_store):
        cc.set_commission_records_cache("2026-07", "US", "Alice", False, {"m": "a"})
        cc.set_commission_records_cache("2026-07", "US", "Bob", False, {"m": "b"})
        assert len(memory_store) == 2

    def test_invalidate_clears_all_months(self, memory_store):
        cc.set_commission_records_cache("2026-06", "US", None, False, {"m": "1"})
        cc.set_commission_records_cache("2026-07", "US", None, False, {"m": "2"})
        deleted = cc.invalidate_commission_records_cache()
        assert deleted == 2
        assert cc.get_commission_records_cache("2026-06", "US", None, False) is None
        assert cc.get_commission_records_cache("2026-07", "US", None, False) is None


class TestCommissionRatioOverrides:
    def test_roundtrip_and_invalidate(self, memory_store):
        cc.set_commission_ratio_overrides_cache("2026-07", {"items": [1]})
        assert cc.get_commission_ratio_overrides_cache("2026-07") == {"items": [1]}
        assert cc.invalidate_commission_ratio_overrides_cache() == 1
        assert cc.get_commission_ratio_overrides_cache("2026-07") is None


class TestCommissionRoleAssignments:
    def test_project_scoped_keys(self, memory_store):
        cc.set_commission_role_assignments_cache(1, "2026-07", {"m": "p1"})
        cc.set_commission_role_assignments_cache(2, "2026-07", {"m": "p2"})
        assert cc.get_commission_role_assignments_cache(1, "2026-07") == {"m": "p1"}
        # 项目级失效只清该项目
        deleted = cc.invalidate_commission_role_assignments_cache(project_id=1)
        assert deleted == 1
        assert cc.get_commission_role_assignments_cache(1, "2026-07") is None
        assert cc.get_commission_role_assignments_cache(2, "2026-07") == {"m": "p2"}
        # 无 project_id → 全量
        assert cc.invalidate_commission_role_assignments_cache() == 1


class TestCommissionSummary:
    def test_roundtrip_and_invalidate(self, memory_store):
        cc.set_commission_summary_cache("monthly", "2026", "US", {"items": []})
        assert cc.get_commission_summary_cache("monthly", "2026", "US") == {"items": []}
        assert cc.get_commission_summary_cache("project", "2026", "US") is None
        assert cc.invalidate_commission_summary_cache() == 1


class TestDomainRegistration:
    def test_domains_registered(self):
        from app.services.infra import cache_decorator as cd

        for domain in (
            "commission_records",
            "commission_ratio_overrides",
            "commission_role_assignments",
            "commission_summary",
            "operator_performance",
        ):
            assert cd.get_invalidate_fn(domain) is not None, (
                f"{domain} 应已注册 invalidate_fn"
            )
