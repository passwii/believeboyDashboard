"""
佣金比例覆盖服务。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.commission_ratio_override import CommissionRatioOverride

from app.services.system_management.shared import _to_decimal


def upsert_commission_ratio_overrides(
    db: Session,
    report_month: str,
    items: list[dict],
    updated_by: str | None = None,
) -> list[CommissionRatioOverride]:
    """Upsert 佣金比例覆盖。"""
    existing_rows = db.execute(
        select(CommissionRatioOverride).where(CommissionRatioOverride.report_month == report_month)
    ).scalars().all()
    existing_map = {(row.project_id, row.person_name, row.income_category): row for row in existing_rows}

    incoming_keys: set[tuple[int, str, str]] = set()
    for item in items:
        key = (item.project_id, item.person_name.strip(), item.income_category.value)
        if not key[1]:
            continue
        incoming_keys.add(key)
        row = existing_map.get(key)
        if row is None:
            row = CommissionRatioOverride(
                report_month=report_month,
                project_id=item.project_id,
                project_name=item.project_name.strip(),
                person_name=item.person_name.strip(),
                income_category=item.income_category.value,
                override_ratio=_to_decimal(item.override_ratio, "0.000001"),
            )
            db.add(row)
            existing_map[key] = row
        else:
            row.project_name = item.project_name.strip()
            row.override_ratio = _to_decimal(item.override_ratio, "0.000001")
        row.reason = (item.reason or "").strip() or None
        row.updated_by = (updated_by or "").strip() or None

    stale_rows = [row for key, row in existing_map.items() if key not in incoming_keys]
    for stale in stale_rows:
        db.delete(stale)

    db.commit()

    return db.execute(
        select(CommissionRatioOverride).where(CommissionRatioOverride.report_month == report_month).order_by(
            CommissionRatioOverride.person_name.asc(),
            CommissionRatioOverride.project_name.asc(),
            CommissionRatioOverride.income_category.asc(),
        )
    ).scalars().all()