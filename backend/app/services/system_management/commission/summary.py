"""
佣金汇总服务。
"""
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.commission_project_month import CommissionProjectMonth


def get_commission_yearly_monthly_summary(
    db: Session,
    year: str,
    country: str | None = None,
) -> list[dict]:
    """获取按月汇总的佣金数据。

    Args:
        db: 数据库会话
        year: 年份
        country: 国家代码，US/UK/DE。如果为 None 则查询所有国家并汇总。

    Returns list of dicts with report_month, income_total_usd, factory_commission_usd,
    factory_commission_rmb, received_rmb, receive_rate.
    """
    month_start = f"{year}-01"
    month_end = f"{year}-12"
    stmt = select(
        CommissionProjectMonth.report_month,
        func.sum(CommissionProjectMonth.income_total_usd).label("income_total_usd"),
        func.sum(CommissionProjectMonth.factory_commission_usd).label("factory_commission_usd"),
        func.sum(CommissionProjectMonth.factory_commission_rmb).label("factory_commission_rmb"),
        func.sum(CommissionProjectMonth.received_rmb).label("received_rmb"),
    ).where(
        CommissionProjectMonth.report_month >= month_start,
        CommissionProjectMonth.report_month <= month_end,
    )
    if country:
        stmt = stmt.where(CommissionProjectMonth.country == country)
    rows = db.execute(
        stmt.group_by(CommissionProjectMonth.report_month).order_by(CommissionProjectMonth.report_month.asc())
    ).all()

    monthly_map: dict[str, tuple[float, float, float, float]] = {}
    for row in rows:
        monthly_map[str(row.report_month)] = (
            float(row.income_total_usd or 0),
            float(row.factory_commission_usd or 0),
            float(row.factory_commission_rmb or 0),
            float(row.received_rmb or 0),
        )

    items = []
    for month in range(1, 13):
        rm = f"{year}-{month:02d}"
        iu, fcu, fcr, rr = monthly_map.get(rm, (0.0, 0.0, 0.0, 0.0))
        rr_rate = (rr / fcr) if fcr > 0 else 0.0
        items.append({
            "report_month": rm,
            "income_total_usd": iu,
            "factory_commission_usd": fcu,
            "factory_commission_rmb": fcr,
            "received_rmb": rr,
            "receive_rate": rr_rate,
        })

    return items


def get_commission_project_yearly_summary(
    db: Session,
    year: str,
    country: str | None = None,
) -> list[dict]:
    """获取按项目汇总的佣金数据（跨站点求和）。

    Args:
        db: 数据库会话
        year: 年份
        country: 国家代码，US/UK/DE。当前实现忽略此参数，汇总所有站点的数据。

    Returns list of dicts with project_id, project_name, months dict, etc.
    """
    month_start = f"{year}-01"
    month_end = f"{year}-12"
    # 按 (project_id, report_month) 分组，对所有数值字段求和
    stmt = select(
        CommissionProjectMonth.project_id,
        CommissionProjectMonth.report_month,
        func.max(CommissionProjectMonth.project_name).label("project_name"),
        func.sum(CommissionProjectMonth.income_total_usd).label("sum_income"),
        func.sum(CommissionProjectMonth.factory_commission_rmb).label("sum_commission"),
        func.sum(CommissionProjectMonth.received_rmb).label("sum_received"),
    ).where(
        CommissionProjectMonth.report_month >= month_start,
        CommissionProjectMonth.report_month <= month_end,
    ).group_by(
        CommissionProjectMonth.project_id,
        CommissionProjectMonth.report_month,
    ).order_by(
        CommissionProjectMonth.project_id.asc(),
        CommissionProjectMonth.report_month.asc(),
    )
    rows = db.execute(stmt).all()

    project_map: dict[int, dict] = {}
    for row in rows:
        pid = int(row.project_id)
        item = project_map.get(pid)
        if item is None:
            item = {
                "project_id": pid,
                "project_name": str(row.project_name or ""),
                "months": {},
                "total_income_usd": 0.0,
                "total_commission_rmb": 0.0,
                "total_received_rmb": 0.0,
                "receive_rate": 0.0,
            }
            project_map[pid] = item

        iv = float(row.sum_income or 0)
        cv = float(row.sum_commission or 0)
        rv = float(row.sum_received or 0)
        item["months"][str(row.report_month)] = {
            "report_month": str(row.report_month),
            "income_total_usd": iv,
            "factory_commission_rmb": cv,
            "received_rmb": rv,
            "receive_rate": (rv / cv) if cv > 0 else 0,
        }
        item["total_income_usd"] += iv
        item["total_commission_rmb"] += cv
        item["total_received_rmb"] += rv

    items = list(project_map.values())
    for item in items:
        item["receive_rate"] = (item["total_received_rmb"] / item["total_commission_rmb"]) if item["total_commission_rmb"] > 0 else 0

    return items


def update_commission_project_payment(
    db: Session,
    project_month_id: int,
    payment_status: str,
    received_rmb: float,
    note: str | None,
    now: datetime,
    operator: str | None = None,
) -> CommissionProjectMonth | None:
    """更新项目月度佣金支付状态。

    返回更新后的记录，如果不存在则返回 None。
    """
    from app.models.commission_record import CommissionRecord
    from app.schemas.system_management.commission._enums import CommissionPaymentStatus, CommissionProjectPaymentStatus
    from app.services.system_management.shared import _to_decimal

    row = db.execute(
        select(CommissionProjectMonth).where(CommissionProjectMonth.id == project_month_id)
    ).scalars().first()
    if row is None:
        return None

    row.payment_status = payment_status
    row.received_rmb = _to_decimal(str(received_rmb), "0.01")
    row.note = (note or "").strip() or None

    if payment_status == CommissionProjectPaymentStatus.unpaid.value:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
    else:
        row.payment_confirmed_at = now
        row.payment_confirmed_by = (operator or "").strip() or None

    row.updated_at = now

    # 更新关联的佣金记录
    if payment_status == CommissionProjectPaymentStatus.paid.value:
        for cr in db.execute(
            select(CommissionRecord).where(
                CommissionRecord.project_month_id == project_month_id,
                CommissionRecord.is_active.is_(True),
            )
        ).scalars().all():
            cr.payment_status = CommissionPaymentStatus.paid.value
            cr.payment_confirmed_at = now
            cr.payment_confirmed_by = row.payment_confirmed_by
            cr.is_locked = True
            cr.locked_at = now
            cr.locked_by = row.payment_confirmed_by
    else:
        for cr in db.execute(
            select(CommissionRecord).where(
                CommissionRecord.project_month_id == project_month_id,
                CommissionRecord.is_active.is_(True),
            )
        ).scalars().all():
            cr.payment_status = CommissionPaymentStatus.unpaid.value
            cr.payment_confirmed_at = None
            cr.payment_confirmed_by = None
            cr.is_locked = False
            cr.locked_at = None
            cr.locked_by = None

    db.commit()
    return row
