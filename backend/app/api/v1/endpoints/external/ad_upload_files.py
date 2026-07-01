"""Endpoint #2 — list ``AdUploadFile`` rows for a project.

``GET /external/projects/{project_id}/ad-upload-files``
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.schemas.external.ad_upload_files import AdUploadFileItem
from app.services.external import ad_rows_query, projects_query


router = APIRouter()


@router.get(
    '/projects/{project_id}/ad-upload-files',
    response_model=list[AdUploadFileItem],
)
def get_external_ad_upload_files(
    project_id: int = Path(..., ge=1),
    report_type: str | None = Query(default=None),
    country: str | None = Query(default=None),
    include_history: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> list[AdUploadFileItem]:
    if not projects_query.project_exists(db, project_id):
        raise HTTPException(
            status_code=404,
            detail=f'project {project_id} not found',
        )

    try:
        files = ad_rows_query.list_ad_upload_files(
            db,
            project_id=project_id,
            report_type=report_type,
            country=country,
            include_history=include_history,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return [
        AdUploadFileItem(
            file_id=f.id,
            report_type=f.report_type,
            report_label=f.report_label,
            country=f.country,
            period_start_date=f.period_start_date,
            period_end_date=f.period_end_date,
            version=f.version,
            is_current=f.is_current,
            ingestion_status=f.ingestion_status,
            row_count_preview=f.row_count_preview,
            uploaded_at=f.created_at,
        )
        for f in files
    ]