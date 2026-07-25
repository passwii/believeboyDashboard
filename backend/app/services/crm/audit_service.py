"""CRM 操作审计日志服务（P4）：记录/查询/变更摘要。

在写端点（endpoint 层，身份所在）调用 record_log 留痕；
update 端点用 summarize_update(改前, patch) 算中文摘要。
actor_name 查询时从 public.user_accounts 解析（不快照）。
"""

from __future__ import annotations

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmAuditLog
from app.schemas.crm import AuditLogItem

# 字段名 → 中文标签（摘要用；未收录字段回退原始字段名）
CUSTOMER_FIELD_LABELS: dict[str, str] = {
    "name": "客户名",
    "short_name": "简称",
    "industry": "行业",
    "customer_type": "对象类型",
    "interested_service": "意向服务",
    "rating": "等级",
    "status": "状态",
    "source": "来源",
    "owner_id": "负责人",
    "address": "地址",
    "website": "网站",
    "annual_revenue": "年营收",
    "employee_count": "员工数",
    "remark": "备注",
}

LEAD_FIELD_LABELS: dict[str, str] = {
    "name": "联系人名",
    "company": "公司",
    "phone": "电话",
    "email": "邮箱",
    "wechat": "微信",
    "source": "来源",
    "customer_type": "对象类型",
    "interested_service": "意向服务",
    "status": "状态",
    "intent": "意向度",
    "owner_id": "负责人",
    "expected_amount": "预期金额",
    "expected_close_date": "预期成交日",
    "remark": "备注",
}


def record_log(
    db: Session,
    *,
    entity_type: str,
    entity_id: int,
    action: str,
    actor_id: str | None,
    summary: str = "",
) -> CrmAuditLog:
    """记录一条审计日志（add + commit + refresh）。"""
    log = CrmAuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        actor_id=actor_id,
        summary=summary or None,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def _actor_name_map(db: Session, actor_ids: set[str]) -> dict[str, str]:
    """批量查 user_accounts.name，避免 N+1。返回 {str(id): name}。"""
    if not actor_ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(actor_ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def list_audit_logs(
    db: Session,
    *,
    entity_type: str | None = None,
    entity_id: int | None = None,
    actor_id: str | None = None,
    action: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[AuditLogItem], int]:
    """按条件查审计日志（created_at desc + id desc 兜底），actor_name 实时解析。"""
    stmt = select(CrmAuditLog)
    if entity_type is not None:
        stmt = stmt.where(CrmAuditLog.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(CrmAuditLog.entity_id == entity_id)
    if actor_id is not None:
        stmt = stmt.where(CrmAuditLog.actor_id == actor_id)
    if action is not None:
        stmt = stmt.where(CrmAuditLog.action == action)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
    stmt = (
        stmt.order_by(CrmAuditLog.created_at.desc(), CrmAuditLog.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    rows = db.execute(stmt).scalars().all()
    names = _actor_name_map(db, {r.actor_id for r in rows if r.actor_id})
    items = [
        AuditLogItem(
            id=r.id,
            entity_type=r.entity_type,
            entity_id=r.entity_id,
            action=r.action,
            actor_id=r.actor_id,
            actor_name=names.get(r.actor_id) if r.actor_id else None,
            summary=r.summary,
            created_at=r.created_at,
        )
        for r in rows
    ]
    return items, int(total)


def summarize_update(before: dict, patch: dict, labels: dict[str, str]) -> str:
    """比较改前值与 patch，只列变化字段，格式「字段: 旧→新; ...」。无变化返回空串。"""
    parts: list[str] = []
    for key, new in patch.items():
        old = before.get(key)
        if old == new:
            continue
        label = labels.get(key, key)
        parts.append(f"{label}: {_fmt(old)}→{_fmt(new)}")
    return "; ".join(parts)


def _fmt(value) -> str:
    if value is None or value == "":
        return "空"
    return str(value)
