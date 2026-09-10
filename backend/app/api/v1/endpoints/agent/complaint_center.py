"""Agent 客诉中心（写侧）域路由（BLF-981）。

对齐 inventory/shipments 模式：project_id 路径参数 + country 查询参数。

* W1 ``POST /batch`` —— 一次事务收全家（run + shop_checks + complaints），
  幂等：同一天 run_date 重复提交走 upsert，不产生重复行；
* R1 ``GET /complaints`` —— Agent 起草前读取最新状态（避免重复处理）。

鉴权：``require_agent_credential`` + ``require_business_scope("complaint_center")``
装配时挂载；写路由挂写限流；写操作落审计（agent_id/idempotency_key 归因）。
"""

from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.deps import get_primary_db_session
from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck
from app.schemas.complaint_center import ComplaintRunBatchRequest
from app.services.audit_log_service import append_operation_audit_log
from app.services.complaint_center_service import (
    IdentityGateError,
    fetch_complaints,
    get_run_by_date,
    upsert_batch,
)

logger = logging.getLogger(__name__)

complaint_center_router = APIRouter(
    prefix="/complaint-center",
    tags=["agent-complaint-center"],
)


@contextmanager
def _service_errors():
    """把 service 层业务异常翻译成 agent 响应壳。

    BLF-1022：IdentityGateError 的 code 即 ErrorCode 名（422 身份码），
    整体 batch 整批拒绝、不落库。
    """
    try:
        yield
    except AgentApiError:
        raise
    except IdentityGateError as exc:
        raise AgentApiError(
            ErrorCode(exc.code),
            human_message=exc.human_message,
            agent_hint=exc.agent_hint,
        ) from None
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(ErrorCode.RESOURCE_NOT_FOUND, human_message=detail) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None
    except Exception as exc:
        logger.exception("complaint_center service error")
        raise AgentApiError(ErrorCode.INTERNAL_ERROR, human_message=str(exc)) from None


def _audit_kwargs(request: Request) -> dict:
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "agent_name": getattr(request.state, "agent_label", None),
        "idempotency_key": request.headers.get("idempotency-key") or None,
        "request": request,
    }


