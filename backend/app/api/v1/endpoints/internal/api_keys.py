"""Internal admin endpoints for external API keys (BEL-377).

Admin-only CRUD for the credentials that guard ``/api/v1/external/*``:

  POST   /api/v1/internal/api-keys            create (returns plaintext once)
  GET    /api/v1/internal/api-keys            list (no secrets)
  POST   /api/v1/internal/api-keys/{id}/revoke  soft-revoke

Gated on ``X-Is-Admin`` (same pattern as ``internal_jobs.py``). The admin
surface is only reachable behind the authenticated dashboard proxy, so the
header gate is sufficient here.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_request_operator
from app.schemas.external_api_key import (
    ApiKeyCreateRequest,
    ApiKeyCreateResponse,
    ApiKeyItem,
    ApiKeyRevokeResponse,
)
from app.services.external import api_key_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/api-keys", tags=["internal-api-keys"])


def _require_admin(is_admin: bool = Header(default=False, alias="X-Is-Admin")) -> bool:
    if not is_admin:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


@router.post(
    "",
    response_model=ApiKeyCreateResponse,
    status_code=201,
    dependencies=[Depends(_require_admin)],
)
def create_api_key(
    body: ApiKeyCreateRequest,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ApiKeyCreateResponse:
    record, plaintext = api_key_service.create_api_key(
        db,
        label=body.label,
        created_by=operator or "admin",
        scope=body.scope,
        expires_at=body.expires_at,
    )
    db.commit()
    db.refresh(record)
    logger.info("external API key created id=%s label=%s", record.id, record.label)
    return ApiKeyCreateResponse(
        id=record.id,
        key_prefix=record.key_prefix,
        label=record.label,
        scope=record.scope,
        expires_at=record.expires_at,
        created_at=record.created_at,
        plaintext_key=plaintext,
    )


@router.get(
    "",
    response_model=list[ApiKeyItem],
    dependencies=[Depends(_require_admin)],
)
def list_api_keys(
    db: Session = Depends(get_primary_db_session),
) -> list[ApiKeyItem]:
    return [
        ApiKeyItem.model_validate(k, from_attributes=True)
        for k in api_key_service.list_api_keys(db)
    ]


@router.post(
    "/{key_id}/revoke",
    response_model=ApiKeyRevokeResponse,
    dependencies=[Depends(_require_admin)],
)
def revoke_api_key(
    key_id: int,
    db: Session = Depends(get_primary_db_session),
) -> ApiKeyRevokeResponse:
    record = api_key_service.revoke_api_key(db, key_id)
    if record is None:
        raise HTTPException(status_code=404, detail="API key not found")
    db.commit()
    logger.info("external API key revoked id=%s", key_id)
    return ApiKeyRevokeResponse(id=record.id, is_revoked=record.is_revoked)
