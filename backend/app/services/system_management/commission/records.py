"""
佣金记录服务。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.commission_project_month import CommissionProjectMonth
from app.models.commission_record import CommissionRecord

from app.schemas.system_management.commission._enums import (
    CommissionPaymentStatus,
    CommissionProjectPaymentStatus,
    CommissionRatioSource,
)

from app.services.system_management.shared import _to_decimal, _to_iso


def upsert_commission_records(
    db: Session,
    report_month: str,
    items: list[dict],
    now: datetime,
) -> list[CommissionRecord]:
    """Upsert 佣金记录。

    Args:
        db: 数据库会话
        report_month: 报表月份 (YYYY-MM)
        items: 佣金记录项列表
        now: 当前时间

    Returns:
        所有活跃的佣金记录列表
    """
    project_items: dict[int, dict[str, str | float | int]] = {}
    for item in items:
        if item.project_id not in project_items:
            project_items[item.project_id] = {
                "project_name": item.project_name.strip(),
                "income_total_usd": item.income_total_usd,
                "factory_commission_rate": item.factory_commission_rate,
                "usd_to_rmb_rate": item.usd_to_rmb_rate,
            }
            continue
        project_items[item.project_id].update({
            "project_name": item.project_name.strip(),
            "income_total_usd": item.income_total_usd,
            "factory_commission_rate": item.factory_commission_rate,
            "usd_to_rmb_rate": item.usd_to_rmb_rate,
        })

    existing_project_months = db.execute(
        select(CommissionProjectMonth).where(CommissionProjectMonth.report_month == report_month)
    ).scalars().all()
    project_month_map = {row.project_id: row for row in existing_project_months}

    for project_id, values in project_items.items():
        pm_row = project_month_map.get(project_id)
        if pm_row is None:
            pm_row = CommissionProjectMonth(
                report_month=report_month,
                project_id=project_id,
                project_name=str(values["project_name"]).strip(),
                payment_status=CommissionProjectPaymentStatus.unpaid.value,
            )
            db.add(pm_row)
            project_month_map[project_id] = pm_row

        income_total_usd = _to_decimal(values["income_total_usd"], "0.01")
        factory_commission_rate = _to_decimal(values["factory_commission_rate"], "0.000001")
        usd_to_rmb_rate = _to_decimal(values["usd_to_rmb_rate"], "0.00000001")
        factory_commission_usd = _to_decimal(income_total_usd * factory_commission_rate, "0.01")
        factory_commission_rmb = _to_decimal(factory_commission_usd * usd_to_rmb_rate, "0.01")

        pm_row.project_name = str(values["project_name"]).strip()
        pm_row.income_total_usd = income_total_usd
        pm_row.factory_commission_rate = factory_commission_rate
        pm_row.usd_to_rmb_rate = usd_to_rmb_rate
        pm_row.factory_commission_usd = factory_commission_usd
        pm_row.factory_commission_rmb = factory_commission_rmb
        pm_row.computed_at = now

    db.flush()

    existing_rows = db.execute(
        select(CommissionRecord).where(CommissionRecord.report_month == report_month)
    ).scalars().all()
    existing_map = {(row.project_id, row.person_name, row.income_category): row for row in existing_rows}
    incoming_keys: set[tuple[int, str, str]] = set()

    for item in items:
        key = (item.project_id, item.person_name.strip(), item.income_category.value)
        if not key[1]:
            continue
        incoming_keys.add(key)
        pm_row = project_month_map.get(item.project_id)
        row = existing_map.get(key)
        if row is None:
            row = CommissionRecord(
                report_month=report_month,
                project_id=item.project_id,
                project_name=item.project_name.strip(),
                project_month_id=pm_row.id if pm_row else None,
                person_name=item.person_name.strip(),
                income_category=item.income_category.value,
                payment_status=CommissionPaymentStatus.unpaid.value,
                is_active=True,
            )
            db.add(row)
            existing_map[key] = row

        row.project_name = item.project_name.strip()
        row.project_month_id = pm_row.id if pm_row else None
        row.is_active = True
        row.deactivated_at = None

        if row.is_locked:
            continue

        bonus_ratio_source = item.bonus_ratio_source
        manual_bonus_ratio_value: float | None = item.manual_bonus_ratio
        if manual_bonus_ratio_value is not None:
            bonus_ratio_source = CommissionRatioSource.manual

        row.income_total_usd = _to_decimal(item.income_total_usd, "0.01")
        row.factory_commission_rate = _to_decimal(item.factory_commission_rate, "0.000001")
        row.operator_bonus_ratio = _to_decimal(item.operator_bonus_ratio, "0.000001")
        row.bonus_amount_usd = _to_decimal(item.bonus_amount_usd, "0.01")
        row.usd_to_rmb_rate = _to_decimal(item.usd_to_rmb_rate, "0.00000001")
        row.bonus_amount_rmb = _to_decimal(item.bonus_amount_rmb, "0.01")
        row.bonus_ratio_source = bonus_ratio_source.value
        row.manual_bonus_ratio = _to_decimal(manual_bonus_ratio_value, "0.000001") if manual_bonus_ratio_value is not None else None
        row.computed_at = now

    stale_rows = [row for old_key, row in existing_map.items() if old_key not in incoming_keys and row.is_active]
    for stale in stale_rows:
        stale.is_active = False
        stale.deactivated_at = now

    db.commit()

    return db.execute(
        select(CommissionRecord).where(
            CommissionRecord.report_month == report_month,
            CommissionRecord.is_active.is_(True),
        ).order_by(
            CommissionRecord.person_name.asc(),
            CommissionRecord.project_name.asc(),
            CommissionRecord.income_category.asc(),
        )
    ).scalars().all()


def update_commission_payment_status(
    db: Session,
    record_id: int,
    payment_status: str,
    now: datetime,
    operator: str | None = None,
) -> CommissionRecord | None:
    """更新佣金记录支付状态。

    返回更新后的记录，如果不存在则返回 None。
    """
    row = db.execute(
        select(CommissionRecord).where(CommissionRecord.id == record_id)
    ).scalars().first()
    if row is None:
        return None

    row.payment_status = payment_status
    if payment_status == CommissionPaymentStatus.paid.value:
        row.payment_confirmed_at = now
        row.payment_confirmed_by = (operator or "").strip() or None
        row.is_locked = True
        row.locked_at = now
        row.locked_by = (operator or "").strip() or None
    else:
        row.payment_confirmed_at = None
        row.payment_confirmed_by = None
        row.is_locked = False
        row.locked_at = None
        row.locked_by = None
    row.updated_at = now

    db.commit()
    return row