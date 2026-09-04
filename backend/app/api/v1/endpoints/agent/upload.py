"""Agent 报表上传域路由（BLF-975）。

提供 dry-run 校验 + 正式提交两步契约，避免误传。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Header, UploadFile
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator
from app.core.config import Settings, get_settings
from app.schemas.upload import (
    AgentUploadCommitRequest,
    AgentUploadCommitResponse,
    AgentUploadValidateResponse,
)
from app.services.data.upload import commit_report_upload
from app.services.data.upload.validate import validate_upload

# BLF-975 修复：agent 命名空间内的路由**不得**挂内部 dashboard 的
# Depends(protected)（require_api_key 只认主 key / user key，agent key
# 不在其中 → 必 403「Invalid API key」）。鉴权统一由 agent_router 级的
# require_agent_credential 承担；业务域门禁挂 business_scope("report_upload")。
router = APIRouter()


@router.post("/upload/validate", response_model=AgentUploadValidateResponse)
def validate_report_upload(
    file: UploadFile = File(...),
    report_type: str = Form(...),
    country: str = Form(default="US"),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AgentUploadValidateResponse:
    """Dry-run 校验：返回列匹配度、检测国家、行数估算，不入库。"""
    return validate_upload(
        db=db,
        settings=settings,
        file=file,
        report_type=report_type,
        country=country,
        operator=operator,
        is_admin=bool(is_admin),
    )


@router.post("/upload/commit", response_model=AgentUploadCommitResponse)
def commit_report_upload_agent(
    payload: AgentUploadCommitRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AgentUploadCommitResponse:
    """正式提交：复用现有 commit_report_upload 逻辑入库。"""
    return commit_report_upload(
        db=db,
        settings=settings,
        payload=payload,
        operator=operator,
        is_admin=bool(is_admin),
    )
