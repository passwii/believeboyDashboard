"""Internal service-to-service endpoints.

These endpoints are NOT exposed to the public frontend. They are guarded
by ``require_internal_token`` (X-Internal-Token header). Mounted under
``/api/v1/internal/auto-report``.
"""
from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db_session
from app.api.deps_internal import require_internal_token
from app.schemas.internal import (
    AutoReportHeartbeatRequest,
    AutoReportHeartbeatResponse,
    AutoReportIngestRequest,
    AutoReportIngestResponse,
    AutoReportRecognizeRequest,
    AutoReportRecognizeResponse,
)
from app.services.internal_ingest import (
    perform_ingest,
    record_heartbeat,
    resolve_recognize,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/internal/auto-report",
    tags=["internal-auto-report"],
    dependencies=[Depends(require_internal_token)],
)


@router.post("/recognize", response_model=AutoReportRecognizeResponse)
def post_recognize(
    payload: AutoReportRecognizeRequest,
    db: Annotated[Session, Depends(get_db_session)],
) -> AutoReportRecognizeResponse:
    return resolve_recognize(db, payload)


@router.post("/ingest", response_model=AutoReportIngestResponse)
def post_ingest(
    payload: AutoReportIngestRequest,
    db: Annotated[Session, Depends(get_db_session)],
) -> AutoReportIngestResponse:
    return perform_ingest(db, payload)


@router.post("/heartbeat", response_model=AutoReportHeartbeatResponse)
def post_heartbeat(
    payload: AutoReportHeartbeatRequest,
    db: Annotated[Session, Depends(get_db_session)],
) -> AutoReportHeartbeatResponse:
    hb_id = record_heartbeat(db, payload)
    return AutoReportHeartbeatResponse(accepted=True, last_heartbeat_id=hb_id)
