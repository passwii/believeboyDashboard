"""
System Management 审计日志服务。
"""
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.operation_audit_log import OperationAuditLog

from app.schemas.system_management.audit import (
    OperationAuditLogActionSummaryItem,
    OperationAuditLogModuleSummaryItem,
)

from app.services.system_management.shared import _apply_audit_log_filters


def get_audit_log_summary(
    db: Session,
    *,
    operator: str | None = None,
    action: str | None = None,
    target_type: str | None = None,
    result: str | None = None,
    keyword: str | None = None,
) -> dict:
    """获取审计日志汇总统计。

    返回包含总数、成功数、失败数、操作者数量、按模块统计、按操作统计。
    """
    base_stmt = _apply_audit_log_filters(
        select(OperationAuditLog),
        operator=operator, action=action, target_type=target_type,
        result=result, keyword=keyword,
    ).subquery()

    total, success_count, failure_count, unique_operator_count = db.execute(
        select(
            func.count().label("total"),
            func.sum(case((base_stmt.c.result == "success", 1), else_=0)).label("success_count"),
            func.sum(case((base_stmt.c.result == "failure", 1), else_=0)).label("failure_count"),
            func.count(func.distinct(base_stmt.c.operator)).label("unique_operator_count"),
        )
    ).one()

    module_specs = (
        ("commission", "运营报表核算", "commission.%"),
        ("shipment_schedules", "编辑发货信息管理", "shipment_schedules.%"),
        ("projects", "项目信息维护", "projects.%"),
        ("users", "账号权限维护", "users.%"),
    )
    modules: list[OperationAuditLogModuleSummaryItem] = []
    for key, label, action_pattern in module_specs:
        count_value, success_value, failure_value = db.execute(
            select(
                func.count().label("count"),
                func.sum(case((base_stmt.c.result == "success", 1), else_=0)).label("success_count"),
                func.sum(case((base_stmt.c.result == "failure", 1), else_=0)).label("failure_count"),
            )
            .select_from(base_stmt)
            .where(base_stmt.c.action.like(action_pattern))
        ).one()
        modules.append(
            OperationAuditLogModuleSummaryItem(
                key=key, label=label,
                count=int(count_value or 0),
                success_count=int(success_value or 0),
                failure_count=int(failure_value or 0),
            )
        )

    top_action_rows = db.execute(
        select(base_stmt.c.action, func.count().label("count"))
        .select_from(base_stmt)
        .group_by(base_stmt.c.action)
        .order_by(func.count().desc(), base_stmt.c.action.asc())
        .limit(6)
    ).all()

    return {
        "total": int(total or 0),
        "success_count": int(success_count or 0),
        "failure_count": int(failure_count or 0),
        "unique_operator_count": int(unique_operator_count or 0),
        "modules": modules,
        "top_actions": [
            {"action": str(an), "count": int(c)}
            for an, c in top_action_rows
        ],
    }