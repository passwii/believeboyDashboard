from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional
from decimal import Decimal
import tempfile

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import MonthlyReport, MonthlyReportPT3Calculation, MonthlyReportPT4Calculation, ReconciliationRecord
from app.utils.pdf_extractor import PDFExtractor
from app.core.config import get_settings

# PT3 fields to compare with PDF key_values
def _resolve_pdf_path(relative_path: str | None) -> Path:
    """
    Resolve PDF path from database storage path.

    Supports:
    - R2 URLs (https://...) - download to temp
    - Local paths (legacy support)
    """
    if not relative_path:
        raise ValueError("PDF path is not set")

    # If it's a URL, download from R2 to temp file
    if relative_path.startswith('http'):
        return _download_from_r2(relative_path)

    # Local file path (legacy support)
    pdf_path = Path(relative_path)

    # If absolute and exists, return directly
    if pdf_path.is_absolute() and pdf_path.exists():
        return pdf_path

    # Try relative to backend directory
    backend_dir = Path(__file__).resolve().parents[2]
    absolute_path = backend_dir / relative_path
    if absolute_path.exists():
        return absolute_path

    raise FileNotFoundError(f"PDF file not found: {relative_path}")


def _build_r2_url_from_key(key: str) -> str:
    """Build R2 URL from key."""
    from app.core.config import get_settings
    settings = get_settings()
    base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    return f"{base}/{key}"


def _download_from_r2(url: str) -> Path:
    """Download PDF from R2 to temporary file."""
    from app.services.r2_service import download_file_to_path
    from urllib.parse import unquote

    settings = get_settings()

    # Extract R2 key from URL
    # URL may be percent-encoded (e.g., %E9%93%A8%E5%AF%8C for 魁宝)
    # but R2 stores the raw key, so we need to decode it

    key = None

    # Pattern 1: r2_public_url
    if settings.r2_public_url and url.startswith(settings.r2_public_url):
        key = url[len(settings.r2_public_url):].lstrip('/')

    # Pattern 2: R2 endpoint format
    if key is None:
        bucket_prefix = f"{settings.r2_bucket_name}/"
        if bucket_prefix in url:
            parts = url.split(bucket_prefix)
            if len(parts) == 2:
                key = parts[1]

    # Pattern 3: Try to extract key from URL by removing protocol and host
    if key is None:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        # Remove leading slash and everything up to the first path component
        path = parsed.path
        if path.startswith('/'):
            path = path[1:]
        # The key is the full path if it looks like a valid key (has slashes or file extension)
        if '/' in path or path.endswith('.pdf'):
            key = path

    if key is None:
        raise ValueError(f"Could not extract R2 key from URL: {url}")

    # Decode URL-encoded characters (e.g., %E9%93%A8%E5%AF%8C -> 魁宝)
    # R2 stores raw keys, so we need the decoded version
    key = unquote(key)

    # Download to temp file
    temp_file = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False)
    temp_path = Path(temp_file.name)
    temp_file.close()

    success = download_file_to_path(settings, key, temp_path)
    if not success:
        temp_path.unlink(missing_ok=True)
        raise FileNotFoundError(f"Failed to download PDF from R2: {url}")

    return temp_path

# PT3 fields to compare with PDF key_values
PT3_TO_PDF_MAPPING: Dict[str, str] = {
    "income_fba_product_sales": "FBA_product_sales",
    "income_fba_product_sale_refunds": "FBA_product_sale_refunds",
    "income_total": "total_income",
    "expense_fba_selling_fees": "FBA_selling_fees",
    "expense_fba_transaction_fees": "FBA_transaction_fees",
    "expense_fba_inventory_and_inbound_services_fees": "FBA_inventory_and_inbound_services",
    "expense_service_fees": "service_fees",
    "expense_cost_of_advertising": "advertising_costs",
    "expense_total": "total_expense",
}

TOLERANCE = 0.01


def get_pt3_value(pt3: MonthlyReportPT3Calculation, field_name: str) -> Optional[float]:
    """Get a float value from PT3Calculation, handling Decimal conversion."""
    value = getattr(pt3, field_name, None)
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return value


def calculate_match(
    db_val: Optional[float],
    pdf_val: Optional[float],
    tolerance: float = TOLERANCE,
) -> tuple[bool, Optional[float], Optional[float]]:
    """Calculate if db_val matches pdf_val within tolerance."""
    if db_val is None and pdf_val is None:
        return True, None, None
    if db_val is None or pdf_val is None:
        return False, None, None

    diff = round(abs(db_val - pdf_val), 2)
    diff_percent = round((diff / abs(pdf_val) * 100), 2) if pdf_val != 0 else None

    is_match = diff <= tolerance

    return is_match, diff, diff_percent


