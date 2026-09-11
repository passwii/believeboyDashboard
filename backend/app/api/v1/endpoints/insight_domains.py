"""域级 Insight run 端点（BLF-1016）。

canonical ``/insight/runs`` 需要调用方自带完整 slots；广告与库存的 slots
必须由服务端从业务表聚合（客户端既拿不到、也不该拼装）。这两个端点就是
「业务口径 → 域 adapter → canonical run」的入口：

- ``POST /insight/ad-analysis/runs``（``ad_analysis.v1``）
- ``POST /insight/inventory-health/runs``（``inventory_health.v1``）

三条硬约束：

1. **不新建第二条 LLM 链**：端点只调 ``submit_run_for_*``，provider /
   run / SSE / retry / cancel 全在 ``app/services/insight``。
2. **单一写端**：域不在 ``insight_canonical_domains`` 时返回 typed 409
   （旧链路仍在服务），切换后旧 ``/ai-insights`` 写入口冻结——同一时刻
   只有一个写端，绝不双写。
3. **同一错误码表**：scope / 幂等 / provider / 校验失败经
   ``insight_common`` 映射，与 ``/insight/runs`` 完全一致。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_request_is_admin,
    get_request_operator,
    protected,
)
from app.api.v1.endpoints.insight_common import (
    json_object_body,
    scope_authorizer_for,
    submission_error,
    to_run_response,
    validate_body,
)
from app.core.config import get_settings
from app.schemas.insight import InsightRunResponse
from app.schemas.insight_domains import (
    AdAnalysisRunRequest,
    InventoryHealthRunRequest,
)
from app.services.ad.insight_adapter.submit import submit_run_for_ad_analysis
from app.services.insight.domain_switch import domain_switch_error, is_domain_canonical
from app.services.insight.runs import IdempotencyConflict
from app.services.insight.provider import InsightProviderError
from app.services.insight.roles import RoleLookupError
from app.services.insight.validator import InsightValidationError, ScopeError
from app.services.inventory.insight_adapter.submit import (
    submit_run_for_inventory_health,
)

router = APIRouter(
    prefix="/insight", tags=["insight"], dependencies=[Depends(protected)]
)

#: 域提交失败的 canonical 分类集合（与 /insight/runs 同一码表）
_SUBMISSION_ERRORS = (
    InsightValidationError,
    RoleLookupError,
    ScopeError,
    InsightProviderError,
    IdempotencyConflict,
)


def _require_domain_enabled(role_id: str) -> None:
    """域未切换时 canonical 入口不可用（旧链路仍在服务）→ typed 409。"""
    if not is_domain_canonical(get_settings(), role_id):
        raise domain_switch_error(role_id, enabled=False)


@router.post(
    "/ad-analysis/runs",
    response_model=InsightRunResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_ad_analysis_run(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightRunResponse:
    """广告分析：聚合冻结 → ``ad_analysis.v1`` run（幂等：同口径复用 run）。"""
    _require_domain_enabled("ad_analysis")
    body = validate_body(await json_object_body(request), AdAnalysisRunRequest)
    authorizer = scope_authorizer_for(db, operator=operator, is_admin=is_admin)
    try:
        run, replayed = submit_run_for_ad_analysis(
            db,
            project_id=body.project_id,
            country=body.country,
            start_date=body.start_date,
            end_date=body.end_date,
            scope_authorizer=authorizer,
            model_id=body.model_id,
        )
    except _SUBMISSION_ERRORS as exc:
        raise submission_error(exc) from None
    return to_run_response(run, replayed=replayed)


@router.post(
    "/inventory-health/runs",
    response_model=InsightRunResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_inventory_health_run(
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightRunResponse:
    """库存健康：补货分析快照 → ``inventory_health.v1`` run（无旧链路）。"""
    _require_domain_enabled("inventory_health")
    body = validate_body(await json_object_body(request), InventoryHealthRunRequest)
    authorizer = scope_authorizer_for(db, operator=operator, is_admin=is_admin)
    try:
        run, replayed = submit_run_for_inventory_health(
            db,
            project_id=body.project_id,
            country=body.country,
            report_date=body.report_date,
            scope_authorizer=authorizer,
            model_id=body.model_id,
        )
    except _SUBMISSION_ERRORS as exc:
        raise submission_error(exc) from None
    return to_run_response(run, replayed=replayed)
