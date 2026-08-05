"""confirm 流 token 存储与装饰器（设计稿 §3）。

危险写操作两步：预览（不落库，HTTP 200 + ok:false + requires_confirmation）
→ 带 X-Confirm-Token 重放（落库）。confirm_token 与请求体 SHA-256 绑定，
防止"预览小改动、确认大改动"。

存储：Redis，key = ``agent:confirm:{token}``；物理 TTL = 2×逻辑 TTL，
以便把"逻辑过期"分类为 CONFIRM_TOKEN_EXPIRED（区别于"从未存在"的 INVALID）。
测试经 ``set_confirm_store`` 注入内存实现。
"""

from __future__ import annotations

import functools
import hashlib
import inspect
import json
import logging
import secrets
import time
from dataclasses import asdict, dataclass
from typing import Any, Callable, Protocol

from fastapi import Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

CONFIRM_KEY_PREFIX = "agent:confirm:"
DEFAULT_CONFIRM_TTL_SECONDS = 300


@dataclass
class ConfirmRecord:
    token: str
    agent_id: str
    action: str
    idempotency_key: str | None
    body_hash: str
    created_at: float  # unix timestamp


class ConfirmStore(Protocol):
    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None: ...

    def get(self, token: str) -> ConfirmRecord | None: ...

    def delete(self, token: str) -> None: ...


class RedisConfirmStore:
    """生产实现：``app/services/infra/redis`` 的全局连接池。"""

    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None:
        from app.services.infra.redis import get_redis_client

        get_redis_client().setex(
            f"{CONFIRM_KEY_PREFIX}{record.token}",
            physical_ttl_seconds,
            json.dumps(asdict(record)),
        )

    def get(self, token: str) -> ConfirmRecord | None:
        from app.services.infra.redis import get_redis_client

        raw = get_redis_client().get(f"{CONFIRM_KEY_PREFIX}{token}")
        if raw is None:
            return None
        try:
            return ConfirmRecord(**json.loads(raw))
        except (json.JSONDecodeError, TypeError, ValueError):
            logger.warning("confirm token payload corrupted: %s", token)
            return None

    def delete(self, token: str) -> None:
        from app.services.infra.redis import get_redis_client

        get_redis_client().delete(f"{CONFIRM_KEY_PREFIX}{token}")


class InMemoryConfirmStore:
    """测试替身：dict + created_at，逻辑过期由 consume 判定。"""

    def __init__(self) -> None:
        self._rows: dict[str, dict[str, Any]] = {}

    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None:
        self._rows[record.token] = {
            "record": record,
            "expires_at": time.time() + physical_ttl_seconds,
        }

    def get(self, token: str) -> ConfirmRecord | None:
        row = self._rows.get(token)
        if row is None or time.time() > row["expires_at"]:
            return None
        return row["record"]

    def delete(self, token: str) -> None:
        self._rows.pop(token, None)


_store: ConfirmStore | None = None


def set_confirm_store(store: ConfirmStore | None) -> None:
    """注入自定义 store；传 None 恢复 Redis 默认。"""
    global _store
    _store = store


def get_confirm_store() -> ConfirmStore:
    global _store
    if _store is None:
        _store = RedisConfirmStore()
    return _store


