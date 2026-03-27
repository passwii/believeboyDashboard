from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.ad_upload import (
    AdUploadCommitRequest,
    AdUploadCommitResponse,
    AdUploadRecognitionResponse,
    AdUploadStatusResponse,
)
import app.services.ad_upload_service as ad_upload_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/ad-upload/recognize', response_model=AdUploadRecognitionResponse)
def recognize_ad_upload(
    file: UploadFile = File(...),
    country: str = Form(default='US'),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdUploadRecognitionResponse:
    saved = ad_upload_service.save_ad_upload_temp_file(file=file, settings=settings)
    return ad_upload_service.recognize_saved_ad_upload(
        db,
        settings,
        temp_file_id=str(saved['temp_file_id']),
        original_filename=str(saved['original_filename']),
        country=country,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.post('/ad-upload/commit', response_model=AdUploadCommitResponse)
def commit_ad_upload(
    payload: AdUploadCommitRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdUploadCommitResponse:
    return ad_upload_service.commit_ad_upload(
        db,
        settings,
        payload=payload,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.get('/ad-upload/status', response_model=AdUploadStatusResponse)
def list_ad_upload_status(
    country: str = Query(default='US'),
    project_name: str | None = Query(default=None),
    report_type: str | None = Query(default=None),
    report_date: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> AdUploadStatusResponse:
    return ad_upload_service.list_ad_upload_statuses(
        db,
        country=country,
        project_name=project_name,
        report_type=report_type,
        report_date=report_date,
        limit=limit,
        operator=operator,
        is_admin=bool(is_admin),
    )
