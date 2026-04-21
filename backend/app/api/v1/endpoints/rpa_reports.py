from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.rpa_report import RpaReportStatusResponseSchema
from app.services.rpa_report_service import get_report_status_for_date

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/rpa-reports/status", response_model=RpaReportStatusResponseSchema)
def get_rpa_report_status(
    report_date: str = Query(..., min_length=10, max_length=10, description="YYYY-MM-DD"),
    country: str = "US",
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    return get_report_status_for_date(
        db,
        report_date=report_date,
        country=country,
        operator=operator,
        is_admin=bool(is_admin),
    )