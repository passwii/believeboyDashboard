"""Agent 中心 · 数据流总览聚合端点(P2b)。

供前端「数据流总览」页(``/dashboard/agent-center/overview``)调用,走
``/api/backend`` 代理 + API key 鉴权(``protected``,与其它 Dashboard 端点同族:
代理自动附加主 key,不占 agent key 配额)。对 ``agent_api_audit_log``(audit
中间件自动落库,BEL-377)按业务域(``operation_type``,与前端
``AGENT_DOMAINS.code`` 同源)聚合窗口内活动:调用量、写侧量、错误数与最近活动。

* ``operation_type IS NULL``(未映射 / 历史流量)不进聚合,矩阵不出现「未知域」行;
* 窗口内无调用的已知域不返回条目,前端以 ``AGENT_DOMAINS`` 注册表补全;
* 响应字段名按前端契约固定为 ``*_24h`` / ``*_7d``(``days`` 仅控制大窗口大小,
  前端恒传 7);
* 路径刻意放在 ``/agent-ops`` 而非 ``/agent/*``:不进 audit 中间件统计范围,
  也与 agent key 鉴权体系解耦;
* 索引结论(plan 2026-09-05-agent-dataflow-overview §P2b):窗口过滤走既有
  ``idx_aaal_created_at`` range scan;(operation_type, created_at) 复合索引与
  本查询形态(时间范围过滤 + 分组)不匹配,不新增迁移。``days`` 上限即 audit
  保留期(默认 90 天)。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, protected
from app.models.agent_api_audit_log import AgentApiAuditLog

router = APIRouter(
    prefix="/agent-ops",
    tags=["agent-ops"],
    dependencies=[Depends(protected)],
)

# audit 保留期上限(``agent_api_audit_retention_days`` 默认 90):窗口再大也无数据
MAX_WINDOW_DAYS = 90

_WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


class DomainSummaryItem(BaseModel):
    domain: str
    calls_24h: int
    calls_7d: int
    writes_24h: int
    writes_7d: int
    errors_7d: int
    last_active_at: datetime | None = None


class DomainSummaryResponse(BaseModel):
    generated_at: datetime
    window_days: int
    items: list[DomainSummaryItem]


@router.get("/domain-summary", response_model=DomainSummaryResponse)
def get_domain_summary(
    days: int = Query(default=7, ge=1, le=MAX_WINDOW_DAYS, description="大窗口天数(前端契约恒为 7)"),
    db: Session = Depends(get_read_db_session),
) -> DomainSummaryResponse:
    now = datetime.now(timezone.utc)
    since_window = now - timedelta(days=days)
    since_24h = now - timedelta(hours=24)

    is_write = AgentApiAuditLog.method.in_(_WRITE_METHODS)
    rows = db.execute(
        select(
            AgentApiAuditLog.operation_type,
            func.count().filter(AgentApiAuditLog.created_at >= since_24h).label("calls_24h"),
            func.count().label("calls_7d"),
            func.count()
            .filter(is_write, AgentApiAuditLog.created_at >= since_24h)
            .label("writes_24h"),
            func.count().filter(is_write).label("writes_7d"),
            func.count().filter(AgentApiAuditLog.status_code >= 400).label("errors_7d"),
            func.max(AgentApiAuditLog.created_at).label("last_active_at"),
        )
        .where(
            AgentApiAuditLog.created_at >= since_window,
            AgentApiAuditLog.operation_type.isnot(None),
        )
        .group_by(AgentApiAuditLog.operation_type)
        .order_by(func.count().desc())
    ).all()

    items = [
        DomainSummaryItem(
            domain=operation_type,
            calls_24h=int(calls_24h),
            calls_7d=int(calls_7d),
            writes_24h=int(writes_24h),
            writes_7d=int(writes_7d),
            errors_7d=int(errors_7d),
            last_active_at=last_active_at,
        )
        for (
            operation_type,
            calls_24h,
            calls_7d,
            writes_24h,
            writes_7d,
            errors_7d,
            last_active_at,
        ) in rows
    ]
    return DomainSummaryResponse(generated_at=now, window_days=days, items=items)
