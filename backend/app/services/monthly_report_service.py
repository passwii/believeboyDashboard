from __future__ import annotations

from collections import defaultdict
from io import BytesIO
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, func, insert, select, update as sa_update
from sqlalchemy.orm import Session
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, NamedStyle, PatternFill, Side
from openpyxl.utils import get_column_letter

from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
    MonthlyReportTransaction,
    ProductCost,
    Project,
    ExchangeRate,
)
from app.models.job import JobStatus
from app.services.payment_report_locale import normalize_country

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
    country: str = "US",
    report_month: str,
    transaction_file_id: str,
    transaction_file_path: str,
    summary_pdf_file_id: str | None,
    summary_pdf_file_path: str | None,
    file_size: int | None,
) -> MonthlyReport:
    ensure_tables(db)
    get_project_or_404(db, project_id)
    normalized_country = normalize_country(country)

    latest_version = db.execute(
        select(MonthlyReport.version)
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.country == normalized_country,
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
                MonthlyReport.country == normalized_country,
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
        country=normalized_country,
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
            MonthlyReport.country == report.country,
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
    country: str | None = None,
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
    if country is not None:
        stmt = stmt.where(MonthlyReport.country == normalize_country(country))
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
    country: str = "US",
    start_month: str | None = None,
    end_month: str | None = None,
    fill_missing: bool = True,
) -> dict[str, Any]:
    ensure_tables(db)
    project = get_project_or_404(db, project_id)
    normalized_country = normalize_country(country)
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
            MonthlyReport.country == normalized_country,
            MonthlyReport.is_current.is_(True),
        )
        .order_by(MonthlyReport.report_month.asc())
    ).all()

    report_ids = [int(row[0].id) for row in query_rows if row and row[0] is not None]
    cost_totals_by_report = _load_monthly_cost_totals(
        db,
        report_ids=report_ids,
        project_name=project.project_name,
        country=normalized_country,
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


def get_financial_accounting_detail(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
    report_month: str,
) -> dict[str, Any]:
    ensure_tables(db)
    month = parse_report_month(report_month)
    project = get_project_or_404(db, project_id)

    report, pt3 = _load_report_with_pt3_or_404(
        db,
        project_id=project_id,
        country=country,
        report_month=month,
    )

    rows = _build_accounting_rows(pt3)
    return {
        "project_id": project.id,
        "project_name": project.project_name,
        "report_month": report.report_month,
        "rows": rows,
    }


def export_financial_accounting_detail_workbook(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
    report_month: str,
    is_admin: bool = False,
) -> tuple[str, bytes]:
    ensure_tables(db)
    month = parse_report_month(report_month)
    report, pt3 = _load_report_with_pt3_or_404(
        db,
        project_id=project_id,
        country=country,
        report_month=month,
    )
    pt4 = db.execute(
        select(MonthlyReportPT4Calculation).where(
            MonthlyReportPT4Calculation.report_id == report.id
        )
    ).scalar_one_or_none()
    if pt4 is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Monthly report accounting snapshot not found",
        )

    all_rows = _load_transaction_raw_rows(db, report_id=int(report.id))
    classified = _classify_monthly_rows(all_rows)
    debt_sum = db.execute(
        select(func.coalesce(func.sum(MonthlyReportTransaction.total), 0)).where(
            MonthlyReportTransaction.report_id == report.id,
            func.lower(func.trim(MonthlyReportTransaction.transaction_type)) == "debt",
        )
    ).scalar_one()
    cost_totals = _load_monthly_cost_totals(
        db,
        report_ids=[int(report.id)],
        project_name=report.project_name,
        country=report.country,
    ).get(int(report.id), {})
    financial_row = _build_financial_row(
        report_month=month,
        pt4=pt4,
        credit_card_deduction_usd=debt_sum,
        fob_cost_rmb=cost_totals.get("fob_cost_rmb", 0),
        first_leg_cost_rmb=cost_totals.get("first_leg_cost_rmb", 0),
    )
    exchange_rate = _load_usd_exchange_rate(db, month)
    project_row = db.get(Project, report.project_id)
    disable_commission = (
        project_row is None or not (project_row.commission_basis or "").strip()
    )
    commission_rmb, payable_total_rmb = _resolve_operation_commission_rmb(
        db=db,
        report=report,
        income_total=financial_row["income_total"],
        amazon_pay_back=financial_row["amazon_pay_back"],
        exchange_rate=exchange_rate,
    )
    net_profit_rmb = (
        financial_row["amazon_pay_back"] * exchange_rate
        - financial_row["fob_cost_rmb"]
        - financial_row["first_leg_cost_rmb"]
        - financial_row["credit_card_deduction_usd"] * exchange_rate
    )
    total_cost_usd = (
        (financial_row["fob_cost_rmb"] + financial_row["first_leg_cost_rmb"])
        / exchange_rate
        if exchange_rate > 0
        else 0
    )
    net_profit_usd = (
        financial_row["amazon_pay_back"]
        - total_cost_usd
        - financial_row["credit_card_deduction_usd"]
    )
    net_profit_rate = (
        net_profit_usd / financial_row["income_total"]
        if financial_row["income_total"] != 0
        else 0
    )

    wb = Workbook()
    ws = wb.active
    ws.title = "报表核算"
    ws.append(
        [
            "Income",
            "收入",
            "In金额（USD）",
            "In源表",
            "",
            "Expense",
            "支出",
            "Ex金额（USD）",
            "Ex源表",
        ]
    )
    for line in _build_accounting_rows(pt3):
        ws.append(
            [
                line["income_en"],
                line["income_zh"],
                line["income_amount_usd"],
                line["income_source"],
                "",
                line["expense_en"],
                line["expense_zh"],
                line["expense_amount_usd"],
                line["expense_source"],
            ]
        )

    sheets_to_write: list[tuple[str, list[dict[str, object]]]] = [
        ("交易一览", all_rows),
        ("销售SKU明细", _group_sku_quantity(classified["order"])),
        ("退款SKU明细", _group_sku_quantity(classified["refund"])),
        ("所有订单", classified["order"]),
        ("所有退款", classified["refund"]),
        ("FBM 订单", classified["fbm_order"]),
        ("FBM 退款", classified["fbm_refund"]),
        ("FBA 订单", classified["fba_order"]),
        ("FBA 退款", classified["fba_refund"]),
        ("FBA库存赔偿", classified["adjustment_income"]),
        ("其他赔偿", classified["adjustment_expense"]),
        ("清算费用", classified["liquidation"]),
        ("拒付退款", classified["chargeback_refund"]),
        ("FBA仓储及入库服务费", classified["fba_inventory_fee"]),
        ("服务费（不含广告）", classified["amazon_fees_and_service_fee_without_ad"]),
        ("广告费", classified["advertising"]),
        ("广告退款", classified["service_refund_for_advertiser"]),
    ]
    for sheet_name, rows in sheets_to_write:
        detail_ws = wb.create_sheet(title=sheet_name)
        _rows_to_sheet(detail_ws, rows)
        _auto_width(detail_ws)

    _apply_monthly_like_styles(wb)

    out = BytesIO()
    wb.save(out)
    safe_project = _safe_project_name(report.project_name)
    filename = f"{safe_project}-月度财务分析-{month}.xlsx"
    return filename, out.getvalue()


