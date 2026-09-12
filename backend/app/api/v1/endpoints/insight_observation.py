"""Insight 观测期只读端点（Stage 5 / BLF-1018）。

对外暴露观测窗口的质量/成本门禁结论与「退役就绪度」：

- ``GET /insight/observation/gate`` —— 各 capability 桶的聚合指标 + 阈值
  结论 + 并发桶上限；与审计脚本 ``scripts/insight_gate.py`` 打印的是同一份
  结构（``GateReport.as_dict()``），因此人工核对与机器判定不会分叉。
- ``GET /insight/observation/retirement-readiness`` —— 退役三票中可机器判定
  的两票（指标、回滚开关状态）与本仓保留历史只读兼容的事实；调用方清零那
  一票恒为 ``null``，由脚本的 CodeGraph 证据补齐，接口不推断。

权限：**仅管理员**（``X-Is-Admin``）。观测是跨项目的运维口径（单 run 可
跨项目聚合），不按项目投影；若按调用方可见项目过滤会给出被人为裁剪的
「达标」假象，故一律拒绝非管理员，避免越权读取（验收 §2 权限越权场景）。

只读：不提供任何写端点 —— 指标由 run 终态与降级事件自动落库，改不动。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_request_is_admin,
    protected,
)
from app.core.config import get_settings
from app.schemas.insight_observation import (
    ObservationGateResponse,
    RetirementReadiness,
)
from app.services.insight.domain_switch import (
    CANONICAL_DOMAIN_ROLES,
    canonical_domain_roles,
)
from app.services.insight.observation import (
    CANONICAL_CAPABILITIES,
    gate_report,
    is_retirement_eligible,
)
from app.services.insight_concurrency import bucket_caps

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/insight/observation",
    tags=["insight"],
    dependencies=[Depends(protected)],
)


def require_admin(is_admin: bool = Depends(get_request_is_admin)) -> bool:
    """观测端点仅管理员可用（与 ``scheduled_reports.require_admin`` 同语义）。"""
    if not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return True


def _thresholds_payload(settings) -> dict[str, object]:
    return {
        "duration_ms": int(settings.insight_gate_max_duration_ms),
        "first_delta_ms": int(settings.insight_gate_max_first_delta_ms),
        "stream_frames": int(settings.insight_gate_max_stream_frames),
        "fallback_ratio": float(settings.insight_gate_max_fallback_ratio),
        "cost_anomaly_multiplier": float(settings.insight_gate_cost_anomaly_multiplier),
    }


@router.get(
    "/gate",
    response_model=ObservationGateResponse,
    dependencies=[Depends(require_admin)],
    summary="观测窗口质量/成本门禁结论",
)
def get_observation_gate(
    window_days: int | None = Query(default=None, ge=1, le=90),
    capability: str | None = Query(default=None, max_length=64),
    db: Session = Depends(get_primary_db_session),
) -> ObservationGateResponse:
    settings = get_settings()
    report = gate_report(db, settings=settings, window_days=window_days, capability=capability)
    payload = report.as_dict()
    payload["thresholds"] = _thresholds_payload(settings)
    payload["bucket_caps"] = bucket_caps()
    # as_dict 与响应契约同源：模型校验失败即说明审计 JSON 已漂移，直接 500 暴露。
    return ObservationGateResponse.model_validate(payload)


@router.get(
    "/retirement-readiness",
    response_model=RetirementReadiness,
    dependencies=[Depends(require_admin)],
    summary="legacy 写端点退役就绪度（缺失的票显式列出）",
)
def get_retirement_readiness(
    window_days: int | None = Query(default=None, ge=1, le=90),
    db: Session = Depends(get_primary_db_session),
) -> RetirementReadiness:
    settings = get_settings()
    report = gate_report(db, settings=settings, window_days=window_days)
    metrics_ok, reasons = is_retirement_eligible(report)
    enabled_domains = sorted(canonical_domain_roles(settings))
    frozen = sorted(
        role for role in enabled_domains if role in CANONICAL_DOMAIN_ROLES
    )
    return RetirementReadiness(
        metrics_ok=metrics_ok,
        metrics_reasons=reasons,
        canonical_domains=enabled_domains,
        frozen_legacy_domains=frozen,
        rollback_switch="清空 Settings.insight_canonical_domains 即回滚到旧写链路",
        legacy_reads_preserved=True,
        codegraph_verified=None,
        # 第三票（CodeGraph 调用方清零 + 回滚演练）未采集前恒不就绪。
        eligible=False,
        blocking_count=len(report.blocking_findings),
    )


__all__ = ["CANONICAL_CAPABILITIES", "require_admin", "router"]
