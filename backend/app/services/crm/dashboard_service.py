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
    FunnelDimensionItem,
    FunnelMetrics,
    NewThisMonth,
    OwnerPerformance,
    StageDetail,
    StageLeadItem,
)
from app.services.crm.permissions import require_admin

SHANGHAI = ZoneInfo("Asia/Shanghai")
# 漏斗展示顺序（与 CrmLeadStatus 一致）
_LEAD_STATUS_ORDER = ("new", "contacting", "qualified", "converted", "discarded")
_STATUS_INDEX = {s: i for i, s in enumerate(_LEAD_STATUS_ORDER)}


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


# =====================================================================
# P8 漏斗指标（BLF-517）— 按 时间/角色/来源 聚合 + 阶段复盘明细
#
# 数据基础（漏斗二层设计决策 #5，BLF-516）：
#   - `CrmLead.entered_stage_at`：进入当前阶段的时间戳（status 变更时写入，
#     create_lead/update_lead/convert_lead 已接；历史数据为 NULL）。
#   - 停留时长 dwell = now - coalesce(entered_stage_at, updated_at)
#     （历史数据回退到 updated_at ≈ 最后一次修改 ≈ 最近一次状态变更）。
#   - last_action_at = max(CrmFollow.created_at)，SQL 推导，不落字段。
# =====================================================================


