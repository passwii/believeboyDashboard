import json
from datetime import UTC, date, datetime
from typing import Any

import redis

from app.core.config import get_settings

_redis_client: redis.Redis | None = None

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


PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX = "product_analysis:weekly"
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
    client = get_redis_client()
    data = client.get(key)
    if data is None:
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def _json_serializer(obj: Any) -> str:
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


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
    return cache_delete_pattern(f"{PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX}:*")


# ─────────────────────────────────────────
# Presence cache
# ─────────────────────────────────────────

CACHE_KEY_PREFIX = "cache"
CACHE_TTL_LONG = 3600  # 1 hour in seconds


def _make_cache_key(*parts: str) -> str:
    """Build a namespaced cache key, e.g. cache:projects:manage:admin:True:operator:alice"""
    return ":".join([CACHE_KEY_PREFIX] + [str(p) for p in parts])


def cache_get(key: str) -> dict | list | None:
    """Return parsed JSON value or None if missing/expired."""
    client = get_redis_client()
    data = client.get(key)
    if data is None:
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def cache_set(key: str, value: Any, ttl: int = CACHE_TTL_LONG) -> None:
    """Store value as JSON with TTL (defaults to 10 hours)."""
    client = get_redis_client()
    client.setex(key, ttl, json.dumps(value, ensure_ascii=False))


def cache_delete(key: str) -> None:
    """Delete a single cache key."""
    client = get_redis_client()
    client.delete(key)


def cache_delete_pattern(pattern: str) -> int:
    """
    Delete all keys matching a glob pattern.
    Returns number of keys deleted.
    """
    client = get_redis_client()
    keys = client.keys(pattern)
    if not keys:
        return 0
    return client.delete(*keys)


def get_redis_client() -> redis.Redis:
    global _redis_client
    if _redis_client is None:
        settings = get_settings()
        _redis_client = redis.Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
            db=settings.redis_db,
            decode_responses=True,
        )
    return _redis_client


def close_redis_client() -> None:
    global _redis_client
    if _redis_client is not None:
        _redis_client.close()
        _redis_client = None


PRESENCE_KEY_PREFIX = "presence:user:"
PRESENCE_TTL_SECONDS = 120


def _get_presence_key(user_id: str) -> str:
    return f"{PRESENCE_KEY_PREFIX}{user_id}"


def set_user_presence(
    user_id: str,
    display_name: str,
    email: str | None,
    avatar_url: str | None,
    current_path: str,
    current_page_title: str,
) -> None:
    client = get_redis_client()
    data = {
        "user_id": user_id,
        "display_name": display_name,
        "email": email,
        "avatar_url": avatar_url,
        "current_path": current_path,
        "current_page_title": current_page_title,
        "last_seen_at": datetime.now(UTC).isoformat(),
    }
    client.setex(
        _get_presence_key(user_id),
        PRESENCE_TTL_SECONDS,
        json.dumps(data, ensure_ascii=False),
    )


def get_all_presence(stale_after_seconds: int = 90) -> list[dict[str, Any]]:
    client = get_redis_client()
    keys = client.keys(f"{PRESENCE_KEY_PREFIX}*")
    if not keys:
        return []

    now = datetime.now(UTC).timestamp()
    stale_cutoff = now - stale_after_seconds
    results = []

    for key in keys:
        data = client.get(key)
        if data is None:
            continue
        try:
            parsed = json.loads(data)
            last_seen = parsed.get("last_seen_at", "")
            if last_seen:
                ts = datetime.fromisoformat(
                    last_seen.replace("Z", "+00:00")
                ).timestamp()
                if ts >= stale_cutoff:
                    results.append(parsed)
        except (json.JSONDecodeError, ValueError):
            continue

    results.sort(key=lambda x: x.get("last_seen_at", ""), reverse=True)
    return results


# ─────────────────────────────────────────
# Shipment Schedules cache
# ─────────────────────────────────────────

SHIPMENT_SCHEDULES_KEY_PREFIX = "shipment-schedules"
SHIPMENT_LIST_TTL = 1800  # 30 minutes
SHIPMENT_DETAIL_TTL = 600  # 10 minutes
SHIPMENT_COST_SUMMARY_TTL = 3600  # 1 hour
SHIPMENT_SKU_TTL = 1800  # 30 minutes


def _make_shipment_schedules_cache_key(*parts: str) -> str:
    """Build a namespaced cache key for shipment schedules."""
    return ":".join([SHIPMENT_SCHEDULES_KEY_PREFIX] + [str(p) for p in parts])


def get_shipment_schedule_list_cache(
    project_id: int | None,
    country: str | None,
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_nos: list[str] | None,
    created_date_from: str | None,
    created_date_to: str | None,
    etd_from: str | None,
    etd_to: str | None,
    eta_from: str | None,
    eta_to: str | None,
    page: int,
    page_size: int,
    include_total: bool,
) -> dict | None:
    """Get cached shipment schedule list data."""
    import hashlib

    params_str = f"{project_id}:{country}:{shipment_status}:{shipping_method}:{shipment_nos}:{created_date_from}:{created_date_to}:{etd_from}:{etd_to}:{eta_from}:{eta_to}:{page}:{page_size}:{include_total}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("list", params_hash)
    return cache_get(key)


