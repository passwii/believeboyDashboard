from __future__ import annotations
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.models.vat_entity import VatEntity
from app.schemas.vat_invoice import (
    VatEntityCreate,
    VatEntityResponse,
    VatEntityUpdate,
)
from app.services import project_service
from app.services import vat_invoice as svc
from app.services.audit_log_service import append_operation_audit_log


router = APIRouter(dependencies=[Depends(protected)])


# ---------------------------------------------------------------------------
# VAT entity endpoints
# ---------------------------------------------------------------------------


@router.get('/vat-entities', response_model=list[VatEntityResponse])
def list_vat_entities(
    request: Request,
    project_id: int = Query(gt=0),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin)
    )
    rows = svc.list_entities(db, project_id)
    db.commit()
    return rows


@router.post('/vat-entities', response_model=VatEntityResponse, status_code=201)
def create_vat_entity(
    payload: VatEntityCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(
        db, payload.project_id, operator=operator, is_admin=bool(is_admin)
    )
    svc.ensure_vat_enabled(db, payload.project_id)

    row = svc.upsert_entity(
        db,
        project_id=payload.project_id,
        country=payload.country,
        company_name=payload.company_name,
        vat_id=payload.vat_id,
        address_line=payload.address_line,
        postal_code=payload.postal_code,
        city=payload.city,
        email=payload.email,
        is_default=payload.is_default,
    )
    append_operation_audit_log(
        db,
        action='vat_entities.upsert',
        target_type='vat_entity',
        target_id=row.id,
        operator=operator,
        after=payload.model_dump(),
        request=request,
    )
    db.commit()
    return row


@router.patch('/vat-entities/{entity_id}', response_model=VatEntityResponse)
def update_vat_entity(
    entity_id: int,
    payload: VatEntityUpdate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    existing = db.get(VatEntity, entity_id)
    if existing is None:
        raise HTTPException(status_code=404, detail='vat entity not found')
    project_service.ensure_project_access(
        db, existing.project_id, operator=operator, is_admin=bool(is_admin)
    )
    svc.ensure_vat_enabled(db, existing.project_id)

    for k, v in payload.model_dump(exclude_unset=True).items():
        setattr(existing, k, v)
    db.flush()
    append_operation_audit_log(
        db,
        action='vat_entities.update',
        target_type='vat_entity',
        target_id=entity_id,
        operator=operator,
        after=payload.model_dump(exclude_unset=True),
        request=request,
    )
    db.commit()
    return existing


@router.delete('/vat-entities/{entity_id}', status_code=204)
def delete_vat_entity(
    entity_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    existing = db.get(VatEntity, entity_id)
    if existing is None:
        raise HTTPException(status_code=404, detail='vat entity not found')
    project_service.ensure_project_access(
        db, existing.project_id, operator=operator, is_admin=bool(is_admin)
    )
    svc.ensure_vat_enabled(db, existing.project_id)
    svc.delete_entity(db, entity_id)
    append_operation_audit_log(
        db,
        action='vat_entities.delete',
        target_type='vat_entity',
        target_id=entity_id,
        operator=operator,
        request=request,
    )
    db.commit()
    return Response(status_code=204)
