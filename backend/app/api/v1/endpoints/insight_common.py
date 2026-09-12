"""Shared HTTP helpers for the canonical Insight run surface.

``/insight/runs``（BLF-1012）与各域提交端点（BLF-1016：广告 / 库存）必须
用**同一套** scope 校验、typed error 映射和 run 响应形状，否则同一个
role 在两条入口上会给出不同的分类与 payload。把这些收在本模块，避免
端点之间互相 import（同 ``inventory_ledger_common`` 的处理）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request, status
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.schemas.insight import (
    ERROR_HTTP_STATUS,
    InsightError,
    InsightErrorCode,
    InsightRunResponse,
    InsightStatus,
    make_error,
)
from app.services import project_service
from app.services.insight.provider import InsightProviderError
from app.services.insight.roles import RoleLookupError
from app.services.insight.runs import IdempotencyConflict
from app.services.insight.validator import InsightValidationError, ScopeError


def run_urls(run_id: UUID | str) -> dict[str, str]:
    """Relative product URLs only — no host, no scheme, no key material."""
    rid = str(run_id)
    return {
        "detail_url": f"/api/v1/insight/runs/{rid}",
        "stream_url": f"/api/v1/insight/runs/{rid}/stream",
        "cancel_url": f"/api/v1/insight/runs/{rid}/cancel",
        "retry_url": f"/api/v1/insight/runs/{rid}/retry",
    }


def _as_utc(value: datetime | None) -> datetime:
    """DB naive UTC → aware UTC (same convention as ``runs.to_detail``)."""
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc)
    return value.replace(tzinfo=timezone.utc)


def to_run_response(run: Any, *, replayed: bool = False) -> InsightRunResponse:
    """Run ORM row → 201 响应信封（域端点与 /insight/runs 共用）。"""
    return InsightRunResponse(
        schema_version=1,
        run_id=UUID(run.run_id),
        attempt=run.attempt,
        role_id=run.role_id,
        role_version=run.role_version,
        project_id=run.project_id,
        country=run.country,  # type: ignore[arg-type]
        status=InsightStatus(run.status),  # type: ignore[arg-type]
        output_format="markdown",
        **run_urls(run.run_id),
        replayed=replayed,
        created_at=_as_utc(run.created_at),
        updated_at=_as_utc(run.updated_at),
    )


def typed_error(error: InsightError) -> HTTPException:
    """Typed Insight error → HTTPException with the contract's fixed status."""
    return HTTPException(
        status_code=ERROR_HTTP_STATUS.get(
            error.code, status.HTTP_500_INTERNAL_SERVER_ERROR
        ),
        detail={
            "code": error.code.value,
            "message": error.message,
            "retryable": bool(error.retryable),
        },
    )


def submission_error(exc: Exception) -> HTTPException:
    """``start_run`` 的失败 → typed HTTP（与 /insight/runs 同一码表）。

    分类完全复用 canonical：校验/role/scope/provider/幂等冲突各自映射，
    域端点不新增错误语义，也不吞掉可重试标记。
    """
    if isinstance(exc, InsightValidationError):
        return typed_error(exc.error)
    if isinstance(exc, RoleLookupError):
        return typed_error(make_error(exc.code, str(exc)))
    if isinstance(exc, ScopeError):
        return typed_error(make_error(exc.code, "Request scope rejected"))
    if isinstance(exc, InsightProviderError):
        from app.services.insight.executor import map_provider_error

        return typed_error(map_provider_error(exc))
    if isinstance(exc, IdempotencyConflict):
        return typed_error(
            make_error(
                InsightErrorCode.IDEMPOTENCY_KEY_CONFLICT,
                "Idempotency key already used with a different payload",
            )
        )
    return typed_error(
        make_error(InsightErrorCode.INVALID_REQUEST, "Insight run could not be created")
    )


def scope_authorizer_for(
    db: Session, *, operator: str | None, is_admin: bool
) -> Any:
    """Wrap ``project_service`` into the validator's ScopeAuthorizer callable.

    Project missing → PROJECT_NOT_FOUND; no access → PROJECT_OUT_OF_SCOPE;
    country mismatch → COUNTRY_MISMATCH. ``ensure_project_access`` raising
    HTTPException is translated into the ScopeError the validator expects.
    """

    def authorizer(project_id: int, country: str) -> None:
        try:
            row = project_service.ensure_project_access(
                db, project_id, operator=operator, is_admin=is_admin
            )
        except HTTPException as exc:
            if exc.status_code == 404:
                raise ScopeError(
                    InsightErrorCode.PROJECT_NOT_FOUND, "Project not found"
                ) from None
            raise ScopeError(
                InsightErrorCode.PROJECT_OUT_OF_SCOPE, "Project out of scope"
            ) from None
        if row.country != country:
            raise ScopeError(
                InsightErrorCode.COUNTRY_MISMATCH,
                f"Project country is {row.country}, requested {country}",
            )

    return authorizer


async def json_object_body(request: Request) -> dict[str, Any]:
    """Parse the request body once; JSON errors map to INVALID_REQUEST."""
    try:
        raw = await request.json()
    except Exception:  # noqa: BLE001 — json() raises assorted parser errors
        raise typed_error(
            make_error(InsightErrorCode.INVALID_REQUEST, "Request body must be JSON")
        ) from None
    if not isinstance(raw, dict):
        raise typed_error(
            make_error(
                InsightErrorCode.INVALID_REQUEST,
                "Request body must be a JSON object",
            )
        )
    return raw


def validate_body(raw: dict[str, Any], schema: type[BaseModel]) -> Any:
    """``raw`` → schema 实例；校验失败统一报 typed INVALID_REQUEST（422）。

    域端点不复用 FastAPI 的 ``response_model`` 校验：它返回的 detail 形状
    与 canonical ``InsightError`` 不同，前端得维护两套错误解析。
    """
    try:
        return schema.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        location = ".".join(str(part) for part in first.get("loc", ())) or "body"
        raise typed_error(
            make_error(
                InsightErrorCode.INVALID_REQUEST,
                f"Invalid request field '{location}': {first.get('msg', 'invalid value')}",
            )
        ) from None


__all__ = [
    "json_object_body",
    "run_urls",
    "scope_authorizer_for",
    "submission_error",
    "to_run_response",
    "typed_error",
    "validate_body",
]