def resolve_result_path(report: MonthlyReport) -> Path | None:
    if not report.result_file_path:
        return None
    result_path = Path(report.result_file_path)
    if not result_path.is_absolute():
        return None
    if not result_path.exists() or not result_path.is_file():
        return None
    return result_path


def _safe_project_name(project_name: str) -> str:
    sanitized = "".join(ch for ch in project_name.strip() if ch not in r'\\/:*?"<>|')
    return sanitized or "unknown"


def _load_report_with_pt3_or_404(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
    report_month: str,
) -> tuple[MonthlyReport, MonthlyReportPT3Calculation]:
    normalized_country = normalize_country(country)
    row = db.execute(
        select(MonthlyReport, MonthlyReportPT3Calculation)
        .join(
            MonthlyReportPT3Calculation,
            MonthlyReportPT3Calculation.report_id == MonthlyReport.id,
        )
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.country == normalized_country,
            MonthlyReport.report_month == report_month,
            MonthlyReport.is_current.is_(True),
            MonthlyReport.status == JobStatus.success,
        )
        .limit(1)
    ).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Monthly report not found for selected month",
        )
    report, pt3 = row
    return report, pt3


def _pt3_float(pt3: MonthlyReportPT3Calculation, key: str) -> float:
    return _to_float(getattr(pt3, key, 0))


