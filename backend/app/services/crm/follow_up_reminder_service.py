"""7 天无跟进提醒服务（P9-1, BLF-539）。

扫描口径复用 P3a sea_reclaim（见 sea_reclaim_service）：
- 客户：COALESCE(last_follow_at, created_at) 距今 > N 天；排除 signed / 已删除 / 已在公海。
- 线索：COALESCE(last_follow_at, next_follow_at, created_at) 距今 > N 天；排除 converted / discarded / 已删除 / 已在池。
  P9-4 (BLF-542)：last_follow_at 置最前——跟进成功刷新即重置计时（与 sea_reclaim 一致），
  next_follow_at 仅作为存量数据（从未跟过进）的回退口径。

与 sea_reclaim 的差异：这里不回收，只「记账」——celery 每日 scan 命中 stale 实体时
写一条 active ``CrmReminderLog``（幂等：已有 active 记录则跳过，单次提醒语义）；
SSE 端点按实体当前 owner 推送 active 记录；跟进成功（follow_service.create_follow）
resolve 该实体记录，下次再 stale 可重新提醒（循环闭环）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import (
    CrmCustomer,
    CrmLead,
    CrmReminderLog,
    CrmReminderStatus,
    CrmReminderType,
)

# 客户/线索不参与提醒的状态（与 sea_reclaim 保护集一致）
_CUSTOMER_PROTECTED_STATUS = {"signed"}
_LEAD_PROTECTED_STATUS = {"converted", "discarded"}


def _current_user_id(user_id: str | None) -> str | None:
    if user_id is None:
        return None
    uid = user_id.strip()
    return uid or None


def _customer_stale(cust: CrmCustomer, cutoff: datetime) -> bool:
    ref = cust.last_follow_at or cust.created_at
    return ref is not None and ref < cutoff


def _lead_stale(lead: CrmLead, cutoff: datetime) -> bool:
    # P9-4 (BLF-542): 跟进成功刷新 last_follow_at → stale 判定重置（与 sea_reclaim 一致）
    ref = lead.last_follow_at or lead.next_follow_at or lead.created_at
    return ref is not None and ref < cutoff


def _active_log_keys(db: Session) -> set[tuple[str, int]]:
    """当前全部 active stale_follow_up 记录的 (entity_type, entity_id)。"""
    rows = db.execute(
        select(CrmReminderLog.entity_type, CrmReminderLog.entity_id).where(
            CrmReminderLog.reminder_type == CrmReminderType.STALE_FOLLOW_UP,
            CrmReminderLog.status == CrmReminderStatus.ACTIVE,
        )
    ).all()
    return {(r[0], r[1]) for r in rows}


def _active_logs(db: Session) -> list[CrmReminderLog]:
    return list(
        db.execute(
            select(CrmReminderLog).where(
                CrmReminderLog.reminder_type == CrmReminderType.STALE_FOLLOW_UP,
                CrmReminderLog.status == CrmReminderStatus.ACTIVE,
            )
        )
        .scalars()
        .all()
    )


def resolve_entity_reminders(db: Session, entity_type: str, entity_id: int) -> int:
    """resolve 某实体全部 active 提醒记录（跟进成功时调用）。

    返回 resolve 条数。只改 status 不 flush——由调用方统一 flush/commit。
    """
    rows = list(
        db.execute(
            select(CrmReminderLog).where(
                CrmReminderLog.reminder_type == CrmReminderType.STALE_FOLLOW_UP,
                CrmReminderLog.status == CrmReminderStatus.ACTIVE,
                CrmReminderLog.entity_type == entity_type,
                CrmReminderLog.entity_id == entity_id,
            )
        )
        .scalars()
        .all()
    )
    for log in rows:
        log.status = CrmReminderStatus.RESOLVED
    return len(rows)


def scan_stale_entities(
    db: Session,
    *,
    now: datetime | None = None,
    days: int,
) -> dict[str, int]:
    """每日扫描 N 天未跟进客户/线索，写入提醒记录（幂等）。返回新建条数。

    同时自愈：resolve 那些实体已不再 stale 的 active 记录（已跟进 / 已回收 /
    已删除 / 状态变更），保证账本与实体状态一致。
    """
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(days=days)

    # ---- 客户：owner 非空 + 未删 + 非 signed + stale ----
    customers = (
        db.execute(
            select(CrmCustomer).where(
                CrmCustomer.is_deleted.is_(False),
                CrmCustomer.owner_id.is_not(None),
                CrmCustomer.status.not_in(_CUSTOMER_PROTECTED_STATUS),
            )
        )
        .scalars()
        .all()
    )
    stale_customer_ids = {c.id for c in customers if _customer_stale(c, cutoff)}

    # ---- 线索：owner 非空 + 未删 + 非 converted/discarded + stale ----
    leads = (
        db.execute(
            select(CrmLead).where(
                CrmLead.is_deleted.is_(False),
                CrmLead.owner_id.is_not(None),
                CrmLead.status.not_in(_LEAD_PROTECTED_STATUS),
            )
        )
        .scalars()
        .all()
    )
    stale_lead_ids = {l.id for l in leads if _lead_stale(l, cutoff)}

    stale_keys: set[tuple[str, int]] = {
        ("customer", cid) for cid in stale_customer_ids
    } | {("lead", lid) for lid in stale_lead_ids}

    active_keys = _active_log_keys(db)

    # ---- 自愈：active 记录对应实体已不再 stale → resolve ----
    resolved = 0
    for log in _active_logs(db):
        if (log.entity_type, log.entity_id) not in stale_keys:
            log.status = CrmReminderStatus.RESOLVED
            resolved += 1

    # ---- 新建：stale 且无 active 记录 → 插一条（单次提醒语义） ----
    customer_by_id = {c.id: c for c in customers}
    lead_by_id = {l.id: l for l in leads}
    created_customers = 0
    created_leads = 0
    for cid in sorted(stale_customer_ids):
        if ("customer", cid) in active_keys:
            continue
        cust = customer_by_id[cid]
        db.add(
            CrmReminderLog(
                entity_type="customer",
                entity_id=cid,
                reminder_type=CrmReminderType.STALE_FOLLOW_UP,
                owner_id=cust.owner_id,
                status=CrmReminderStatus.ACTIVE,
                reminded_at=moment,
            )
        )
        created_customers += 1
    for lid in sorted(stale_lead_ids):
        if ("lead", lid) in active_keys:
            continue
        lead = lead_by_id[lid]
        db.add(
            CrmReminderLog(
                entity_type="lead",
                entity_id=lid,
                reminder_type=CrmReminderType.STALE_FOLLOW_UP,
                owner_id=lead.owner_id,
                status=CrmReminderStatus.ACTIVE,
                reminded_at=moment,
            )
        )
        created_leads += 1

    db.flush()
    return {"customers": created_customers, "leads": created_leads}


def list_user_stale_reminders(
    db: Session,
    *,
    user_id: str | None,
    now: datetime | None = None,
    days: int = 7,
) -> list[dict]:
    """SSE 推送源（BLF-539）：当前用户应提醒的 stale 实体列表。

    条件：active stale_follow_up 记录 AND 实体当前 owner=user_id AND 实体未删
    且未处于保护状态 AND 实体仍 stale（自愈兜底：follow 后即使 resolve 漏执行
    也不再推送）。返回 [{entity_type, entity_id, name, days}]，days=实际未跟进天数。
    """
    cur = _current_user_id(user_id)
    if cur is None:
        return []
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(days=days)

    results: list[dict] = []

    cust_logs = db.execute(
        select(CrmReminderLog, CrmCustomer)
        .join(
            CrmCustomer,
            (CrmReminderLog.entity_type == "customer")
            & (CrmReminderLog.entity_id == CrmCustomer.id),
        )
        .where(
            CrmReminderLog.reminder_type == CrmReminderType.STALE_FOLLOW_UP,
            CrmReminderLog.status == CrmReminderStatus.ACTIVE,
            CrmCustomer.owner_id == cur,
            CrmCustomer.is_deleted.is_(False),
            CrmCustomer.status.not_in(_CUSTOMER_PROTECTED_STATUS),
        )
    ).all()
    for _log, cust in cust_logs:
        ref = cust.last_follow_at or cust.created_at
        if ref is not None and ref < cutoff:
            results.append(
                {
                    "entity_type": "customer",
                    "entity_id": cust.id,
                    "name": cust.name,
                    "days": max(0, (moment - ref).days),
                }
            )

    lead_logs = db.execute(
        select(CrmReminderLog, CrmLead)
        .join(
            CrmLead,
            (CrmReminderLog.entity_type == "lead")
            & (CrmReminderLog.entity_id == CrmLead.id),
        )
        .where(
            CrmReminderLog.reminder_type == CrmReminderType.STALE_FOLLOW_UP,
            CrmReminderLog.status == CrmReminderStatus.ACTIVE,
            CrmLead.owner_id == cur,
            CrmLead.is_deleted.is_(False),
            CrmLead.status.not_in(_LEAD_PROTECTED_STATUS),
        )
    ).all()
    for _log, lead in lead_logs:
        ref = lead.last_follow_at or lead.next_follow_at or lead.created_at
        if ref is not None and ref < cutoff:
            results.append(
                {
                    "entity_type": "lead",
                    "entity_id": lead.id,
                    "name": lead.name,
                    "days": max(0, (moment - ref).days),
                }
            )

    results.sort(key=lambda r: (-r["days"], r["entity_type"], r["entity_id"]))
    return results
