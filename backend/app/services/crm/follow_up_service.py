"""Follow-up service: 待跟进视图（P2b）。

按 ``next_follow_at`` 把客户/线索归入逾期/今日/本周三组（业务时区 Asia/Shanghai）。
销售只见自己名下（scope=mine），admin 可见全部（scope=all，路由层经 resolve_scope 降级）。
线索排除已转化/弃置；均排除已删除。owner 名与「上次跟进」批量查询，避免 N+1。
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmFollow, CrmLead
from app.schemas.crm import FollowUpGroups, FollowUpItem
from app.services.user_display import resolve_display_names

SHANGHAI = ZoneInfo("Asia/Shanghai")
_EXCLUDED_LEAD_STATUSES = ("converted", "discarded")


def _latest_follow_map(db: Session, pairs: list[tuple[str, int]]) -> dict[tuple[str, int], CrmFollow]:
    """每实体最新一条跟进（created_at desc, id desc 取首）。一次 IN 查询避免 N+1。"""
    if not pairs:
        return {}
    rows = (
        db.execute(
            select(CrmFollow)
            .where(tuple_(CrmFollow.entity_type, CrmFollow.entity_id).in_(pairs))
            .order_by(CrmFollow.created_at.desc(), CrmFollow.id.desc())
        )
        .scalars()
        .all()
    )
    result: dict[tuple[str, int], CrmFollow] = {}
    for f in rows:
        result.setdefault((f.entity_type, f.entity_id), f)
    return result


def list_follow_ups(
    db: Session,
    *,
    user_id: str | None,
    scope: str = "mine",
    now: datetime | None = None,
) -> FollowUpGroups:
    ref = (now or datetime.now(SHANGHAI)).astimezone(SHANGHAI)
    today_start = ref.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow_start = today_start + timedelta(days=1)
    days_until_sunday = 6 - ref.weekday()  # 周一=0 … 周日=6
    week_end = today_start + timedelta(days=days_until_sunday, hours=23, minutes=59, seconds=59)

    cur = user_id.strip() if user_id and user_id.strip() else None

    # ---- 客户 ----
    cstmt = select(CrmCustomer).where(
        CrmCustomer.is_deleted.is_(False), CrmCustomer.next_follow_at.is_not(None)
    )
    if scope == "mine" and cur is not None:
        cstmt = cstmt.where(CrmCustomer.owner_id == cur)
    customers = db.execute(cstmt).scalars().all()

    # ---- 线索（排除已转化/弃置）----
    lstmt = select(CrmLead).where(
        CrmLead.is_deleted.is_(False),
        CrmLead.next_follow_at.is_not(None),
        CrmLead.status.not_in(_EXCLUDED_LEAD_STATUSES),
    )
    if scope == "mine" and cur is not None:
        lstmt = lstmt.where(CrmLead.owner_id == cur)
    leads = db.execute(lstmt).scalars().all()

    # ---- 批量补字段 ----
    owner_ids = {c.owner_id for c in customers if c.owner_id} | {l.owner_id for l in leads if l.owner_id}
    owner_names = resolve_display_names(db, owner_ids)
    pairs = [("customer", c.id) for c in customers] + [("lead", l.id) for l in leads]
    latest = _latest_follow_map(db, pairs)

    def _bucket(nfa: datetime) -> str | None:
        nfa_sh = nfa.astimezone(SHANGHAI)
        if nfa_sh < today_start:
            return "overdue"
        if nfa_sh < tomorrow_start:
            return "today"
        if nfa_sh <= week_end:
            return "this_week"
        return None

    def _item(et: str, obj, name: str, subtitle: str | None, rating, status, intent) -> FollowUpItem:
        f = latest.get((et, obj.id))
        return FollowUpItem(
            entity_type=et,
            entity_id=obj.id,
            name=name,
            subtitle=subtitle,
            owner_id=obj.owner_id,
            owner_name=owner_names.get(obj.owner_id) if obj.owner_id else None,
            next_follow_at=obj.next_follow_at,
            last_follow_content=f.content if f else None,
            last_follow_at=f.created_at if f else None,
            rating=rating,
            status=status,
            intent=intent,
        )

    buckets: dict[str, list[FollowUpItem]] = {"overdue": [], "today": [], "this_week": []}
    for c in customers:
        b = _bucket(c.next_follow_at)
        if b is not None:
            buckets[b].append(_item("customer", c, c.name, c.industry, c.rating, c.status, None))
    for lead in leads:
        b = _bucket(lead.next_follow_at)
        if b is not None:
            buckets[b].append(_item("lead", lead, lead.name, lead.company, None, lead.status, lead.intent))

    for items in buckets.values():
        items.sort(key=lambda i: i.next_follow_at)

    return FollowUpGroups(
        overdue=buckets["overdue"],
        today=buckets["today"],
        this_week=buckets["this_week"],
        overdue_count=len(buckets["overdue"]),
        total_count=len(buckets["overdue"]) + len(buckets["today"]) + len(buckets["this_week"]),
    )
