"""
Agent 访问日志管理端端点（agent_api_audit_log 查询）。

回答"谁在什么时间调了哪个 Agent API、结果如何"：列表端点 LEFT JOIN
``agent_api_keys`` 还原 agent_id / label；未鉴权请求 api_key_id 为空，
agent_id 显示为未绑定。数据保留 90 天（agent_api_audit_retention_days，
Celery 每日清理），本端点只读不写。
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.models.agent_api_audit_log import AgentApiAuditLog
from app.models.agent_api_key import AgentApiKey
from app.schemas.system_management.agent_access_logs import (
    AgentAccessLogAgentSummaryItem,
    AgentAccessLogsResponse,
    AgentAccessLogsSummaryResponse,
)

router = APIRouter(prefix="/agent-access-logs", tags=["Agent 访问日志"])

_LOG = AgentApiAuditLog
_KEY = AgentApiKey


def _apply_filters(
    stmt,
    *,
    keyword: str | None,
    method: str | None,
    status_code: int | None,
    result: str | None,
    date_from: date | None,
    date_to: date | None,
    project_id: int | None = None,
    operation_type: str | None = None,
):
    """应用 Agent 访问日志过滤条件。"""
    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        like_value = f"%{normalized_keyword}%"
        stmt = stmt.where(
            or_(
                _KEY.agent_id.ilike(like_value),
                _KEY.label.ilike(like_value),
                _LOG.path.ilike(like_value),
                _LOG.method.ilike(like_value),
            )
        )

    normalized_method = (method or "").strip().upper()
    if normalized_method:
        stmt = stmt.where(_LOG.method == normalized_method)

    if status_code is not None:
        stmt = stmt.where(_LOG.status_code == status_code)

    normalized_result = (result or "").strip().lower()
    if normalized_result == "success":
        stmt = stmt.where(_LOG.status_code.between(200, 299))
    elif normalized_result == "error":
        stmt = stmt.where(_LOG.status_code >= 400)

    if date_from is not None:
        stmt = stmt.where(func.date(_LOG.created_at) >= date_from)
    if date_to is not None:
        stmt = stmt.where(func.date(_LOG.created_at) <= date_to)

    # BLF-460 读操作明细筛选
    if project_id is not None:
        stmt = stmt.where(_LOG.project_id == project_id)
    normalized_op = (operation_type or "").strip()
    if normalized_op:
        stmt = stmt.where(_LOG.operation_type == normalized_op)

    return stmt


def _base_stmt():
    return select(_LOG, _KEY.agent_id, _KEY.label).outerjoin(
        _KEY, _KEY.id == _LOG.api_key_id
    )


def _to_iso(value) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        return value.isoformat(timespec="seconds")
    return value.astimezone().isoformat(timespec="seconds")


@router.get("", response_model=AgentAccessLogsResponse)
def list_agent_access_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    keyword: str | None = Query(default=None),
    method: str | None = Query(default=None),
    status_code: int | None = Query(default=None, ge=100, le=599),
    result: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    project_id: int | None = Query(default=None, ge=1),
    operation_type: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> AgentAccessLogsResponse:
    kwargs = {
        "keyword": keyword,
        "method": method,
        "status_code": status_code,
        "result": result,
        "date_from": date_from,
        "date_to": date_to,
        "project_id": project_id,
        "operation_type": operation_type,
    }
    stmt = _apply_filters(_base_stmt(), **kwargs)
    total_stmt = _apply_filters(
        select(func.count(_LOG.id))
        .select_from(_LOG)
        .outerjoin(_KEY, _KEY.id == _LOG.api_key_id),
        **kwargs,
    )
    total = int(db.execute(total_stmt).scalar() or 0)
    offset = (page - 1) * page_size
    rows = db.execute(
        stmt.order_by(_LOG.id.desc()).offset(offset).limit(page_size)
    ).all()
    items = [
        {
            "id": log.id,
            "created_at": _to_iso(log.created_at),
            "method": log.method,
            "path": log.path,
            "status_code": log.status_code,
            "latency_ms": log.latency_ms,
            "ip_address": log.ip_address,
            "api_key_id": log.api_key_id,
            "agent_id": agent_id,
            "key_label": label,
            "project_id": log.project_id,
            "operation_type": log.operation_type,
        }
        for log, agent_id, label in rows
    ]
    return AgentAccessLogsResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_next=offset + len(rows) < total,
    )


@router.get("/summary", response_model=AgentAccessLogsSummaryResponse)
def agent_access_logs_summary(
    keyword: str | None = Query(default=None),
    method: str | None = Query(default=None),
    status_code: int | None = Query(default=None, ge=100, le=599),
    result: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    project_id: int | None = Query(default=None, ge=1),
    operation_type: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> AgentAccessLogsSummaryResponse:
    sub = _apply_filters(
        _base_stmt(),
        keyword=keyword,
        method=method,
        status_code=status_code,
        result=result,
        date_from=date_from,
        date_to=date_to,
        project_id=project_id,
        operation_type=operation_type,
    ).subquery()

    total = int(db.execute(select(func.count()).select_from(sub)).scalar() or 0)
    success_count = int(
        db.execute(
            select(func.count())
            .select_from(sub)
            .where(sub.c.status_code.between(200, 299))
        ).scalar()
        or 0
    )
    error_count = int(
        db.execute(
            select(func.count()).select_from(sub).where(sub.c.status_code >= 400)
        ).scalar()
        or 0
    )
    unique_agent_count = int(
        db.execute(
            select(func.count(func.distinct(sub.c.agent_id)))
            .select_from(sub)
            .where(sub.c.agent_id.is_not(None))
        ).scalar()
        or 0
    )
    top_rows = db.execute(
        select(sub.c.agent_id, sub.c.label, func.count().label("cnt"))
        .select_from(sub)
        .where(sub.c.agent_id.is_not(None))
        .group_by(sub.c.agent_id, sub.c.label)
        .order_by(func.count().desc())
        .limit(10)
    ).all()

    return AgentAccessLogsSummaryResponse(
        total=total,
        success_count=success_count,
        error_count=error_count,
        unique_agent_count=unique_agent_count,
        top_agents=[
            AgentAccessLogAgentSummaryItem(
                agent_id=agent_id, key_label=label, count=count
            )
            for agent_id, label, count in top_rows
        ],
    )
