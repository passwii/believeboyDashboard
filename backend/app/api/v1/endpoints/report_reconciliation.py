from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.api.deps import protected
from app.core.config import get_settings
from app.services.report_reconciliation_service import reconcile_to_dict

router = APIRouter(dependencies=[Depends(protected)])


@router.post("/report-reconciliation/reconcile")
def reconcile_reports(
    excel_file: UploadFile = File(...),
    pdf_file: UploadFile = File(...),
    tolerance: float = 0.01,
) -> dict:
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