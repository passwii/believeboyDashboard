from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
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
from app.models import ReconciliationRecord, MonthlyReport, MonthlyReportPT3Calculation
from app.services.artifact_service import ArtifactService
from app.services.upload_service import save_upload_file
from decimal import Decimal
from io import BytesIO
from openpyxl import Workbook
from openpyxl.styles import Font
from urllib.parse import quote as url_quote
import re

router = APIRouter(dependencies=[Depends(protected)])

# PT3 database column names → Chinese display labels
PT3_FIELD_LABELS = {
    "income_fba_product_sales": "FBA 销售额",
    "income_fba_product_sale_refunds": "FBA 销售额退款",
    "income_total": "合计收入",
    "expense_fba_selling_fees": "FBA 销售佣金",
    "expense_fba_transaction_fees": "FBA 派送费",
    "expense_fba_inventory_and_inbound_services_fees": "FBA 库存和入库服务费",
    "expense_service_fees": "服务费",
    "expense_cost_of_advertising": "广告成本",
    "expense_total": "合计费用",
}


@router.get("/report-reconciliation/available-reports", response_model=AvailableReportsResponse)
def list_available_reports(
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    month: str | None = Query(default=None),
    db=Depends(get_read_db_session),
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
    db=Depends(get_primary_db_session),
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
    db=Depends(get_read_db_session),
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
    db: Session = Depends(get_primary_db_session),
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

        # If report_id provided, save to ReconciliationRecord for persistence.
        # BEL-55-P5 / BEL-73: the `db` is a primary session (POST handler
        # switched to get_primary_db_session) and is closed by FastAPI on
        # handler exit — we don't create a second session or close it here.
        if report_id:
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
    db=Depends(get_primary_db_session),
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


@router.get("/report-reconciliation/reports/{report_id}/export-pt3")
def export_pt3_data(
    report_id: int,
    db=Depends(get_read_db_session),
):
    """Export PT3 calculation data as Excel for offline comparison."""
    report = db.query(MonthlyReport).filter(MonthlyReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")

    pt3 = db.query(MonthlyReportPT3Calculation).filter(
        MonthlyReportPT3Calculation.report_id == report_id
    ).first()
    if not pt3:
        raise HTTPException(status_code=404, detail="PT3 calculation not found")

    # Build workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "数据库数据"

    # Header row
    header_font = Font(bold=True)
    ws.append(["字段名称", "数据库值"])
    for cell in ws[1]:
        cell.font = header_font

    # Data rows - income fields
    ws.append(["── 收入 ──", ""])
    for field, label in PT3_FIELD_LABELS.items():
        if field.startswith("income_"):
            val = getattr(pt3, field, None)
            ws.append([label, float(val) if val is not None else None])

    # Data rows - expense fields
    ws.append(["── 支出 ──", ""])
    for field, label in PT3_FIELD_LABELS.items():
        if field.startswith("expense_"):
            val = getattr(pt3, field, None)
            ws.append([label, float(val) if val is not None else None])

    # Column widths
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 18

    out = BytesIO()
    wb.save(out)

    # Build filename
    safe_project = re.sub(r'[\\/:*?"<>|]', "_", report.project_name)
    ym = report.report_month.split("-")
    filename = f"{safe_project}-数据库数据-{ym[0]}年{int(ym[1])}月.xlsx"

    encoded_filename = url_quote(filename)
    content_disposition = (
        f'attachment; filename="pt3-data.xlsx"; '
        f"filename*=UTF-8''{encoded_filename}"
    )

    return Response(
        content=out.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition},
    )


@router.get("/report-reconciliation/reports/{report_id}/download-pdf")
def download_reconciliation_pdf(
    report_id: int,
    db=Depends(get_read_db_session),
):
    """Download the summary PDF for a reconciliation report via R2 proxy."""
    report = db.query(MonthlyReport).filter(MonthlyReport.id == report_id).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    pdf_key = report.summary_pdf_r2_key
    if not pdf_key and report.summary_pdf_r2_url:
        pdf_key = ArtifactService.extract_key_from_url(report.summary_pdf_r2_url)
    if not pdf_key:
        raise HTTPException(status_code=404, detail="PDF not found in R2")

    try:
        with ArtifactService.download_to_temp(pdf_key, suffix=".pdf") as pdf_path:
            pdf_bytes = pdf_path.read_bytes()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="PDF file missing from R2")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download PDF: {str(e)}")

    safe_project = re.sub(r'[\\/:*?"<>|]', "_", report.project_name)
    ym = report.report_month.split("-")
    filename = f"{safe_project}-结算汇总-{ym[0]}年{int(ym[1])}月.pdf"

    encoded_filename = url_quote(filename)
    content_disposition = (
        f'attachment; filename="summary.pdf"; '
        f"filename*=UTF-8''{encoded_filename}"
    )

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": content_disposition},
    )