def set_shipment_schedule_list_cache(
    project_id: int | None,
    country: str | None,
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_nos: list[str] | None,
    created_date_from: str | None,
    created_date_to: str | None,
    etd_from: str | None,
    etd_to: str | None,
    eta_from: str | None,
    eta_to: str | None,
    page: int,
    page_size: int,
    include_total: bool,
    data: dict,
) -> None:
    """Cache shipment schedule list data."""
    import hashlib

    params_str = f"{project_id}:{country}:{shipment_status}:{shipping_method}:{shipment_nos}:{created_date_from}:{created_date_to}:{etd_from}:{etd_to}:{eta_from}:{eta_to}:{page}:{page_size}:{include_total}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("list", params_hash)
    cache_set(key, data, SHIPMENT_LIST_TTL)


def get_shipment_schedule_cost_summary_cache(
    project_id: int | None,
    country: str | None,
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_nos: list[str] | None,
    created_date_from: str | None,
    created_date_to: str | None,
) -> dict | None:
    """Get cached shipment schedule cost summary."""
    import hashlib

    params_str = f"{project_id}:{country}:{shipment_status}:{shipping_method}:{shipment_nos}:{created_date_from}:{created_date_to}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("cost-summary", params_hash)
    return cache_get(key)


def set_shipment_schedule_cost_summary_cache(
    project_id: int | None,
    country: str | None,
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_nos: list[str] | None,
    created_date_from: str | None,
    created_date_to: str | None,
    data: dict,
) -> None:
    """Cache shipment schedule cost summary."""
    import hashlib

    params_str = f"{project_id}:{country}:{shipment_status}:{shipping_method}:{shipment_nos}:{created_date_from}:{created_date_to}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("cost-summary", params_hash)
    cache_set(key, data, SHIPMENT_COST_SUMMARY_TTL)


def get_shipment_sku_summary_cache(
    project_id: int | None,
    country: str | None,
    include_only_history_calc: bool,
    shipment_status: str | None,
    shipment_nos: list[str] | None = None,
    created_date_from: str | None = None,
    created_date_to: str | None = None,
) -> list[dict] | None:
    """Get cached shipment SKU summary."""
    import hashlib

    shipment_nos_str = ",".join(sorted(shipment_nos)) if shipment_nos else ""
    params_str = f"{project_id}:{country}:{include_only_history_calc}:{shipment_status}:{shipment_nos_str}:{created_date_from}:{created_date_to}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("sku-summary", params_hash)
    return cache_get(key)


def set_shipment_sku_summary_cache(
    project_id: int | None,
    country: str | None,
    include_only_history_calc: bool,
    shipment_status: str | None,
    data: list[dict],
    shipment_nos: list[str] | None = None,
    created_date_from: str | None = None,
    created_date_to: str | None = None,
) -> None:
    """Cache shipment SKU summary."""
    import hashlib

    shipment_nos_str = ",".join(sorted(shipment_nos)) if shipment_nos else ""
    params_str = f"{project_id}:{country}:{include_only_history_calc}:{shipment_status}:{shipment_nos_str}:{created_date_from}:{created_date_to}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("sku-summary", params_hash)
    cache_set(key, data, SHIPMENT_SKU_TTL)


