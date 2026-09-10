"""Insight 请求验证纯服务层：固定顺序校验 + 幂等 fingerprint。

顺序：schema/base → role/version/availability → secret/prompt keys → scope →
slot names/requiredness → per-slot Pydantic → limits → model 标识 → fingerprint。

纯函数：不触发 LLM / Redis / Celery / DB 写入；scope 经注入的 authorizer 模拟。
"""

from collections.abc import Callable
from typing import Any

from pydantic import ValidationError

from app.schemas.insight import (
    FORBIDDEN_CLIENT_KEYS,
    SYSTEM_PROMPT_KEYS,
    InsightError,
    InsightErrorCode,
    InsightRunRequest,
    JsonValue,
    make_error,
)
from app.services.insight import limits as L
from app.services.insight.contracts import (
    serialize_contract,
    sha256_hex,
    to_canonical_json,
)
from app.services.insight.roles import RoleLookupError, lookup_role, require_active

#: request 侧递归 JSON 别名（供 limits 遍历的类型提示）
JsonScalar = None | bool | int | float | str

class InsightValidationError(Exception):
    """校验失败：携带 typed error，调用方按 ERROR_HTTP_STATUS 转 HTTP。"""

    def __init__(self, error: InsightError) -> None:
        super().__init__(error.message)
        self.error = error


