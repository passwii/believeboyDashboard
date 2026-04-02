from __future__ import annotations

from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, func, insert, select, update as sa_update
from sqlalchemy.orm import Session

from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
    MonthlyReportTransaction,
    ProductCost,
    Project,
)
from app.models.job import JobStatus

try:
    from app.services.redis_service import invalidate_financial_series_cache
except ImportError:
    invalidate_financial_series_cache = None

TWO_DP = Decimal("0.01")
TZ_OFFSET_BY_ABBR = {
    "UTC": 0,
    "GMT": 0,
    "PST": -8,
    "PDT": -7,
    "MST": -7,
    "MDT": -6,
    "CST": -6,
    "CDT": -5,
    "EST": -5,
    "EDT": -4,
}
_SQLITE_TABLES_READY = False
_SQLITE_TABLES_LOCK = Lock()


def ensure_tables(db: Session) -> None:
    global _SQLITE_TABLES_READY
    bind = db.get_bind()
    if bind.dialect.name != "sqlite":
        return
    if _SQLITE_TABLES_READY:
        return

    with _SQLITE_TABLES_LOCK:
        if _SQLITE_TABLES_READY:
            return

        for table in (
            MonthlyReport.__table__,
            MonthlyReportTransaction.__table__,
            MonthlyReportPT3Calculation.__table__,
            MonthlyReportPT4Calculation.__table__,
        ):
            table.create(bind=bind, checkfirst=True)
        _SQLITE_TABLES_READY = True


def parse_report_month(value: str) -> str:
    raw = (value or "").strip()
    try:
        parsed = datetime.strptime(raw, "%Y-%m")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="report_month must be YYYY-MM",
        ) from exc
    return parsed.strftime("%Y-%m")


def get_project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    return project


def get_project_by_name_or_404(db: Session, project_name: str) -> Project:
    normalized = (project_name or "").strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="project_name is required",
        )

    project = (
        db.execute(select(Project).where(Project.project_name == normalized))
        .scalars()
        .first()
    )
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    return project


