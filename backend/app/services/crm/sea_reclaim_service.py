"""公海自动回收服务（P3a + P9-3 价值差异化）。

扫描有主但 N 天未跟进的客户/线索，自动掉公海（owner=null），防销售占着不跟。
每条回收写一条系统跟进（type=note, created_by=null）留痕，跟进时间线可见。

判定基准：
- 客户：COALESCE(last_follow_at, created_at) 距今 > N 天；排除 signed / 已删除 / 已在公海。
- 线索：COALESCE(next_follow_at, created_at) 距今 > N 天；排除 converted / discarded / 已删除 / 已在池。

P9-3 价值差异化（BLF-541）：
- ``exempt_ratings``（默认 {"A"}）：最高价值档永不回收（roadmap 文案 S/A 中
  S 档在 P6a 不存在，实际最高档 = A）。
- ``rating_days``（默认 {"B": 7, "C": 7}）：B/C 档 7 天回收；未配置的档位
  （如 D）回落全局 ``days``（保持 P3a 现状）。
- 线索无价值评分（rating 仅客户表），回收阈值维持全局 ``days``。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmFollow, CrmLead, CrmReclaimSetting

# 客户掉公海时不动的状态（已签约是成交资产，不回收）
_CUSTOMER_PROTECTED_STATUS = {"signed"}
# 线索回收排除状态（已转化/已弃置不再流转）
_LEAD_PROTECTED_STATUS = {"converted", "discarded"}

# P9-3 默认价值策略（与 crm_reclaim_settings 单行表 server_default 一致）
DEFAULT_EXEMPT_RATINGS = {"A"}
DEFAULT_RATING_DAYS = {"B": 7, "C": 7}
RECLAIM_SETTING_ID = 1


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


def get_reclaim_settings(db: Session) -> CrmReclaimSetting:
    """读取公海回收差异化配置；行缺失时按默认值补齐（幂等）。

    P9-3（BLF-541）：id=1 单行。默认 A 永不回收、B/C 7 天、D 回落全局阈值。
    """
    row = db.get(CrmReclaimSetting, RECLAIM_SETTING_ID)
    if row is not None:
        return row
    # 并发安全：ON CONFLICT DO NOTHING 后重查，谁插入都行
    db.execute(
        text(
            "insert into crm_reclaim_settings (id, exempt_ratings, rating_b_days, "
            "rating_c_days) values (:id, :exempt, :b_days, :c_days) "
            "on conflict (id) do nothing"
        ),
        {
            "id": RECLAIM_SETTING_ID,
            "exempt": ",".join(sorted(DEFAULT_EXEMPT_RATINGS)),
            "b_days": DEFAULT_RATING_DAYS["B"],
            "c_days": DEFAULT_RATING_DAYS["C"],
        },
    )
    db.commit()
    return db.get(CrmReclaimSetting, RECLAIM_SETTING_ID)  # type: ignore[return-value]


def reclaim_stale_to_sea(
    db: Session,
    *,
    now: datetime | None = None,
    days: int,
    exempt_ratings: set[str] | None = None,
    rating_days: dict[str, int] | None = None,
) -> dict[str, int]:
    """扫描并回收 N 天未跟进的客户/线索。返回 {"customers": n, "leads": m}。

    P9-3（BLF-541）价值差异化（可选参数，缺省时行为与 P3a 完全一致）：
    - ``exempt_ratings``：这些档位的客户永不回收。
    - ``rating_days``：按档位覆盖回收天数；未列出的档位回落 ``days``。
    """
    moment = now or datetime.now(timezone.utc)
    exempt = exempt_ratings or set()
    days_by_rating = rating_days or {}

    def _customer_days(cust: CrmCustomer) -> int:
        return days_by_rating.get(cust.rating, days)

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
        if cust.rating in exempt:
            continue  # 高价值档永不回收（P9-3）
        cutoff = moment - timedelta(days=_customer_days(cust))
        ref = cust.last_follow_at or cust.created_at
        if ref is not None and ref < cutoff:
            cust.owner_id = None
            cust.next_follow_at = None
            _write_system_follow(db, "customer", cust.id, _customer_days(cust))
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
    lead_cutoff = moment - timedelta(days=days)
    for lead in leads:
        ref = lead.next_follow_at or lead.created_at
        if ref is not None and ref < lead_cutoff:
            lead.owner_id = None
            lead.next_follow_at = None
            _write_system_follow(db, "lead", lead.id, days)
            reclaimed_leads += 1

    db.commit()
    return {"customers": reclaimed_customers, "leads": reclaimed_leads}
