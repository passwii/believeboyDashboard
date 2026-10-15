"""confirm 流 token 存储与装饰器（设计稿 §3）。

危险写操作两步：预览（不落库，HTTP 200 + ok:false + requires_confirmation）
→ 带 X-Confirm-Token 重放（落库）。confirm_token 与请求体 SHA-256 绑定，
防止"预览小改动、确认大改动"。

存储：Redis，key = ``{redis_key_prefix}:agent:confirm:{token}``；物理 TTL = 2×逻辑 TTL，
以便把"逻辑过期"分类为 CONFIRM_TOKEN_EXPIRED（区别于"从未存在"的 INVALID）。
消费走原子 pop（Lua GET+DEL），并发重放只有一个能取到 token。
测试经 ``set_confirm_store`` 注入内存实现。

预览期算定的派生值（如自动生成的货件编号/发货日期）经 ``bind`` 绑定进 confirm
记录，重放时用 ``get_confirm_context`` 取回复用——避免「预览一个、落库另一个」
（跨日重算、候选编号被并发占用后静默换号）。
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
from starlette.datastructures import UploadFile

from app.core.config import get_settings

logger = logging.getLogger(__name__)

CONFIRM_KEY_PREFIX = "agent:confirm:"
DEFAULT_CONFIRM_TTL_SECONDS = 300

#: multipart 上传允许的表单字段（其余字段忽略，避免未声明字段进 preview）
_MULTIPART_SOURCE_FIELD = "source"
_MULTIPART_FILE_FIELD = "file"


def _confirm_key(token: str) -> str:
    """全局前缀 + confirm 前缀（对齐 infra ``_p()`` 惯例，P0 终审 Minor T5-2）。"""
    return f"{get_settings().redis_key_prefix}:{CONFIRM_KEY_PREFIX}{token}"


@dataclass
class ConfirmRecord:
    token: str
    agent_id: str
    action: str
    idempotency_key: str | None
    body_hash: str
    created_at: float  # unix timestamp
    #: 预览期算定、重放期复用的绑定值（JSON 可序列化；旧记录无此字段时缺省 None）
    context: dict[str, Any] | None = None


class ConfirmStore(Protocol):
    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None: ...

    def pop(self, token: str) -> ConfirmRecord | None:
        """原子取出并删除；不存在返回 None。"""
        ...


_POP_LUA = """
local v = redis.call('GET', KEYS[1])
if v then
    redis.call('DEL', KEYS[1])