def _build_accounting_rows(pt3: MonthlyReportPT3Calculation) -> list[dict[str, Any]]:
    income_lines = [
        (
            "Product sales (non-FBA)",
            "销售额（非FBA）",
            _pt3_float(pt3, "income_product_sales_non_fba"),
            "FBM 订单-订单金额",
        ),
        (
            "Product sale refunds (non-FBA)",
            "销售额退款（非FBA）",
            _pt3_float(pt3, "income_product_sale_refunds_non_fba"),
            "FBM 退款-订单金额",
        ),
        (
            "FBA product sales",
            "销售额（FBA）",
            _pt3_float(pt3, "income_fba_product_sales"),
            "FBA 订单-订单金额",
        ),
        (
            "FBA product sale refunds",
            "销售额退款（FBA）",
            _pt3_float(pt3, "income_fba_product_sale_refunds"),
            "FBA 退款-订单金额 + 其他金额",
        ),
        (
            "FBA inventory credit",
            "FBA库存赔偿（FBA）",
            _pt3_float(pt3, "income_fba_inventory_credit"),
            "FBA库存赔偿-总计",
        ),
        (
            "FBA liquidation proceeds",
            "FBA清算收入",
            _pt3_float(pt3, "income_fba_liquidation_proceeds"),
            "清算费用-订单金额",
        ),
        (
            "Shipping credits",
            "运费收入",
            _pt3_float(pt3, "income_shipping_credits"),
            "所有订单-运费金额",
        ),
        (
            "Shipping credit refunds",
            "运费退款",
            _pt3_float(pt3, "income_shipping_credit_refunds"),
            "所有退款-运费金额",
        ),
        (
            "Gift wrap credits",
            "礼品包装收入",
            _pt3_float(pt3, "income_gift_wrap_credits"),
            "所有订单-礼品包装金额",
        ),
        (
            "Gift wrap credit refunds",
            "礼品包装退款",
            _pt3_float(pt3, "income_gift_wrap_credits_refunds"),
            "所有退款-礼品包装金额",
        ),
        (
            "Promotional rebates",
            "促销折扣",
            _pt3_float(pt3, "income_promotional_rebates"),
            "所有订单-促销折扣金额",
        ),
        (
            "Promotional rebate refunds",
            "促销折扣退款",
            _pt3_float(pt3, "income_promotional_rebate_refunds"),
            "所有退款-促销折扣金额",
        ),
        (
            "A-to-z Guarantee claims",
            "A-to-z保障索赔",
            _pt3_float(pt3, "income_a_to_z_guarantee_claims"),
            "",
        ),
        (
            "Chargebacks",
            "拒付退款",
            _pt3_float(pt3, "income_chargebacks"),
            "拒付退款-总计",
        ),
        (
            "SAFE-T reimbursement",
            "SAFE-T赔偿",
            _pt3_float(pt3, "income_safe_t_reimbursement"),
            "",
        ),
        ("Total_Income", "合计销售额", _pt3_float(pt3, "income_total"), ""),
    ]
    expense_lines = [
        (
            "Seller fulfilled selling fees",
            "卖家自配送销售佣金",
            _pt3_float(pt3, "expense_seller_fulfilled_selling_fees"),
            "FBM 订单-销售佣金",
        ),
        (
            "FBA selling fees",
            "FBA销售佣金",
            _pt3_float(pt3, "expense_fba_selling_fees"),
            "FBA 订单-销售佣金",
        ),
        (
            "Selling fee refunds",
            "销售佣金退款",
            _pt3_float(pt3, "expense_selling_fee_refunds"),
            "所有退款-销售佣金 + 退款管理费",
        ),
        (
            "FBA transaction fees",
            "FBA派送费",
            _pt3_float(pt3, "expense_fba_transaction_fees"),
            "FBA 订单 - 派送费",
        ),
        (
            "FBA transaction fee refunds",
            "FBA派送费退款",
            _pt3_float(pt3, "expense_fba_transaction_fee_refunds"),
            "FBA 退款 - 派送费 + 测量费",
        ),
        (
            "Other transaction fees",
            "其他交易费用",
            _pt3_float(pt3, "expense_other_transaction_fees"),
            "",
        ),
        (
            "Other transaction fee refunds",
            "其他交易费用退款",
            _pt3_float(pt3, "expense_other_transaction_fee_refunds"),
            "",
        ),
        (
            "FBA inventory and inbound services fees",
            "FBA库存和入库服务费",
            _pt3_float(pt3, "expense_fba_inventory_and_inbound_services_fees"),
            "FBA仓储及入库服务费 - 总计",
        ),
        (
            "Shipping label purchases",
            "购买配送标签",
            _pt3_float(pt3, "expense_shipping_label_purchases"),
            "",
        ),
        (
            "Shipping label refunds",
            "配送标签退款",
            _pt3_float(pt3, "expense_shipping_label_refunds"),
            "",
        ),
        (
            "Carrier shipping label adjustments",
            "承运商配送标签调整",
            _pt3_float(pt3, "expense_carrier_shipping_label_adjustments"),
            "",
        ),
        (
            "Service fees",
            "服务费",
            _pt3_float(pt3, "expense_service_fees"),
            "服务费（不含广告）-总计",
        ),
        (
            "Refund administration fees",
            "退款管理费",
            _pt3_float(pt3, "expense_refund_administration_fees"),
            "合并在销售佣金退款中扣除",
        ),
        (
            "Adjustments",
            "调整项",
            _pt3_float(pt3, "expense_adjustments"),
            "其他赔偿调整-总计",
        ),
        (
            "Cost of Advertising",
            "广告成本",
            _pt3_float(pt3, "expense_cost_of_advertising"),
            "广告费-总计",
        ),
        (
            "Refund for Advertiser",
            "广告商退款",
            _pt3_float(pt3, "expense_refund_for_advertiser"),
            "广告退款-总计",
        ),
        (
            "Liquidations fees",
            "清算处理费",
            _pt3_float(pt3, "expense_liquidations_fees"),
            "清算费用-其他交易费用",
        ),
        ("Receivables", "应收账款", _pt3_float(pt3, "expense_receivables"), ""),
        ("Deductions", "扣款", _pt3_float(pt3, "expense_deductions"), ""),
        (
            "Amazon Shipping Charge Adjustments",
            "亚马逊配送运费调整",
            _pt3_float(pt3, "expense_amazon_shipping_charge_adjustments"),
            "",
        ),
        ("Total_Expense", "合计费用", _pt3_float(pt3, "expense_total"), ""),
    ]

    max_len = max(len(income_lines), len(expense_lines))
    rows: list[dict[str, Any]] = []
    for idx in range(max_len):
        in_line = income_lines[idx] if idx < len(income_lines) else ("", "", 0.0, "")
        ex_line = expense_lines[idx] if idx < len(expense_lines) else ("", "", 0.0, "")
        rows.append(
            {
                "income_en": in_line[0],
                "income_zh": in_line[1],
                "income_amount_usd": in_line[2],
                "income_source": in_line[3],
                "expense_en": ex_line[0],
                "expense_zh": ex_line[1],
                "expense_amount_usd": ex_line[2],
                "expense_source": ex_line[3],
            }
        )
    return rows


