"""
Agent 操作日志管理端端点（BLF-460 写操作明细上架）。

回答"Agent 最近做了哪些写操作、改动前后是什么"：查询 ``operation_audit_logs``
中 ``agent_id IS NOT NULL`` 的行（写路由经 ``append_operation_audit_log`` 落库，
含 before/after JSON）。``project_id`` 从 ``request_path`` 正则派生（兜底
before/after 内嵌 ``project_id``）；``operation_type`` 由 ``action`` 前缀派生，
取值与读侧 ``agent_api_audit_log.operation_type`` 对齐（shipments /
shop_calculations / new_product_calculations）。本端点只读不写。

保留期：agent 写操作行由 Celery ``operation_audit_cleanup`` 按
``operation_audit_retention_days``（默认 90 天）清理；人工 operator 行不受影响。
"""

from __future__ import annotations

import re
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.models.operation_audit_log import OperationAuditLog
from app.models.project import Project
from app.schemas.system_management.agent_operations import (
    AgentOperationLogActionSummaryItem,
    AgentOperationLogItem,
    AgentOperationLogsResponse,
    AgentOperationLogsSummaryResponse,
    AgentOperationLogSummaryItem,
)

router = APIRouter(prefix="/agent-operation-logs", tags=["Agent 操作日志"])

_LOG = OperationAuditLog

# action 前缀 → 业务域（与读侧 AGENT_PATH_DOMAIN_MAP / frontend agent-domains.ts 对齐）
_ACTION_DOMAIN_PREFIXES: tuple[tuple[str, str], ...] = (
    ("new_product_calculation.", "new_product_calculations"),
    ("shop_calculation.", "shop_calculations"),
    ("shipment.", "shipments"),
)

_PROJECT_ID_RE = re.compile(r"/projects/(\d+)")

# 货件域对象标识派生：path 里 /shipments/{shipment_no} 段（写操作多数无
# shipment_no 落 JSON，如状态推进 / 明细替换，但 path 恒带）。
_SHIPMENT_NO_PATH_RE = re.compile(r"/shipments/([^/]+)")


def _derive_operation_type(action: str) -> str | None:
    """由 action 前缀派生业务域（如 shipment.status.transition → shipments）。"""
    for prefix, domain in _ACTION_DOMAIN_PREFIXES:
        if action.startswith(prefix):
            return domain
    return None


def _derive_project_id(
    request_path: str | None,
    before_json: dict | list | None,
    after_json: dict | list | None,
) -> int | None:
    """优先从 request_path 解析；兜底 before/after 内嵌 project_id（部分 action 已带）。"""
    if request_path:
        match = _PROJECT_ID_RE.search(request_path)
        if match:
            return int(match.group(1))
    for payload in (before_json, after_json):
        if isinstance(payload, dict):
            value = payload.get("project_id")
            if value is not None:
                try:
                    return int(value)
                except (TypeError, ValueError):
                    pass
    return None


def _derive_target_label(
    request_path: str | None,
    before_json: dict | list | None,
    after_json: dict | list | None,
) -> str | None:
    """派生人类可读对象标识（BLF-471）：货件域优先 before/after 内嵌
    shipment_no，兜底 request_path 的 /shipments/{shipment_no} 段。"""
    for payload in (before_json, after_json):
        if isinstance(payload, dict):
            value = payload.get("shipment_no")
            if value:
                return str(value)
    if request_path:
        match = _SHIPMENT_NO_PATH_RE.search(request_path)
        if match:
            return match.group(1)
    return None


def _load_project_names(db: Session, project_ids: set[int]) -> dict[int, str]:
    """一次查询把 project_id 集合还原为 {id: project_name}（BLF-471）。

    空集合直接返回 {}（避免 ``IN ()`` 非法 SQL）。
    """
    if not project_ids:
        return {}
    rows = db.execute(
        select(Project.id, Project.project_name).where(Project.id.in_(project_ids))
    ).all()
    return {int(row.id): str(row.project_name) for row in rows}


def _apply_filters(
    stmt,
    *,
    agent_id: str | None,
    project_id: int | None,
    action: str | None,
    result: str | None,
    date_from: date | None,
    date_to: date | None,
    keyword: str | None,
):
    """应用 Agent 操作日志过滤条件（始终限定 agent 写操作行）。"""
    stmt = stmt.where(_LOG.agent_id.is_not(None))

    normalized_agent = (agent_id or "").strip()
    if normalized_agent:
        stmt = stmt.where(_LOG.agent_id.ilike(f"%{normalized_agent}%"))

    if project_id is not None:
        stmt = stmt.where(_LOG.request_path.like(f"%/projects/{project_id}/%"))

    normalized_action = (action or "").strip()
    if normalized_action:
        stmt = stmt.where(_LOG.action.ilike(f"%{normalized_action}%"))

    normalized_result = (result or "").strip().lower()
    if normalized_result in {"success", "failure"}:
        stmt = stmt.where(_LOG.result == normalized_result)

    if date_from is not None:
        stmt = stmt.where(func.date(_LOG.created_at) >= date_from)
    if date_to is not None:
        stmt = stmt.where(func.date(_LOG.created_at) <= date_to)

    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        like_value = f"%{normalized_keyword}%"
        stmt = stmt.where(
            or_(
                _LOG.agent_id.ilike(like_value),
                _LOG.action.ilike(like_value),
                _LOG.target_type.ilike(like_value),
                _LOG.target_id.ilike(like_value),
                _LOG.request_path.ilike(like_value),
                _LOG.error_message.ilike(like_value),
            )
        )
    return stmt