def prepare_monthly_report(
    db: Session,
    *,
    project_id: int,
    project_name: str,
    report_month: str,
    transaction_file_id: str,
    transaction_file_path: str,
    summary_pdf_file_id: str | None,
    summary_pdf_file_path: str | None,
    file_size: int | None,
) -> MonthlyReport:
    ensure_tables(db)
    get_project_or_404(db, project_id)

    latest_version = db.execute(
        select(MonthlyReport.version)
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.report_month == report_month,
        )
        .order_by(MonthlyReport.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    next_version = (latest_version or 0) + 1

    current_report = (
        db.execute(
            select(MonthlyReport).where(
                MonthlyReport.project_id == project_id,
                MonthlyReport.report_month == report_month,
                MonthlyReport.is_current.is_(True),
            )
        )
        .scalars()
        .first()
    )

    report = MonthlyReport(
        project_id=project_id,
        project_name=project_name,
        report_month=report_month,
        version=next_version,
        is_current=current_report is None,
        superseded_at=None,
        transaction_file_id=transaction_file_id,
        transaction_file_path=transaction_file_path,
        summary_pdf_file_id=summary_pdf_file_id,
        summary_pdf_file_path=summary_pdf_file_path,
        file_size=file_size,
        status=JobStatus.pending,
        error_message=None,
        total_transactions=0,
        total_orders=0,
        total_refunds=0,
        total_adjustments=0,
        total_service_fees=0,
        total_trans_fees=0,
        calculation_version=1,
        result_file_path=None,
        settlement_id=None,
        computed_at=None,
    )
    db.add(report)
    db.flush()
    db.refresh(report)
    return report


def _clear_report_children(db: Session, report_id: int) -> None:
    db.execute(
        delete(MonthlyReportTransaction).where(
            MonthlyReportTransaction.report_id == report_id
        )
    )
    db.execute(
        delete(MonthlyReportPT3Calculation).where(
            MonthlyReportPT3Calculation.report_id == report_id
        )
    )
    db.execute(
        delete(MonthlyReportPT4Calculation).where(
            MonthlyReportPT4Calculation.report_id == report_id
        )
    )


def mark_report_running(db: Session, report_id: int) -> None:
    report = db.get(MonthlyReport, report_id)
    if report is None:
        return
    _clear_report_children(db, report_id)
    report.status = JobStatus.running
    report.error_message = None
    db.flush()


def mark_report_failed(db: Session, report_id: int, error_message: str) -> None:
    report = db.get(MonthlyReport, report_id)
    if report is None:
        return
    report.status = JobStatus.failed
    report.error_message = (error_message or "")[:4000]
    db.flush()


def persist_monthly_report_result(
    db: Session,
    *,
    report_id: int,
    result: dict[str, Any],
    calculation_version: int = 1,
) -> None:
    report = db.get(MonthlyReport, report_id)
    if report is None:
        raise ValueError(f"monthly report not found: {report_id}")

    rows = result.get("transactions")
    pt3 = result.get("pt3")
    pt4 = result.get("pt4")
    if (
        not isinstance(rows, list)
        or not isinstance(pt3, dict)
        or not isinstance(pt4, dict)
    ):
        raise ValueError("monthly report result payload missing transactions/pt3/pt4")

    _clear_report_children(db, report_id)
    transaction_payloads = _build_transaction_payloads(
        report_id=report_id,
        project_name=report.project_name,
        report_month=report.report_month,
        rows=rows,
    )
    if transaction_payloads:
        db.execute(insert(MonthlyReportTransaction), transaction_payloads)

    db.add(
        MonthlyReportPT3Calculation(
            report_id=report_id,
            project_name=report.project_name,
            report_month=report.report_month,
            calculation_version=calculation_version,
            computed_at=datetime.now(UTC),
            **_normalize_pt3_payload(pt3),
        )
    )
    db.add(
        MonthlyReportPT4Calculation(
            report_id=report_id,
            project_name=report.project_name,
            report_month=report.report_month,
            calculation_version=calculation_version,
            computed_at=datetime.now(UTC),
            **_normalize_pt4_payload(pt4),
        )
    )

    report.status = JobStatus.success
    report.error_message = None
    db.execute(
        sa_update(MonthlyReport)
        .where(
            MonthlyReport.project_id == report.project_id,
            MonthlyReport.report_month == report.report_month,
            MonthlyReport.id != report.id,
            MonthlyReport.is_current.is_(True),
        )
        .values(is_current=False, superseded_at=datetime.now(UTC))
    )
    report.is_current = True
    report.superseded_at = None
    report.result_file_path = str(result.get("result_path") or "") or None
    report.settlement_id = _first_non_empty(rows, "settlement id")
    report.calculation_version = calculation_version
    report.computed_at = datetime.now(UTC)
    report.total_transactions = len(rows)
    report.total_orders = sum(
        1 for row in rows if str(row.get("type", "")).strip() == "Order"
    )
    report.total_refunds = sum(
        1 for row in rows if str(row.get("type", "")).strip() == "Refund"
    )
    report.total_adjustments = sum(
        1 for row in rows if str(row.get("type", "")).strip() == "Adjustment"
    )
    report.total_service_fees = sum(
        1 for row in rows if str(row.get("type", "")).strip() == "Service Fee"
    )
    report.total_trans_fees = sum(
        1 for row in rows if str(row.get("type", "")).strip() == "FBA Transaction fees"
    )
    db.flush()

    if invalidate_financial_series_cache is not None:
        invalidate_financial_series_cache(report.project_id)


def list_reports(
    db: Session,
    *,
    project_id: int | None = None,
    report_month: str | None = None,
    current_only: bool = True,
) -> list[MonthlyReport]:
    ensure_tables(db)
    stmt = select(MonthlyReport).order_by(
        MonthlyReport.report_month.desc(), MonthlyReport.id.desc()
    )
    if current_only:
        stmt = stmt.where(MonthlyReport.is_current.is_(True))
    if project_id is not None:
        stmt = stmt.where(MonthlyReport.project_id == project_id)
    if report_month is not None:
        stmt = stmt.where(MonthlyReport.report_month == report_month)
    return list(db.execute(stmt).scalars().all())


def get_report_or_404(db: Session, report_id: int) -> MonthlyReport:
    ensure_tables(db)
    row = db.get(MonthlyReport, report_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Monthly report not found"
        )
    return row


def get_report_detail(
    db: Session,
    *,
    report_id: int,
) -> tuple[
    MonthlyReport,
    MonthlyReportPT3Calculation | None,
    MonthlyReportPT4Calculation | None,
]:
    report = get_report_or_404(db, report_id)
    pt3 = db.execute(
        select(MonthlyReportPT3Calculation).where(
            MonthlyReportPT3Calculation.report_id == report_id
        )
    ).scalar_one_or_none()
    pt4 = db.execute(
        select(MonthlyReportPT4Calculation).where(
            MonthlyReportPT4Calculation.report_id == report_id
        )
    ).scalar_one_or_none()
    return report, pt3, pt4


def get_financial_series(
    db: Session,
    *,
    project_id: int,
    start_month: str | None = None,
    end_month: str | None = None,
    fill_missing: bool = True,
) -> dict[str, Any]:
    ensure_tables(db)
    project = get_project_or_404(db, project_id)
    if start_month:
        parse_report_month(start_month)
    if end_month:
        parse_report_month(end_month)

    debt_sum_subquery = (
        select(
            MonthlyReportTransaction.report_id.label("report_id"),
            func.coalesce(func.sum(MonthlyReportTransaction.total), 0).label(
                "credit_card_deduction_usd"
            ),
        )
        .where(
            func.lower(func.trim(MonthlyReportTransaction.transaction_type)) == "debt"
        )
        .group_by(MonthlyReportTransaction.report_id)
        .subquery()
    )

    query_rows = db.execute(
        select(MonthlyReport, MonthlyReportPT4Calculation)
        .add_columns(debt_sum_subquery.c.credit_card_deduction_usd)
        .outerjoin(
            MonthlyReportPT4Calculation,
            MonthlyReportPT4Calculation.report_id == MonthlyReport.id,
        )
        .outerjoin(debt_sum_subquery, debt_sum_subquery.c.report_id == MonthlyReport.id)
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.is_current.is_(True),
        )
        .order_by(MonthlyReport.report_month.asc())
    ).all()

    report_ids = [int(row[0].id) for row in query_rows if row and row[0] is not None]
    cost_totals_by_report = _load_monthly_cost_totals(
        db,
        report_ids=report_ids,
        project_name=project.project_name,
    )

    month_to_row: dict[str, dict[str, Any]] = {}
    for row in query_rows:
        report = row[0]
        pt4 = row[1] if len(row) > 1 else None
        credit_card_deduction_usd = row[2] if len(row) > 2 else None
        cost_totals = cost_totals_by_report.get(int(report.id), {})
        month_to_row[report.report_month] = _build_financial_row(
            report.report_month,
            pt4,
            credit_card_deduction_usd=credit_card_deduction_usd,
            fob_cost_rmb=cost_totals.get("fob_cost_rmb", 0),
            first_leg_cost_rmb=cost_totals.get("first_leg_cost_rmb", 0),
        )

    start_date, end_date = _resolve_financial_range(
        month_values=list(month_to_row.keys()),
        start_month=start_month,
        end_month=end_month,
    )

    months = _month_range(start_date, end_date)
    rows: list[dict[str, Any]] = []
    if fill_missing:
        for month in months:
            rows.append(month_to_row.get(month) or _empty_financial_row(month))
    else:
        for month in months:
            row = month_to_row.get(month)
            if row is not None:
                rows.append(row)

    trend_points = [_build_trend_point(row) for row in rows]
    income_total_sum = sum(point["income_total"] for point in trend_points)
    expense_total_sum = sum(point["expense_total"] for point in trend_points)
    amazon_pay_back_sum = sum(point["amazon_pay_back"] for point in trend_points)
    net_amount_sum = sum(point["net_amount"] for point in trend_points)

    return {
        "project_id": project.id,
        "project_name": project.project_name,
        "start_month": _month_to_str(start_date),
        "end_month": _month_to_str(end_date),
        "rows": rows,
        "trend": {
            "income_total_sum": income_total_sum,
            "expense_total_sum": expense_total_sum,
            "amazon_pay_back_sum": amazon_pay_back_sum,
            "net_amount_sum": net_amount_sum,
            "points": trend_points,
        },
    }


