"""cache_decorator 测试共享 fixtures（BLF-666）。

沿用 BLF-633 ``memory_store`` 模式（内存 Redis 三件套），新增:
- ``register_test_fns``: 给测试域注入失效函数（spy / 自定义），测试后自动注销；
- ``spy_invalidate_fns``: 便捷 spy——注入后记录 (domain, project_id, resource_id)；
- ``reset_committed_marker``: 每个测试后清 Celery committed 标记（ContextVar
  跨测试污染防护）。
"""

from __future__ import annotations

import fnmatch

import pytest

import app.services.infra.cache_decorator as cd


@pytest.fixture
def memory_store(monkeypatch):
    """内存版 Redis 三件套：cache_get / cache_set / cache_delete_pattern。

    直接 patch 到 cache_decorator 依赖的 cache 模块上，避免依赖本地 Redis。
    """
    import app.services.infra.cache as cache_mod

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

    monkeypatch.setattr(cache_mod, "cache_get", fake_get)
    monkeypatch.setattr(cache_mod, "cache_set", fake_set)
    monkeypatch.setattr(cache_mod, "cache_delete_pattern", fake_delete_pattern)
    return store


@pytest.fixture
def register_test_fns(monkeypatch):
    """注册测试域失效函数；测试结束自动从登记表移除。

    返回 ``register(domain, fn=None)`` 函数——不传 fn 时注册默认 spy
    （记录调用并返回 1）。
    """

    def _register(domain: str, fn=None):
        if fn is None:
            fn = lambda project_id=None, **kwargs: 1  # noqa: E731
        monkeypatch.setitem(cd._INVALIDATE_FNS, domain, fn)
        return fn

    return _register


@pytest.fixture
def spy_invalidate_fns(register_test_fns):
    """给多个测试域注入调用记录 spy。

    返回 ``(register, calls)``:
    - register(domain) → 注入该域 spy 并返回 spy；
    - calls: {domain: [(project_id, resource_id), ...]} 调用序列。
    """

    calls: dict[str, list[tuple]] = {}

    def _register(domain: str):
        def spy(project_id=None, **kwargs):
            calls.setdefault(domain, []).append((project_id, kwargs.get("resource_id")))
            return 1

        register_test_fns(domain, spy)
        return spy

    return _register, calls


@pytest.fixture
def reset_committed_marker():
    """每个测试后清 Celery committed 标记（ContextVar 跨测试污染防护）。"""
    cd.reset_committed()
    yield
    cd.reset_committed()
