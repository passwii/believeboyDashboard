from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.upload import (
    ReportCommitRequest,
    ReportCommitResponse,
    ReportRecognitionResponse,
    ReportStatusResponse,
    UploadResponse,
)
import app.services.report_upload_service as report_upload_service
from app.services.upload_service import save_report_upload_temp_file, save_upload_file

router = APIRouter(dependencies=[Depends(protected)])


@router.post("/uploads", response_model=UploadResponse)
def upload_file(
    file: UploadFile = File(...),
    project_name: str = Form(...),
    file_type: str = Form(...),
    settings: Settings = Depends(get_settings),
) -> UploadResponse:
    payload = save_upload_file(
        file=file, settings=settings, project_name=project_name, file_type=file_type
    )
    return UploadResponse(**payload)


@router.post("/report-upload/recognize", response_model=ReportRecognitionResponse)
def recognize_report_upload(
    file: UploadFile = File(...),
    country: str = Form(default="US"),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ReportRecognitionResponse:
    saved = save_report_upload_temp_file(file=file, settings=settings)
    return report_upload_service.recognize_saved_report_upload(
        db,
        settings,
        temp_file_id=str(saved["temp_file_id"]),
        original_filename=str(saved["original_filename"]),
        country=country,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.post("/report-upload/commit", response_model=ReportCommitResponse)
def commit_report_upload(
    payload: ReportCommitRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ReportCommitResponse:
    return report_upload_service.commit_report_upload(
        db,
        settings,
        payload=payload,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.get("/report-upload/status", response_model=ReportStatusResponse)
def list_report_upload_status(
    report_date: str | None = Query(default=None),
    country: str = Query(default="US"),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ReportStatusResponse:
    return report_upload_service.list_report_upload_statuses(
        db,
        report_date=report_date,
        operator=operator,
        is_admin=bool(is_admin),
        country=country,
    )