def get_shipment_fba_box_details_cache(shipment_nos: list[str]) -> dict | None:
    """Get cached FBA box details."""
    import hashlib

    shipment_nos_str = ",".join(sorted(shipment_nos))
    params_hash = hashlib.md5(shipment_nos_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("fba-box-details", params_hash)
    return cache_get(key)


def set_shipment_fba_box_details_cache(shipment_nos: list[str], data: dict) -> None:
    """Cache FBA box details."""
    import hashlib

    shipment_nos_str = ",".join(sorted(shipment_nos))
    params_hash = hashlib.md5(shipment_nos_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("fba-box-details", params_hash)
    cache_set(key, data, SHIPMENT_SKU_TTL)


def get_shipment_schedule_detail_cache(schedule_id: int) -> dict | None:
    """Get cached shipment schedule detail."""
    key = _make_shipment_schedules_cache_key("detail", str(schedule_id))
    return cache_get(key)


def set_shipment_schedule_detail_cache(schedule_id: int, data: dict) -> None:
    """Cache shipment schedule detail."""
    key = _make_shipment_schedules_cache_key("detail", str(schedule_id))
    cache_set(key, data, SHIPMENT_DETAIL_TTL)


def invalidate_shipment_schedule_detail_cache(schedule_id: int) -> None:
    """Invalidate a specific shipment schedule detail cache."""
    key = _make_shipment_schedules_cache_key("detail", str(schedule_id))
    cache_delete(key)


def invalidate_shipment_schedules_list_cache() -> int:
    """Invalidate all shipment schedule list caches."""
    pattern = _make_shipment_schedules_cache_key("list", "*")
    return cache_delete_pattern(pattern)


def invalidate_shipment_schedules_cost_summary_cache() -> int:
    """Invalidate all shipment schedule cost summary caches."""
    pattern = _make_shipment_schedules_cache_key("cost-summary", "*")
    return cache_delete_pattern(pattern)


def invalidate_shipment_sku_summary_cache() -> int:
    """Invalidate all shipment SKU summary caches."""
    pattern = _make_shipment_schedules_cache_key("sku-summary", "*")
    return cache_delete_pattern(pattern)


def invalidate_shipment_fba_box_details_cache() -> int:
    """Invalidate all FBA box details caches."""
    pattern = _make_shipment_schedules_cache_key("fba-box-details", "*")
    return cache_delete_pattern(pattern)


def invalidate_all_shipment_schedules_cache() -> int:
    """Invalidate all shipment schedules related caches."""
    pattern = _make_shipment_schedules_cache_key("*")
    return cache_delete_pattern(pattern)


# ─────────────────────────────────────────
# Daily Analysis cache
# ─────────────────────────────────────────

DAILY_ANALYSIS_KEY_PREFIX = "cache:reports:daily"
DAILY_ANALYSIS_TTL = 7200  # 2 hours


def _make_daily_analysis_cache_key(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
) -> str:
    """Build cache key for daily analysis data."""
    return f"{DAILY_ANALYSIS_KEY_PREFIX}:project:{project_id}:country:{country}:start:{start_date}:end:{end_date}"


def get_daily_analysis_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
) -> dict | None:
    """Get cached daily analysis data."""
    key = _make_daily_analysis_cache_key(project_id, country, start_date, end_date)
    return cache_get(key)


def set_daily_analysis_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    data: dict,
) -> None:
    """Cache daily analysis data."""
    key = _make_daily_analysis_cache_key(project_id, country, start_date, end_date)
    cache_set(key, data, DAILY_ANALYSIS_TTL)


def invalidate_daily_analysis_cache(project_id: int) -> int:
    """Invalidate all daily analysis caches for a project."""
    pattern = f"{DAILY_ANALYSIS_KEY_PREFIX}:project:{project_id}:*"
    return cache_delete_pattern(pattern)


# ─────────────────────────────────────────
# Monthly Financial Series cache
# ─────────────────────────────────────────

MONTHLY_FINANCIAL_SERIES_KEY_PREFIX = "cache:monthly:financial-series"
MONTHLY_FINANCIAL_SERIES_TTL = 3600  # 1 hour (critical: financial data must reflect changes quickly)


def _make_financial_series_cache_key(
    project_id: int,
    country: str,
    start_month: str | None,
    end_month: str | None,
) -> str:
    """Build cache key for monthly financial series data."""
    return (
        f"{MONTHLY_FINANCIAL_SERIES_KEY_PREFIX}:project:{project_id}:country:{country}:"
        f"start:{start_month or 'none'}:end:{end_month or 'none'}"
    )


def get_financial_series_cache(
    project_id: int,
    country: str,
    start_month: str | None,
    end_month: str | None,
) -> dict | None:
    """Get cached monthly financial series data."""
    key = _make_financial_series_cache_key(project_id, country, start_month, end_month)
    return cache_get(key)


def set_financial_series_cache(
    project_id: int,
    country: str,
    start_month: str | None,
    end_month: str | None,
    data: dict,
) -> str:
    """Cache monthly financial series data. Returns the cache key used."""
    key = _make_financial_series_cache_key(project_id, country, start_month, end_month)
    cache_set(key, data, MONTHLY_FINANCIAL_SERIES_TTL)
    return key


def invalidate_financial_series_cache(project_id: int) -> int:
    """Invalidate all financial series caches for a project."""
    pattern = f"{MONTHLY_FINANCIAL_SERIES_KEY_PREFIX}:project:{project_id}:*"
    return cache_delete_pattern(pattern)


def clear_all_caches() -> int:
    """Clear all application caches. Returns total keys deleted."""
    cache_prefixes = [
        DATA_MANAGEMENT_OVERVIEW_KEY.split(":")[0],
        PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX.split(":")[0],
        CACHE_KEY_PREFIX,  # covers daily and financial-series
        SHIPMENT_SCHEDULES_KEY_PREFIX,
        "presence",
    ]

    total_deleted = 0
    for prefix in cache_prefixes:
        if prefix == "cache":
            patterns = ["cache:*", "presence:*"]
        else:
            patterns = [f"{prefix}*"]

        for pattern in patterns:
            total_deleted += cache_delete_pattern(pattern)

    return total_deleted