def _as_shanghai(dt: datetime | None) -> datetime | None:
    """把查询参数时间规整到 Asia/Shanghai（naive 视为上海时间；aware 做换算）。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=SHANGHAI)
    return dt.astimezone(SHANGHAI)


def _funnel_conds(
    *,
    start_at: datetime | None,
    end_at: datetime | None,
    owner_id: str | None,
    source: str | None,
) -> list:
    """漏斗指标基础过滤。

    - 给了时间范围 → 按 `entered_stage_at ∈ [start_at, end_at)` 计（本期流入视角，
      与 total/分桶口径一致）；未给 → 当前状态快照（含历史数据）。
    - owner_id / source 过滤始终生效。
    """
    conds = [CrmLead.is_deleted.is_(False)]
    if owner_id is not None:
        conds.append(CrmLead.owner_id == owner_id)
    if source is not None:
        conds.append(CrmLead.source == source)
    if start_at is not None:
        conds.append(CrmLead.entered_stage_at >= start_at)
    if end_at is not None:
        conds.append(CrmLead.entered_stage_at < end_at)
    return conds


def _empty_funnel() -> dict[str, int]:
    return {s: 0 for s in _LEAD_STATUS_ORDER}


def get_funnel_metrics(
    db: Session,
    *,
    is_admin: bool,
    dimension: str,
    start_at: datetime | None = None,
    end_at: datetime | None = None,
    owner_id: str | None = None,
    source: str | None = None,
) -> FunnelMetrics:
    """按维度聚合的漏斗数据（仅管理员）。

    dimension ∈ {owner, source, time}：
    - owner：按负责人分组（owner_id 为空 = 线索池/未分配，key=""）；
    - source：按来源分组（空 = 未知，key=""）；
    - time：按 `entered_stage_at` 的月份分桶（YYYY-MM，Asia/Shanghai 口径），
      历史数据 NULL 不计入分桶（但计入 total 快照——「本期流入」与「当前存量」的差异属预期）。
    """
    require_admin(is_admin)
    start_at = _as_shanghai(start_at)
    end_at = _as_shanghai(end_at)
    conds = _funnel_conds(
        start_at=start_at, end_at=end_at, owner_id=owner_id, source=source
    )

    # total：全量漏斗（应用过滤后的 5 状态计数）
    funnel_rows = db.execute(
        select(CrmLead.status, func.count()).where(*conds).group_by(CrmLead.status)
    ).all()
    total = _empty_funnel()
    for st, cnt in funnel_rows:
        total[st] = int(cnt)

    if dimension == "owner":
        rows = db.execute(
            select(CrmLead.owner_id, CrmLead.status, func.count())
            .where(*conds)
            .group_by(CrmLead.owner_id, CrmLead.status)
        ).all()
        by_key: dict[str, dict[str, int]] = {}
        for oid, st, cnt in rows:
            by_key.setdefault(oid or "", _empty_funnel())[st] = int(cnt)
        names = _owner_name_map(db, {k for k in by_key if k})
        items = [
            FunnelDimensionItem(
                key=k, label=names.get(k) if k else None, funnel=by_key[k]
            )
            for k in sorted(by_key)
        ]
    elif dimension == "source":
        rows = db.execute(
            select(CrmLead.source, CrmLead.status, func.count())
            .where(*conds)
            .group_by(CrmLead.source, CrmLead.status)
        ).all()
        by_key = {}
        for src, st, cnt in rows:
            by_key.setdefault(src or "", _empty_funnel())[st] = int(cnt)
        items = [
            FunnelDimensionItem(key=k, label=k or None, funnel=by_key[k])
            for k in sorted(by_key)
        ]
    elif dimension == "time":
        # Asia/Shanghai 口径的月份分桶（entered_stage_at 为 timestamptz，先转时区）
        month_expr = func.to_char(
            func.timezone("Asia/Shanghai", CrmLead.entered_stage_at), "YYYY-MM"
        )
        rows = db.execute(
            select(month_expr, CrmLead.status, func.count())
            .where(*conds, CrmLead.entered_stage_at.is_not(None))
            .group_by(month_expr, CrmLead.status)
        ).all()
        by_key = {}
        for month, st, cnt in rows:
            by_key.setdefault(month, _empty_funnel())[st] = int(cnt)
        items = [
            FunnelDimensionItem(key=month, label=month, funnel=by_key[month])
            for month in sorted(by_key)
        ]
    else:
        raise ValueError(f"unknown funnel dimension: {dimension}")

    return FunnelMetrics(
        dimension=dimension,  # type: ignore[arg-type]
        total=total,
        items=items,
        start_at=start_at,
        end_at=end_at,
    )


def get_stage_detail(
    db: Session,
    *,
    is_admin: bool,
    stage: str,
    sort_by: str = "dwell",
    start_at: datetime | None = None,
    end_at: datetime | None = None,
    owner_id: str | None = None,
    source: str | None = None,
    stuck_days: int = 7,
    page: int = 1,
    page_size: int = 50,
    now: datetime | None = None,
) -> StageDetail:
    """某阶段的复盘明细（漏斗二层面板，仅管理员）。

    - count：当前处于该阶段的线索数（未删除，含历史数据）。
    - avg_dwell_days / stuck_count：停留时长按 dwell 口径（见模块注释）。
    - inflow：本期流入 = 当前成员中 entered_stage_at ∈ [start_at, end_at) 的条数；
      未给时间范围时 = 全部成员。
    - outflow：本期流出（近似）= 当前处于**后续阶段**且 entered_stage_at ∈ period 的
      条数——这些线索在期内离开本阶段进入更后阶段。弃置线索无分阶段时间戳
      （无 discarded_at），不参与阶段级流失统计（弃置在看板右上角单独展示）。
      未给时间范围时 = None。
    - leads：默认按停留时长降序（卡最久在前），sort_by=recent 按最后动作倒序。
    """
    require_admin(is_admin)
    if stage not in _STATUS_INDEX:
        raise ValueError(f"unknown stage: {stage}")
    ref = (now or datetime.now(SHANGHAI)).astimezone(SHANGHAI)
    start_at = _as_shanghai(start_at)
    end_at = _as_shanghai(end_at)

    conds = [CrmLead.status == stage, CrmLead.is_deleted.is_(False)]
    if owner_id is not None:
        conds.append(CrmLead.owner_id == owner_id)
    if source is not None:
        conds.append(CrmLead.source == source)

    enter_at = func.coalesce(CrmLead.entered_stage_at, CrmLead.updated_at)
    dwell_expr = func.extract("epoch", ref - enter_at) / 86400.0

    last_at_subq = (
        select(func.max(CrmFollow.created_at))
        .where(CrmFollow.entity_type == "lead", CrmFollow.entity_id == CrmLead.id)
        .scalar_subquery()
    )
    last_content_subq = (
        select(CrmFollow.content)
        .where(CrmFollow.entity_type == "lead", CrmFollow.entity_id == CrmLead.id)
        .order_by(CrmFollow.created_at.desc(), CrmFollow.id.desc())
        .limit(1)
        .scalar_subquery()
    )

    total = db.execute(
        select(func.count()).select_from(CrmLead).where(*conds)
    ).scalar_one()

    if sort_by == "recent":
        order = last_at_subq.desc().nullslast()
    else:  # dwell（默认）：卡最久在前，NULLS LAST（无进入时间的排最后）
        order = dwell_expr.desc().nullslast()

    rows = db.execute(
        select(
            CrmLead,
            dwell_expr.label("dwell_days"),
            last_at_subq.label("last_action_at"),
            last_content_subq.label("last_action_content"),
        )
        .where(*conds)
        .order_by(order, CrmLead.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    owner_names = _owner_name_map(
        db, {r.CrmLead.owner_id for r in rows if r.CrmLead.owner_id}
    )
    leads = []
    for r in rows:
        lead = r.CrmLead
        dwell = float(r.dwell_days) if r.dwell_days is not None else None
        leads.append(
            StageLeadItem(
                id=lead.id,
                name=lead.name,
                company=lead.company,
                owner_id=lead.owner_id,
                owner_name=owner_names.get(lead.owner_id) if lead.owner_id else None,
                source=lead.source,
                intent=lead.intent,
                entered_stage_at=lead.entered_stage_at,
                last_action_at=r.last_action_at,
                last_action_content=r.last_action_content,
                next_follow_at=lead.next_follow_at,
                dwell_days=round(dwell, 1) if dwell is not None else None,
                is_stuck=dwell is not None and dwell > stuck_days,
            )
        )

    # ---- 摘要 ----
    avg_dwell = db.execute(select(func.avg(dwell_expr)).where(*conds)).scalar_one()
    stuck_count = db.execute(
        select(func.count()).select_from(CrmLead).where(*conds, dwell_expr > stuck_days)
    ).scalar_one()

    inflow = int(total)
    outflow: int | None = None
    if start_at is not None or end_at is not None:
        period_conds = list(conds)
        if start_at is not None:
            period_conds.append(CrmLead.entered_stage_at >= start_at)
        if end_at is not None:
            period_conds.append(CrmLead.entered_stage_at < end_at)
        inflow = db.execute(
            select(func.count()).select_from(CrmLead).where(*period_conds)
        ).scalar_one()
        # 流出 ≈ 当前处于后续阶段的线索，且 entered_stage_at ∈ period
        # （弃置不进阶段级流失：无分阶段时间戳，看板右上角单独展示）
        later_stages = [
            s
            for s in _LEAD_STATUS_ORDER
            if s != "discarded" and _STATUS_INDEX[s] > _STATUS_INDEX[stage]
        ]
        out_conds = [
            CrmLead.is_deleted.is_(False),
            CrmLead.status.in_(later_stages),
        ]
        if owner_id is not None:
            out_conds.append(CrmLead.owner_id == owner_id)
        if source is not None:
            out_conds.append(CrmLead.source == source)
        if start_at is not None:
            out_conds.append(CrmLead.entered_stage_at >= start_at)
        if end_at is not None:
            out_conds.append(CrmLead.entered_stage_at < end_at)
        outflow = db.execute(
            select(func.count()).select_from(CrmLead).where(*out_conds)
        ).scalar_one()

    return StageDetail(
        stage=stage,
        count=int(total),
        avg_dwell_days=round(float(avg_dwell), 1) if avg_dwell is not None else None,
        stuck_count=int(stuck_count),
        inflow=int(inflow),
        outflow=int(outflow) if outflow is not None else None,
        stuck_days=stuck_days,
        leads=leads,
        page=page,
        page_size=page_size,
        total=int(total),
    )
