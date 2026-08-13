"""CRM 域缓存层（BLF-665 子 #2 阶段 2-A）。

CRM 是全局工作区（无 project_id 维度，数据按 owner_id + scope 过滤），因此
``crm`` / ``crm_tasks`` 两个 L0 域的失效是**全量**的（写后整域清空）。
提供 get/set/invalidate 三件套，供 CRM 列表读端点 + ``invalidate_cache_on_commit``
装饰器使用。

设计 §4.1：#8 crm（5 子域一起失效）、#10 crm_tasks。
"""

from __future__ import annotations

import hashlib

from app.services.infra.cache import cache_delete_pattern, cache_get, cache_set
from app.services.infra.cache_decorator import register_invalidate_fn
from app.services.infra.redis import _p

CRM_KEY_PREFIX = _p("cache:crm")
CRM_TASKS_KEY_PREFIX = _p("cache:crm-tasks")

CRM_TTL = 4 * 3600  # L0：4h 长 TTL（设计 §4.1）


def _hash(*parts: str) -> str:
    raw = ":".join(str(p) for p in parts)
    return hashlib.md5(raw.encode()).hexdigest()[:16]


# ── crm（客户/线索/公海/跟进/商机统一域）───────────────────────────────


def get_crm_cache(kind: str, user_id: str | None, params: tuple) -> dict | None:
    """按 (kind, user_id, params-hash) 取 CRM 列表缓存。"""
    key = f"{CRM_KEY_PREFIX}:{kind}:{_hash(user_id or 'anon', *map(str, params))}"
    return cache_get(key)


def set_crm_cache(kind: str, user_id: str | None, params: tuple, data: dict) -> None:
    key = f"{CRM_KEY_PREFIX}:{kind}:{_hash(user_id or 'anon', *map(str, params))}"
    cache_set(key, data, CRM_TTL)


def invalidate_crm_cache(project_id: int | None = None) -> int:
    """整域失效（CRM 无项目维度，写后清空全部）。"""
    return cache_delete_pattern(f"{CRM_KEY_PREFIX}:*")


# ── crm_tasks（任务域，独立失效）──────────────────────────────────────


def get_crm_tasks_cache(user_id: str | None, params: tuple) -> dict | None:
    key = f"{CRM_TASKS_KEY_PREFIX}:{_hash(user_id or 'anon', *map(str, params))}"
    return cache_get(key)


def set_crm_tasks_cache(user_id: str | None, params: tuple, data: dict) -> None:
    key = f"{CRM_TASKS_KEY_PREFIX}:{_hash(user_id or 'anon', *map(str, params))}"
    cache_set(key, data, CRM_TTL)


def invalidate_crm_tasks_cache(project_id: int | None = None) -> int:
    return cache_delete_pattern(f"{CRM_TASKS_KEY_PREFIX}:*")


# ── 域注册（供装饰器契约使用）─────────────────────────────────────────

register_invalidate_fn("crm", invalidate_crm_cache)
register_invalidate_fn("crm_tasks", invalidate_crm_tasks_cache)
