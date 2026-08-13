"""crm_cache 域缓存层测试（BLF-665 子 #2 阶段 2-A）。

CRM 为全局工作区（无 project_id 维度），验证 crm / crm_tasks 两域的
get/set 往返 + 整域失效。用内存 store 替换 cache 三件套，不依赖 Redis。
"""

from __future__ import annotations

import pytest

from app.services.infra import crm_cache as crm


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

    # 模块 import 时已绑定函数引用，须在模块级替换
    monkeypatch.setattr(crm, "cache_get", fake_get)
    monkeypatch.setattr(crm, "cache_set", fake_set)
    monkeypatch.setattr(crm, "cache_delete_pattern", fake_delete_pattern)
    return store


class TestCrmCache:
    def test_roundtrip(self, memory_store):
        crm.set_crm_cache("customers", "u1", ("all", 1, 20), {"items": [1]})
        assert crm.get_crm_cache("customers", "u1", ("all", 1, 20)) == {"items": [1]}

    def test_user_scoped_keys(self, memory_store):
        crm.set_crm_cache("customers", "u1", ("all", 1, 20), {"m": "u1"})
        crm.set_crm_cache("customers", "u2", ("all", 1, 20), {"m": "u2"})
        assert len(memory_store) == 2

    def test_invalidate_clears_all(self, memory_store):
        crm.set_crm_cache("customers", "u1", ("all", 1, 20), {"m": "a"})
        crm.set_crm_cache("leads", "u1", ("all", 1, 20), {"m": "b"})
        deleted = crm.invalidate_crm_cache()
        assert deleted == 2
        assert crm.get_crm_cache("customers", "u1", ("all", 1, 20)) is None
        assert crm.get_crm_cache("leads", "u1", ("all", 1, 20)) is None


class TestCrmTasksCache:
    def test_roundtrip_and_invalidate(self, memory_store):
        crm.set_crm_tasks_cache("u1", ("mine", 1, 20), {"items": [1]})
        assert crm.get_crm_tasks_cache("u1", ("mine", 1, 20)) == {"items": [1]}
        assert crm.invalidate_crm_tasks_cache() == 1
        assert crm.get_crm_tasks_cache("u1", ("mine", 1, 20)) is None


class TestDomainRegistration:
    def test_domains_registered(self):
        from app.services.infra import cache_decorator as cd

        for domain in ("crm", "crm_tasks"):
            assert cd.get_invalidate_fn(domain) is not None, (
                f"{domain} 应已注册 invalidate_fn"
            )