end
return v
"""


class RedisConfirmStore:
    """生产实现：``app/services/infra/redis`` 的全局连接池。"""

    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None:
        from app.services.infra.redis import get_redis_client

        get_redis_client().setex(
            _confirm_key(record.token),
            physical_ttl_seconds,
            json.dumps(asdict(record)),
        )

    def pop(self, token: str) -> ConfirmRecord | None:
        from app.services.infra.redis import get_redis_client

        raw = get_redis_client().eval(_POP_LUA, 1, _confirm_key(token))
        if raw is None:
            return None
        try:
            return ConfirmRecord(**json.loads(raw))
        except (json.JSONDecodeError, TypeError, ValueError):
            logger.warning("confirm token payload corrupted: %s", token)
            return None


class InMemoryConfirmStore:
    """测试替身：dict + created_at，逻辑过期由 consume 判定。"""

    def __init__(self) -> None:
        self._rows: dict[str, dict[str, Any]] = {}

    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None:
        self._rows[record.token] = {
            "record": record,
            "expires_at": time.time() + physical_ttl_seconds,
        }

    def pop(self, token: str) -> ConfirmRecord | None:
        row = self._rows.pop(token, None)
        if row is None or time.time() > row["expires_at"]:
            return None
        return row["record"]


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


def compute_multipart_fingerprint(
    source: str | None, filename: str, file_bytes: bytes
) -> str:
    """multipart 上传的重放一致性指纹（W4，BLF-628）。

    规范化输入：``source + "\x00" + filename + "\x00" + 文件字节``。
    **不含 multipart boundary**（客户端重放时可换 boundary，内容一致即通过）
    也不含其余表单字段/请求头——内容一致性由指纹绑定，agent 身份与
    Idempotency-Key 由 confirm 记录单独绑定。
    """
    h = hashlib.sha256()
    h.update((source or "").encode("utf-8"))
    h.update(b"\x00")
    h.update(filename.encode("utf-8"))
    h.update(b"\x00")
    h.update(file_bytes)
    return h.hexdigest()


def issue_confirm_token(
    *,
    agent_id: str,
    action: str,
    idempotency_key: str | None,
    body: bytes,
    ttl_seconds: int = DEFAULT_CONFIRM_TTL_SECONDS,
    body_hash: str | None = None,
    context: dict[str, Any] | None = None,
) -> tuple[ConfirmRecord, int]:
    """签发 token；``context`` 为预览期算定的绑定值（须 JSON 可序列化）。"""
    token = f"cf_{secrets.token_urlsafe(24)}"
    record = ConfirmRecord(
        token=token,
        agent_id=agent_id,
        action=action,
        idempotency_key=idempotency_key,
        body_hash=body_hash or compute_body_hash(body),
        created_at=time.time(),
        context=context,
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
    body_hash: str | None = None,
) -> ConfirmRecord:
    """校验并消费（原子 pop，用后即删）。不匹配抛 ConfirmReplayError。

    ``body_hash`` 提供时**优先**用它比对（multipart 上传流：body 为规范化
    指纹而非原始字节，见 ``compute_multipart_fingerprint``）；缺省回退
    ``compute_body_hash(body)``（JSON 流，既有行为）。
    """
    record = get_confirm_store().pop(token)
    if record is None:
        raise ConfirmReplayError("invalid")
    if time.time() - record.created_at > ttl_seconds:
        raise ConfirmReplayError("expired")
    if (
        record.agent_id != agent_id
        or record.idempotency_key != idempotency_key
        or record.body_hash != (body_hash or compute_body_hash(body))
    ):
        raise ConfirmReplayError("invalid")
    return record


def require_confirmation(
    *,
    action: str,
    build_preview: Callable[[dict, Request], dict] | None = None,
    validate: Callable[[dict, Request], None] | None = None,
    bind: Callable[[dict, Request], dict] | None = None,
):
    """危险写操作两步确认门（设计稿 §3.2）。

    被装饰 handler 必须是 **async** 且签名只接 ``request: Request``
    （请求体经 ``await request.body()`` 读取，FastAPI 会缓存）。

    * 第一次调用（无 X-Confirm-Token）：``validate(body, request)`` →
      ``bind(body, request)`` → 签发 token → 返回 HTTP 200 预览壳（不进 handler）；
    * 第二次调用（带 X-Confirm-Token）：token 校验（body-hash 绑定保证
      请求体一致）→ 执行 handler。
    ``validate`` 抛 ``AgentApiError`` 时在签发 token 之前失败（spec S6）。
    ``validate``/``build_preview``/``bind`` 均接收 ``(body, request)``。

    ``bind`` 用于**非确定性派生值**：预览期算一次，返回值（JSON 可序列化 dict）
    随 confirm 记录存储，重放时由 ``get_confirm_context`` 取回复用，因此预览里
    展示的值就是最终落库的值（跨日/并发占用都不会漂移）。
    """

    def decorator(handler):
        if not inspect.iscoroutinefunction(handler):
            raise TypeError(
                f"require_confirmation requires an async handler (got {handler!r})"
            )

        @functools.wraps(handler)
        async def wrapper(request: Request, *args, **kwargs):
            decision = await _confirm_gate(
                request,
                action=action,
                build_preview=build_preview,
                validate=validate,
                bind=bind,
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
    build_preview: Callable[[dict, Request], dict] | None,
    validate: Callable[[dict, Request], None] | None,
    bind: Callable[[dict, Request], dict] | None = None,
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
            validate(
                body, request
            )  # 业务校验先于 confirm（spec S6）；抛 AgentApiError 直接短路
        # 预览期算定的派生值随 token 落库，重放时复用同一份（预览=落库）
        context = bind(body, request) if bind is not None else None
        record, ttl = issue_confirm_token(
            agent_id=agent_id,
            action=action,
            idempotency_key=idempotency_key,
            body=body_bytes,
            ttl_seconds=DEFAULT_CONFIRM_TTL_SECONDS,
            context=context,
        )
        if context is not None:
            request.state.confirm_context = context
        preview: dict[str, Any] = {"action": action}
        if build_preview is not None:
            preview.update(build_preview(body, request))
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
        record = consume_confirm_token(
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
    # 重放期把记录与绑定值挂到 request.state，供 handler 复用（预览=落库）
    request.state.confirm_record = record
    if record.context is not None:
        request.state.confirm_context = record.context
    return None


def get_confirm_context(request: Request) -> dict[str, Any] | None:
    """本次请求的 confirm 绑定上下文（``bind`` 返回值）。

    预览阶段为刚算定的值，重放阶段为确认记录里存的值；非 confirm 流程
    （内部调用 / 无确认门）返回 None——调用方应回退到即时计算。
    """
    context = getattr(request.state, "confirm_context", None)
    return context if isinstance(context, dict) else None


def get_confirm_record(request: Request) -> ConfirmRecord | None:
    """本次请求消费掉的 confirm 记录；预览阶段（未带 token）返回 None。"""
    record = getattr(request.state, "confirm_record", None)
    return record if isinstance(record, ConfirmRecord) else None


async def _parse_multipart_fields(
    request: Request,
) -> tuple[dict[str, Any], str, bytes]:
    """解析 multipart 表单 → (字段 dict, 规范化指纹, 文件字节)。

    字段 dict（供 validate/build_preview/handler 复用）：
    ``{"source": str, "file": {"filename": str, "size": int}}``——
    **不携带文件字节**（JSON 可序列化，避免大文件进 preview 内存）。
    返回的文件字节用于指纹计算；调用方需 ``seek(0)`` 让 handler 可重读。
    """
    form = await request.form()
    fields: dict[str, Any] = {}
    file_bytes = b""
    file_meta: dict[str, Any] = {}
    source: str | None = None
    for key, value in form.items():
        if isinstance(value, UploadFile):
            data = await value.read()
            await value.seek(0)
            file_meta = {
                "filename": value.filename or "",
                "size": len(data),
            }
            file_bytes = data
            fields[_MULTIPART_FILE_FIELD] = file_meta
        elif key == _MULTIPART_SOURCE_FIELD:
            source = str(value) if value is not None else None
            fields[_MULTIPART_SOURCE_FIELD] = source
    fingerprint = compute_multipart_fingerprint(
        source, file_meta.get("filename", ""), file_bytes
    )
    return fields, fingerprint, file_bytes


async def _multipart_confirm_gate(
    request: Request,
    *,
    action: str,
    build_preview: Callable[[dict, Request], dict] | None,
    validate: Callable[[dict, Request], None] | None,
) -> JSONResponse | None:
    """multipart/form-data 两步确认门（W4 上传端点，BLF-628）。

    与 ``_confirm_gate`` 同构，差异：
    * body 不做 JSON 解析（multipart 直接失败是旧行为）；preview 由表单字段
      构建（字段 dict 见 ``_parse_multipart_fields``）；
    * token 绑定的是**规范化指纹**（``compute_multipart_fingerprint``）而非
      原始字节——multipart boundary 每次请求随机，客户端重放可换 boundary，
      只要 source/filename/文件字节一致即通过；
    * 文件字节在预览与重放之间由客户端持有（服务端不暂存），TTL 300s。
    """
    from app.api.agent.errors import AgentApiError, ErrorCode

    fields, fingerprint, _ = await _parse_multipart_fields(request)

    agent_id = getattr(request.state, "agent_id", None) or ""
    idempotency_key = request.headers.get("idempotency-key") or None
    confirm_header = (request.headers.get("x-confirm-token") or "").strip()

    if not confirm_header:
        if validate is not None:
            validate(fields, request)  # 业务校验先于 confirm；抛 AgentApiError 直接短路
        record, ttl = issue_confirm_token(
            agent_id=agent_id,
            action=action,
            idempotency_key=idempotency_key,
            body=b"",
            ttl_seconds=DEFAULT_CONFIRM_TTL_SECONDS,
            body_hash=fingerprint,
        )
        preview: dict[str, Any] = {"action": action}
        if build_preview is not None:
            preview.update(build_preview(fields, request))
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
                    "X-Confirm-Token 重放**内容一致**的 multipart 请求（文件字节/"
                    "source/文件名不变，boundary 可不同）"
                ),
            },
        )

    try:
        consume_confirm_token(
            token=confirm_header,
            agent_id=agent_id,
            idempotency_key=idempotency_key,
            body=b"",
            body_hash=fingerprint,
        )
    except ConfirmReplayError as exc:
        code = (
            ErrorCode.CONFIRM_TOKEN_EXPIRED
            if exc.reason == "expired"
            else ErrorCode.CONFIRM_TOKEN_INVALID
        )
        raise AgentApiError(code) from None
    return None


def require_multipart_confirmation(
    *,
    action: str,
    build_preview: Callable[[dict, Request], dict] | None = None,
    validate: Callable[[dict, Request], None] | None = None,
):
    """危险写操作两步确认门——multipart/form-data 变体（W4 上传，BLF-628）。

    与 ``require_confirmation`` 同构：第一次调用（无 X-Confirm-Token）→
    ``validate(fields, request)`` → 签发 token → 返回 HTTP 200 预览壳；
    第二次调用（带 X-Confirm-Token）→ 指纹校验 → 执行 handler。

    ``fields`` 为表单字段 dict（``{"source": str, "file": {"filename", "size"}}``），
    不含文件字节——validate/preview 只依赖元数据，字节由 handler 重读
    （``request.form()`` 被 starlette 缓存，gate 已 ``seek(0)`` 回卷）。
    """

    def decorator(handler):
        if not inspect.iscoroutinefunction(handler):
            raise TypeError(
                "require_multipart_confirmation requires an async handler "
                f"(got {handler!r})"
            )

        @functools.wraps(handler)
        async def wrapper(request: Request, *args, **kwargs):
            decision = await _multipart_confirm_gate(
                request, action=action, build_preview=build_preview, validate=validate
            )
            if decision is not None:
                return decision
            return await handler(request, *args, **kwargs)

        return wrapper

    return decorator