def resolve_result_path(report: MonthlyReport) -> Path | None:
    if not report.result_file_path:
        return None
    result_path = Path(report.result_file_path)
    if not result_path.is_absolute():
        return None
    if not result_path.exists() or not result_path.is_file():
        return None
    return result_path


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal("0")
    text = str(value).strip().replace(",", "")
    if not text:
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    return float(value)


def _round2(value: Decimal) -> Decimal:
    return value.quantize(TWO_DP, rounding=ROUND_HALF_UP)


def _parse_transaction_datetime(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise ValueError("transaction date is empty")

    parts = text.rsplit(" ", 1)
    if len(parts) == 2 and parts[1] in TZ_OFFSET_BY_ABBR:
        naive = datetime.strptime(parts[0], "%b %d, %Y %I:%M:%S %p")
        tz = timezone(timedelta(hours=TZ_OFFSET_BY_ABBR[parts[1]]))
        return naive.replace(tzinfo=tz).astimezone(UTC)

    for fmt in ("%b %d, %Y %I:%M:%S %p %Z", "%Y-%m-%d %H:%M:%S"):
        try:
            parsed = datetime.strptime(text, fmt)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=UTC)
            return parsed.astimezone(UTC)
        except ValueError:
            continue

    raise ValueError(f"invalid transaction date: {text}")


