"""PT4 summary calculation module.

Builds financial summary rows and calculates costs from MonthlyReportPT4Calculation model.
"""
from __future__ import annotations

from datetime import date

from decimal import Decimal, ROUND_HALF_UP
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
    MonthlyReportTransaction,
    SkuRecord,
    Project,
)
from app.utils.country import normalize_country
from app.utils.constants import TWO_DP

from app.services.report.utils import (
    _empty_financial_row,
    _month_to_date,
    _month_to_str,
    _add_months,
    _month_range,
    _normalize_key,
    _to_decimal,
    _to_float,
    _round2,
)


def _build_financial_row(
    report_month: str,
    pt4: MonthlyReportPT4Calculation | None,
    *,
    credit_card_deduction_usd: Decimal | float | int | None = None,
    fob_cost_rmb: Decimal | float | int | None = None,
    first_leg_cost_rmb: Decimal | float | int | None = None,
) -> dict[str, Any]:
    """Build financial row dict from PT4 calculation.

    Args:
        report_month: YYYY-MM string
        pt4: PT4 calculation model or None
        credit_card_deduction_usd: Credit card deduction amount
        fob_cost_rmb: FOB cost in RMB
        first_leg_cost_rmb: First leg shipping cost in RMB

    Returns:
        Dict with financial metrics
    """
    if pt4 is None:
        return _empty_financial_row(
            report_month,
            credit_card_deduction_usd=credit_card_deduction_usd,
            fob_cost_rmb=fob_cost_rmb,
            first_leg_cost_rmb=first_leg_cost_rmb,
        )
    stored_credit_card = getattr(pt4, "credit_card_deduction_usd", None)
    resolved_credit_card = (
        stored_credit_card
        if stored_credit_card is not None
        else credit_card_deduction_usd
    )
    return {
        "report_month": report_month,
        "income_sales": _to_float(pt4.income_sales),
        "income_refund": _to_float(pt4.income_refund),
        "income_adjustment": _to_float(pt4.income_adjustment),
        "income_other": _to_float(pt4.income_other),
        "expense_selling_fee": _to_float(pt4.expense_selling_fee),
        "expense_fba_fee": _to_float(pt4.expense_fba_fee),
        "expense_inventory_fee": _to_float(pt4.expense_inventory_fee),
        "expense_service_fee": _to_float(pt4.expense_service_fee),
        "expense_advertising": _to_float(pt4.expense_advertising),
        "expense_other_fees": _to_float(pt4.expense_other_fees),
        "income_total": _to_float(pt4.income_total),
        "expense_total": _to_float(pt4.expense_total),
        "amazon_pay_back": _to_float(pt4.amazon_pay_back),
        "income_vat_total": _to_float(
            getattr(pt4, "income_vat_total", None) or 0
        ),
        "income_sales_with_tax": _to_float(
            getattr(pt4, "income_sales_with_tax", None) or 0
        ),
        "expense_vat_total": _to_float(
            getattr(pt4, "expense_vat_total", None) or 0
        ),
        "credit_card_deduction_usd": _to_float(resolved_credit_card),
        "fob_cost_rmb": _to_float(fob_cost_rmb),
        "first_leg_cost_rmb": _to_float(first_leg_cost_rmb),
        "has_source_report": True,
    }


def _resolve_operation_commission_rmb(
    *,
    db: Session,
    report: MonthlyReport,
    income_total: float,
    amazon_pay_back: float,
    exchange_rate: float,
) -> tuple[float, float]:
    """Calculate operation commission in RMB based on payback ratio or configured rate.

    Commission is calculated based on the project's commission_basis setting:
    - "cash_received": Uses payback ratio tiers (≥70%:15%, ≥60%:13%, etc.)
    - Otherwise: Uses configured commission_rate percentage

    Args:
        db: Database session
        report: Monthly report
        income_total: Total income
        amazon_pay_back: Amazon pay back amount
        exchange_rate: USD to RMB exchange rate

    Returns:
        Tuple of (commission_rmb, payable_total_rmb)
    """
    project = db.get(Project, report.project_id)
    commission_basis = (project.commission_basis or "").strip() if project else ""
    configured_rate = _to_float(project.commission_rate) if project else 0.0
    commission_usd = 0.0

    if commission_basis == "cash_received":
        payback_ratio = amazon_pay_back / income_total if income_total > 0 else 0
        if payback_ratio >= 0.7:
            configured_rate = 0.15
        elif payback_ratio >= 0.6:
            configured_rate = 0.13
        elif payback_ratio >= 0.5:
            configured_rate = 0.10
        elif payback_ratio >= 0.4:
            configured_rate = 0.07
        else:
            configured_rate = 0.0
        base = amazon_pay_back if amazon_pay_back > 0 else 0
        commission_usd = base * configured_rate
    else:
        configured_rate = max(0.0, min(1.0, configured_rate))
        commission_usd = income_total * configured_rate

    commission_rmb = commission_usd * exchange_rate
    payable_total_rmb = commission_rmb
    return commission_rmb, payable_total_rmb