def _load_transaction_raw_rows(
    db: Session, *, report_id: int
) -> list[dict[str, object]]:
    transactions = (
        db.execute(
            select(MonthlyReportTransaction)
            .where(MonthlyReportTransaction.report_id == report_id)
            .order_by(MonthlyReportTransaction.source_row_no.asc())
        )
        .scalars()
        .all()
    )
    rows: list[dict[str, object]] = []
    for tx in transactions:
        raw = dict(tx.raw_row or {})
        if "quantity" not in raw:
            raw["quantity"] = tx.quantity
        rows.append(raw)
    return rows


def _classify_monthly_rows(
    all_rows: list[dict[str, object]],
) -> dict[str, list[dict[str, object]]]:
    classified: dict[str, list[dict[str, object]]] = {
        "order": [],
        "refund": [],
        "chargeback_refund": [],
        "liquidation": [],
        "fba_inventory_fee": [],
        "amazon_fees_and_service_fee_without_ad": [],
        "fba_transaction_fees": [],
        "fba_order": [],
        "fbm_order": [],
        "fba_refund": [],
        "fbm_refund": [],
        "adjustment_income": [],
        "adjustment_expense": [],
        "advertising": [],
        "service_refund_for_advertiser": [],
    }
    adjustment_expense_descriptions = {
        "FBA Inventory Reimbursement - General Adjustment",
        "Non-subscription Fee Adjustment",
    }
    ad_excluded_descriptions = {"Cost of Advertising", "Refund for Advertiser"}

    for row in all_rows:
        row_type = str(row.get("type", "")).strip()
        description = str(row.get("description", "")).strip()
        fulfillment = str(row.get("fulfillment", "")).strip()

        if row_type == "Order":
            classified["order"].append(row)
            if fulfillment == "Amazon":
                classified["fba_order"].append(row)
            elif fulfillment == "Seller":
                classified["fbm_order"].append(row)
            continue
        if row_type == "Refund":
            classified["refund"].append(row)
            if fulfillment == "Amazon":
                classified["fba_refund"].append(row)
            elif fulfillment == "Seller":
                classified["fbm_refund"].append(row)
            continue
        if row_type == "Chargeback Refund":
            classified["chargeback_refund"].append(row)
            continue
        if row_type == "Liquidations":
            classified["liquidation"].append(row)
            continue
        if row_type == "FBA Inventory Fee":
            classified["fba_inventory_fee"].append(row)
            continue
        if row_type == "FBA Transaction fees":
            classified["fba_transaction_fees"].append(row)
            continue
        if row_type == "Adjustment":
            if description in adjustment_expense_descriptions:
                classified["adjustment_expense"].append(row)
            else:
                classified["adjustment_income"].append(row)
            continue
        if row_type == "Amazon Fees" or row_type == "Service Fee":
            if description not in ad_excluded_descriptions:
                classified["amazon_fees_and_service_fee_without_ad"].append(row)
            if row_type == "Service Fee" and description == "Cost of Advertising":
                classified["advertising"].append(row)
            elif row_type == "Service Fee" and description == "Refund for Advertiser":
                classified["service_refund_for_advertiser"].append(row)
            continue
    return classified