def _build_transaction_payloads(
    *,
    report_id: int,
    project_name: str,
    report_month: str,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        payloads.append(
            {
                "report_id": report_id,
                "project_name": project_name,
                "report_month": report_month,
                "source_row_no": index,
                "transaction_date": _parse_transaction_datetime(row.get("date/time")),
                "settlement_id": _normalize_text(row.get("settlement id")),
                "transaction_type": _normalize_text(row.get("type")) or "",
                "order_id": _normalize_text(row.get("order id")),
                "sku": _normalize_text(row.get("sku")),
                "description": _normalize_text(row.get("description")),
                "quantity": int(_to_decimal(row.get("quantity"))),
                "marketplace": _normalize_text(row.get("marketplace")),
                "account_type": _normalize_text(row.get("account type")),
                "fulfillment": _normalize_text(row.get("fulfillment")),
                "order_city": _normalize_text(row.get("order city")),
                "order_state": _normalize_text(row.get("order state")),
                "order_postal": _normalize_text(row.get("order postal")),
                "tax_collection_model": _normalize_text(
                    row.get("tax collection model")
                ),
                "product_sales": _round2(_to_decimal(row.get("product sales"))),
                "product_sales_tax": _round2(_to_decimal(row.get("product sales tax"))),
                "shipping_credits": _round2(_to_decimal(row.get("shipping credits"))),
                "shipping_credits_tax": _round2(
                    _to_decimal(row.get("shipping credits tax"))
                ),
                "gift_wrap_credits": _round2(_to_decimal(row.get("gift wrap credits"))),
                "gift_wrap_credits_tax": _round2(
                    _to_decimal(row.get("giftwrap credits tax"))
                ),
                "regulatory_fee": _round2(_to_decimal(row.get("Regulatory Fee"))),
                "regulatory_fee_tax": _round2(
                    _to_decimal(row.get("Tax On Regulatory Fee"))
                ),
                "promotional_rebates": _round2(
                    _to_decimal(row.get("promotional rebates"))
                ),
                "promotional_rebates_tax": _round2(
                    _to_decimal(row.get("promotional rebates tax"))
                ),
                "marketplace_withheld_tax": _round2(
                    _to_decimal(row.get("marketplace withheld tax"))
                ),
                "selling_fees": _round2(_to_decimal(row.get("selling fees"))),
                "fba_fees": _round2(_to_decimal(row.get("fba fees"))),
                "other_transaction_fees": _round2(
                    _to_decimal(row.get("other transaction fees"))
                ),
                "other_amount": _round2(_to_decimal(row.get("other"))),
                "total": _round2(_to_decimal(row.get("total"))),
                "raw_row": {
                    str(k): "" if v is None else str(v) for k, v in row.items()
                },
            }
        )
    return payloads


def _first_non_empty(rows: list[dict[str, Any]], key: str) -> str | None:
    for row in rows:
        value = _normalize_text(row.get(key))
        if value:
            return value
    return None


def _normalize_pt3_payload(pt3: dict[str, Any]) -> dict[str, Any]:
    payload = {key: _round2(_to_decimal(value)) for key, value in pt3.items()}
    if "advertising_percentage" in payload:
        payload["advertising_percentage"] = _to_decimal(
            pt3["advertising_percentage"]
        ).quantize(Decimal("0.0001"))
    else:
        payload["advertising_percentage"] = Decimal("0")
    return payload


def _normalize_pt4_payload(pt4: dict[str, Any]) -> dict[str, Any]:
    return {key: _round2(_to_decimal(value)) for key, value in pt4.items()}


def _month_to_date(value: str) -> date:
    return datetime.strptime(parse_report_month(value), "%Y-%m").date().replace(day=1)


def _month_to_str(value: date) -> str:
    return value.strftime("%Y-%m")


def _add_months(base: date, delta: int) -> date:
    month_index = (base.year * 12 + (base.month - 1)) + delta
    year = month_index // 12
    month = month_index % 12 + 1
    return date(year, month, 1)


def _month_range(start: date, end: date) -> list[str]:
    cursor = start
    months: list[str] = []
    while cursor <= end:
        months.append(_month_to_str(cursor))
        cursor = _add_months(cursor, 1)
    return months


def _resolve_financial_range(
    *,
    month_values: list[str],
    start_month: str | None,
    end_month: str | None,
) -> tuple[date, date]:
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


def _build_financial_row(
    report_month: str,
    pt4: MonthlyReportPT4Calculation | None,
    *,
    credit_card_deduction_usd: Decimal | float | int | None = None,
    fob_cost_rmb: Decimal | float | int | None = None,
    first_leg_cost_rmb: Decimal | float | int | None = None,
) -> dict[str, Any]:
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
        "credit_card_deduction_usd": _to_float(resolved_credit_card),
        "fob_cost_rmb": _to_float(fob_cost_rmb),
        "first_leg_cost_rmb": _to_float(first_leg_cost_rmb),
        "has_source_report": True,
    }


