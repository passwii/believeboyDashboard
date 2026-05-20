from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import get_settings
from app.schemas.reconciliation import (
    AutoReconcileRequest,
    AvailableReportItem,
    AvailableReportsResponse,
    ReconciliationHistoryResponse,
    ReconcileResultResponse,
    PDFUploadResponse,
)
from app.services.reconciliation_service import (
    auto_reconcile,
    get_available_reports,
    get_reconciliation_history,
)
from app.services.report_reconciliation_service import reconcile_to_dict
from app.models import ReconciliationRecord, MonthlyReport
from app.services.upload_service import save_upload_file
from decimal import Decimal
import re

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/report-reconciliation/available-reports", response_model=AvailableReportsResponse)
def list_available_reports(
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    month: str | None = Query(default=None),
    db=Depends(get_db_session),
) -> AvailableReportsResponse:
    """List reports available for automatic reconciliation."""
    reports = get_available_reports(
        db,
        project_id=project_id,
        country=country,
        report_month=month,
    )
    return AvailableReportsResponse(
        reports=[AvailableReportItem(**r) for r in reports],
        total=len(reports),
    )


@router.post("/report-reconciliation/auto-reconcile", response_model=ReconcileResultResponse)
def perform_auto_reconcile(
    data: AutoReconcileRequest,
    db=Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ReconcileResultResponse:
    """Perform automatic reconciliation using database PT3 data and uploaded PDF."""
    try:
        result = auto_reconcile(
            db,
            report_id=data.report_id,
            tolerance=data.tolerance,
            operator=operator or "system",
            country=data.country,
        )

        summary = result["summary"]
        return ReconcileResultResponse(
            summary={
                "db_total_income": summary.get("db_total_income"),
                "db_total_expense": summary.get("db_total_expense"),
                "db_net_amount": summary.get("db_net_amount"),
                "pdf_total_income": summary.get("pdf_total_income"),
                "pdf_total_expense": summary.get("pdf_total_expense"),
                "pdf_net_amount": summary.get("pdf_net_amount"),
            },
            total_items=result["total_items"],
            matched_items=result["matched_items"],
            mismatched_items=result["mismatched_items"],
            missing_items=result["missing_items"],
            match_rate=result["match_rate"],
            items=result["items"],
            record_id=result["record_id"],
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/report-reconciliation/history", response_model=ReconciliationHistoryResponse)
def list_reconciliation_history(
    project_id: int | None = Query(default=None, gt=0),
    month: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db=Depends(get_db_session),
) -> ReconciliationHistoryResponse:
    """Get reconciliation history."""
    records = get_reconciliation_history(
        db,
        project_id=project_id,
        report_month=month,
        limit=limit,
    )
    return ReconciliationHistoryResponse(
        records=records,
        total=len(records),
    )


@router.post("/report-reconciliation/reconcile")
def reconcile_reports(
    excel_file: UploadFile = File(...),
    pdf_file: UploadFile = File(...),
    tolerance: float = 0.01,
    report_id: int | None = Query(default=None, ge=1),
) -> dict:
    """Manual reconciliation: compare uploaded Excel and PDF files."""
    settings = get_settings()
    temp_dir = settings.upload_root / "reconciliation-temp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    excel_path = temp_dir / f"{Path(excel_file.filename).stem}_excel.xlsx"
    pdf_path = temp_dir / f"{Path(pdf_file.filename).stem}.pdf"

    try:
        with open(excel_path, "wb") as f:
            content = excel_file.file.read()
            if not content:
                raise HTTPException(status_code=400, detail="Excel file is empty")
            f.write(content)

        with open(pdf_path, "wb") as f:
            content = pdf_file.file.read()
            if not content:
                raise HTTPException(status_code=400, detail="PDF file is empty")
            f.write(content)

        result = reconcile_to_dict(
            str(excel_path),
            str(pdf_path),
            excel_sheet_name="报表核算",
            tolerance=tolerance,
        )

        # If report_id provided, save to ReconciliationRecord for persistence
        if report_id:
            db_gen = get_db_session()
            db = next(db_gen)
            try:
                # Check if already has a record
                existing = db.query(ReconciliationRecord).filter(
                    ReconciliationRecord.report_id == report_id,
                    ReconciliationRecord.mode == "manual"
                ).first()

                match_rate = Decimal(str(result["match_rate"]))
                if existing:
                    existing.match_rate = match_rate
                    existing.matched_items = result["matched_items"]
                    existing.mismatched_items = result["mismatched_items"]
                    existing.missing_items = result["missing_items"]
                    existing.detail_json = {"items": result["items"], "summary": result.get("summary", {})}
                else:
                    record = ReconciliationRecord(
                        report_id=report_id,
                        operator="manual",
                        mode="manual",
                        match_rate=match_rate,
                        matched_items=result["matched_items"],
                        mismatched_items=result["mismatched_items"],
                        missing_items=result["missing_items"],
                        detail_json={"items": result["items"], "summary": result.get("summary", {})},
                    )
                    db.add(record)
                db.commit()
            finally:
                db.close()

        return result

    except KeyError as e:
        raise HTTPException(status_code=400, detail=f"Excel sheet '报表核算' not found: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Reconciliation failed: {str(e)}")
    finally:
        if excel_path.exists():
            excel_path.unlink()
        if pdf_path.exists():
            pdf_path.unlink()


@router.post("/report-reconciliation/reports/{report_id}/pdf-upload", response_model=PDFUploadResponse)
def upload_summary_pdf(
    report_id: int,
    pdf_file: UploadFile = File(...),
    db=Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
):
    """
    Upload or replace summary PDF for a report.

    - PDF is uploaded to R2 cloud storage
    - Database records: summary_pdf_r2_key, summary_pdf_r2_url
    - Frontend can directly access PDF via R2 URL
    """
    # Get the report
    report = db.query(MonthlyReport).filter(MonthlyReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    # Validate file
    if not pdf_file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    ext = Path(pdf_file.filename).suffix.lower()
    if ext != '.pdf':
        raise HTTPException(status_code=400, detail="Only PDF files are allowed")

    # Check content type
    if pdf_file.content_type and pdf_file.content_type != 'application/pdf':
        raise HTTPException(status_code=400, detail="Invalid content type, expected PDF")

    settings = get_settings()

    # Use existing project_name from the report
    project_name = report.project_name

    try:
        # Save the file to R2
        result = save_upload_file(
            file=pdf_file,
            settings=settings,
            project_name=project_name,
            file_type='monthly_summary_pdf',
        )

        # Update the report with R2 storage info
        report.summary_pdf_r2_key = result['r2_key']
        report.summary_pdf_r2_url = result['r2_url']
        # Keep file_id for compatibility (stores the R2 key)
        report.summary_pdf_file_id = result['r2_key']
        db.commit()

        return PDFUploadResponse(
            report_id=report_id,
            pdf_file_id=result['r2_key'],
            pdf_file_path=result['r2_url'],
            original_filename=result['original_filename'],
            size=result['size'],
            message="PDF uploaded to R2 successfully",
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save PDF: {str(e)}")