def _to_iso(value) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        return value.isoformat(timespec="seconds")
    return value.astimezone().isoformat(timespec="seconds")


def _serialize(row: OperationAuditLog, project_names: dict[int, str]) -> dict:
    project_id = _derive_project_id(
        row.request_path, row.before_json, row.after_json
    )
    return {
        "id": row.id,
        "created_at": _to_iso(row.created_at),
        "agent_id": row.agent_id,
        "agent_name": row.agent_name,
        "action": row.action,
        "target_type": row.target_type,
        "target_id": row.target_id,
        "target_label": _derive_target_label(
            row.request_path, row.before_json, row.after_json
        ),
        "result": row.result,
        "project_id": project_id,
        "project_name": project_names.get(project_id) if project_id is not None else None,
        "operation_type": _derive_operation_type(row.action),
        "request_path": row.request_path,
        "request_method": row.request_method,
        "before_json": row.before_json,
        "after_json": row.after_json,
        "idempotency_key": row.idempotency_key,
        "error_message": row.error_message,
    }


@router.get("", response_model=AgentOperationLogsResponse)
def list_agent_operation_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    agent_id: str | None = Query(default=None),
    project_id: int | None = Query(default=None, ge=1),
    action: str | None = Query(default=None),
    result: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> AgentOperationLogsResponse:
    kwargs = {
        "agent_id": agent_id,
        "project_id": project_id,
        "action": action,
        "result": result,
        "date_from": date_from,
        "date_to": date_to,
        "keyword": keyword,
    }
    stmt = _apply_filters(select(_LOG), **kwargs)
    total_stmt = _apply_filters(select(func.count(_LOG.id)), **kwargs)
    total = int(db.execute(total_stmt).scalar() or 0)
    offset = (page - 1) * page_size
    rows = (
        db.execute(
            stmt.order_by(_LOG.created_at.desc(), _LOG.id.desc())
            .offset(offset)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    project_ids: set[int] = set()
    for row in rows:
        pid = _derive_project_id(row.request_path, row.before_json, row.after_json)
        if pid is not None:
            project_ids.add(pid)
    project_names = _load_project_names(db, project_ids)
    return AgentOperationLogsResponse(
        items=[
            AgentOperationLogItem(**_serialize(row, project_names)) for row in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
        has_next=offset + len(rows) < total,
    )


@router.get("/summary", response_model=AgentOperationLogsSummaryResponse)
def agent_operation_logs_summary(
    agent_id: str | None = Query(default=None),
    project_id: int | None = Query(default=None, ge=1),
    action: str | None = Query(default=None),
    result: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> AgentOperationLogsSummaryResponse:
    sub = _apply_filters(
        select(_LOG),
        agent_id=agent_id,
        project_id=project_id,
        action=action,
        result=result,
        date_from=date_from,
        date_to=date_to,
        keyword=keyword,
    ).subquery()

    total = int(db.execute(select(func.count()).select_from(sub)).scalar() or 0)
    success_count = int(
        db.execute(
            select(func.count()).select_from(sub).where(sub.c.result == "success")
        ).scalar()
        or 0
    )
    failure_count = int(
        db.execute(
            select(func.count()).select_from(sub).where(sub.c.result == "failure")
        ).scalar()
        or 0
    )
    unique_agent_count = int(
        db.execute(
            select(func.count(func.distinct(sub.c.agent_id))).select_from(sub)
        ).scalar()
        or 0
    )
    top_agent_rows = db.execute(
        select(sub.c.agent_id, sub.c.agent_name, func.count().label("cnt"))
        .select_from(sub)
        .where(sub.c.agent_id.is_not(None))
        .group_by(sub.c.agent_id, sub.c.agent_name)
        .order_by(func.count().desc())
        .limit(10)
    ).all()
    top_action_rows = db.execute(
        select(sub.c.action, func.count().label("cnt"))
        .select_from(sub)
        .group_by(sub.c.action)
        .order_by(func.count().desc())
        .limit(10)
    ).all()

    return AgentOperationLogsSummaryResponse(
        total=total,
        success_count=success_count,
        failure_count=failure_count,
        unique_agent_count=unique_agent_count,
        top_agents=[
            AgentOperationLogSummaryItem(
                agent_id=agent_id, agent_name=agent_name, count=count
            )
            for agent_id, agent_name, count in top_agent_rows
        ],
        top_actions=[
            AgentOperationLogActionSummaryItem(action=action, count=count)
            for action, count in top_action_rows
        ],
    )
