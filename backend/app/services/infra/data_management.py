"""Data management overview cache (dashboard cache).

统一走 cache_get / cache_set 共享层，不再直接操作 Redis 客户端。
"""

from app.services.infra.cache import cache_delete, cache_get, cache_set
from app.services.infra.cache_decorator import register_invalidate_fn
from app.services.infra.redis import _p

DATA_MANAGEMENT_OVERVIEW_KEY = _p("data_management:overview")
DATA_MANAGEMENT_OVERVIEW_TTL = 36000  # 10 hours


def get_data_management_overview_cache() -> dict | None:
    return cache_get(DATA_MANAGEMENT_OVERVIEW_KEY)


def set_data_management_overview_cache(payload: dict) -> None:
    cache_set(DATA_MANAGEMENT_OVERVIEW_KEY, payload, DATA_MANAGEMENT_OVERVIEW_TTL)


def invalidate_data_management_overview_cache() -> None:
    cache_delete(DATA_MANAGEMENT_OVERVIEW_KEY)


# 域注册（供装饰器契约使用，BLF-665 子 #2）
register_invalidate_fn("data_management", invalidate_data_management_overview_cache)