def get_available_reports(
    db: Session,
    project_id: int | None = None,
    country: str | None = None,
    report_month: str | None = None,
) -> List[Dict[str, Any]]:
    """Get list of reports that are eligible for reconciliation."""
    stmt = (
        select(MonthlyReport)
        .where(MonthlyReport.status == "success")
        .where(MonthlyReport.is_current.is_(True))
        .order_by(MonthlyReport.report_month.desc())
    )

    if project_id is not None:
        stmt = stmt.where(MonthlyReport.project_id == project_id)
    if country:
        stmt = stmt.where(MonthlyReport.country == country)
    if report_month:
        stmt = stmt.where(MonthlyReport.report_month == report_month)

    reports = db.execute(stmt).scalars().all()

    # Get upload root for file existence check
    from app.core.config import get_settings
    settings = get_settings()
    # Use resolved absolute path for upload_root
    upload_root = settings.upload_root.resolve()

    result = []
    for report in reports:
        # Check if PT3 calculation exists
        pt3_stmt = select(MonthlyReportPT3Calculation).where(
            MonthlyReportPT3Calculation.report_id == report.id
        )
        pt3 = db.execute(pt3_stmt).scalars().first()

        # Check if PT4 calculation exists
        pt4_stmt = select(MonthlyReportPT4Calculation).where(
            MonthlyReportPT4Calculation.report_id == report.id
        )
        pt4 = db.execute(pt4_stmt).scalars().first()

        # Check if PDF exists in R2 (via r2_key or r2_url)
        # ACTUALLY verify the file exists, not just check DB fields
        from app.services.r2_service import check_file_exists, extract_key_from_url

        pdf_exists_in_r2 = False
        pdf_key = None

        if report.summary_pdf_r2_key:
            # Key is directly stored, check it
            pdf_key = report.summary_pdf_r2_key
            pdf_exists_in_r2 = check_file_exists(settings, pdf_key)
        elif report.summary_pdf_r2_url:
            # Try to extract key from URL and check
            pdf_key = extract_key_from_url(report.summary_pdf_r2_url, settings)
            if pdf_key:
                pdf_exists_in_r2 = check_file_exists(settings, pdf_key)

        pdf_exists = pdf_exists_in_r2
        pdf_file_missing = not pdf_exists_in_r2
        pdf_url = report.summary_pdf_r2_url if pdf_exists_in_r2 else None

        # Check if this report has been reconciled before
        recon_stmt = select(ReconciliationRecord).where(
            ReconciliationRecord.report_id == report.id
        ).order_by(ReconciliationRecord.created_at.desc())
        recon_record = db.execute(recon_stmt).scalars().first()

        result.append({
            "report_id": report.id,
            "project_name": report.project_name,
            "country": report.country,
            "report_month": report.report_month,
            "has_summary_pdf": pdf_exists,
            "pdf_url": pdf_url,
            "pdf_uploaded_at": report.updated_at,
            "pt3_calculation_complete": pt3 is not None,
            "pt4_calculation_complete": pt4 is not None,
            "status": report.status.value if report.status else "unknown",
            "pdf_file_missing": pdf_file_missing,
            # Reconciliation status from history
            "reconciled": recon_record is not None,
            "reconcile_match_rate": float(recon_record.match_rate) if recon_record else None,
            "reconcile_record_id": recon_record.id if recon_record else None,
        })

    return result


def get_report_or_404(db: Session, report_id: int) -> MonthlyReport:
    """Get a report by ID or raise 404."""
    report = db.get(MonthlyReport, report_id)
    if report is None:
        raise ValueError(f"Report {report_id} not found")
    return report


