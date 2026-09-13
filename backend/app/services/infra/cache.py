"""Generic cache operations and domain-specific caches (shipment, daily analysis, financial series)."""

import base64
import hashlib
import json
import zlib
from typing import Any, cast

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
    params_hash = hashlib.sha256(params_str.encode()).hexdigest()[:16]
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
    params_hash = hashlib.sha256(params_str.encode()).hexdigest()[:16]
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
    params_hash = hashlib.sha256(params_str.encode()).hexdigest()[:16]
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
    params_hash = hashlib.sha256(params_str.encode()).hexdigest()[:16]
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
    params_hash = hashlib.sha256(params_str.encode()).hexdigest()[:16]
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
    params_hash = hashlib.sha256(params_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("sku-summary", params_hash)
    cache_set(key, data, SHIPMENT_SKU_TTL)


def get_shipment_fba_box_details_cache(shipment_nos: list[str]) -> dict | None:
    shipment_nos_str = ",".join(sorted(shipment_nos))
    params_hash = hashlib.sha256(shipment_nos_str.encode()).hexdigest()[:16]
    key = _make_shipment_schedules_cache_key("fba-box-details", params_hash)
    return cache_get(key)


def set_shipment_fba_box_details_cache(shipment_nos: list[str], data: dict) -> None:
    shipment_nos_str = ",".join(sorted(shipment_nos))
    params_hash = hashlib.sha256(shipment_nos_str.encode()).hexdigest()[:16]
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
    deleted = cache_delete_pattern(pattern)
    # BLF-1038：全项目聚合快照跨多项目，无法按 project 前缀收敛，
    # 改为推进全局 data-epoch —— 快照 computed_at < epoch 即视为过期，
    # 下一次读取立即返回旧快照并在后台刷新（stale-while-revalidate）。
    mark_daily_analysis_all_data_changed()
    return deleted


# ── Daily Analysis（全项目聚合）快照缓存（BLF-1038）─────────────────────
# 背景：`/api/v1/daily-analysis/all` 是生产最慢接口（p50 1287ms，每天 142 次
# 慢日志）。前端 4 个 hook 打它，其中 2 个按 5 分钟轮询；而"5 分钟 TTL"与
# 轮询同频 → 纯 TTL 缓存的命中率会在"几乎全命中"与"几乎全 miss"之间抖动。
#
# 因此这里缓存的是**已序列化的响应字节** + 采用 stale-while-revalidate：
# - 新鲜（age <= FRESH）且未被 data-epoch 标记 → 直接返回字节（无 DB、无聚合、
#   无 Pydantic/FastAPI 序列化，命中路径只需 1 次 Redis GET + 解压）；
# - 过期 → 立即返回旧字节，调用方用 BackgroundTasks 异步刷新（请求不等重算）；
# - 无快照 → 单飞：抢到锁的同步计算回填，其余请求短暂等待先到者的回填。
#
# 采用字节而非 dict：命中路径若缓存 dict，每次仍要 json.loads(3.4MB) +
# Pydantic 校验 + FastAPI 序列化，prod 下足以顶穿 300ms 的验收目标。

DAILY_ANALYSIS_ALL_KEY_PREFIX = _p("cache:reports:daily-all")
# 硬 TTL：快照最多存活 1h（期间无访问才自然淘汰，偶发冷启动可接受）。
DAILY_ANALYSIS_ALL_HARD_TTL = 3600
# 软新鲜期：与 L1 档 `daily_analysis` 域 5min TTL、前端 5min 轮询对齐。
DAILY_ANALYSIS_ALL_FRESH_SECONDS = 300
# 单飞锁（冷启动计算 + 后台刷新共用）：锁超时兜底进程崩溃场景。
DAILY_ANALYSIS_ALL_LOCK_TTL = 60
# 冷启动未抢到锁的请求最多等待秒数（等待先到者回填快照）。
DAILY_ANALYSIS_ALL_COLD_WAIT_SECONDS = 15.0
_DAILY_ANALYSIS_ALL_COLD_WAIT_INTERVAL = 0.2
_DAILY_ANALYSIS_ALL_EPOCH_KEY = f"{DAILY_ANALYSIS_ALL_KEY_PREFIX}:data-epoch"
_DAILY_ANALYSIS_ALL_EPOCH_TTL = 24 * 3600
# 快照 blob 头部：`<computed_at 秒>\n<响应字节>`，一个 key 同时承载时间戳与体。
_SNAPSHOT_HEADER_SEP = b"\n"


def make_daily_analysis_all_cache_key(
    *,
    project_ids: list[int],
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
    schema_fingerprint: str,
) -> str:
    """全项目聚合快照的缓存 key（项目 id 顺序无关，含响应 schema 指纹）。

    ``schema_fingerprint`` 进 key 的目的：响应模型一旦变更，旧缓存体形状即失效，
    无需人工 bump 版本号。
    """
    ids = ",".join(str(i) for i in sorted(set(project_ids)))
    raw = f"{ids}|{country}|{start_date}|{end_date}|{sku or ''}|{schema_fingerprint}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return f"{DAILY_ANALYSIS_ALL_KEY_PREFIX}:snapshot:{digest}"


def _cache_get_raw_bytes(key: str) -> bytes | None:
    """读取字节载荷（与 ``cache_set`` 同款 zlib+base64 编码，但直接返回 bytes）。"""
    client = get_redis_client()
    data = cast("str | bytes | None", client.get(key))
    if data is None:
        return None
    text = data.decode("utf-8") if isinstance(data, bytes) else data
    if text.startswith(_COMPRESS_PREFIX):
        try:
            return zlib.decompress(base64.b64decode(text[len(_COMPRESS_PREFIX) :]))
        except (ValueError, zlib.error):
            return None
    return text.encode("utf-8")


def _cache_set_raw_bytes(key: str, raw: bytes, ttl: int) -> None:
    client = get_redis_client()
    payload = _COMPRESS_PREFIX + base64.b64encode(zlib.compress(raw, level=1)).decode(
        "ascii"
    )
    client.setex(key, ttl, payload)


def _encode_daily_analysis_all_snapshot(body: bytes, computed_at: float) -> bytes:
    return f"{computed_at:.3f}".encode("ascii") + _SNAPSHOT_HEADER_SEP + body


def _decode_daily_analysis_all_snapshot(raw: bytes) -> tuple[bytes, float] | None:
    head, sep, body = raw.partition(_SNAPSHOT_HEADER_SEP)
    if not sep:
        return None
    try:
        return body, float(head)
    except ValueError:
        return None


def load_daily_analysis_all_snapshot(key: str) -> tuple[bytes, float] | None:
    """读取快照 → ``(body_bytes, computed_at)``；无快照/体损坏 → None。"""
    raw = _cache_get_raw_bytes(key)
    if raw is None:
        return None
    return _decode_daily_analysis_all_snapshot(raw)


def store_daily_analysis_all_snapshot(
    key: str, body: bytes, *, computed_at: float | None = None
) -> None:
    """写入快照（``computed_at`` 缺省取当前时间）。"""
    import time as _time

    stamp = computed_at if computed_at is not None else _time.time()
    _cache_set_raw_bytes(
        key,
        _encode_daily_analysis_all_snapshot(body, stamp),
        DAILY_ANALYSIS_ALL_HARD_TTL,
    )


def mark_daily_analysis_all_data_changed() -> None:
    """推进全局 data-epoch（任何 daily-analysis 写路径都应调用）。

    只写 1 个 key、1 次 SET；比逐 key 删除更便宜，也避免"删了却没人回填"。
    """
    import time as _time

    cache_set(
        _DAILY_ANALYSIS_ALL_EPOCH_KEY,
        {"at": _time.time()},
        _DAILY_ANALYSIS_ALL_EPOCH_TTL,
    )


def _load_daily_analysis_all_epoch() -> float:
    raw = cache_get(_DAILY_ANALYSIS_ALL_EPOCH_KEY)
    if isinstance(raw, dict):
        value = raw.get("at")
        return float(value) if isinstance(value, (int, float)) else 0.0
    return 0.0


def is_daily_analysis_all_snapshot_fresh(computed_at: float) -> bool:
    """快照是否仍新鲜：未超过软新鲜期，且晚于最后一次数据变更 epoch。"""
    import time as _time

    if _time.time() - computed_at > DAILY_ANALYSIS_ALL_FRESH_SECONDS:
        return False
    return computed_at >= _load_daily_analysis_all_epoch()


def _daily_analysis_all_lock_key(key: str) -> str:
    return f"{key}:lock"


def try_acquire_daily_analysis_all_lock(key: str) -> bool:
    """单飞锁：抢到返回 True（冷启动同步计算 / 后台刷新由本调用方负责）。"""
    client = get_redis_client()
    return bool(
        client.set(
            _daily_analysis_all_lock_key(key),
            "1",
            nx=True,
            ex=DAILY_ANALYSIS_ALL_LOCK_TTL,
        )
    )


def release_daily_analysis_all_lock(key: str) -> None:
    cache_delete(_daily_analysis_all_lock_key(key))


def wait_daily_analysis_all_snapshot(
    key: str, timeout: float = DAILY_ANALYSIS_ALL_COLD_WAIT_SECONDS
) -> tuple[bytes, float] | None:
    """冷启动未抢到锁时，短暂轮询等待先到者回填快照；超时返回 None。"""
    import time as _time

    deadline = _time.monotonic() + timeout
    while _time.monotonic() < deadline:
        _time.sleep(_DAILY_ANALYSIS_ALL_COLD_WAIT_INTERVAL)
        snapshot = load_daily_analysis_all_snapshot(key)
        if snapshot is not None:
            return snapshot
    return None


def load_or_compute_daily_analysis_all_body(
    key: str, compute: "Any"
) -> tuple[bytes, bool]:
    """读快照或计算响应字节 → ``(body, needs_refresh)``。

    - 命中快照：返回 ``(body, 是否需要后台刷新)``；
    - 无快照：单飞——本调用方负责同步计算并回填；未抢到锁的调用方最多等
      ``DAILY_ANALYSIS_ALL_COLD_WAIT_SECONDS`` 秒读别人回填的快照，超时才自己算
      （且不写缓存，避免覆盖先到者）。
    """
    snapshot = load_daily_analysis_all_snapshot(key)
    if snapshot is not None:
        body, computed_at = snapshot
        return body, not is_daily_analysis_all_snapshot_fresh(computed_at)

    if try_acquire_daily_analysis_all_lock(key):
        try:
            body = compute()
            store_daily_analysis_all_snapshot(key, body)
        finally:
            release_daily_analysis_all_lock(key)
        return body, False

    waited = wait_daily_analysis_all_snapshot(key)
    if waited is not None:
        return waited[0], False
    return compute(), False


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
    DAILY_ANALYSIS_ALL_KEY_PREFIX,  # bb:cache:reports:daily-all:*（BLF-1038）
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
