"""Data management overview cache (dashboard cache)."""

import json

from app.services.infra.redis import get_redis_client

DATA_MANAGEMENT_OVERVIEW_KEY = "data_management:overview"
DATA_MANAGEMENT_OVERVIEW_TTL = 36000  # 10 hours


def get_data_management_overview_cache() -> dict | None:
    client = get_redis_client()
    data = client.get(DATA_MANAGEMENT_OVERVIEW_KEY)
    if data is None:
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def set_data_management_overview_cache(payload: dict) -> None:
    client = get_redis_client()
    client.setex(
        DATA_MANAGEMENT_OVERVIEW_KEY,
        DATA_MANAGEMENT_OVERVIEW_TTL,
        json.dumps(payload, ensure_ascii=False),
    )


def invalidate_data_management_overview_cache() -> None:
    client = get_redis_client()
    client.delete(DATA_MANAGEMENT_OVERVIEW_KEY)