def auto_reconcile(
    db: Session,
    report_id: int,
    tolerance: float = TOLERANCE,
    operator: str = "system",
    country: str | None = None,
) -> Dict[str, Any]:
    """
    Perform automatic reconciliation between database PT3 calculation and PDF.

    1. Load PT3 calculation from database
    2. Extract PDF key_values
    3. Compare fields
    4. Save result to ReconciliationRecord

    Args:
        country: Country code for PDF number format (e.g., US, DE). If not provided,
                 will use US format by default.
    """
    # Get report
    report = get_report_or_404(db, report_id)

    # Check if PDF exists in R2
    if not report.summary_pdf_r2_key and not report.summary_pdf_r2_url:
        raise ValueError(f"Report {report_id} does not have a summary PDF uploaded to R2")

    # Get PT3 calculation
    pt3_stmt = select(MonthlyReportPT3Calculation).where(
        MonthlyReportPT3Calculation.report_id == report_id
    )
    pt3 = db.execute(pt3_stmt).scalars().first()

    if not pt3:
        raise ValueError(f"Report {report_id} does not have PT3 calculation data")

    # Extract PDF data from R2
    # Prefer R2 URL, fall back to constructing from R2 key
    pdf_url = report.summary_pdf_r2_url or _build_r2_url_from_key(report.summary_pdf_r2_key)
    pdf_path = _resolve_pdf_path(pdf_url)
    try:
        extractor = PDFExtractor(str(pdf_path), country=country)
        pdf_data = extractor.get_raw_data().get("key_values", {})
    except Exception as e:
        raise ValueError(f"Failed to extract PDF data: {str(e)}")

    # Compare fields
    items: List[Dict[str, Any]] = []
    matched = 0
    mismatched = 0
    missing = 0

    # PT3 → PDF field comparison
    for pt3_field, pdf_field in PT3_TO_PDF_MAPPING.items():
        db_val = get_pt3_value(pt3, pt3_field)
        pdf_val = pdf_data.get(pdf_field)

        # Convert pdf_val if it's Decimal
        if pdf_val is not None and isinstance(pdf_val, Decimal):
            pdf_val = float(pdf_val)

        # Skip if both are None
        if db_val is None and pdf_val is None:
            continue

        is_match, diff, diff_pct = calculate_match(db_val, pdf_val, tolerance)

        item = {
            "field_name": pdf_field,
            "db_value": db_val,
            "pdf_value": pdf_val,
            "match": is_match,
            "difference": diff,
            "difference_percent": diff_pct,
        }
        items.append(item)

        if is_match:
            matched += 1
        elif db_val is None or pdf_val is None:
            missing += 1
        else:
            mismatched += 1

    total_items = len(items)
    match_rate = round((matched / total_items * 100), 1) if total_items > 0 else 0.0

    # Calculate summary
    db_total_income = get_pt3_value(pt3, "income_total")
    db_total_expense = get_pt3_value(pt3, "expense_total")
    pdf_total_income = pdf_data.get("total_income")
    pdf_total_expense = pdf_data.get("total_expense")

    if pdf_total_income is not None and isinstance(pdf_total_income, Decimal):
        pdf_total_income = float(pdf_total_income)
    if pdf_total_expense is not None and isinstance(pdf_total_expense, Decimal):
        pdf_total_expense = float(pdf_total_expense)

    summary = {
        "db_total_income": db_total_income,
        "db_total_expense": db_total_expense,
        "db_net_amount": (db_total_income or 0) + (db_total_expense or 0)
            if db_total_income is not None and db_total_expense is not None
            else None,
        "pdf_total_income": pdf_total_income,
        "pdf_total_expense": pdf_total_expense,
        "pdf_net_amount": (pdf_total_income or 0) + (pdf_total_expense or 0)
            if pdf_total_income is not None and pdf_total_expense is not None
            else None,
    }

    # Save to database (upsert: update if exists, create if not)
    detail_json = {
        "summary": summary,
        "items": items,
    }

    existing = db.query(ReconciliationRecord).filter(
        ReconciliationRecord.report_id == report_id,
        ReconciliationRecord.mode == "auto"
    ).first()

    if existing:
        # Update existing record
        existing.operator = operator
        existing.match_rate = Decimal(str(match_rate))
        existing.matched_items = matched
        existing.mismatched_items = mismatched
        existing.missing_items = missing
        existing.detail_json = detail_json
        record = existing
    else:
        # Create new record
        record = ReconciliationRecord(
            report_id=report_id,
            operator=operator,
            mode="auto",
            match_rate=Decimal(str(match_rate)),
            matched_items=matched,
            mismatched_items=mismatched,
            missing_items=missing,
            detail_json=detail_json,
        )
        db.add(record)

    db.commit()
    db.refresh(record)

    return {
        "record_id": record.id,
        "summary": summary,
        "total_items": total_items,
        "matched_items": matched,
        "mismatched_items": mismatched,
        "missing_items": missing,
        "match_rate": match_rate,
        "items": items,
    }


def get_reconciliation_history(
    db: Session,
    project_id: int | None = None,
    report_month: str | None = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Get reconciliation history."""
    stmt = (
        select(ReconciliationRecord, MonthlyReport)
        .join(MonthlyReport, ReconciliationRecord.report_id == MonthlyReport.id)
        .order_by(ReconciliationRecord.created_at.desc())
        .limit(limit)
    )

    if project_id is not None:
        stmt = stmt.where(MonthlyReport.project_id == project_id)
    if report_month:
        stmt = stmt.where(MonthlyReport.report_month == report_month)

    results = db.execute(stmt).all()

    records = []
    for record, report in results:
        detail = record.detail_json or {}
        summary = detail.get("summary", {})

        records.append({
            "id": record.id,
            "report_id": record.report_id,
            "project_name": report.project_name,
            "country": report.country,
            "report_month": report.report_month,
            "operator": record.operator,
            "mode": record.mode,
            "match_rate": float(record.match_rate),
            "matched_items": record.matched_items,
            "mismatched_items": record.mismatched_items,
            "missing_items": record.missing_items,
            "total_items": record.matched_items + record.mismatched_items + record.missing_items,
            "summary": {
                "db_total_income": summary.get("db_total_income"),
                "db_total_expense": summary.get("db_total_expense"),
                "db_net_amount": summary.get("db_net_amount"),
                "pdf_total_income": summary.get("pdf_total_income"),
                "pdf_total_expense": summary.get("pdf_total_expense"),
                "pdf_net_amount": summary.get("pdf_net_amount"),
            },
            "detail_json": [
                {
                    "field_name": item.get("field_name"),
                    "db_value": item.get("db_value"),
                    "pdf_value": item.get("pdf_value"),
                    "match": item.get("match"),
                    "difference": item.get("difference"),
                    "difference_percent": item.get("difference_percent"),
                }
                for item in detail.get("items", [])
            ],
            "created_at": record.created_at,
        })

    return records
