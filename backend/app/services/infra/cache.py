"""Generic cache operations and domain-specific caches (shipment, daily analysis, financial series)."""

import hashlib
import json
from typing import Any

from app.services.infra._serialization import json_default
from app.services.infra.data_management import DATA_MANAGEMENT_OVERVIEW_KEY
from app.services.infra.product_cache import PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX
from app.services.infra.redis import get_redis_client

CACHE_KEY_PREFIX = "cache"
CACHE_TTL_LONG = 3600  # 1 hour

SHIPMENT_SCHEDULES_KEY_PREFIX = "shipment-schedules"
SHIPMENT_LIST_TTL = 1800
SHIPMENT_DETAIL_TTL = 600
SHIPMENT_COST_SUMMARY_TTL = 3600
SHIPMENT_SKU_TTL = 1800

DAILY_ANALYSIS_KEY_PREFIX = "cache:reports:daily"
DAILY_ANALYSIS_TTL = 7200

SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX = "cache:shipment:in-transit-qty"
SHIPMENT_IN_TRANSIT_QTY_TTL = 1800  # 30 minutes

MONTHLY_FINANCIAL_SERIES_KEY_PREFIX = "cache:monthly:financial-series"
MONTHLY_FINANCIAL_SERIES_TTL = 3600


# ── Generic cache operations ──────────────────────────────────────────


def _make_cache_key(*parts: str) -> str:
    return ":".join([CACHE_KEY_PREFIX] + [str(p) for p in parts])


def cache_get(key: str) -> dict | list | None:
    client = get_redis_client()
    data = client.get(key)
    if data is None:
        return None
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def cache_set(key: str, value: Any, ttl: int = CACHE_TTL_LONG) -> None:
    client = get_redis_client()
    # 使用共享 json_default 兜底 date / datetime / Decimal / UUID 等非原生 JSON
    # 类型,避免请求路径上抛 TypeError 500(P0-2)。
    client.setex(key, ttl, json.dumps(value, ensure_ascii=False, default=json_default))


def cache_delete(key: str) -> None:
    client = get_redis_client()
    client.delete(key)


def cache_delete_pattern(pattern: str) -> int:
    """使用 SCAN 迭代匹配并删除 key，避免 KEYS 命令的 O(N) 阻塞问题。"""
    client = get_redis_client()
    count = 0
    cursor = 0
    while True:
        cursor, keys = client.scan(cursor, match=pattern, count=1000)
        if keys:
            count += client.delete(*keys)
        if cursor == 0:
            break
    return count


# ── Shipment Schedules cache ──────────────────────────────────────────