def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符。"""
    key = request.headers.get("idempotency-key")
    if key is not None:
        if not key.strip():
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="Idempotency-Key 不能为空字符串",
            )
        if len(key) > 64:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="Idempotency-Key 长度不能超过 64 字符",
            )


def _check_shops_failed_types(body: dict) -> None:
    """BLF-1022 规则 8：shops_failed 必须是 list[str]，对象直接拒绝。

    注：按现有 agent 响应壳契约，请求体类型错误统一走 400
    VALIDATION_FAILED（身份语义错误才走 422 身份码）。
    """
    shops_failed = body.get("shops_failed", [])
    if not isinstance(shops_failed, list) or any(
        not isinstance(item, str) for item in shops_failed
    ):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="shops_failed 必须是 list[str]",
            agent_hint="remove non-string entries from shops_failed before retry",
        )


def _serialize_run_batch_response(run: ComplaintRun, body: ComplaintRunBatchRequest) -> dict:
    submitted = {
        (c2.project_id, c2.country, c2.buyer_name, c2.first_message_date)
        for c2 in body.complaints
    }
    return {
        "run_id": run.id,
        "run_date": run.run_date.isoformat(),
        "idempotency_key": None,
        "shop_checks": [
            {"shop_check_id": sc.id, "project_id": sc.project_id, "country": sc.country}
            for sc in run.shop_checks
            if (sc.project_id, sc.country) in {(s.project_id, s.country) for s in body.shop_checks}
        ],
        "complaints": [
            {
                "complaint_id": c.id,
                "project_id": c.project_id,
                "country": c.country,
                "buyer_name": c.buyer_name,
                "first_message_date": c.first_message_date.isoformat(),
                "message_date": c.message_date.isoformat(),
            }
            for c in run.complaints
            if (c.project_id, c.country, c.buyer_name, c.first_message_date) in submitted
        ],
    }


# ── W1 POST /batch ───────────────────────────────────────────────


@complaint_center_router.post(
    "/batch",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
async def batch_upsert(request: Request, db: Session = Depends(get_primary_db_session)) -> dict:
    """W1 批量 upsert：一次事务收全家（run + shop_checks + complaints）。

    幂等：同一天 run_date 重复提交 → 更新原 run，不产生重复行。

    BLF-1022 身份门禁与事务一致性（整批拒绝，不落库）：
    * ``shop_checks`` 的 ``(project_id, country)`` 每批次最多一条；
    * ``check_status=ok`` 必须 ``identity_check.verified=true``，
      否则 422 ``IDENTITY_CHECK_REQUIRED``；
    * ``identity_mismatch`` 配 ``verified=true`` → 422
      ``IDENTITY_CHECK_CONTRADICTION``；
    * ``verified=true`` 但 alias/country 重算不匹配 → 422
      ``IDENTITY_CHECK_INVALID``；
    * ``required=true`` 的店铺缺 ``expected_alias`` → 422
      ``IDENTITY_EXPECTED_ALIAS_MISSING``；
    * complaints 只接受同一批次中 ``ok && verified=true`` 的
      ``(project_id, country)``，否则整批 422（``IDENTITY_CHECK_REQUIRED``）；
      ``identity_mismatch``/``login_page``/``launch_fail`` 的店铺不得产生
      complaints；complaint 明细只用 ``project_id + country``。
    """
    _check_idempotency_header(request)
    raw = await request.body()
    body = json.loads(raw) if raw else {}
    if not isinstance(body, dict):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="请求体必须是 JSON 对象"
        )
    _check_shops_failed_types(body)
    try:
        parsed = ComplaintRunBatchRequest.model_validate(body)
    except ValidationError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"请求参数校验失败：{exc}",
        ) from exc
    with _service_errors():
        run = upsert_batch(db, parsed, agent_id=getattr(request.state, "agent_id", None))
        append_operation_audit_log(
            db,
            action="complaint_center.batch_write",
            target_type="complaint_run",
            target_id=run.id,
            operator=None,
            after={"run_date": run.run_date.isoformat(), "shops_checked": run.shops_checked},
            **_audit_kwargs(request),
        )
        db.commit()
    return agent_ok(
        _serialize_run_batch_response(run, parsed),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )


# ── R1 GET /complaints ───────────────────────────────────────────


@complaint_center_router.get("/complaints")
def list_complaints(
    request: Request,
    run_date: str | None = None,
    project_id: int | None = None,
    status_filter: str | None = None,
    category: str | None = None,
    country: str | None = None,
    keyword: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """R1 Agent 起草前读取最新状态（避免重复处理）。"""
    from datetime import date as _date
    parsed_date = None
    if run_date:
        try:
            parsed_date = _date.fromisoformat(run_date)
        except ValueError:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message="run_date 格式非法（期望 YYYY-MM-DD）"
            )
    with _service_errors():
        items, total = fetch_complaints(
            db,
            run_date=parsed_date,
            project_id=project_id,
            status_filter=status_filter,
            category=category,
            country=country,
            keyword=keyword,
            limit=min(limit, 200),
            offset=offset,
        )
    return agent_ok(
        {
            "items": [
                {
                    "id": c.id,
                    "project_id": c.project_id,
                    "country": c.country,
                    "buyer_name": c.buyer_name,
                    "message_date": c.message_date.isoformat(),
                    "subject": c.subject,
                    "category": c.category,
                    "has_order": c.has_order,
                    "status": c.status,
                    "triage": c.triage,
                    "sla": c.sla,
                    "draft_path": c.draft_path,
                    "reply_sent_at": c.reply_sent_at.isoformat() if c.reply_sent_at else None,
                    "handler_note": c.handler_note,
                }
                for c in items
            ],
            "total": total,
        }
    )