def _group_sku_quantity(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    grouped: dict[str, int] = defaultdict(int)
    for row in rows:
        sku = str(row.get("sku", "") or "")
        if not sku:
            continue
        grouped[sku] += int(_to_decimal(row.get("quantity") or 0))
    data = [{"sku": sku, "quantity": qty} for sku, qty in grouped.items()]
    data.sort(key=lambda item: item["quantity"], reverse=True)
    return data


def _rows_to_sheet(ws, rows: list[dict[str, object]]) -> None:
    if not rows:
        ws.append(["No Data"])
        return
    headers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            header = str(key)
            if header not in seen:
                seen.add(header)
                headers.append(header)
    ws.append(headers)
    for row in rows:
        ws.append([row.get(h, "") for h in headers])


def _auto_width(ws) -> None:
    for col in range(1, ws.max_column + 1):
        letter = get_column_letter(col)
        max_length = 0
        for row in range(1, ws.max_row + 1):
            value = ws.cell(row, col).value
            text = "" if value is None else str(value)
            max_length = max(max_length, min(len(text) + 2, 50))
        ws.column_dimensions[letter].width = max(10, max_length)


_ADMIN_ONLY_EXPORT_KEYS = {
    "evaluationFeeRmb",
    "prepaymentOtherRmb",
    "operationCommissionRmb",
    "payableTotalRmb",
    "exchangeRate",
}

_EXPORT_DETAIL_COLUMNS: list[dict[str, str]] = [
    {"key": "monthLabel", "title": "年月", "format": "text", "group": "基础信息"},
    {
        "key": "hasSourceReport",
        "title": "是否有源报表",
        "format": "boolean",
        "group": "基础信息",
    },
    {
        "key": "incomeSales",
        "title": "销售额",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "incomeRefund",
        "title": "退款",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "incomeAdjustment",
        "title": "赔偿",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "incomeOther",
        "title": "其他收入",
        "format": "currency_usd",
        "group": "平台收入",
    },
    {
        "key": "expenseSellingFee",
        "title": "平台费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseFbaFee",
        "title": "配送费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseInventoryFee",
        "title": "仓储费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseServiceFee",
        "title": "服务费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseAdvertising",
        "title": "广告费",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "expenseOtherFees",
        "title": "其他费用",
        "format": "currency_usd",
        "group": "平台支出",
    },
    {
        "key": "incomeTotal",
        "title": "收入合计",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "expenseTotal",
        "title": "支出合计",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "amazonPayBack",
        "title": "亚马逊回款",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "creditCardDeductionUsd",
        "title": "信用卡扣款",
        "format": "currency_usd",
        "group": "结果",
    },
    {
        "key": "evaluationFeeRmb",
        "title": "测评费用RMB",
        "format": "currency_rmb",
        "group": "运营结算",
    },
    {
        "key": "prepaymentOtherRmb",
        "title": "垫付其他RMB",
        "format": "currency_rmb",
        "group": "运营结算",
    },
    {
        "key": "operationCommissionRmb",
        "title": "运营佣金RMB",
        "format": "currency_rmb_nullable",
        "group": "运营结算",
    },
    {
        "key": "payableTotalRmb",
        "title": "应付总计RMB",
        "format": "currency_rmb_nullable",
        "group": "运营结算",
    },
    {"key": "exchangeRate", "title": "汇率", "format": "rate", "group": "运营结算"},
    {
        "key": "platformRatio",
        "title": "平台占比",
        "format": "percent",
        "group": "费用占比",
    },
    {
        "key": "deliveryRatio",
        "title": "配送占比",
        "format": "percent",
        "group": "费用占比",
    },
    {
        "key": "storageRatio",
        "title": "仓储占比",
        "format": "percent",
        "group": "费用占比",
    },
    {
        "key": "serviceRatio",
        "title": "服务占比",
        "format": "percent",
        "group": "费用占比",
    },
    {"key": "adRatio", "title": "广告占比", "format": "percent", "group": "费用占比"},
    {"key": "refundRatio", "title": "退款率", "format": "percent", "group": "费用占比"},
    {
        "key": "paybackRatio",
        "title": "回款率",
        "format": "percent_signed",
        "group": "费用占比",
    },
    {
        "key": "fobCostRmb",
        "title": "FOB成本RMB",
        "format": "currency_rmb",
        "group": "成本核算",
    },
    {
        "key": "firstLegCostRmb",
        "title": "头程成本RMB",
        "format": "currency_rmb",
        "group": "成本核算",
    },
    {
        "key": "netProfitRmb",
        "title": "净利润RMB",
        "format": "currency_rmb",
        "group": "成本核算",
    },
    {
        "key": "netProfitUsd",
        "title": "净利润USD",
        "format": "currency_usd",
        "group": "成本核算",
    },
    {
        "key": "netProfitRate",
        "title": "净利率",
        "format": "percent_signed",
        "group": "成本核算",
    },
]


def _format_month_label(month: str) -> str:
    try:
        y, m = month.split("-")
        return f"{y}年{int(m)}月"
    except Exception:
        return month


def _to_positive_ratio(numerator: float, denominator: float) -> float:
    base = abs(denominator)
    if base == 0:
        return 0.0
    return abs(numerator) / base


def _to_signed_ratio(numerator: float, denominator: float) -> float:
    if denominator == 0:
        return 0.0
    return numerator / denominator


def _excel_num_fmt(format_key: str) -> str | None:
    if format_key == "currency_usd":
        return "$#,##0.00;[Red]-$#,##0.00"
    if format_key in ("currency_rmb", "currency_rmb_nullable"):
        return "¥#,##0.00;[Red]-¥#,##0.00"
    if format_key in ("percent", "percent_signed"):
        return "0.0%"
    if format_key == "rate":
        return "0.0000"
    return None


def _apply_excel_border(cell, color: str = "FFE2E8F0") -> None:
    cell.border = Border(
        left=Side(style="thin", color=color),
        right=Side(style="thin", color=color),
        top=Side(style="thin", color=color),
        bottom=Side(style="thin", color=color),
    )


def _build_financial_detail_row(
    *,
    month: str,
    financial_row: dict[str, Any],
    exchange_rate: float,
    commission_rmb: float,
    payable_total_rmb: float,
    net_profit_rmb: float,
    net_profit_usd: float,
    net_profit_rate: float,
    has_source_report: bool,
    disable_commission: bool,
) -> dict[str, Any]:
    return {
        "monthLabel": _format_month_label(month),
        "hasSourceReport": has_source_report,
        "incomeSales": financial_row["income_sales"],
        "incomeRefund": financial_row["income_refund"],
        "incomeAdjustment": financial_row["income_adjustment"],
        "incomeOther": financial_row["income_other"],
        "expenseSellingFee": financial_row["expense_selling_fee"],
        "expenseFbaFee": financial_row["expense_fba_fee"],
        "expenseInventoryFee": financial_row["expense_inventory_fee"],
        "expenseServiceFee": financial_row["expense_service_fee"],
        "expenseAdvertising": financial_row["expense_advertising"],
        "expenseOtherFees": financial_row["expense_other_fees"],
        "incomeTotal": financial_row["income_total"],
        "expenseTotal": financial_row["expense_total"],
        "amazonPayBack": financial_row["amazon_pay_back"],
        "creditCardDeductionUsd": financial_row["credit_card_deduction_usd"],
        "evaluationFeeRmb": 0.0,
        "prepaymentOtherRmb": 0.0,
        "operationCommissionRmb": None if disable_commission else commission_rmb,
        "payableTotalRmb": None if disable_commission else payable_total_rmb,
        "exchangeRate": exchange_rate,
        "platformRatio": _to_positive_ratio(
            financial_row["expense_selling_fee"], financial_row["income_total"]
        ),
        "deliveryRatio": _to_positive_ratio(
            financial_row["expense_fba_fee"], financial_row["income_total"]
        ),
        "storageRatio": _to_positive_ratio(
            financial_row["expense_inventory_fee"], financial_row["income_total"]
        ),
        "serviceRatio": _to_positive_ratio(
            financial_row["expense_service_fee"], financial_row["income_total"]
        ),
        "adRatio": _to_positive_ratio(
            financial_row["expense_advertising"], financial_row["income_total"]
        ),
        "refundRatio": _to_positive_ratio(
            financial_row["income_refund"], financial_row["income_sales"]
        ),
        "paybackRatio": _to_signed_ratio(
            financial_row["amazon_pay_back"], financial_row["income_total"]
        ),
        "fobCostRmb": financial_row["fob_cost_rmb"],
        "firstLegCostRmb": financial_row["first_leg_cost_rmb"],
        "netProfitRmb": net_profit_rmb,
        "netProfitUsd": net_profit_usd,
        "netProfitRate": net_profit_rate,
    }


def _build_legacy_summary_sheet(
    *,
    wb: Workbook,
    project_name: str,
    start_month: str,
    end_month: str,
    detail_rows: list[dict[str, Any]],
) -> None:
    ws = wb.active
    ws.title = "汇总"
    ws.freeze_panes = "B5"
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=4)
    c = ws.cell(1, 1, "月度财务分析 - 汇总")
    c.font = Font(name="Microsoft YaHei", size=16, bold=True, color="FF0F172A")
    c.fill = PatternFill(fill_type="solid", fgColor="FFE2E8F0")

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=4)
    s = ws.cell(
        2,
        1,
        f"店铺：{project_name}    区间：{_format_month_label(start_month)} 至 {_format_month_label(end_month)}",
    )
    s.font = Font(name="Microsoft YaHei", size=10, color="FF475569")
    s.fill = PatternFill(fill_type="solid", fgColor="FFF8FAFC")

    headers = ["指标", "数值", "说明", "趋势"]
    for idx, title in enumerate(headers, start=1):
        cell = ws.cell(4, idx, title)
        cell.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.fill = PatternFill(fill_type="solid", fgColor="FFE2E8F0")
        _apply_excel_border(cell, "FFCBD5E1")

    income = sum(float(row["incomeTotal"]) for row in detail_rows)
    expense = sum(float(row["expenseTotal"]) for row in detail_rows)
    payback = sum(float(row["amazonPayBack"]) for row in detail_rows)
    kpis = [
        ("收入合计", income, "所选区间全部平台收入汇总", 0.0),
        ("支出合计", expense, "所选区间全部平台支出汇总", 0.0),
        ("亚马逊返款", payback, "所选区间返款总额", 0.0),
        ("净额合计", income + expense, "收入减支出后的净值", 0.0),
    ]
    for i, item in enumerate(kpis, start=5):
        ws.cell(i, 1, item[0])
        ws.cell(i, 2, item[1])
        ws.cell(i, 2).number_format = "$#,##0.00;[Red]-$#,##0.00"
        ws.cell(i, 3, item[2])
        ws.cell(i, 4, item[3])
        ws.cell(i, 4).number_format = "0.0%"
        for col in range(1, 5):
            cell = ws.cell(i, col)
            cell.font = Font(name="Microsoft YaHei", color="FF0F172A")
            cell.alignment = Alignment(
                horizontal="right" if col in (2, 4) else "left", vertical="center"
            )
            _apply_excel_border(cell)

    ws.merge_cells(start_row=11, start_column=1, end_row=11, end_column=4)
    t = ws.cell(11, 1, "月度趋势")
    t.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
    t.fill = PatternFill(fill_type="solid", fgColor="FFF1F5F9")
    _apply_excel_border(t, "FFCBD5E1")

    trend_headers = ["月份", "收入合计", "支出合计", "亚马逊返款"]
    for idx, title in enumerate(trend_headers, start=1):
        cell = ws.cell(12, idx, title)
        cell.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.fill = PatternFill(fill_type="solid", fgColor="FFE2E8F0")
        _apply_excel_border(cell, "FFCBD5E1")

    for i, row in enumerate(detail_rows, start=13):
        ws.cell(i, 1, row["monthLabel"])
        ws.cell(i, 2, row["incomeTotal"])
        ws.cell(i, 3, row["expenseTotal"])
        ws.cell(i, 4, row["amazonPayBack"])
        for col in (2, 3, 4):
            ws.cell(i, col).number_format = "$#,##0.00;[Red]-$#,##0.00"
        for col in range(1, 5):
            cell = ws.cell(i, col)
            cell.font = Font(name="Microsoft YaHei", color="FF0F172A")
            cell.alignment = Alignment(
                horizontal="left" if col == 1 else "right", vertical="center"
            )
            _apply_excel_border(cell)

    ws.column_dimensions["A"].width = 16
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 28
    ws.column_dimensions["D"].width = 12


