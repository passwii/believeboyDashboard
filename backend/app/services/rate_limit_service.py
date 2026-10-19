"""
Rate limiting for auth endpoints using Redis as backend.

Redis is preferred; falls back to in-memory if Redis is unavailable.
Redis counters survive server restarts via Redis persistence.
"""

from __future__ import annotations

import logging
import threading
import time
from uuid import uuid4

logger = logging.getLogger(__name__)

# 登录限流的两个窗口口径（原本定义在 auth.py，移到服务层是为了让「清桶」
# 的调用方（重置密码 / 删除 / 新建用户）不必反向 import 路由模块）。
LOGIN_IP_RATE_MAX = 10
LOGIN_IP_RATE_WINDOW = 15 * 60
LOGIN_EMAIL_FAILED_MAX = 5
LOGIN_EMAIL_FAILED_WINDOW = 30 * 60


def _rate_limit_key(limit_type: str, identifier: str) -> str:
    from app.core.config import get_settings

    prefix = get_settings().redis_key_prefix
    return f"{prefix}:ratelimit:{limit_type}:{identifier}"


def _redis_client():
    from app.services.infra import get_redis_client

    try:
        return get_redis_client()
    except Exception:
        return None


def increment_and_check(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[int, int]:
    """计入一次尝试" 并返回 ``(attempts, retry_after_seconds)``。

    返回体里的 ``retry_after_seconds`` 为 0 表示未超限。

    **BLF-1381 起登录路径不再用本函数**：它把「检查」与「记账」绑在一起，
    于是被拒绝的请求也会续写窗口（重试自己把锁往后推）、成功登录同样吃额度。
    登录需要的是 ``peek_limit``（只读判定）+ 仅在**失败**时 ``record_attempt``。
    本函数保留给「每次访问都该计费」的粗粒度场景。
    """
    client = _redis_client()
    if client is None:
        return _in_memory_check(limit_type, identifier, max_requests, window_seconds)

    key = _rate_limit_key(limit_type, identifier)
    try:
        pipe = client.pipeline()
        now = time.time()
        window_start = now - window_seconds

        pipe.zremrangebyscore(key, 0, window_start)
        pipe.zadd(key, {str(now): now})
        pipe.zcard(key)
        pipe.expire(key, window_seconds + 10)
        results = pipe.execute()
        count = results[2]

        if count > max_requests:
            oldest = client.zrange(key, 0, 0, withscores=True)
            retry_after = (
                int(oldest[0][1] + window_seconds - now) if oldest else window_seconds
            )
            return count, max(retry_after, 1)

        return count, 0
    except Exception:
        logger.warning("Redis rate limit unavailable, falling back to in-memory")
        return _in_memory_check(limit_type, identifier, max_requests, window_seconds)


def peek_limit(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[int, int]:
    """**只读**判定当前窗口用量，返回 ``(count, retry_after_seconds)``。

    与 ``increment_and_check`` 的区别是不写入任何东西：被挡的请求不能反过
    来续命窗口，否则客户端越重试锁得越久（BLF-1381 的「重置密码后一直登不
    进去」里就有一半是这条）。

    ``retry_after_seconds`` > 0 表示已超限，调用方应直接 429。
    """
    client = _redis_client()
    if client is None:
        return _in_memory_peek(limit_type, identifier, max_requests, window_seconds)

    key = _rate_limit_key(limit_type, identifier)
    try:
        now = time.time()
        client.zremrangebyscore(key, 0, now - window_seconds)
        count = int(client.zcard(key))
        if count < max_requests:
            return count, 0
        oldest = client.zrange(key, 0, 0, withscores=True)
        retry_after = (
            int(oldest[0][1] + window_seconds - now) if oldest else window_seconds
        )
        return count, max(retry_after, 1)
    except Exception:
        logger.warning("Redis rate limit unavailable, falling back to in-memory")
        return _in_memory_peek(limit_type, identifier, max_requests, window_seconds)


def record_attempt(limit_type: str, identifier: str, window_seconds: int) -> None:
    """记一次**失败**尝试（成功登录不记账，见 BLF-1381）。

    失败是通往攻击的唯一路径，所以只给失败记账既不削弱防爆破，又不会让正常用
    户被自己的成功登录吃光额度。

    登录路径**不要**用本函数：先校验密码、发现错了才记账，等于把「这个窗口还
    能不能试」的判断推迟到攻击者已经拿到答案之后 —— 并发批次可以绕过上限。
    登录改用 ``reserve_attempt`` + ``release_attempt``（先原子预占，成功再回滚）。
    """
    client = _redis_client()
    if client is None:
        _in_memory_record(limit_type, identifier, window_seconds)
        return

    key = _rate_limit_key(limit_type, identifier)
    try:
        pipe = client.pipeline()
        now = time.time()
        pipe.zremrangebyscore(key, 0, now - window_seconds)
        # member 用唯一 id 而不是时间戳：同一微秒内的两次记账不能互相覆盖，
        # 否则并发失败会被少算（member 相同的 zadd 是覆盖而非新增）。
        pipe.zadd(key, {f"r:{uuid4().hex}": now})
        pipe.expire(key, window_seconds + 10)
        pipe.execute()
    except Exception:
        logger.warning("Redis rate limit unavailable, falling back to in-memory")
        _in_memory_record(limit_type, identifier, window_seconds)


def reserve_attempt(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[bool, int, str | None]:
    """**原子**预占一次尝试额度，返回 ``(allowed, retry_after_seconds, token)``。

    BLF-1381 的登录路径用它替代「先 peek 再判密码」。原因：``peek_limit`` +
    「失败才 ``record_attempt``」的写法在**并发**下会漏 —— 同一邮箱/同一 IP
    的一批请求可以全部看到「桶没满」，全部走完密码校验，最后才一起记账；攻击
    者因此能在任何计数生效前并行提交任意多组密码。预占把「检查 + 记账」压在
    一个原子操作里（Redis pipeline / 内存锁），并发批次到第 ``max_requests + 1``
    个就被挡住了。

    与旧 ``increment_and_check`` 的区别是**可以回滚**：``token`` 交给
    ``release_attempt`` 就能把这次预占退回去，所以成功登录依旧零消耗、被挡的
    请求也不会反向续命窗口。

    ``allowed=False`` 时本次预占已经撤回，调用方无需再 release。
    """
    client = _redis_client()
    if client is None:
        return _in_memory_reserve(limit_type, identifier, max_requests, window_seconds)

    key = _rate_limit_key(limit_type, identifier)
    member = f"r:{uuid4().hex}"
    try:
        now = time.time()
        pipe = client.pipeline()
        pipe.zremrangebyscore(key, 0, now - window_seconds)
        pipe.zadd(key, {member: now})
        pipe.zcard(key)
        pipe.expire(key, window_seconds + 10)
        results = pipe.execute()
        count = int(results[2])

        if count > max_requests:
            # 超限的这次不算数：撤回预占，别让重试把窗口往后推。
            client.zrem(key, member)
            return False, _redis_retry_after(client, key, window_seconds, now), None

        return True, 0, member
    except Exception:
        logger.warning("Redis rate limit unavailable, falling back to in-memory")
        return _in_memory_reserve(limit_type, identifier, max_requests, window_seconds)


def release_attempt(
    limit_type: str,
    identifier: str,
    token: str | None,
    window_seconds: int,
) -> None:
    """回滚一次 ``reserve_attempt`` 的预占（登录成功 / 该次尝试不构成失败）。

    ``token`` 自带来源前缀（``r:`` = Redis，``m:`` = 内存兜底），因为预占与回滚
    之间 Redis 可能恰好不可用 —— 不能拿当前状态去猜该清哪一套。
    """
    if not token:
        return

    if token.startswith("m:"):
        _in_memory_release(limit_type, identifier, window_seconds)
        return

    client = _redis_client()
    if client is None:
        _in_memory_release(limit_type, identifier, window_seconds)
        return

    key = _rate_limit_key(limit_type, identifier)
    try:
        client.zrem(key, token)
    except Exception:
        logger.warning(
            "redis release_attempt failed limit_type=%s identifier=%s",
            limit_type,
            identifier,
        )
        _in_memory_release(limit_type, identifier, window_seconds)


def _redis_retry_after(client, key: str, window_seconds: int, now: float) -> int:
    """桶里最早一条记录过期还要多久（Redis 不可用时回落到整个窗口）。"""
    try:
        oldest = client.zrange(key, 0, 0, withscores=True)
        if not oldest:
            return window_seconds
        return max(int(oldest[0][1] + window_seconds - now), 1)
    except Exception:
        return window_seconds


# ─── In-memory fallback ───────────────────────────────────────────────────────

_IN_MEMORY: dict[str, tuple[int, float]] = {}
_MEMORY_LOCK = threading.Lock()
_IN_MEMORY_OP_COUNT = 0
_IN_MEMORY_CLEANUP_INTERVAL = 1000  # 每 1000 次操作后清理一次过期条目


def _clean_expired_in_memory_entries(now: float) -> None:
    """清理已超过 24 小时的内存限流条目，防止字典无限增长。"""
    expired_keys = [
        key for key, (_, timestamp) in _IN_MEMORY.items() if now - timestamp > 86400
    ]
    for key in expired_keys:
        del _IN_MEMORY[key]


def _in_memory_check(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[int, int]:
    key = f"{limit_type}:{identifier}"
    now = time.time()

    # 周期性清理过期条目，防止内存无限增长
    global _IN_MEMORY_OP_COUNT
    with _MEMORY_LOCK:
        _IN_MEMORY_OP_COUNT += 1
        if _IN_MEMORY_OP_COUNT >= _IN_MEMORY_CLEANUP_INTERVAL:
            _IN_MEMORY_OP_COUNT = 0
            _clean_expired_in_memory_entries(now)

        entry = _IN_MEMORY.get(key)
        if entry is None or (now - entry[1]) > window_seconds:
            _IN_MEMORY[key] = (1, now)
            return 1, 0
        count, start = entry
        if count >= max_requests:
            elapsed = now - start
            return count, int(window_seconds - elapsed)
        _IN_MEMORY[key] = (count + 1, start)
        return count + 1, 0


def _in_memory_peek(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[int, int]:
    """内存兜底版的**只读**判定（对齐 ``peek_limit``，不写条目）。"""
    key = f"{limit_type}:{identifier}"
    now = time.time()
    with _MEMORY_LOCK:
        entry = _IN_MEMORY.get(key)
        if entry is None or (now - entry[1]) > window_seconds:
            return 0, 0
        count, start = entry
        if count < max_requests:
            return count, 0
        return count, max(int(window_seconds - (now - start)), 1)


def _in_memory_reserve(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[bool, int, str | None]:
    """内存兜底版的原子预占（持 ``_MEMORY_LOCK``，对齐 ``reserve_attempt``）。"""
    key = f"{limit_type}:{identifier}"
    now = time.time()

    global _IN_MEMORY_OP_COUNT
    with _MEMORY_LOCK:
        _IN_MEMORY_OP_COUNT += 1
        if _IN_MEMORY_OP_COUNT >= _IN_MEMORY_CLEANUP_INTERVAL:
            _IN_MEMORY_OP_COUNT = 0
            _clean_expired_in_memory_entries(now)

        entry = _IN_MEMORY.get(key)
        if entry is None or (now - entry[1]) > window_seconds:
            _IN_MEMORY[key] = (1, now)
            return True, 0, "m:1"

        count, start = entry
        if count >= max_requests:
            return False, max(int(window_seconds - (now - start)), 1), None

        _IN_MEMORY[key] = (count + 1, start)
        return True, 0, "m:1"


def _in_memory_release(limit_type: str, identifier: str, window_seconds: int) -> None:
    """内存兜底版回滚一次预占（固定窗口只能整体减计数）。"""
    key = f"{limit_type}:{identifier}"
    now = time.time()
    with _MEMORY_LOCK:
        entry = _IN_MEMORY.get(key)
        if entry is None:
            return
        count, start = entry
        if (now - start) > window_seconds or count <= 1:
            _IN_MEMORY.pop(key, None)
            return
        _IN_MEMORY[key] = (count - 1, start)


def _in_memory_record(limit_type: str, identifier: str, window_seconds: int) -> None:
    """内存兜底版记一次失败尝试（固定窗口：窗口从首次失败起算）。"""
    key = f"{limit_type}:{identifier}"
    now = time.time()

    # 周期性清理过期条目，防止内存无限增长
    global _IN_MEMORY_OP_COUNT
    with _MEMORY_LOCK:
        _IN_MEMORY_OP_COUNT += 1
        if _IN_MEMORY_OP_COUNT >= _IN_MEMORY_CLEANUP_INTERVAL:
            _IN_MEMORY_OP_COUNT = 0
            _clean_expired_in_memory_entries(now)

        entry = _IN_MEMORY.get(key)
        if entry is None or (now - entry[1]) > window_seconds:
            _IN_MEMORY[key] = (1, now)
        else:
            count, start = entry
            _IN_MEMORY[key] = (count + 1, start)


def clear_login_failures(email: str | None) -> None:
    """清掉该邮箱的登录失败桶（BLF-1381）。

    管理员重置密码 / 删除账号 / 新建账号时调用：这三种动作都会让「过去那段
    密码错」失去意义，继续计费只会把手里拿着正确新密码的人挡在 429 外面。
    按**邮箱**而不是 user_id 清 —— 删除后重建拿到的是新 id，旧残留会连坐新账号。
    """
    if not email:
        return
    clear_key("login_email_fail", email.strip().lower())


def clear_key(limit_type: str, identifier: str) -> None:
    """清掉一个限流桶（Redis 与内存兜底**两套都清**）。

    BLF-1381：只清 Redis 是不够的 —— Redis 抖动期间桶落在内存兜底里，随后
    ``clear_key`` 空转，重置密码 / 删除重建后的用户要干等一整个窗口（30 分钟）
    才能重新登录，现场表现就是「重置了也没用」。
    """
    with _MEMORY_LOCK:
        _IN_MEMORY.pop(f"{limit_type}:{identifier}", None)

    client = _redis_client()
    if client is not None:
        try:
            key = _rate_limit_key(limit_type, identifier)
            client.delete(key)
        except Exception:
            # 内存桶已经清过了，Redis 这次失败不能把调用方（登录 / 重置密码）带疃。
            logger.warning(
                "redis clear_key failed limit_type=%s identifier=%s",
                limit_type,
                identifier,
            )
