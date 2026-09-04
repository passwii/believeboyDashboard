"""CRM 数据看板聚合服务（P3c，仅管理员）。

给销售主管看的看板：线索漏斗 / 本月新增 / 跟进活跃度 / 每销售业绩。
时间口径统一用业务时区 Asia/Shanghai 计算「本月」「最近 7 天」。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmAuditLog, CrmCustomer, CrmFollow, CrmLead, CrmTask
from app.schemas.crm import (
    DashboardStats,
    FollowActivity,
    FunnelDimensionItem,
    FunnelMetrics,
    LifecycleBoard,
    LifecycleBucket,
    LifecycleDistribution,
    LifecycleSummary,
    NewThisMonth,
    OwnerPerformance,
    PerformanceBoard,
    PerformanceMetrics,
    PerformanceRankItem,
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


# =====================================================================
# P8 业绩看板（BLF-519）— 个人 + 全局业绩指标 + 按人排名
#
# 口径（Asia/Shanghai「本月」）：
#   - 本月新增客户：crm_customers.created_at ∈ 本月（未删除），按 owner_id 归属
#   - 转化数：crm_leads.converted_at ∈ 本月（未删除），按 owner_id 归属
#   - 跟进数：crm_follows.created_at ∈ 本月，按 created_by 归属（谁做的跟进）
#   - 完成率：crm_tasks（P7）本月任务完成率 =
#       本月完成(status=done 且 completed_at ∈ 本月) / (本月完成 + 当前未完成)
#       （未完成 = pending/in_progress；cancelled 排除；分母 0 → None）
# 权限：scope=mine 任何人（员工看自己）；scope=all 仅管理员（403）。
# =====================================================================


def _parse_month(
    month: str | None, ref: datetime | None
) -> tuple[datetime, datetime, str]:
    """解析 YYYY-MM → (month_start, month_end, label)。缺省 = ref 所在月。"""
    base = (ref or datetime.now(SHANGHAI)).astimezone(SHANGHAI)
    if month:
        try:
            y, m = (int(x) for x in month.split("-"))
            start = datetime(y, m, 1, tzinfo=SHANGHAI)
        except ValueError as e:
            raise ValueError("month 须为 YYYY-MM 格式") from e
    else:
        start = base.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        end = datetime(start.year + 1, 1, 1, tzinfo=SHANGHAI)
    else:
        end = datetime(start.year, start.month + 1, 1, tzinfo=SHANGHAI)
    return start, end, start.strftime("%Y-%m")


def _active_user_roster(db: Session) -> list[tuple[str, str]]:
    """活跃用户 (id::text, name)，排名名单与总人数口径。"""
    rows = (
        db.execute(
            text(
                "select id::text as id, name from public.user_accounts "
                "where is_active = true order by name"
            )
        )
        .mappings()
        .all()
    )
    return [(str(r["id"]), r["name"]) for r in rows]


def get_performance_board(
    db: Session,
    *,
    user_id: str | None,
    is_admin: bool,
    scope: str = "mine",
    month: str | None = None,
    sort_by: str = "converted_count",
    now: datetime | None = None,
) -> PerformanceBoard:
    """业绩看板：个人/全局业绩指标 + 按人排名（BLF-519）。

    - scope=mine：任何人可看自己的指标与排名（不泄露他人明细，ranking 为空）。
    - scope=all：仅管理员（require_admin 403）；返回全员合计 + 全员排名表。
    - sort_by ∈ {converted_count, new_customers, follow_count, completion_rate}：
      排名主键（默认转化数，最核心业绩）；并列时依次比转化/新增/跟进/完成率。
    """
    if scope == "all":
        require_admin(is_admin)
    month_start, month_end, month_label = _parse_month(month, now)

    # ---- 按人聚合（一条 SQL 各取一次，避免 N+1）----
    cust_rows = db.execute(
        select(CrmCustomer.owner_id, func.count())
        .where(
            CrmCustomer.is_deleted.is_(False),
            CrmCustomer.created_at >= month_start,
            CrmCustomer.created_at < month_end,
            CrmCustomer.owner_id.is_not(None),
        )
        .group_by(CrmCustomer.owner_id)
    ).all()
    new_by_owner = {str(oid): int(c) for oid, c in cust_rows}

    conv_rows = db.execute(
        select(CrmLead.owner_id, func.count())
        .where(
            CrmLead.is_deleted.is_(False),
            CrmLead.converted_at >= month_start,
            CrmLead.converted_at < month_end,
            CrmLead.owner_id.is_not(None),
        )
        .group_by(CrmLead.owner_id)
    ).all()
    conv_by_owner = {str(oid): int(c) for oid, c in conv_rows}

    follow_rows = db.execute(
        select(CrmFollow.created_by, func.count())
        .where(
            CrmFollow.created_at >= month_start,
            CrmFollow.created_at < month_end,
            CrmFollow.created_by.is_not(None),
        )
        .group_by(CrmFollow.created_by)
    ).all()
    follow_by_creator = {str(cid): int(c) for cid, c in follow_rows}

    done_rows = db.execute(
        select(CrmTask.owner_id, func.count())
        .where(
            CrmTask.status == "done",
            CrmTask.completed_at >= month_start,
            CrmTask.completed_at < month_end,
            CrmTask.owner_id.is_not(None),
        )
        .group_by(CrmTask.owner_id)
    ).all()
    done_by_owner = {str(oid): int(c) for oid, c in done_rows}

    open_rows = db.execute(
        select(CrmTask.owner_id, func.count())
        .where(
            CrmTask.status.in_(("pending", "in_progress")),
            CrmTask.owner_id.is_not(None),
        )
        .group_by(CrmTask.owner_id)
    ).all()
    open_by_owner = {str(oid): int(c) for oid, c in open_rows}

    def _metrics(oid: str) -> PerformanceMetrics:
        done = done_by_owner.get(oid, 0)
        open_ = open_by_owner.get(oid, 0)
        denom = done + open_
        return PerformanceMetrics(
            new_customers=new_by_owner.get(oid, 0),
            converted_count=conv_by_owner.get(oid, 0),
            follow_count=follow_by_creator.get(oid, 0),
            completion_rate=round(done / denom, 4) if denom > 0 else None,
        )

    # ---- 排名名单：活跃用户全员（含 0 业绩者，admin 看全局时可见）----
    roster = _active_user_roster(db)
    _SORT_KEYS = ("converted_count", "new_customers", "follow_count", "completion_rate")
    if sort_by not in _SORT_KEYS:
        raise ValueError(f"sort_by 须为 {_SORT_KEYS} 之一")
    primary = sort_by

    def _sort_key(item: tuple[PerformanceMetrics, str, str]) -> tuple:
        m, name, oid = item
        # 主键降序；completion_rate None 排最后；并列依次比转化/新增/跟进，再按姓名
        prim = (
            m.completion_rate if primary == "completion_rate" else getattr(m, primary)
        )
        # 升序 + 取负实现降序；None → +inf 排最后（避免 -1.0 排在 -0.5 前面）
        prim_key = float("inf") if prim is None else -prim
        return (
            prim_key,
            -m.converted_count,
            -m.new_customers,
            -m.follow_count,
            name or oid,
        )

    scored = sorted([(_metrics(oid), name, oid) for oid, name in roster], key=_sort_key)
    ranking = [
        PerformanceRankItem(
            rank=i + 1,
            owner_id=oid,
            owner_name=name or None,
            new_customers=m.new_customers,
            converted_count=m.converted_count,
            follow_count=m.follow_count,
            completion_rate=m.completion_rate,
        )
        for i, (m, name, oid) in enumerate(scored)
    ]
    total_users = len(roster)

    # ---- 我的指标 + 排名 ----
    mine = _metrics(user_id) if user_id else PerformanceMetrics()
    my_rank = next((r.rank for r in ranking if r.owner_id == user_id), None)

    if scope == "mine":
        return PerformanceBoard(
            scope="mine",
            month=month_label,
            mine=mine,
            my_rank=my_rank,
            total_users=total_users,
        )

    # ---- scope=all：全局合计 ----
    global_done = db.execute(
        select(func.count())
        .select_from(CrmTask)
        .where(
            CrmTask.status == "done",
            CrmTask.completed_at >= month_start,
            CrmTask.completed_at < month_end,
        )
    ).scalar_one()
    global_open = db.execute(
        select(func.count())
        .select_from(CrmTask)
        .where(CrmTask.status.in_(("pending", "in_progress")))
    ).scalar_one()
    global_new = db.execute(
        select(func.count())
        .select_from(CrmCustomer)
        .where(
            CrmCustomer.is_deleted.is_(False),
            CrmCustomer.created_at >= month_start,
            CrmCustomer.created_at < month_end,
        )
    ).scalar_one()
    global_conv = db.execute(
        select(func.count())
        .select_from(CrmLead)
        .where(
            CrmLead.is_deleted.is_(False),
            CrmLead.converted_at >= month_start,
            CrmLead.converted_at < month_end,
        )
    ).scalar_one()
    global_follow = db.execute(
        select(func.count())
        .select_from(CrmFollow)
        .where(CrmFollow.created_at >= month_start, CrmFollow.created_at < month_end)
    ).scalar_one()
    gdenom = int(global_done) + int(global_open)
    global_metrics = PerformanceMetrics(
        new_customers=int(global_new),
        converted_count=int(global_conv),
        follow_count=int(global_follow),
        completion_rate=round(int(global_done) / gdenom, 4) if gdenom > 0 else None,
    )
    return PerformanceBoard(
        scope="all",
        month=month_label,
        mine=mine,
        my_rank=my_rank,
        total_users=total_users,
        global_metrics=global_metrics,
        ranking=ranking,
    )


# =====================================================================
# P8 生命周期看板（BLF-520）— 客户从创建到里程碑事件的时间分布
#
# 口径（天数 = 事件时间 - 创建时间，向下钳制到 0，Asia/Shanghai 不参与计算）：
#   - first_follow（首次跟进）：客户创建 → 第一条跟进（crm_follows
#     entity_type='customer'）。线索转化时跟进会 re-parent 到客户
#     （created_at 早于客户创建），时长钳制到 0（同一天）即可，不扭曲分布。
#   - conversion（转化）：线索创建 → 转化（crm_leads.converted_at）。
#     客户自身无 converted_at，线索转客户是系统里唯一的转化事件。
#   - churn（流失）：客户创建 → 首次回公海。公海事件 = 审计 action='move_sea'
#     （手动释放）与系统回收跟进（created_by 为空且内容含「回收至公海」，
#     P3a 自动回收，见 sea_reclaim_service）中较早者；多次回公海取首次。
# 分桶边界（天）：[0,1) [1,3) [3,7) [7,14) [14,30) [30,∞) → 6 桶。
# =====================================================================

# 桶上界（天）；6 桶 = 5 个边界 + 无上限桶
_LIFECYCLE_BUCKET_EDGES = (1.0, 3.0, 7.0, 14.0, 30.0)
_LIFECYCLE_BUCKET_LABELS = (
    "1 天内",
    "1-3 天",
    "3-7 天",
    "7-14 天",
    "14-30 天",
    "30 天以上",
)
# P3a 自动回收系统跟进的内容标记（sea_reclaim_service._write_system_follow）
_SEA_RECLAIM_FOLLOW_MARK = "回收至公海"


def _lifecycle_bucket_index(days: float) -> int:
    """天数 → 桶下标（0..5）。"""
    for i, edge in enumerate(_LIFECYCLE_BUCKET_EDGES):
        if days < edge:
            return i
    return len(_LIFECYCLE_BUCKET_EDGES)


def _days_between(start: datetime, end: datetime) -> float:
    """两个时间点之间的天数；任一缺失或负值 → 0（钳制，避免 re-parent 噪音）。"""
    if start is None or end is None:
        return 0.0
    return max(0.0, (end - start).total_seconds() / 86400.0)


def _duration_summary(durations: list[float]) -> LifecycleSummary:
    """时长列表 → 摘要（均值 / 中位 P50 / P90 / 最大值）。"""
    if not durations:
        return LifecycleSummary()
    ordered = sorted(durations)
    n = len(ordered)
    median = ordered[n // 2] if n % 2 else (ordered[n // 2 - 1] + ordered[n // 2]) / 2.0
    p90 = ordered[min(n - 1, int(n * 0.9))]
    return LifecycleSummary(
        sample_count=n,
        avg_days=round(sum(ordered) / n, 1),
        median_days=round(median, 1),
        p90_days=round(p90, 1),
        max_days=round(ordered[-1], 1),
    )


def _buckets_from_durations(durations: list[float]) -> list[LifecycleBucket]:
    """时长列表 → 直方图分桶（含累计占比，前端漏斗叠加用）。"""
    n_buckets = len(_LIFECYCLE_BUCKET_EDGES) + 1
    counts = [0] * n_buckets
    for d in durations:
        counts[_lifecycle_bucket_index(d)] += 1
    n = max(len(durations), 1)
    cumulative = 0
    buckets = []
    for i in range(n_buckets):
        cumulative += counts[i]
        buckets.append(
            LifecycleBucket(
                label=_LIFECYCLE_BUCKET_LABELS[i],
                min_days=0.0 if i == 0 else _LIFECYCLE_BUCKET_EDGES[i - 1],
                max_days=None if i == n_buckets - 1 else _LIFECYCLE_BUCKET_EDGES[i],
                count=counts[i],
                pct=round(counts[i] / n, 4),
                cumulative_pct=round(cumulative / n, 4),
            )
        )
    return buckets


def _build_distribution(
    metric: str,
    label: str,
    description: str,
    durations: list[float],
    total_count: int,
) -> LifecycleDistribution:
    summary = _duration_summary(durations)
    summary.total_count = total_count
    return LifecycleDistribution(
        metric=metric,  # type: ignore[arg-type]
        label=label,
        description=description,
        buckets=_buckets_from_durations(durations),
        summary=summary,
    )


def get_lifecycle_board(
    db: Session,
    *,
    is_admin: bool,
) -> LifecycleBoard:
    """生命周期看板：客户从创建到 首次跟进/转化/流失 的时间分布（BLF-520）。

    仅管理员（require_admin）。三种分布各一条聚合查询，无 N+1；
    时长只依赖事件时间差，不随"现在"漂移（区别于漏斗 dwell）。
    """
    require_admin(is_admin)

    # ---- first_follow：客户创建 → 第一条跟进（LEFT JOIN 保无跟进客户）----
    cust_rows = db.execute(
        select(
            CrmCustomer.created_at,
            func.min(CrmFollow.created_at).label("first_follow_at"),
        )
        .select_from(CrmCustomer)
        .outerjoin(
            CrmFollow,
            (CrmFollow.entity_type == "customer")
            & (CrmFollow.entity_id == CrmCustomer.id),
        )
        .where(CrmCustomer.is_deleted.is_(False))
        .group_by(CrmCustomer.id, CrmCustomer.created_at)
    ).all()
    total_customers = len(cust_rows)
    ff_durations = [
        _days_between(r.created_at, r.first_follow_at)
        for r in cust_rows
        if r.first_follow_at is not None
    ]

    # ---- conversion：线索创建 → 转化（converted_at 非空）----
    conv_rows = db.execute(
        select(CrmLead.created_at, CrmLead.converted_at)
        .where(CrmLead.is_deleted.is_(False), CrmLead.converted_at.is_not(None))
        .order_by(CrmLead.id)
    ).all()
    total_leads = db.execute(
        select(func.count()).select_from(CrmLead).where(CrmLead.is_deleted.is_(False))
    ).scalar_one()
    conv_durations = [_days_between(r.created_at, r.converted_at) for r in conv_rows]

    # ---- churn：客户创建 → 首次回公海（审计 move_sea ∪ 系统回收跟进，取较早）----
    churn_events = (
        select(CrmAuditLog.entity_id, CrmAuditLog.created_at)
        .where(
            CrmAuditLog.entity_type == "customer",
            CrmAuditLog.action == "move_sea",
        )
        .union_all(
            select(CrmFollow.entity_id, CrmFollow.created_at).where(
                CrmFollow.entity_type == "customer",
                CrmFollow.created_by.is_(None),
                CrmFollow.content.contains(_SEA_RECLAIM_FOLLOW_MARK),
            )
        )
        .subquery()
    )
    churn_rows = db.execute(
        select(
            CrmCustomer.created_at,
            func.min(churn_events.c.created_at).label("churn_at"),
        )
        .select_from(CrmCustomer)
        .outerjoin(churn_events, churn_events.c.entity_id == CrmCustomer.id)
        .where(CrmCustomer.is_deleted.is_(False))
        .group_by(CrmCustomer.id, CrmCustomer.created_at)
    ).all()
    churn_durations = [
        _days_between(r.created_at, r.churn_at)
        for r in churn_rows
        if r.churn_at is not None
    ]

    now_in_sea = db.execute(
        select(func.count())
        .select_from(CrmCustomer)
        .where(CrmCustomer.is_deleted.is_(False), CrmCustomer.owner_id.is_(None))
    ).scalar_one()

    return LifecycleBoard(
        first_follow=_build_distribution(
            "first_follow",
            "首次跟进",
            "客户创建 → 第一条跟进记录",
            ff_durations,
            total_customers,
        ),
        conversion=_build_distribution(
            "conversion",
            "转化",
            "线索创建 → 转化完成（线索转客户）",
            conv_durations,
            total_leads,
        ),
        churn=_build_distribution(
            "churn",
            "流失",
            "客户创建 → 首次回公海",
            churn_durations,
            total_customers,
        ),
        now_in_sea=int(now_in_sea),
    )
