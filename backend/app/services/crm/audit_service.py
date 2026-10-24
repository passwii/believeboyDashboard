"""CRM 操作审计日志服务（P4）：记录/查询/变更摘要。

在写端点（endpoint 层，身份所在）调用 record_log 留痕；
update 端点用 summarize_update(改前, patch) 算中文摘要。
actor_name 查询时从 public.user_accounts 解析（不快照）。
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.crm import CrmAuditLog
from app.schemas.crm import AuditLogItem
from app.services.user_display import resolve_display_names

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

# P5-1：联系人字段标签。
# 注：plan 写的是 role/note，但 CrmContact 实际字段是 title/remark
# （参见 backend/app/schemas/crm.py:87 / backend/app/models/crm.py:127）。
# 按 schema 实际命名落 labels，避免 service 的 setattr 触发 AttributeError。
CONTACT_FIELD_LABELS: dict[str, str] = {
    "name": "姓名",
    "title": "职位",
    "phone": "电话",
    "email": "邮箱",
    "wechat": "微信",
    "is_primary": "主联系人",
    "remark": "备注",
}

# P9-8（BLF-546）：规则引擎头字段中文标签（update 摘要用；conditions/actions
# 为子表整体重建，摘要里用「条件/动作已更新」表述，不逐条 diff）。
RULE_FIELD_LABELS: dict[str, str] = {
    "name": "规则名",
    "description": "描述",
    "entity_type": "作用对象",
    "event_type": "触发事件",
    "enabled": "启停",
    "priority": "优先级",
}


def record_log(
    db: Session,
    *,
    entity_type: str,
    entity_id: int,
    action: str,
    actor_id: str | None,
    summary: str = "",
    commit: bool = False,
) -> CrmAuditLog:
    """记录一条审计日志（add + flush + refresh）。

    P5-6: 默认 commit=False（不自动 commit），让调用方负责 commit，
    保证业务写入 + 审计写入原子化（要么都成功、要么都回滚）。
    兼容旧调用：传 commit=True 保持原有「record_log 自带 commit」行为。
    """
    log = CrmAuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        actor_id=actor_id,
        summary=summary or None,
    )
    db.add(log)
    db.flush()
    if commit:
        db.commit()
    db.refresh(log)
    return log


def list_audit_logs(
    db: Session,
    *,
    entity_type: str | None = None,
    entity_id: int | None = None,
    entity_types: list[str] | None = None,
    entity_ids: list[int] | None = None,
    actor_id: str | None = None,
    action: str | None = None,
    page: int = 1,
    page_size: int = 20,
) -> tuple[list[AuditLogItem], int]:
    """按条件查审计日志（created_at desc + id desc 兜底），actor_name 实时解析。

    P5-9: 支持 entity_types + entity_ids 多值过滤（用于客户抽屉同时查
    客户审计 + 该客户下所有联系人审计）。
    """
    stmt = select(CrmAuditLog)
    if entity_types is not None:
        stmt = stmt.where(CrmAuditLog.entity_type.in_(entity_types))
    elif entity_type is not None:
        stmt = stmt.where(CrmAuditLog.entity_type == entity_type)
    if entity_ids is not None:
        stmt = stmt.where(CrmAuditLog.entity_id.in_(entity_ids))
    elif entity_id is not None:
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
    names = resolve_display_names(db, {r.actor_id for r in rows if r.actor_id})
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
    """比较改前值与 patch，只列变化字段，格式「字段: 旧→新; ...」。无变化返回空串。

    P5-10: None ↔ "" 视为无变更（避免「空→空」噪音）。
    """

    def _is_empty(v):
        return v is None or v == ""

    parts: list[str] = []
    for key, new in patch.items():
        old_val = before.get(key)
        # None ↔ "" 视为无变更
        if _is_empty(old_val) and _is_empty(new):
            continue
        if old_val == new:
            continue
        label = labels.get(key, key)
        parts.append(f"{label}: {_fmt(old_val)}→{_fmt(new)}")
    return "; ".join(parts)


def summarize_contact_update(before: dict, patch: dict) -> str | None:
    """P5-1 联系人字段级变更摘要。

    只迭代 ``patch`` 中已声明的字段（``CONTACT_FIELD_LABELS`` 的 key），
    未声明字段（含 caller 误传的自定义 key）静默跳过、不抛错。
    无变化返回 ``None``，让 endpoint 决定是否仍写兜底摘要或跳过。
    """
    parts: list[str] = []
    for key, new in patch.items():
        if key not in CONTACT_FIELD_LABELS:
            continue
        old = before.get(key)
        if old == new:
            continue
        label = CONTACT_FIELD_LABELS[key]
        parts.append(f"{label}: {_fmt(old)}→{_fmt(new)}")
    return "; ".join(parts) if parts else None


def _fmt(value) -> str:
    if value is None or value == "":
        return "空"
    return str(value)
