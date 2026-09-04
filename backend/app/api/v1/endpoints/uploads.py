from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, UploadFile
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
from app.services.data.upload import (
    commit_report_upload,
    list_report_upload_statuses,
    recognize_saved_report_upload,
)
from app.services.audit_log_service import append_operation_audit_log
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
    request: Request,
    file: UploadFile = File(...),
    country: str = Form(default="US"),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ReportRecognitionResponse:
    saved = save_report_upload_temp_file(file=file, settings=settings)
    response = recognize_saved_report_upload(
        db,
        settings,
        temp_file_id=str(saved["temp_file_id"]),
        original_filename=str(saved["original_filename"]),
        country=country,
        operator=operator,
        is_admin=bool(is_admin),
    )
    append_operation_audit_log(
        db,
        action='report_upload.recognize',
        target_type='report_upload_temp_file',
        target_id=str(saved["temp_file_id"]),
        operator=operator,
        after={
            'temp_file_id': str(saved["temp_file_id"]),
            'original_filename': str(saved["original_filename"]),
            'status': response.status,
            'report_type': response.report_type,
            'country': response.country,
        },
        request=request,
    )
    db.commit()
    return response


@router.post("/report-upload/commit", response_model=ReportCommitResponse)
def commit_report_upload_endpoint(
    payload: ReportCommitRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ReportCommitResponse:
    response = commit_report_upload(
        db,
        settings,
        payload=payload,
        operator=operator,
        is_admin=bool(is_admin),
    )
    append_operation_audit_log(
        db,
        action='report_upload.commit',
        target_type='report_upload',
        target_id=response.file_id,
        operator=operator,
        after={
            'file_id': response.file_id,
            'report_type': response.report_type,
            'status': response.status,
            'project_name': response.project_name,
            'country': response.country,
            'report_date': response.report_date,
            'report_start_date': response.report_start_date,
            'report_end_date': response.report_end_date,
            'persisted_source_id': response.persisted_source_id,
        },
        request=request,
    )
    db.commit()
    return response


@router.get("/report-upload/status", response_model=ReportStatusResponse)
def list_report_upload_status(
    report_date: str | None = Query(default=None),
    country: str = Query(default="US"),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> ReportStatusResponse:
    return list_report_upload_statuses(
        db,
        report_date=report_date,
        operator=operator,
        is_admin=bool(is_admin),
        country=country,
    )