def _empty_financial_row(
    report_month: str,
    *,
    credit_card_deduction_usd: Decimal | float | int | None = None,
    fob_cost_rmb: Decimal | float | int | None = None,
    first_leg_cost_rmb: Decimal | float | int | None = None,
) -> dict[str, Any]:
    return {
        "report_month": report_month,
        "income_sales": 0.0,
        "income_refund": 0.0,
        "income_adjustment": 0.0,
        "income_other": 0.0,
        "expense_selling_fee": 0.0,
        "expense_fba_fee": 0.0,
        "expense_inventory_fee": 0.0,
        "expense_service_fee": 0.0,
        "expense_advertising": 0.0,
        "expense_other_fees": 0.0,
        "income_total": 0.0,
        "expense_total": 0.0,
        "amazon_pay_back": 0.0,
        "credit_card_deduction_usd": _to_float(credit_card_deduction_usd),
        "fob_cost_rmb": _to_float(fob_cost_rmb),
        "first_leg_cost_rmb": _to_float(first_leg_cost_rmb),
        "has_source_report": False,
    }


def _normalize_key(value: str | None) -> str:
    return (value or "").strip().lower()


def _load_monthly_cost_totals(
    db: Session,
    *,
    report_ids: list[int],
    project_name: str,
) -> dict[int, dict[str, float]]:
    if not report_ids:
        return {}

    cost_rows = (
        db.execute(
            select(ProductCost)
            .where(
                ProductCost.project_name == project_name,
                ProductCost.is_active.is_(True),
            )
            .order_by(ProductCost.updated_at.desc(), ProductCost.id.desc())
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
        quantity = _to_decimal(row.total_quantity)
        if row.transaction_type == "refund":
            quantity = -quantity
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


def _build_trend_point(row: dict[str, Any]) -> dict[str, Any]:
    income_total = float(row["income_total"])
    expense_total = float(row["expense_total"])
    amazon_pay_back = float(row["amazon_pay_back"])
    return {
        "report_month": row["report_month"],
        "income_total": income_total,
        "expense_total": expense_total,
        "amazon_pay_back": amazon_pay_back,
        "net_amount": income_total + expense_total,
        "has_source_report": bool(row["has_source_report"]),
    }