def compute_body_hash(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def issue_confirm_token(
    *,
    agent_id: str,
    action: str,
    idempotency_key: str | None,
    body: bytes,
    ttl_seconds: int = DEFAULT_CONFIRM_TTL_SECONDS,
) -> tuple[ConfirmRecord, int]:
    token = f"cf_{secrets.token_urlsafe(24)}"
    record = ConfirmRecord(
        token=token,
        agent_id=agent_id,
        action=action,
        idempotency_key=idempotency_key,
        body_hash=compute_body_hash(body),
        created_at=time.time(),
    )
    get_confirm_store().put(record, physical_ttl_seconds=ttl_seconds * 2)
    return record, ttl_seconds


class ConfirmReplayError(Exception):
    """重放校验失败。reason ∈ {"invalid", "expired"}。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def consume_confirm_token(
    *,
    token: str,
    agent_id: str,
    idempotency_key: str | None,
    body: bytes,
    ttl_seconds: int = DEFAULT_CONFIRM_TTL_SECONDS,
) -> ConfirmRecord:
    """校验并消费（用后即删）。不匹配抛 ConfirmReplayError。"""
    store = get_confirm_store()
    record = store.get(token)
    if record is None:
        raise ConfirmReplayError("invalid")
    if time.time() - record.created_at > ttl_seconds:
        raise ConfirmReplayError("expired")
    if (
        record.agent_id != agent_id
        or record.idempotency_key != idempotency_key
        or record.body_hash != compute_body_hash(body)
    ):
        raise ConfirmReplayError("invalid")
    store.delete(token)
    return record


def require_confirmation(
    *,
    action: str,
    build_preview: Callable[[dict], dict] | None = None,
    validate: Callable[[dict], None] | None = None,
):
    """危险写操作两步确认门（设计稿 §3.2）。

    被装饰 handler 必须是 **async** 且签名只接 ``request: Request``
    （请求体经 ``await request.body()`` 读取，FastAPI 会缓存）。

    * 第一次调用（无 X-Confirm-Token）：``validate(body)`` → 签发 token →
      返回 HTTP 200 预览壳（不进 handler）；
    * 第二次调用（带 X-Confirm-Token）：token 校验（body-hash 绑定保证
      请求体一致）→ 执行 handler。
    ``validate`` 抛 ``AgentApiError`` 时在签发 token 之前失败（spec S6）。
    """

    def decorator(handler):
        if not inspect.iscoroutinefunction(handler):
            raise TypeError(
                "require_confirmation requires an async handler "
                f"(got {handler!r})"
            )

        @functools.wraps(handler)
        async def wrapper(request: Request, *args, **kwargs):
            decision = await _confirm_gate(
                request, action=action, build_preview=build_preview, validate=validate
            )
            if decision is not None:
                return decision
            return await handler(request, *args, **kwargs)

        return wrapper

    return decorator


async def _confirm_gate(
    request: Request,
    *,
    action: str,
    build_preview: Callable[[dict], dict] | None,
    validate: Callable[[dict], None] | None,
) -> JSONResponse | None:
    """返回 JSONResponse = 预览壳（短路）；返回 None = 放行 handler。"""
    from app.api.agent.errors import AgentApiError, ErrorCode

    body_bytes = await request.body()
    try:
        body = json.loads(body_bytes) if body_bytes else {}
    except json.JSONDecodeError:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="请求体必须是 JSON 对象"
        )
    if not isinstance(body, dict):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="请求体必须是 JSON 对象"
        )

    agent_id = getattr(request.state, "agent_id", None) or ""
    idempotency_key = request.headers.get("idempotency-key") or None
    confirm_header = (request.headers.get("x-confirm-token") or "").strip()

    if not confirm_header:
        if validate is not None:
            validate(body)  # 业务校验先于 confirm（spec S6）；抛 AgentApiError 直接短路
        record, ttl = issue_confirm_token(
            agent_id=agent_id,
            action=action,
            idempotency_key=idempotency_key,
            body=body_bytes,
            ttl_seconds=DEFAULT_CONFIRM_TTL_SECONDS,
        )
        preview: dict[str, Any] = {"action": action}
        if build_preview is not None:
            preview.update(build_preview(body))
        return JSONResponse(
            status_code=200,
            content={
                "ok": False,
                "requires_confirmation": True,
                "confirm_token": record.token,
                "preview": preview,
                "expires_in_sec": ttl,
                "human_message": "该操作需要用户确认",
                "agent_hint": (
                    "向用户复述上述摘要；用户确认后用同一 Idempotency-Key + "
                    "X-Confirm-Token 与完全相同的请求体重放同一接口"
                ),
            },
        )

    try:
        consume_confirm_token(
            token=confirm_header,
            agent_id=agent_id,
            idempotency_key=idempotency_key,
            body=body_bytes,
        )
    except ConfirmReplayError as exc:
        code = (
            ErrorCode.CONFIRM_TOKEN_EXPIRED
            if exc.reason == "expired"
            else ErrorCode.CONFIRM_TOKEN_INVALID
        )
        raise AgentApiError(code) from None
    return None