def _build_legacy_detail_sheet(
    *,
    wb: Workbook,
    project_name: str,
    start_month: str,
    end_month: str,
    detail_rows: list[dict[str, Any]],
    is_admin: bool,
) -> None:
    active_columns = [
        col
        for col in _EXPORT_DETAIL_COLUMNS
        if is_admin or col["key"] not in _ADMIN_ONLY_EXPORT_KEYS
    ]
    ws = wb.create_sheet(title="月度财务明细")
    ws.freeze_panes = "B6"

    last_col = len(active_columns)
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
    t = ws.cell(1, 1, "月度财务分析 - 月度财务明细")
    t.font = Font(name="Microsoft YaHei", size=16, bold=True, color="FF0F172A")
    t.fill = PatternFill(fill_type="solid", fgColor="FFE2E8F0")

    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last_col)
    s = ws.cell(
        2,
        1,
        f"店铺：{project_name}    区间：{_format_month_label(start_month)} 至 {_format_month_label(end_month)}",
    )
    s.font = Font(name="Microsoft YaHei", size=10, color="FF475569")
    s.fill = PatternFill(fill_type="solid", fgColor="FFF8FAFC")

    group_colors = {
        "基础信息": "FFF1F5F9",
        "平台收入": "FFDDF7EA",
        "平台支出": "FFFCE7C3",
        "结果": "FFDCEEFF",
        "成本核算": "FFFDE68A",
        "运营结算": "FFFDE6F2",
        "费用占比": "FFEADFEE",
    }

    group_row = 4
    head_row = 5
    current_col = 1
    groups: list[str] = []
    for col in active_columns:
        if not groups or groups[-1] != col["group"]:
            groups.append(col["group"])
    for group in groups:
        cols = [col for col in active_columns if col["group"] == group]
        start_col = current_col
        for col in cols:
            ws.cell(head_row, current_col, col["title"])
            current_col += 1
        ws.merge_cells(
            start_row=group_row,
            start_column=start_col,
            end_row=group_row,
            end_column=current_col - 1,
        )
        gc = ws.cell(group_row, start_col, group)
        gc.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
        gc.alignment = Alignment(horizontal="center", vertical="center")
        gc.fill = PatternFill(
            fill_type="solid", fgColor=group_colors.get(group, "FFE2E8F0")
        )
        _apply_excel_border(gc, "FFCBD5E1")

    for r in (group_row, head_row):
        for col_idx in range(1, last_col + 1):
            cell = ws.cell(r, col_idx)
            cell.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
            cell.alignment = Alignment(
                horizontal="center", vertical="center", wrap_text=True
            )
            if cell.fill.fill_type is None:
                cell.fill = PatternFill(fill_type="solid", fgColor="FFE2E8F0")
            _apply_excel_border(cell, "FFCBD5E1")

    start_data_row = 6
    for idx, row_data in enumerate(detail_rows, start=start_data_row):
        for col_idx, col in enumerate(active_columns, start=1):
            value = row_data.get(col["key"])
            cell = ws.cell(idx, col_idx)
            if col["format"] == "boolean":
                cell.value = "有" if value else "无"
            else:
                cell.value = "-" if value is None else value
            cell.font = Font(
                name="Microsoft YaHei",
                color="FF0F172A" if col["key"] == "monthLabel" else "FF334155",
                bold=col["key"] == "monthLabel",
            )
            cell.alignment = Alignment(
                horizontal="left" if col["format"] in ("text", "boolean") else "right",
                vertical="center",
            )
            if isinstance(value, (int, float)):
                num_fmt = _excel_num_fmt(col["format"])
                if num_fmt:
                    cell.number_format = num_fmt
            _apply_excel_border(cell)

    total_row_idx = start_data_row + len(detail_rows)
    for col_idx, col in enumerate(active_columns, start=1):
        cell = ws.cell(total_row_idx, col_idx)
        if col["key"] == "monthLabel":
            cell.value = "合计"
        elif col["key"] == "hasSourceReport":
            cell.value = f"{len(detail_rows)} 个月"
        else:
            vals = [
                row.get(col["key"])
                for row in detail_rows
                if isinstance(row.get(col["key"]), (int, float))
            ]
            if col["format"] in ("percent", "percent_signed", "rate"):
                cell.value = (sum(vals) / len(vals)) if vals else 0
            else:
                cell.value = sum(vals) if vals else "-"
        cell.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
        cell.alignment = Alignment(
            horizontal="right" if isinstance(cell.value, (int, float)) else "left",
            vertical="center",
        )
        num_fmt = _excel_num_fmt(col["format"])
        if isinstance(cell.value, (int, float)) and num_fmt:
            cell.number_format = num_fmt
        cell.fill = PatternFill(fill_type="solid", fgColor="FFF8FAFC")
        _apply_excel_border(cell, "FFCBD5E1")

    compact_width_keys = {"hasSourceReport"}
    for col_idx, col in enumerate(active_columns, start=1):
        if col["key"] == "monthLabel":
            width = 12
        elif col["key"] in compact_width_keys:
            width = 10
        else:
            width = 12
        ws.column_dimensions[get_column_letter(col_idx)].width = width


