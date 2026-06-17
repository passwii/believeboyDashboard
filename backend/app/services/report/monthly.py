"""Monthly report lifecycle and query module.

Main public API for monthly report operations including lifecycle management,
queries, and financial analysis.
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import delete, func, insert, select, update as sa_update
from sqlalchemy.orm import Session

from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
    MonthlyReportTransaction,
    Project,
)
from app.models.job import JobStatus
from app.utils.country import normalize_country

from app.services.report.export import export_financial_accounting_detail_workbook
from app.services.report.pt3 import (
    _build_transaction_payloads,
    _load_transaction_raw_rows,
    _normalize_pt3_payload,
)
from app.services.report.pt4 import (
    _build_financial_row,
    _build_trend_point,
    _load_monthly_cost_totals,
    _normalize_pt4_payload,
    _resolve_financial_range,
)
from app.services.report.utils import (
    _month_to_date,
    _month_to_str,
    _add_months,
    _month_range,
    _first_non_empty,
    _empty_financial_row,
    _parse_transaction_datetime,
    normalize_text,
    _to_decimal,
    _to_float,
    _round2,
)

try:
    from app.services.infra import (
        invalidate_financial_series_cache,
        set_financial_series_cache,
    )
except ImportError:
    invalidate_financial_series_cache = None
    set_financial_series_cache = None


def parse_report_month(value: str) -> str:
    """Parse and validate YYYY-MM format month string.

    Args:
        value: Month string (YYYY-MM format)

    Returns:
        Normalized YYYY-MM string

    Raises:
        HTTPException: If format is invalid
    """
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
    """Get project by ID or raise 404.

    Args:
        db: Database session
        project_id: Project ID

    Returns:
        Project model

    Raises:
        HTTPException: If project not found
    """
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Project not found"
        )
    return project


def get_project_by_name_or_404(db: Session, project_name: str) -> Project:
    """Get project by name or raise 422/404.

    Args:
        db: Database session
        project_name: Project name

    Returns:
        Project model

    Raises:
        HTTPException: If project name not provided or not found
    """
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
    """Prepare a new monthly report record.

    Args:
        db: Database session
        project_id: Project ID
        project_name: Project name
        country: Country code (US/DE/UK)
        report_month: Report month (YYYY-MM)
        transaction_file_id: Uploaded file ID
        transaction_file_path: Uploaded file path
        summary_pdf_file_id: Optional PDF file ID
        summary_pdf_file_path: Optional PDF file path
        file_size: File size in bytes

    Returns:
        Created MonthlyReport record
    """
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
    # Set R2-specific fields for PDF if present
    if summary_pdf_file_id:
        from app.core.config import get_settings
        from app.services.upload_service import _safe_project_folder_name, slugify
        from app.services.artifact_service import ArtifactService

        settings = get_settings()
        # Build R2 key: {project_slug}/{file_type}/{filename}
        project_slug = _safe_project_folder_name(project_name)
        file_type_slug = slugify('monthly_summary_pdf')[:50] or 'file'
        # summary_pdf_file_id contains the full R2 key (e.g., "玥涵/monthly-summary-pdf/xxx.pdf")
        # so we extract just the filename part to reconstruct the proper key
        filename = summary_pdf_file_id.split('/')[-1] if '/' in summary_pdf_file_id else summary_pdf_file_id
        r2_key = f"{project_slug}/{file_type_slug}/{filename}"
        report.summary_pdf_r2_key = r2_key
        # 使用 ArtifactService.build_public_url() 统一构建 URL
        report.summary_pdf_r2_url = ArtifactService.build_public_url(r2_key)

    db.add(report)
    db.flush()
    db.refresh(report)
    return report


def _clear_report_children(db: Session, report_id: int) -> None:
    """Clear child records for a report (transactions, PT3, PT4).

    Args:
        db: Database session
        report_id: Monthly report ID
    """
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
    """Mark report as running and clear previous children.

    Args:
        db: Database session
        report_id: Monthly report ID
    """
    report = db.get(MonthlyReport, report_id)
    if report is None:
        return
    _clear_report_children(db, report_id)
    report.status = JobStatus.running
    report.error_message = None
    db.flush()


def mark_report_failed(db: Session, report_id: int, error_message: str) -> None:
    """Mark report as failed with error message.

    Args:
        db: Database session
        report_id: Monthly report ID
        error_message: Error message
    """
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
    """Persist monthly report calculation results.

    Args:
        db: Database session
        report_id: Monthly report ID
        result: Dict with transactions, pt3, pt4, and result_path
        calculation_version: Calculation version number

    Raises:
        ValueError: If report not found or result missing required fields
    """
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

    # 使用 savepoint 保证 delete + insert 的原子性：
    # 如果插入失败，子记录回滚到删除前的状态，report 主体不受影响。
    with db.begin_nested():
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
        1 for row in rows if str(row.get("type", "")).strip() == "FBA Transaction Fees"
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
    """List monthly reports with optional filters.

    Args:
        db: Database session
        project_id: Optional project filter
        country: Optional country filter
        report_month: Optional month filter (YYYY-MM)
        current_only: If True, only return current versions

    Returns:
        List of MonthlyReport records
    """
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
    """Get report by ID or raise 404.

    Args:
        db: Database session
        report_id: Report ID

    Returns:
        MonthlyReport record

    Raises:
        HTTPException: If report not found
    """
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
    """Get report with PT3 and PT4 calculations.

    Args:
        db: Database session
        report_id: Report ID

    Returns:
        Tuple of (report, pt3, pt4)
    """
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
    """Get financial time series for a project.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code
        start_month: Optional start month (YYYY-MM)
        end_month: Optional end month (YYYY-MM)
        fill_missing: If True, fill missing months with zero rows

    Returns:
        Dict with project info, rows, and trend
    """
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
        select(MonthlyReport, MonthlyReportPT4Calculation, MonthlyReportPT3Calculation)
        .add_columns(debt_sum_subquery.c.credit_card_deduction_usd)
        .outerjoin(
            MonthlyReportPT4Calculation,
            MonthlyReportPT4Calculation.report_id == MonthlyReport.id,
        )
        .outerjoin(
            MonthlyReportPT3Calculation,
            MonthlyReportPT3Calculation.report_id == MonthlyReport.id,
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
        # Income-side VAT columns (alembic 160) live on PT3 — BEL-125 v3.
        # Without this outerjoin, ``_build_financial_row`` always sees
        # ``pt3=None`` and the income VAT fields come back as 0.
        pt3 = row[2] if len(row) > 2 else None
        credit_card_deduction_usd = row[3] if len(row) > 3 else None
        cost_totals = cost_totals_by_report.get(int(report.id), {})
        month_to_row[report.report_month] = _build_financial_row(
            report.report_month,
            pt4,
            pt3,
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
    """Get accounting detail for a specific month.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code
        report_month: Report month (YYYY-MM)

    Returns:
        Dict with project info and accounting rows
    """
    month = parse_report_month(report_month)
    project = get_project_or_404(db, project_id)

    from app.services.report.pt3 import _build_accounting_rows
    from app.services.report.export import _load_report_with_pt3_or_404

    report, pt3 = _load_report_with_pt3_or_404(
        db,
        project_id=project_id,
        country=country,
        report_month=month,
    )

    rows = _build_accounting_rows(pt3, country=report.country)
    return {
        "project_id": project.id,
        "project_name": project.project_name,
        "report_month": report.report_month,
        "rows": rows,
    }


def resolve_result_path(report: MonthlyReport) -> Path | None:
    """Resolve the result file path for a report.

    Args:
        report: MonthlyReport record

    Returns:
        Path object or None if not found/invalid
    """
    if not report.result_file_path:
        return None
    result_path = Path(report.result_file_path)
    if not result_path.is_absolute():
        return None
    if not result_path.exists() or not result_path.is_file():
        return None
    return result_path


# Re-export from payment submodule
from app.services.payment import classify_rows, compute_metrics, validate_payment_report_project_match


def rebuild_pt3_pt4_for_report(db: Session, report_id: int) -> bool:
    """Rebuild PT3 and PT4 calculations from stored raw transactions.

    Loads the raw transaction rows already saved in the database,
    re-classifies them with the current classifier, recomputes PT3/PT4,
    and replaces the old records.

    Args:
        db: Database session
        report_id: Monthly report ID

    Returns:
        True if rebuild succeeded, False if no transactions found
    """
    report = db.get(MonthlyReport, report_id)
    if report is None:
        return False

    rows = _load_transaction_raw_rows(db, report_id=report_id)
    if not rows:
        return False

    classified = classify_rows(rows)
    result = compute_metrics(classified, country=report.country)

    pt3 = result["pt3"]
    pt4 = result["pt4"]

    with db.begin_nested():
        # Delete old PT3 and PT4 (keep transactions intact)
        db.execute(
            delete(MonthlyReportPT3Calculation)
            .where(MonthlyReportPT3Calculation.report_id == report_id)
        )
        db.execute(
            delete(MonthlyReportPT4Calculation)
            .where(MonthlyReportPT4Calculation.report_id == report_id)
        )

        db.add(
            MonthlyReportPT3Calculation(
                report_id=report_id,
                project_name=report.project_name,
                report_month=report.report_month,
                calculation_version=1,
                computed_at=datetime.now(UTC),
                **_normalize_pt3_payload(pt3),
            )
        )
        db.add(
            MonthlyReportPT4Calculation(
                report_id=report_id,
                project_name=report.project_name,
                report_month=report.report_month,
                calculation_version=1,
                computed_at=datetime.now(UTC),
                **_normalize_pt4_payload(pt4),
            )
        )

    return True


def rebuild_and_refresh_financial_series(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_month: str | None = None,
    end_month: str | None = None,
) -> dict[str, Any]:
    """Rebuild PT3/PT4 for all current reports of a project, then return fresh financial series.

    1. Finds all current reports for the project/country
    2. Rebuilds PT3+PT4 from raw transactions for each report
    3. Invalidates Redis cache
    4. Returns fresh financial series data

    Args:
        db: Database session
        project_id: Project ID
        country: Country code
        start_month: Optional start month filter
        end_month: Optional end month filter

    Returns:
        Financial series dict (same structure as get_financial_series)
    """
    stmt = (
        select(MonthlyReport)
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.country == country,
            MonthlyReport.is_current.is_(True),
        )
        .order_by(MonthlyReport.report_month.asc())
    )
    reports = list(db.execute(stmt).scalars().all())

    rebuilt = 0
    for report in reports:
        if rebuild_pt3_pt4_for_report(db, report.id):
            rebuilt += 1

    if rebuilt > 0:
        db.flush()
        db.commit()

    if invalidate_financial_series_cache is not None:
        invalidate_financial_series_cache(project_id)

    payload = get_financial_series(
        db,
        project_id=project_id,
        country=country,
        start_month=start_month,
        end_month=end_month,
    )

    set_financial_series_cache(project_id, country, start_month, end_month, payload)

    return payload

__all__ = [
    # Core functions
    "parse_report_month",
    "get_project_or_404",
    "prepare_monthly_report",
    "mark_report_running",
    "mark_report_failed",
    "persist_monthly_report_result",
    # Rebuild functions
    "rebuild_pt3_pt4_for_report",
    "rebuild_and_refresh_financial_series",
    # Query functions
    "list_reports",
    "get_report_or_404",
    "get_report_detail",
    "get_financial_series",
    "get_financial_accounting_detail",
    "resolve_result_path",
    # From payment
    "validate_payment_report_project_match",
    # From export
    "export_financial_accounting_detail_workbook",
]
