"""CRM 数据看板聚合服务（P3c，仅管理员）。

给销售主管看的看板：线索漏斗 / 本月新增 / 跟进活跃度 / 每销售业绩。
时间口径统一用业务时区 Asia/Shanghai 计算「本月」「最近 7 天」。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmFollow, CrmLead
from app.schemas.crm import (
    DashboardStats,
    FollowActivity,
    NewThisMonth,
    OwnerPerformance,
)
from app.services.crm.permissions import require_admin

SHANGHAI = ZoneInfo("Asia/Shanghai")
# 漏斗展示顺序（与 CrmLeadStatus 一致）
_LEAD_STATUS_ORDER = ("new", "contacting", "qualified", "converted", "discarded")


def _owner_name_map(db: Session, owner_ids: set[str]) -> dict[str, str]:
    """批量查 user_accounts.name，避免 N+1（同 customer_service._owner_name_map）。"""
    if not owner_ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(owner_ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def get_dashboard_stats(
    db: Session, *, is_admin: bool, now: datetime | None = None
) -> DashboardStats:
    """聚合看板数据。非管理员 → 403（require_admin）。"""
    require_admin(is_admin)

    ref = (now or datetime.now(SHANGHAI)).astimezone(SHANGHAI)
    month_start = ref.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    seven_days_ago = ref - timedelta(days=7)

    # ---- 线索漏斗（各状态计数，排除已删除）----
    funnel_rows = db.execute(
        select(CrmLead.status, func.count())
        .where(CrmLead.is_deleted.is_(False))
        .group_by(CrmLead.status)
    ).all()
    funnel = {s: 0 for s in _LEAD_STATUS_ORDER}
    for status_, count in funnel_rows:
        funnel[status_] = int(count)

    # ---- 本月新增 ----
    new_customers = db.execute(
        select(func.count())
        .select_from(CrmCustomer)
        .where(CrmCustomer.is_deleted.is_(False), CrmCustomer.created_at >= month_start)
    ).scalar_one()
    new_leads = db.execute(
        select(func.count())
        .select_from(CrmLead)
        .where(CrmLead.is_deleted.is_(False), CrmLead.created_at >= month_start)
    ).scalar_one()
    converted_count = db.execute(
        select(func.count())
        .select_from(CrmLead)
        .where(CrmLead.is_deleted.is_(False), CrmLead.converted_at >= month_start)
    ).scalar_one()

    # ---- 跟进活跃度（最近 7 天跟进记录数）----
    follow_count_7d = db.execute(
        select(func.count())
        .select_from(CrmFollow)
        .where(CrmFollow.created_at >= seven_days_ago)
    ).scalar_one()

    # ---- 每销售业绩（按负责人分组）----
    cust_rows = db.execute(
        select(CrmCustomer.owner_id, func.count())
        .where(CrmCustomer.is_deleted.is_(False), CrmCustomer.owner_id.is_not(None))
        .group_by(CrmCustomer.owner_id)
    ).all()
    cust_by_owner = {str(oid): int(c) for oid, c in cust_rows}

    conv_rows = db.execute(
        select(CrmLead.owner_id, func.count())
        .where(
            CrmLead.is_deleted.is_(False),
            CrmLead.owner_id.is_not(None),
            CrmLead.converted_at >= month_start,
        )
        .group_by(CrmLead.owner_id)
    ).all()
    conv_by_owner = {str(oid): int(c) for oid, c in conv_rows}

    owner_ids = set(cust_by_owner) | set(conv_by_owner)
    owner_names = _owner_name_map(db, owner_ids)
    per_owner = [
        OwnerPerformance(
            owner_id=oid,
            owner_name=owner_names.get(oid),
            customer_count=cust_by_owner.get(oid, 0),
            converted_this_month=conv_by_owner.get(oid, 0),
        )
        for oid in sorted(owner_ids)
    ]

    return DashboardStats(
        lead_funnel=funnel,
        new_this_month=NewThisMonth(
            new_customers=int(new_customers),
            new_leads=int(new_leads),
            converted_count=int(converted_count),
        ),
        follow_activity=FollowActivity(follow_count_7d=int(follow_count_7d)),
        per_owner=per_owner,
    )