def _load_usd_exchange_rate(db: Session, report_month: str) -> float:
    row = db.execute(
        select(ExchangeRate).where(
            ExchangeRate.currency == "USD",
            ExchangeRate.year_month == report_month,
        )
    ).scalar_one_or_none()
    if row is None:
        return 0.0
    return _to_float(row.rate)


def _resolve_operation_commission_rmb(
    *,
    db: Session,
    report: MonthlyReport,
    income_total: float,
    amazon_pay_back: float,
    exchange_rate: float,
) -> tuple[float, float]:
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


def _apply_monthly_like_styles(workbook: Workbook) -> None:
    from openpyxl.styles import PatternFill, Font, Alignment, Side, Border

    thin = Side(style="thin", color="FFCBD5E1")
    medium = Side(style="medium", color="FF94A3B8")
    header_fill = PatternFill(
        start_color="FFE2E8F0", end_color="FFE2E8F0", fill_type="solid"
    )
    even_row_fill = PatternFill(
        start_color="FFFFFFFF", end_color="FFFFFFFF", fill_type="solid"
    )
    odd_row_fill = PatternFill(
        start_color="FFF8FAFC", end_color="FFF8FAFC", fill_type="solid"
    )

    existing_style_names: set[str] = set()
    for style in workbook.named_styles:
        if isinstance(style, str):
            existing_style_names.add(style)
        else:
            name = getattr(style, "name", "")
            if isinstance(name, str) and name:
                existing_style_names.add(name)
    if "sty1" not in existing_style_names:
        sty1 = NamedStyle(name="sty1")
        sty1.font = Font(name="等线", size=11, bold=True, color="FF0F172A")
        sty1.alignment = Alignment(
            horizontal="center", vertical="center", wrap_text=True
        )
        sty1.border = Border(top=medium, bottom=medium, left=thin, right=thin)
        sty1.fill = header_fill
        workbook.add_named_style(sty1)

    if "sty2" not in existing_style_names:
        sty2 = NamedStyle(name="sty2")
        sty2.font = Font(name="等线", size=10, color="FF334155")
        sty2.alignment = Alignment(horizontal="left", vertical="center")
        sty2.border = Border(top=thin, bottom=thin, left=thin, right=thin)
        workbook.add_named_style(sty2)

    core_sheets = {"报表核算"}
    legacy_financial_sheets = {"汇总", "月度财务明细"}
    for ws in workbook.worksheets:
        if ws.title in legacy_financial_sheets:
            continue
        ws.freeze_panes = "A2"
        if ws.title in core_sheets:
            for r in range(1, ws.max_row + 1):
                row_fill = (
                    header_fill
                    if r == 1
                    else (even_row_fill if r % 2 == 0 else odd_row_fill)
                )
                ws.row_dimensions[r].height = 24 if r > 1 else 28
                for c in range(1, ws.max_column + 1):
                    cell = ws.cell(r, c)
                    cell.style = "sty1" if r == 1 else "sty2"
                    if r > 1:
                        cell.fill = row_fill
            _auto_width_for_report_sheet_service(ws)
        else:
            ws.row_dimensions[1].height = 28
            for c in range(1, ws.max_column + 1):
                cell = ws.cell(1, c)
                cell.style = "sty1"
                cell.fill = header_fill
            for r in range(2, ws.max_row + 1):
                ws.row_dimensions[r].height = 24
                row_fill = even_row_fill if r % 2 == 0 else odd_row_fill
                for c in range(1, ws.max_column + 1):
                    ws.cell(r, c).style = "sty2"
                    ws.cell(r, c).fill = row_fill
            for c in range(1, ws.max_column + 1):
                ws.column_dimensions[get_column_letter(c)].width = 14