class ScopeError(Exception):
    """scope authorizer 抛出的权限失败：携带固定错误码。"""

    def __init__(self, code: InsightErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


#: scope 权限入口：(project_id, country) → 无异常即通过；
#: 项目不存在 → PROJECT_NOT_FOUND；无权访问 → PROJECT_OUT_OF_SCOPE；country 不符 → COUNTRY_MISMATCH
ScopeAuthorizer = Callable[[int, str], None]


def _fail(
    code: InsightErrorCode,
    message: str,
    *,
    field: str | None = None,
    slot: str | None = None,
) -> InsightValidationError:
    return InsightValidationError(make_error(code, message, field=field, slot=slot))


def _check_secret_keys(raw: dict[str, Any]) -> None:
    for key in SYSTEM_PROMPT_KEYS:
        if key in raw:
            raise _fail(
                InsightErrorCode.SYSTEM_PROMPT_NOT_ALLOWED,
                "client must not submit system prompt or instructions",
                field=key,
            )
    for key in FORBIDDEN_CLIENT_KEYS:
        if key in raw:
            raise _fail(
                InsightErrorCode.INVALID_REQUEST,
                f"field '{key}' is not allowed in InsightRunRequest",
                field=key,
            )


def _parse_base(raw: dict[str, Any]) -> InsightRunRequest:
    try:
        return InsightRunRequest.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        loc = first.get("loc", ())
        field = ".".join(str(p) for p in loc) or None
        err_type = str(first.get("type", ""))
        msg = str(first.get("msg", "invalid request"))
        if "SYSTEM_PROMPT_NOT_ALLOWED" in str(first.get("ctx", {}).get("error", "")) or (
            field in SYSTEM_PROMPT_KEYS
        ):
            raise _fail(
                InsightErrorCode.SYSTEM_PROMPT_NOT_ALLOWED,
                "client must not submit system prompt or instructions",
                field=field,
            ) from None
        if field == "idempotency_key" or "IDEMPOTENCY_KEY_REQUIRED" in msg:
            raise _fail(
                InsightErrorCode.IDEMPOTENCY_KEY_REQUIRED,
                "idempotency_key is required: ASCII 1-64 chars [A-Za-z0-9._:-]",
                field="idempotency_key",
            ) from None
        if err_type == "extra_forbidden":
            raise _fail(
                InsightErrorCode.INVALID_REQUEST,
                f"unknown field '{field}': extra fields are forbidden",
                field=field,
            ) from None
        raise _fail(InsightErrorCode.INVALID_REQUEST, msg, field=field) from None


def check_json_limits(value: JsonValue, *, what: str, slot: str | None = None) -> None:
    """递归 JSON 上限：字符串/对象/array/深度超限 → SLOT_VALIDATION_FAILED（不截断）。"""

    def _walk(node: JsonValue, depth: int) -> None:
        if depth > L.JSON_MAX_DEPTH:
            raise _fail(
                InsightErrorCode.SLOT_VALIDATION_FAILED,
                f"{what}: nesting depth exceeds {L.JSON_MAX_DEPTH}",
                slot=slot,
            )
        if isinstance(node, str):
            if len(node) > L.STRING_MAX_CHARS:
                raise _fail(
                    InsightErrorCode.SLOT_VALIDATION_FAILED,
                    f"{what}: string exceeds {L.STRING_MAX_CHARS} chars",
                    slot=slot,
                )
        elif isinstance(node, dict):
            if len(node) > L.OBJECT_MAX_KEYS:
                raise _fail(
                    InsightErrorCode.SLOT_VALIDATION_FAILED,
                    f"{what}: object exceeds {L.OBJECT_MAX_KEYS} keys",
                    slot=slot,
                )
            for key, child in node.items():
                if len(key) > L.OBJECT_KEY_MAX_CHARS:
                    raise _fail(
                        InsightErrorCode.SLOT_VALIDATION_FAILED,
                        f"{what}: object key exceeds {L.OBJECT_KEY_MAX_CHARS} chars",
                        slot=slot,
                    )
                _walk(child, depth + 1)
        elif isinstance(node, list):
            if len(node) > L.ARRAY_MAX_ITEMS:
                raise _fail(
                    InsightErrorCode.SLOT_VALIDATION_FAILED,
                    f"{what}: array exceeds {L.ARRAY_MAX_ITEMS} items",
                    slot=slot,
                )
            for child in node:
                _walk(child, depth + 1)

    _walk(value, 0)


def fingerprint_of(request: InsightRunRequest) -> str:
    """幂等 fingerprint：纳入版本/role/scope/slots canonical JSON 与受控标识；排除 key 与 client_request_id。"""
    canonical = to_canonical_json(
        {
            "schema_version": request.schema_version,
            "role_id": request.role_id,
            "role_version": request.role_version,
            "project_id": request.project_id,
            "country": request.country,
            "slots": request.model_dump(mode="json", exclude_none=True)["slots"],
            "endpoint_id": request.endpoint_id,
            "model_id": request.model_id,
        }
    )
    return sha256_hex(canonical.encode("utf-8"))


def resolve_idempotency(stored_fingerprint: str | None, request: InsightRunRequest) -> bool:
    """同 key 下：无记录 → False（新建）；同 fingerprint → True（replayed）；不同 → IDEMPOTENCY_KEY_CONFLICT。"""
    if stored_fingerprint is None:
        return False
    if stored_fingerprint == fingerprint_of(request):
        return True
    raise _fail(
        InsightErrorCode.IDEMPOTENCY_KEY_CONFLICT,
        "idempotency_key was already used with a different request payload",
        field="idempotency_key",
    )


def validate_run_request(
    raw: dict[str, Any],
    scope_authorizer: ScopeAuthorizer,
    *,
    raw_body: bytes | None = None,
    allowed_endpoint_ids: frozenset[str] | None = None,
    allowed_model_ids: frozenset[str] | None = None,
) -> InsightRunRequest:
    """按固定顺序校验创建请求；通过返回解析后的 InsightRunRequest，失败抛 InsightValidationError。"""
    if raw_body is not None and len(raw_body) > L.REQUEST_BODY_MAX_BYTES:
        raise _fail(
            InsightErrorCode.REQUEST_TOO_LARGE,
            f"request body exceeds {L.REQUEST_BODY_MAX_BYTES} bytes",
        )

    _check_secret_keys(raw)
    request = _parse_base(raw)

    try:
        role = require_active(lookup_role(request.role_id, request.role_version))
    except RoleLookupError as exc:
        raise _fail(exc.code, str(exc), field="role_id") from None

    try:
        scope_authorizer(request.project_id, request.country)
    except ScopeError as exc:
        raise _fail(exc.code, str(exc), field="project_id") from None

    for name in request.slots:
        if name not in role.allowed_slots:
            raise _fail(
                InsightErrorCode.UNKNOWN_SLOT,
                f"slot '{name}' is not registered for role '{role.canonical_key}'",
                slot=name,
            )
    for name in role.required_slots:
        if name not in request.slots:
            raise _fail(
                InsightErrorCode.MISSING_REQUIRED_SLOT,
                f"role '{role.canonical_key}' requires slot '{name}'",
                slot=name,
            )

    total_bytes = 0
    for name, payload in request.slots.items():
        adapter = role.adapter_for(name)
        try:
            adapter.validate_python(payload)
        except ValidationError as exc:
            raise _fail(
                InsightErrorCode.SLOT_VALIDATION_FAILED,
                f"slot '{name}' failed validation: {exc.errors()[0].get('msg', 'invalid value')}",
                slot=name,
            ) from None
        check_json_limits(payload, what=f"slot '{name}'", slot=name)
        slot_bytes = len(serialize_contract({"slot": name, "payload": payload}))
        if slot_bytes > L.SLOT_CANONICAL_MAX_BYTES:
            raise _fail(
                InsightErrorCode.SLOT_TOO_LARGE,
                f"slot '{name}' canonical JSON exceeds {L.SLOT_CANONICAL_MAX_BYTES} bytes",
                slot=name,
            )
        total_bytes += slot_bytes
    if total_bytes > L.SLOTS_TOTAL_MAX_BYTES:
        raise _fail(
            InsightErrorCode.SLOT_TOO_LARGE,
            f"all slots canonical JSON exceeds {L.SLOTS_TOTAL_MAX_BYTES} bytes",
        )

    if (
        request.endpoint_id is not None
        and allowed_endpoint_ids is not None
        and request.endpoint_id not in allowed_endpoint_ids
    ):
        raise _fail(
            InsightErrorCode.MODEL_NOT_ALLOWED,
            f"endpoint_id '{request.endpoint_id}' is not in the server allowlist",
            field="endpoint_id",
        )
    if (
        request.model_id is not None
        and allowed_model_ids is not None
        and request.model_id not in allowed_model_ids
    ):
        raise _fail(
            InsightErrorCode.MODEL_NOT_ALLOWED,
            f"model_id '{request.model_id}' is not in the server allowlist",
            field="model_id",
        )
    _check_scope_consistency(request)
    return request


def _check_scope_consistency(request: InsightRunRequest) -> None:
    """slot 内 report.context 须与请求 project/country 一致，否则 SCOPE_MISMATCH。"""
    context = request.slots.get("report.context")
    if not isinstance(context, dict):
        return
    if context.get("country") is not None and context.get("country") != request.country:
        raise _fail(
            InsightErrorCode.SCOPE_MISMATCH,
            "report.context.country does not match request country",
            slot="report.context",
        )
    project_ids = context.get("project_ids")
    if isinstance(project_ids, list) and request.project_id not in project_ids:
        raise _fail(
            InsightErrorCode.SCOPE_MISMATCH,
            "report.context.project_ids does not contain request project_id",
            slot="report.context",
        )
