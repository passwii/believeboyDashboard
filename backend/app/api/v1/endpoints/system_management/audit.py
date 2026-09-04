"""
审计日志端点。
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, protected
from app.models.operation_audit_log import OperationAuditLog

from app.schemas.system_management.audit import (
    OperationAuditLogsResponse,
    OperationAuditLogsSummaryResponse,
    OperationAuditLogActionSummaryItem,
)

from app.services.system_management import _apply_audit_log_filters, get_audit_log_summary


router = APIRouter(tags=["审计日志"])


@router.get("/audit-logs", response_model=OperationAuditLogsResponse)
def list_operation_audit_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    operator: str | None = Query(default=None),
    action: str | None = Query(default=None),
    target_type: str | None = Query(default=None),
    result: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> OperationAuditLogsResponse:
    from app.services.system_management import _to_iso

    stmt = _apply_audit_log_filters(
        select(OperationAuditLog),
        operator=operator, action=action, target_type=target_type,
        result=result, keyword=keyword,
    )
    total_stmt = _apply_audit_log_filters(
        select(func.count(OperationAuditLog.id)),
        operator=operator, action=action, target_type=target_type,
        result=result, keyword=keyword,
    )
    total = int(db.execute(total_stmt).scalar() or 0)
    offset = (page - 1) * page_size
    rows = (
        db.execute(
            stmt.order_by(
                OperationAuditLog.created_at.desc(),
                OperationAuditLog.id.desc(),
            )
            .offset(offset)
            .limit(page_size)
        )
        .scalars()
        .all()
    )
    has_next = offset + len(rows) < total

    items = [
        OperationAuditLogsResponse.model_validate({
            "items": [{
                "id": r.id,
                "created_at": _to_iso(r.created_at) or "",
                "operator": r.operator,
                "action": r.action,
                "target_type": r.target_type,
                "target_id": r.target_id,
                "result": r.result,
                "trace_id": r.trace_id,
                "request_method": r.request_method,
                "request_path": r.request_path,
                "ip_address": r.ip_address,
                "user_agent": r.user_agent,
                "before_json": r.before_json,
                "after_json": r.after_json,
                "error_message": r.error_message,
            }],
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_next": has_next,
        }).items[0]
        for r in rows
    ]

    return OperationAuditLogsResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_next=has_next,
    )


@router.get("/audit-logs/summary", response_model=OperationAuditLogsSummaryResponse)
def get_operation_audit_logs_summary(
    operator: str | None = Query(default=None),
    action: str | None = Query(default=None),
    target_type: str | None = Query(default=None),
    result: str | None = Query(default=None),
    keyword: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> OperationAuditLogsSummaryResponse:
    summary = get_audit_log_summary(
        db,
        operator=operator, action=action, target_type=target_type,
        result=result, keyword=keyword,
    )
    return OperationAuditLogsSummaryResponse(
        total=summary["total"],
        success_count=summary["success_count"],
        failure_count=summary["failure_count"],
        unique_operator_count=summary["unique_operator_count"],
        modules=summary["modules"],
        top_actions=[
            OperationAuditLogActionSummaryItem(**item)
            for item in summary["top_actions"]
        ],
    )