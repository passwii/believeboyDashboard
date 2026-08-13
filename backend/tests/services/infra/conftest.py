"""缓存治理测试共享 fixture（BLF-665 子 #1）。

- ``memory_store``：沿用 BLF-633 模式（monkeypatch cache_get/set/delete_pattern）
- ``spy_invalidate_fns``：把注册域替换为 spy，记录 (project_id, resource_id) 调用
- ``reset_committed_marker``：每个测试前后清 ContextVar，防跨测试泄漏
"""

from __future__ import annotations

import fnmatch
import logging
from dataclasses import dataclass, field

import pytest

from app.services.infra import cache_decorator as cd


@pytest.fixture
def memory_store(monkeypatch):
    """内存版 Redis 三件套：cache_get / cache_set / cache_delete_pattern。"""
    from app.services.infra import cache as cache_mod

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


@dataclass
class SpyCall:
    project_id: int | None
    resource_id: object = None


@dataclass
class SpyInvalidate:
    """替换某域 invalidate_fn 的 spy：记录调用，可选抛错。"""

    calls: list[SpyCall] = field(default_factory=list)
    raise_on_call: Exception | None = None

    def __call__(self, project_id: int | None = None, resource_id: object = None):
        if self.raise_on_call is not None:
            raise self.raise_on_call
        self.calls.append(SpyCall(project_id=project_id, resource_id=resource_id))
        return 1


@pytest.fixture
def spy_invalidate_fns(monkeypatch):
    """把指定域注入 spy invalidate_fn，返回 {domain: SpyInvalidate}；测试后恢复原值。"""

    def _install(domains: list[str]) -> dict[str, SpyInvalidate]:
        spies: dict[str, SpyInvalidate] = {}
        for domain in domains:
            spy = SpyInvalidate()
            spies[domain] = spy
            cd.REGISTERED_DOMAINS[domain]["invalidate_fn"] = spy
        return spies

    return _install


@pytest.fixture(autouse=True)
def _restore_registered_domains():
    """自动 fixture：测试前后保存/恢复 REGISTERED_DOMAINS 的 invalidate_fn，防跨测试污染。"""
    saved = {
        domain: entry["invalidate_fn"]
        for domain, entry in cd.REGISTERED_DOMAINS.items()
    }
    yield
    for domain, fn in saved.items():
        cd.REGISTERED_DOMAINS[domain]["invalidate_fn"] = fn


@pytest.fixture
def reset_committed_marker():
    """清空 ContextVar commit 标记（前后各一次）。"""
    cd.reset_committed()
    yield
    cd.reset_committed()
