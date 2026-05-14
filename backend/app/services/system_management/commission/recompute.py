"""
佣金重计算服务。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.commission_project_month import CommissionProjectMonth
from app.models.commission_record import CommissionRecord
from app.models.exchange_rate import ExchangeRate
from app.models.monthly_report import MonthlyReport, MonthlyReportPT4Calculation
from app.models.project import Project
from app.models.project_role_assignment import ProjectRoleAssignment

from app.schemas.system_management.commission._enums import (
    CommissionPaymentStatus,
    CommissionProjectPaymentStatus,
    CommissionRatioSource,
)

from app.services.system_management.commission._commission_calculator import (
    _build_default_bonus_ratios,
    _resolve_factory_commission,
)
from app.services.system_management.shared import _to_decimal, _dedupe_names, _split_role_names


def recompute_commission_records(
    db: Session,
    report_month: str,
    now: datetime,
) -> tuple[int, int, int]:
    """重新计算佣金记录。

    Returns:
        (project_month_count, record_count, locked_record_count)
    """
    report_rows = db.execute(
        select(MonthlyReport, MonthlyReportPT4Calculation).join(
            MonthlyReportPT4Calculation, MonthlyReportPT4Calculation.report_id == MonthlyReport.id
        ).where(
            MonthlyReport.report_month == report_month,
            MonthlyReport.is_current.is_(True),
        ).order_by(MonthlyReport.project_id.asc())
    ).all()

    project_ids = [int(report.project_id) for report, _pt4 in report_rows]
    if not project_ids:
        return 0, 0, 0

    projects = db.execute(select(Project).where(Project.id.in_(project_ids))).scalars().all()
    project_map = {int(project.id): project for project in projects}

    exchange_rate = db.execute(
        select(ExchangeRate).where(ExchangeRate.currency == "USD", ExchangeRate.year_month == report_month)
    ).scalars().first()
    if exchange_rate is None:
        raise ValueError(f"USD exchange rate for {report_month} not found")
    usd_to_rmb_rate = exchange_rate.rate

    role_rows = db.execute(
        select(ProjectRoleAssignment).where(
            ProjectRoleAssignment.project_id.in_(project_ids),
            ProjectRoleAssignment.effective_from_month <= report_month,
            (ProjectRoleAssignment.effective_to_month.is_(None)) | (ProjectRoleAssignment.effective_to_month >= report_month),
        )
    ).scalars().all()
    roles_by_project: dict[int, dict[str, list[str]]] = {}
    for row in role_rows:
        roles_by_project.setdefault(int(row.project_id), {"operator": [], "assistant": []})[row.role_type].append(row.person_name.strip())

    from app.models.commission_ratio_override import CommissionRatioOverride
    override_rows = db.execute(
        select(CommissionRatioOverride).where(CommissionRatioOverride.report_month == report_month)
    ).scalars().all()
    override_map = {(int(row.project_id), row.person_name.strip(), row.income_category): row for row in override_rows}

    existing_project_months = db.execute(
        select(CommissionProjectMonth).where(CommissionProjectMonth.report_month == report_month)
    ).scalars().all()
    project_month_map = {int(row.project_id): row for row in existing_project_months}

    existing_records = db.execute(
        select(CommissionRecord).where(CommissionRecord.report_month == report_month)
    ).scalars().all()
    record_map = {(int(row.project_id), row.person_name.strip(), row.income_category): row for row in existing_records}

    incoming_record_keys: set[tuple[int, str, str]] = set()
    locked_record_count = 0

    for report, pt4 in report_rows:
        project = project_map.get(int(report.project_id))
        if project is None:
            continue

        income_total_usd = _to_decimal(pt4.income_total, "0.01")
        amazon_pay_back = _to_decimal(pt4.amazon_pay_back, "0.01")
        factory_commission_rate, _, factory_commission_usd = _resolve_factory_commission(
            project.commission_basis, project.commission_rate, income_total_usd, amazon_pay_back,
        )
        factory_commission_rmb = _to_decimal(factory_commission_usd * usd_to_rmb_rate, "0.01")

        pm_row = project_month_map.get(int(project.id))
        if pm_row is None:
            pm_row = CommissionProjectMonth(
                report_month=report_month,
                project_id=project.id,
                project_name=project.project_name,
                payment_status=CommissionProjectPaymentStatus.unpaid.value,
            )
            db.add(pm_row)
            project_month_map[int(project.id)] = pm_row

        pm_row.project_name = project.project_name
        pm_row.income_total_usd = income_total_usd
        pm_row.factory_commission_rate = _to_decimal(factory_commission_rate, "0.000001")
        pm_row.usd_to_rmb_rate = _to_decimal(usd_to_rmb_rate, "0.00000001")
        pm_row.factory_commission_usd = factory_commission_usd
        pm_row.factory_commission_rmb = factory_commission_rmb
        pm_row.computed_at = now

        fallback_roles = roles_by_project.get(int(project.id), {"operator": [], "assistant": []})
        operator_names = _dedupe_names(fallback_roles["operator"]) or _dedupe_names(_split_role_names(project.project_operator))
        assistant_names = _dedupe_names(fallback_roles["assistant"]) or _dedupe_names([project.assistant_operator or ""])
        default_ratio_map = _build_default_bonus_ratios(
            income_total_usd=income_total_usd, operator_names=operator_names, assistant_names=assistant_names,
        )

        for (person_name, income_category), default_ratio in default_ratio_map.items():
            incoming_record_keys.add((int(project.id), person_name, income_category))
            override_row = override_map.get((int(project.id), person_name, income_category))
            ratio_value = override_row.override_ratio if override_row is not None else default_ratio
            ratio_source = CommissionRatioSource.manual if override_row is not None else CommissionRatioSource.rule
            manual_ratio = override_row.override_ratio if override_row is not None else None
            bonus_amount_usd = _to_decimal(factory_commission_usd * ratio_value, "0.01")

            row = record_map.get((int(project.id), person_name, income_category))
            if row is None:
                row = CommissionRecord(
                    report_month=report_month,
                    project_id=project.id,
                    project_name=project.project_name,
                    project_month_id=pm_row.id,
                    person_name=person_name,
                    income_category=income_category,
                    payment_status=CommissionPaymentStatus.unpaid.value,
                    is_active=True,
                )
                db.add(row)
                record_map[(int(project.id), person_name, income_category)] = row

            row.income_total_usd = _to_decimal(income_total_usd, "0.01")
            row.factory_commission_rate = _to_decimal(factory_commission_rate, "0.000001")
            row.operator_bonus_ratio = _to_decimal(ratio_value, "0.000001")
            row.bonus_amount_usd = bonus_amount_usd
            row.usd_to_rmb_rate = _to_decimal(usd_to_rmb_rate, "0.00000001")
            row.bonus_amount_rmb = _to_decimal(bonus_amount_usd * usd_to_rmb_rate, "0.01")
            row.bonus_ratio_source = ratio_source.value
            row.manual_bonus_ratio = _to_decimal(manual_ratio, "0.000001") if manual_ratio is not None else None
            row.computed_at = now

            if row.is_locked:
                locked_record_count += 1

    db.flush()
    for row in project_month_map.values():
        if row.id is None:
            db.flush()
            break

    stale_records = [
        row for (pid, pn, ic), row in record_map.items()
        if (pid, pn, ic) not in incoming_record_keys and row.is_active
    ]
    for stale in stale_records:
        stale.is_active = False
        stale.deactivated_at = now

    db.flush()
    for row in project_month_map.values():
        if row.id is None:
            db.flush()
            break

    for record_key in incoming_record_keys:
        row = record_map.get(record_key)
        if row is not None and row.project_month_id is None:
            pm_row = project_month_map.get(record_key[0])
            if pm_row is not None:
                row.project_month_id = pm_row.id

    db.commit()

    return len(project_ids), len(incoming_record_keys), locked_record_count