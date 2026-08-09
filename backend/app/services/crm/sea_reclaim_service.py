"""公海自动回收服务（P3a + P9-3 价值分档）。

扫描有主但 N 天未跟进的客户/线索，自动掉公海（owner=null），防销售占着不跟。
每条回收写一条系统跟进（type=note, created_by=null）留痕，跟进时间线可见。

判定基准：
- 客户：COALESCE(last_follow_at, created_at) 距今 > N 天；排除 signed / 已删除 / 已在公海；
  且按价值分档差异化（P9-3, BLF-541）：rating=A（P6a 最高档）永不回收，
  B/C/D 档按 N 天回收。
- 线索：COALESCE(last_follow_at, next_follow_at, created_at) 距今 > N 天；排除 converted / discarded / 已删除 / 已在池。
  线索无价值分档（rating 仅客户有），维持统一阈值回收。
  P9-4 (BLF-542)：last_follow_at 置最前——跟进成功即重置计时（客户/线索一致），
  next_follow_at 仅作为存量数据（未跟过进）的回退口径。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmFollow, CrmLead

# 客户掉公海时不动的状态（已签约是成交资产，不回收）
_CUSTOMER_PROTECTED_STATUS = {"signed"}
# 客户按价值分档（P6a rating）差异化回收：A 档（最高价值）永不回公海（P9-3, BLF-541）
_CUSTOMER_PROTECTED_RATINGS = {"A"}
# 线索回收排除状态（已转化/已弃置不再流转）
_LEAD_PROTECTED_STATUS = {"converted", "discarded"}


def _write_system_follow(
    db: Session, entity_type: str, entity_id: int, days: int
) -> None:
    db.add(
        CrmFollow(
            entity_type=entity_type,
            entity_id=entity_id,
            type="note",
            content=f"超过 {days} 天未跟进，系统自动回收至公海",
            next_follow_at=None,
            created_by=None,  # 系统跟进，无操作人
        )
    )


def reclaim_stale_to_sea(
    db: Session,
    *,
    now: datetime | None = None,
    days: int,
) -> dict[str, int]:
    """扫描并回收 N 天未跟进的客户/线索。返回 {"customers": n, "leads": m}。"""
    moment = now or datetime.now(timezone.utc)
    cutoff = moment - timedelta(days=days)

    # ---- 客户 ----
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
    reclaimed_customers = 0
    for cust in customers:
        if cust.rating in _CUSTOMER_PROTECTED_RATINGS:
            continue  # A 档高价值客户永不回收（P9-3）
        ref = cust.last_follow_at or cust.created_at
        if ref is not None and ref < cutoff:
            cust.owner_id = None
            cust.next_follow_at = None
            _write_system_follow(db, "customer", cust.id, days)
            reclaimed_customers += 1

    # ---- 线索 ----
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
    reclaimed_leads = 0
    for lead in leads:
        # P9-4 (BLF-542): 跟进成功刷新 last_follow_at → 回收计时重置；
        # 存量数据（从未跟过进）回退 next_follow_at / created_at，旧口径无回归
        ref = lead.last_follow_at or lead.next_follow_at or lead.created_at
        if ref is not None and ref < cutoff:
            lead.owner_id = None
            lead.next_follow_at = None
            _write_system_follow(db, "lead", lead.id, days)
            reclaimed_leads += 1

    db.commit()
    return {"customers": reclaimed_customers, "leads": reclaimed_leads}
