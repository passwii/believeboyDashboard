"""Generic cache operations and domain-specific caches (shipment, daily analysis, financial series)."""

import hashlib
import json
from typing import Any

from app.services.infra._serialization import json_default
from app.services.infra.redis import _p, get_redis_client

CACHE_KEY_PREFIX = _p("cache")
CACHE_TTL_LONG = 3600  # 1 hour

SHIPMENT_SCHEDULES_KEY_PREFIX = _p("shipment-schedules")
SHIPMENT_LIST_TTL = 1800
SHIPMENT_DETAIL_TTL = 600
SHIPMENT_COST_SUMMARY_TTL = 3600
SHIPMENT_SKU_TTL = 1800

DAILY_ANALYSIS_KEY_PREFIX = _p("cache:reports:daily")
# BLF-668: 统一 L1 档 5min（原 2min），短 TTL + 主动 invalidate
DAILY_ANALYSIS_TTL = 300  # 5 minutes

SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX = _p("cache:shipment:in-transit-qty")
SHIPMENT_IN_TRANSIT_QTY_TTL = 1800  # 30 minutes

MONTHLY_FINANCIAL_SERIES_KEY_PREFIX = _p("cache:monthly:financial-series")
# BLF-668: 统一 L1 档 5min（原 1h），短 TTL + 主动 invalidate
MONTHLY_FINANCIAL_SERIES_TTL = 300


# ── Generic cache operations ──────────────────────────────────────────

# 压缩阈值：JSON 序列化后超过此字节数才压缩（小 payload 压缩反而浪费 CPU）
_COMPRESS_THRESHOLD = 1024  # 1 KB
_COMPRESS_PREFIX = "z:"  # 标记已压缩的 value


def _make_cache_key(*parts: str) -> str:
    return ":".join([CACHE_KEY_PREFIX] + [str(p) for p in parts])


def cache_get(key: str) -> dict | list | None:
    client = get_redis_client()
    data = client.get(key)
    if data is None:
        return None
    try:
        # 检查压缩标记
        if isinstance(data, str) and data.startswith(_COMPRESS_PREFIX):
            import base64
            import zlib

            raw = base64.b64decode(data[len(_COMPRESS_PREFIX) :])
            data = zlib.decompress(raw).decode("utf-8")
        return json.loads(data)
    except (json.JSONDecodeError, Exception):
        return None


def cache_set(key: str, value: Any, ttl: int = CACHE_TTL_LONG) -> None:
    client = get_redis_client()
    # 使用共享 json_default 兜底 date / datetime / Decimal / UUID 等非原生 JSON
    # 类型,避免请求路径上抛 TypeError 500(P0-2)。
    payload = json.dumps(value, ensure_ascii=False, default=json_default)
    # 大 payload 压缩存储（zlib + base64），省 60-80% Redis 内存
    if len(payload.encode("utf-8")) > _COMPRESS_THRESHOLD:
        import base64
        import zlib

        compressed = zlib.compress(payload.encode("utf-8"), level=1)
        payload = _COMPRESS_PREFIX + base64.b64encode(compressed).decode("ascii")
    client.setex(key, ttl, payload)


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

# 所有已知的 Redis key 前缀（含其他模块的），用于 clear_all_caches。
# 新增缓存域时在此追加前缀即可。
_ALL_KEY_PREFIXES = [
    CACHE_KEY_PREFIX,  # bb:cache:*
    SHIPMENT_SCHEDULES_KEY_PREFIX,  # bb:shipment-schedules:*
    DAILY_ANALYSIS_KEY_PREFIX,  # bb:cache:reports:daily:*
    SHIPMENT_IN_TRANSIT_QTY_KEY_PREFIX,  # bb:cache:shipment:in-transit-qty:*
    MONTHLY_FINANCIAL_SERIES_KEY_PREFIX,  # bb:cache:monthly:financial-series:*
    _p("data_management"),  # bb:data_management:*
    _p("product_analysis"),  # bb:product_analysis:*
    _p("presence"),  # bb:presence:*
    _p("session"),  # bb:session:*
    _p("ratelimit"),  # bb:ratelimit:*
    _p("semaphore"),  # bb:semaphore:*
    _p("office"),  # bb:office:*
]


def clear_all_caches() -> int:
    """清除所有已知前缀的 Redis key。"""
    total_deleted = 0
    for prefix in _ALL_KEY_PREFIXES:
        total_deleted += cache_delete_pattern(f"{prefix}:*")
        # 兼容无冒号分隔的旧 key（如 "cache" 前缀下的 "cache:xxx" 已含冒号）
        if ":" not in prefix:
            total_deleted += cache_delete_pattern(f"{prefix}*")
    return total_deleted


# ── Stampede protection ─────────────────────────────────────────────


def cache_get_or_set(
    key: str,
    compute_fn: Any,
    ttl: int = CACHE_TTL_LONG,
    lock_timeout: int = 10,
    lock_wait: float = 0.1,
    max_wait: float = 5.0,
) -> dict | list | None:
    """带 stampede 保护的缓存读取。

    缓存命中直接返回；miss 时用 ``SET NX`` 抢互斥锁，只有一个调用方
    执行 ``compute_fn()`` 并回填缓存，其余调用方短暂等待后重读缓存。

    Args:
        key: 缓存 key。
        compute_fn: 无参可调用对象，返回要缓存的值（dict / list）。
        ttl: 缓存 TTL（秒）。
        lock_timeout: 互斥锁自动过期（秒），防 compute_fn 卡死。
        lock_wait: 未抢到锁时的轮询间隔（秒）。
        max_wait: 未抢到锁时的最大等待（秒），超时后 fallback 直接计算。
    """
    import time as _time

    # 快路径：缓存命中
    cached = cache_get(key)
    if cached is not None:
        return cached

    client = get_redis_client()
    lock_key = f"{key}:lock"

    # 尝试抢锁
    acquired = client.set(lock_key, "1", nx=True, ex=lock_timeout)
    if acquired:
        try:
            value = compute_fn()
            cache_set(key, value, ttl)
            return value
        finally:
            client.delete(lock_key)
    else:
        # 未抢到锁：等待其他调用方回填
        deadline = _time.monotonic() + max_wait
        while _time.monotonic() < deadline:
            _time.sleep(lock_wait)
            cached = cache_get(key)
            if cached is not None:
                return cached
        # 超时 fallback：直接计算（不回填，避免覆盖正在写入的值）
        return compute_fn()
