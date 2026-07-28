"""Product analysis cache (weekly analysis cache).

统一走 cache_get / cache_set 共享层，不再直接操作 Redis 客户端。
"""

from app.services.infra.cache import cache_delete_pattern, cache_get, cache_set
from app.services.infra.redis import _p

PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX = _p("product_analysis:weekly")
PRODUCT_ANALYSIS_WEEKLY_TTL = 14400  # 4 hours


def make_weekly_analysis_cache_key(
    project_id: int,
    country: str,
    start_date: str | None,
    end_date: str | None,
    current_only: bool,
) -> str:
    return (
        f"{PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX}"
        f":project:{project_id}"
        f":country:{country}"
        f":start:{start_date or 'none'}"
        f":end:{end_date or 'none'}"
        f":current:{current_only}"
    )


def get_weekly_analysis_cache(
    project_id: int,
    country: str,
    start_date: str | None,
    end_date: str | None,
    current_only: bool,
) -> list[dict] | None:
    key = make_weekly_analysis_cache_key(
        project_id, country, start_date, end_date, current_only
    )
    return cache_get(key)


def set_weekly_analysis_cache(
    project_id: int,
    country: str,
    start_date: str | None,
    end_date: str | None,
    current_only: bool,
    rows: list[dict],
) -> None:
    key = make_weekly_analysis_cache_key(
        project_id, country, start_date, end_date, current_only
    )
    cache_set(key, rows, PRODUCT_ANALYSIS_WEEKLY_TTL)


def invalidate_weekly_analysis_cache() -> int:
    return cache_delete_pattern(f"{PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX}:*")