def _resolve_financial_range(
    *,
    month_values: list[str],
    start_month: str | None,
    end_month: str | None,
) -> tuple[date, date]:
    """Resolve the financial date range with defaults.

    If neither start nor end month is specified, defaults to last 12 months.
    If only one is specified, derives the other from it.

    Args:
        month_values: List of YYYY-MM strings from existing data
        start_month: Optional start month
        end_month: Optional end month

    Returns:
        Tuple of (start_date, end_date)

    Raises:
        HTTPException: If start_month > end_month
    """
    parsed_start = _month_to_date(start_month) if start_month else None
    parsed_end = _month_to_date(end_month) if end_month else None

    current_month = date.today().replace(day=1)
    earliest_month = min(
        (_month_to_date(month) for month in month_values), default=None
    )

    if parsed_start is None and parsed_end is None:
        default_start = _add_months(current_month, -11)
        if earliest_month is not None and earliest_month > default_start:
            default_start = earliest_month
        parsed_start = default_start
        parsed_end = current_month
    elif parsed_start is None:
        parsed_end = parsed_end or current_month
        default_start = _add_months(parsed_end, -11)
        if earliest_month is not None and earliest_month > default_start:
            default_start = earliest_month
        parsed_start = default_start
    elif parsed_end is None:
        parsed_end = current_month

    if parsed_start > parsed_end:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="start_month cannot be greater than end_month",
        )
    return parsed_start, parsed_end


def _build_trend_point(row: dict[str, Any]) -> dict[str, Any]:
    """Build trend point data from financial row.

    Args:
        row: Financial row dict

    Returns:
        Dict with trend metrics
    """
    income_total = float(row["income_total"])
    expense_total = float(row["expense_total"])
    amazon_pay_back = float(row["amazon_pay_back"])
    vat_total = float(row.get("vat_total", 0.0) or 0.0)
    return {
        "report_month": row["report_month"],
        "income_total": income_total,
        "expense_total": expense_total,
        "amazon_pay_back": amazon_pay_back,
        "vat_total": vat_total,
        "net_amount": income_total + expense_total,
        "has_source_report": bool(row["has_source_report"]),
    }


def _load_monthly_cost_totals(
    db: Session,
    *,
    report_ids: list[int],
    project_name: str,
    country: str = "US",
) -> dict[int, dict[str, float]]:
    """Load monthly cost totals (FOB + first leg) by report ID.

    Cost is calculated by joining transactions with product costs:
    - FOB unit cost * quantity = FOB cost
    - First leg cost RMB * quantity = first leg cost
    - Refunds are excluded (cost already confirmed in original sale month)

    Args:
        db: Database session
        report_ids: List of report IDs
        project_name: Project name
        country: Country code

    Returns:
        Dict mapping report_id to {fob_cost_rmb, first_leg_cost_rmb}
    """
    if not report_ids:
        return {}

    cost_rows = (
        db.execute(
            select(SkuRecord)
            .where(
                SkuRecord.project_name == project_name,
                SkuRecord.country == normalize_country(country),
            )
            .order_by(SkuRecord.updated_at.desc(), SkuRecord.id.desc())
        )
        .scalars()
        .all()
    )

    cost_by_sku: dict[str, tuple[Decimal, Decimal]] = {}
    for row in cost_rows:
        sku_key = _normalize_key(row.sku)
        if not sku_key or sku_key in cost_by_sku:
            continue
        cost_by_sku[sku_key] = (
            _to_decimal(row.fob_unit_cost),
            _to_decimal(row.first_leg_cost_rmb),
        )
    if not cost_by_sku:
        return {}

    quantity_rows = db.execute(
        select(
            MonthlyReportTransaction.report_id.label("report_id"),
            MonthlyReportTransaction.sku.label("sku"),
            func.lower(func.trim(MonthlyReportTransaction.transaction_type)).label(
                "transaction_type"
            ),
            func.coalesce(func.sum(MonthlyReportTransaction.quantity), 0).label(
                "total_quantity"
            ),
        )
        .where(
            MonthlyReportTransaction.report_id.in_(report_ids),
            MonthlyReportTransaction.sku.is_not(None),
            func.lower(func.trim(MonthlyReportTransaction.transaction_type)).in_(
                ("order", "refund")
            ),
        )
        .group_by(
            MonthlyReportTransaction.report_id,
            MonthlyReportTransaction.sku,
            func.lower(func.trim(MonthlyReportTransaction.transaction_type)),
        )
    ).all()

    totals_by_report: dict[int, dict[str, Decimal]] = {}
    for row in quantity_rows:
        cost_pair = cost_by_sku.get(_normalize_key(row.sku))
        if cost_pair is None:
            continue
        if row.transaction_type == "refund":
            continue  # Cost already confirmed in original sale month
        quantity = _to_decimal(row.total_quantity)
        report_totals = totals_by_report.setdefault(
            int(row.report_id),
            {
                "fob_cost_rmb": Decimal("0"),
                "first_leg_cost_rmb": Decimal("0"),
            },
        )
        report_totals["fob_cost_rmb"] += quantity * cost_pair[0]
        report_totals["first_leg_cost_rmb"] += quantity * cost_pair[1]

    return {
        report_id: {
            "fob_cost_rmb": float(
                values["fob_cost_rmb"].quantize(TWO_DP, rounding=ROUND_HALF_UP)
            ),
            "first_leg_cost_rmb": float(
                values["first_leg_cost_rmb"].quantize(TWO_DP, rounding=ROUND_HALF_UP)
            ),
        }
        for report_id, values in totals_by_report.items()
    }


def _normalize_pt4_payload(pt4: dict[str, Any]) -> dict[str, Any]:
    """Normalize PT4 payload with proper rounding.

    Args:
        pt4: Raw PT4 dict

    Returns:
        Normalized dict with Decimal values
    """
    return {key: _round2(_to_decimal(value)) for key, value in pt4.items()}


__all__ = [
    "_build_financial_row",
    "_build_trend_point",
    "_load_monthly_cost_totals",
    "_normalize_pt4_payload",
    "_resolve_financial_range",
    "_resolve_operation_commission_rmb",
]