def _make_shipment_schedules_cache_key(*parts: str) -> str:
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
    shipment_nos_str = ",".join(sorted(shipment_nos)) if shipment_nos else ""
    params_str = f"{project_id}:{country}:{include_only_history_calc}:{shipment_status}:{shipment_nos_str}:{created_date_from}:{created_date_to}"
    params_hash = hashlib.md5(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("sku-summary", params_hash)
    cache_set(key, data, SHIPMENT_SKU_TTL)


def get_shipment_fba_box_details_cache(shipment_nos: list[str]) -> dict | None:
    shipment_nos_str = ",".join(sorted(shipment_nos))
    params_hash = hashlib.md5(shipment_nos_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("fba-box-details", params_hash)
    return cache_get(key)


def set_shipment_fba_box_details_cache(shipment_nos: list[str], data: dict) -> None:
    shipment_nos_str = ",".join(sorted(shipment_nos))
    params_hash = hashlib.md5(shipment_nos_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("fba-box-details", params_hash)
    cache_set(key, data, SHIPMENT_SKU_TTL)


def get_shipment_schedule_detail_cache(schedule_id: int) -> dict | None:
    key = _make_shipment_schedules_cache_key("detail", str(schedule_id))
    return cache_get(key)


def set_shipment_schedule_detail_cache(schedule_id: int, data: dict) -> None:
    key = _make_shipment_schedules_cache_key("detail", str(schedule_id))
    cache_set(key, data, SHIPMENT_DETAIL_TTL)


def invalidate_shipment_schedule_detail_cache(schedule_id: int) -> None:
    key = _make_shipment_schedules_cache_key("detail", str(schedule_id))
    cache_delete(key)


def invalidate_shipment_schedules_list_cache() -> int:
    pattern = _make_shipment_schedules_cache_key("list", "*")
    return cache_delete_pattern(pattern)


def invalidate_shipment_schedules_cost_summary_cache() -> int:
    pattern = _make_shipment_schedules_cache_key("cost-summary", "*")
    return cache_delete_pattern(pattern)


def invalidate_shipment_sku_summary_cache() -> int:
    pattern = _make_shipment_schedules_cache_key("sku-summary", "*")
    return cache_delete_pattern(pattern)


def invalidate_shipment_fba_box_details_cache() -> int:
    pattern = _make_shipment_schedules_cache_key("fba-box-details", "*")
    return cache_delete_pattern(pattern)


def invalidate_all_shipment_schedules_cache() -> int:
    pattern = _make_shipment_schedules_cache_key("*")
    return cache_delete_pattern(pattern)


# ── In-Transit Quantity cache ─────────────────────────────────────────


def get_shipment_in_transit_qty_cache(
    project_id: int,
    country: str,
) -> dict | None:
    key = f"{SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX}:project:{project_id}:country:{country}"
    return cache_get(key)


def set_shipment_in_transit_qty_cache(
    project_id: int,
    country: str,
    data: dict,
) -> None:
    key = f"{SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX}:project:{project_id}:country:{country}"
    cache_set(key, data, SHIPMENT_IN_TRANSIT_QTY_TTL)


def invalidate_shipment_in_transit_qty_cache(project_id: int) -> int:
    pattern = f"{SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX}:project:{project_id}:*"
    return cache_delete_pattern(pattern)


# ── Daily Analysis cache ──────────────────────────────────────────────


def _make_daily_analysis_cache_key(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
) -> str:
    return f"{DAILY_ANALYSIS_KEY_PREFIX}:project:{project_id}:country:{country}:start:{start_date}:end:{end_date}"


def get_daily_analysis_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
) -> dict | None:
    key = _make_daily_analysis_cache_key(project_id, country, start_date, end_date)
    return cache_get(key)


def set_daily_analysis_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    data: dict,
) -> None:
    key = _make_daily_analysis_cache_key(project_id, country, start_date, end_date)
    cache_set(key, data, DAILY_ANALYSIS_TTL)


def invalidate_daily_analysis_cache(project_id: int) -> int:
    pattern = f"{DAILY_ANALYSIS_KEY_PREFIX}:project:{project_id}:*"
    return cache_delete_pattern(pattern)


# ── Monthly Financial Series cache ────────────────────────────────────


def _make_financial_series_cache_key(
    project_id: int,
    country: str,
    start_month: str | None,
    end_month: str | None,
) -> str:
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
    key = _make_financial_series_cache_key(project_id, country, start_month, end_month)
    return cache_get(key)


def set_financial_series_cache(
    project_id: int,
    country: str,
    start_month: str | None,
    end_month: str | None,
    data: dict,
) -> str:
    key = _make_financial_series_cache_key(project_id, country, start_month, end_month)
    cache_set(key, data, MONTHLY_FINANCIAL_SERIES_TTL)
    return key


def invalidate_financial_series_cache(project_id: int) -> int:
    pattern = f"{MONTHLY_FINANCIAL_SERIES_KEY_PREFIX}:project:{project_id}:*"
    return cache_delete_pattern(pattern)


# ── Clear all caches ──────────────────────────────────────────────────


def clear_all_caches() -> int:
    # DATA_MANAGEMENT_OVERVIEW_KEY 与 PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX
    # 已由 infra/__init__.py 在包加载时导入,这里直接使用即可,无需再 import。
    cache_prefixes = [
        DATA_MANAGEMENT_OVERVIEW_KEY.split(":")[0],
        PRODUCT_ANALYSIS_WEEKLY_KEY_PREFIX.split(":")[0],
        CACHE_KEY_PREFIX,
        SHIPMENT_SCHEDULES_KEY_PREFIX,
        DAILY_ANALYSIS_KEY_PREFIX,
        SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX,
        MONTHLY_FINANCIAL_SERIES_KEY_PREFIX,
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
