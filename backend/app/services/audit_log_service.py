from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.operation_audit_log import OperationAuditLog

_SENSITIVE_KEYS = {
    'password',
    'password_hash',
    'token',
    'access_token',
    'refresh_token',
    'authorization',
    'cookie',
    'set-cookie',
    'secret',
    'api_key',
    'x-api-key',
}


def _clip(value: str | None, max_len: int) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return normalized[:max_len]


def _json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.isoformat(timespec='seconds')
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for key, child in value.items():
            key_text = str(key)
            if key_text.lower() in _SENSITIVE_KEYS:
                output[key_text] = '***'
            else:
                output[key_text] = _json_safe(child)
        return output
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _extract_request_meta(request: Request | None) -> tuple[str | None, str | None, str | None, str | None]:
    if request is None:
        return None, None, None, None

    forwarded_for = request.headers.get('x-forwarded-for')
    if forwarded_for:
        ip_address = forwarded_for.split(',')[0].strip()
    else:
        ip_address = request.client.host if request.client else None

    return (
        _clip(str(getattr(request.state, 'request_id', '') or ''), 64),
        _clip(request.method, 16),
        _clip(request.url.path, 255),
        _clip(ip_address, 64),
    )


def append_operation_audit_log(
    db: Session,
    *,
    action: str,
    target_type: str,
    target_id: str | int | None = None,
    operator: str | None = None,
    result: str = 'success',
    before: dict[str, Any] | list[Any] | None = None,
    after: dict[str, Any] | list[Any] | None = None,
    error_message: str | None = None,
    request: Request | None = None,
) -> None:
    trace_id, request_method, request_path, ip_address = _extract_request_meta(request)
    db.add(
        OperationAuditLog(
            operator=_clip(operator, 255),
            action=_clip(action, 128) or 'unknown',
            target_type=_clip(target_type, 64) or 'unknown',
            target_id=_clip(str(target_id), 128) if target_id is not None else None,
            result='success' if result != 'failure' else 'failure',
            trace_id=trace_id,
            request_method=request_method,
            request_path=request_path,
            ip_address=ip_address,
            user_agent=_clip(request.headers.get('user-agent') if request else None, 512),
            before_json=_json_safe(before),
            after_json=_json_safe(after),
            error_message=_clip(error_message, 4000),
        )
    )
