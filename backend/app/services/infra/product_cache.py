"""Product analysis cache (weekly analysis cache)."""

import json
from datetime import UTC, date, datetime
from typing import Any

from app.services.infra.redis import get_redis_client

PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX = "product_analysis:weekly"
PRODUCT_ANALYSIS_WEEKLY_TTL = 14400  # 4 hours


def _json_serializer(obj: Any) -> str:
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


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
    client = get_redis_client()
    data = client.get(key)
    if data is None:
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


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
    client = get_redis_client()
    client.setex(
        key,
        PRODUCT_ANALYSIS_WEEKLY_TTL,
        json.dumps(rows, ensure_ascii=False, default=_json_serializer),
    )


def invalidate_weekly_analysis_cache() -> int:
    from app.services.infra.cache import cache_delete_pattern

    return cache_delete_pattern(f"{PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX}:*")
