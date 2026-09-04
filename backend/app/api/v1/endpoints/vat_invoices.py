from __future__ import annotations
import base64
import io
from datetime import date as _date
from decimal import Decimal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.core.config import Settings, get_settings
from app.models.project import Project
from app.models.vat_entity import VatEntity
from app.models.vat_invoice import VatInvoice
from app.schemas.vat_invoice import (
    VatEntityCreate,
    VatEntityResponse,
    VatEntityUpdate,
    VatInvoiceCreate,
    VatInvoiceListItem,
    VatInvoicePdfUploadRequest,
    VatInvoicePdfUploadResponse,
    VatInvoiceResponse,
    VatInvoiceVoidRequest,
)
from app.services import project_service
from app.services import vat_invoice as svc
from app.services.audit_log_service import append_operation_audit_log
from app.services.r2_service import upload_file_to_r2


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


# ---------------------------------------------------------------------------
# VAT invoice endpoints
# ---------------------------------------------------------------------------


@router.post('/vat-invoices', response_model=VatInvoiceResponse, status_code=201)
def create_vat_invoice(
    payload: VatInvoiceCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    project_service.ensure_project_access(
        db, payload.project_id, operator=operator, is_admin=bool(is_admin)
    )
    svc.ensure_vat_enabled(db, payload.project_id)

    inv = svc.create_invoice(
        db,
        project_id=payload.project_id,
        seller_entity_id=payload.seller_entity_id,
        currency=payload.currency,
        order_id=payload.order_id,
        invoice_date=payload.invoice_date,
        buyer=payload.buyer.model_dump(),
        shipping_incl_vat=Decimal(payload.shipping_incl_vat),
        lines=[ln.model_dump(mode='json') for ln in payload.lines],
        status=payload.status,
    )
    append_operation_audit_log(
        db,
        action='vat_invoices.create',
        target_type='vat_invoice',
        target_id=inv.id,
        operator=operator,
        after={
            'invoice_no': inv.invoice_no,
            'status': inv.status,
            'total_incl': str(inv.total_incl),
        },
        request=request,
    )
    db.commit()
    db.refresh(inv)
    return inv


@router.get('/vat-invoices', response_model=list[VatInvoiceListItem])
def list_vat_invoices(
    request: Request,
    project_id: int | None = Query(default=None, gt=0),
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    date_from: _date | None = Query(default=None),
    date_to: _date | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    if project_id is not None:
        project_service.ensure_project_access(
            db, project_id, operator=operator, is_admin=bool(is_admin)
        )
    rows = svc.list_invoices(
        db, project_id=project_id, status=status, q=q,
        date_from=date_from, date_to=date_to, limit=limit, offset=offset,
    )
    name_map = {p.id: p.project_name for p in db.scalars(select(Project)).all()}
    out: list[VatInvoiceListItem] = []
    for inv in rows:
        out.append(VatInvoiceListItem(
            id=inv.id,
            invoice_no=inv.invoice_no,
            project_id=inv.project_id,
            project_name=name_map.get(inv.project_id, ''),
            currency=inv.currency,
            order_id=inv.order_id,
            buyer_name=(inv.buyer or {}).get('name', ''),
            invoice_date=inv.invoice_date,
            subtotal_excl=inv.subtotal_excl,
            total_vat=inv.total_vat,
            total_incl=inv.total_incl,
            status=inv.status,
            has_pdf=bool(inv.r2_key),
            created_at=inv.created_at,
            updated_at=inv.updated_at,
        ))
    db.commit()
    return out


@router.get('/vat-invoices/{invoice_id}', response_model=VatInvoiceResponse)
def get_vat_invoice(
    invoice_id: int,
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(
        db, inv.project_id, operator=operator, is_admin=bool(is_admin)
    )
    db.commit()
    return inv


@router.post('/vat-invoices/{invoice_id}/pdf', response_model=VatInvoicePdfUploadResponse)
def upload_vat_invoice_pdf(
    invoice_id: int,
    payload: VatInvoicePdfUploadRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(
        db, inv.project_id, operator=operator, is_admin=bool(is_admin)
    )
    svc.ensure_vat_enabled(db, inv.project_id)

    raw = base64.b64decode(payload.pdf_base64)
    project = db.get(Project, inv.project_id)
    project_slug = project.project_name if project else f'project-{inv.project_id}'
    info = upload_file_to_r2(
        settings,
        file_data=io.BytesIO(raw),
        filename=payload.filename,
        project_slug=project_slug,
        file_type='vat-invoice',
        content_type='application/pdf',
    )
    svc.attach_invoice_pdf(db, invoice_id, r2_key=info['key'], r2_url=info['url'])
    append_operation_audit_log(
        db,
        action='vat_invoices.upload_pdf',
        target_type='vat_invoice',
        target_id=invoice_id,
        operator=operator,
        after={'r2_key': info['key']},
        request=request,
    )
    db.commit()
    reloaded = svc.get_invoice_or_404(db, invoice_id)
    return VatInvoicePdfUploadResponse(
        id=reloaded.id,
        invoice_no=reloaded.invoice_no,
        r2_key=reloaded.r2_key,
        r2_url=reloaded.r2_url,
        status=reloaded.status,
    )


@router.get('/vat-invoices/{invoice_id}/pdf')
def get_vat_invoice_pdf(
    invoice_id: int,
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(
        db, inv.project_id, operator=operator, is_admin=bool(is_admin)
    )
    if not inv.r2_url:
        raise HTTPException(status_code=409, detail='invoice has no pdf yet')
    db.commit()
    return RedirectResponse(url=inv.r2_url, status_code=302)


@router.post('/vat-invoices/{invoice_id}/void', response_model=VatInvoiceResponse)
def void_vat_invoice(
    invoice_id: int,
    payload: VatInvoiceVoidRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    inv = svc.get_invoice_or_404(db, invoice_id)
    project_service.ensure_project_access(
        db, inv.project_id, operator=operator, is_admin=bool(is_admin)
    )
    svc.void_invoice(db, invoice_id, reason=payload.reason)
    append_operation_audit_log(
        db,
        action='vat_invoices.void',
        target_type='vat_invoice',
        target_id=invoice_id,
        operator=operator,
        after={'reason': payload.reason},
        request=request,
    )
    db.commit()
    return svc.get_invoice_or_404(db, invoice_id)