def _auto_width_for_report_sheet_service(ws) -> None:
    for col in range(1, ws.max_column + 1):
        letter = get_column_letter(col)
        max_length = 0
        for row in range(1, ws.max_row + 1):
            value = ws.cell(row, col).value
            if value is None:
                continue
            text = str(value)
            length = 0
            for ch in text:
                length += 2 if "\u4e00" <= ch <= "\u9fff" else 1
            max_length = max(max_length, length)
        ws.column_dimensions[letter].width = min(max(max_length + 2, 8), 50)


def _style_financial_export_sheets(ws_summary, ws_financial_detail) -> None:
    ws_summary.column_dimensions["A"].width = 18
    ws_summary.column_dimensions["B"].width = 18
    ws_summary.column_dimensions["C"].width = 36
    for row in range(2, ws_summary.max_row + 1):
        ws_summary.cell(row, 2).number_format = "$#,##0.00;[Red]-$#,##0.00"

    num_fmt_usd = "$#,##0.00;[Red]-$#,##0.00"
    num_fmt_rmb = "¥#,##0.00;[Red]-¥#,##0.00"
    ws_financial_detail.cell(2, 2).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 3).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 4).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 5).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 6).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 7).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 8).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 9).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 10).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 11).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 12).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 13).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 14).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 15).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 16).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 17).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 18).number_format = "0.0000"
    ws_financial_detail.cell(2, 19).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 20).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 21).number_format = num_fmt_rmb
    ws_financial_detail.cell(2, 22).number_format = num_fmt_usd
    ws_financial_detail.cell(2, 23).number_format = "0.00%"


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

    for fmt in (
        "%b %d, %Y %I:%M:%S %p %Z",
        "%b %d, %Y %I:%M:%S %p",
        "%Y-%m-%d %H:%M:%S",
        "%d.%m.%Y %H:%M:%S",
    ):
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
    country: str = "US",
) -> dict[int, dict[str, float]]:
    if not report_ids:
        return {}

    cost_rows = (
        db.execute(
            select(ProductCost)
            .where(
                ProductCost.project_name == project_name,
                ProductCost.country == normalize_country(country),
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
        if row.transaction_type == "refund":
            continue  # 成本在原销售月已确认，退货不再重复扣减
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
