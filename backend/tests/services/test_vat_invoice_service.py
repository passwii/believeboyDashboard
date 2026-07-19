"""VAT invoice service tests — entity CRUD (phase1-3).

Uses the real ``db_session`` fixture (test Postgres DB). Projects are
created inline (no ``project_factory`` fixture exists in this repo).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.vat_entity import VatEntity
from app.services import vat_invoice as svc


def _uid(prefix: str) -> str:
    return f'{prefix}-{uuid.uuid4().hex[:8]}'


def _make_project(db_session, *, name: str | None = None, vat_enabled: bool = True) -> Project:
    p = Project(project_name=name or _uid('SmokeShop'), sort_order=1, vat_enabled=vat_enabled)
    db_session.add(p)
    db_session.flush()
    return p


def test_upsert_entity_creates_new(db_session):
    p = _make_project(db_session)
    e = svc.upsert_entity(
        db_session, project_id=p.id, country='DE',
        company_name='ACME GmbH', vat_id='DE123',
    )
    assert e.id is not None
    assert e.country == 'DE'
    assert e.company_name == 'ACME GmbH'
    assert e.vat_id == 'DE123'


def test_upsert_entity_updates_existing_same_country(db_session):
    p = _make_project(db_session)
    svc.upsert_entity(db_session, project_id=p.id, country='DE',
                      company_name='Old', vat_id='DE1')
    svc.upsert_entity(db_session, project_id=p.id, country='DE',
                      company_name='New', vat_id='DE2')
    rows = db_session.query(VatEntity).filter_by(
        project_id=p.id, country='DE'
    ).all()
    assert len(rows) == 1
    assert rows[0].company_name == 'New'
    assert rows[0].vat_id == 'DE2'


def test_list_entities_orders_by_country(db_session):
    p = _make_project(db_session)
    svc.upsert_entity(db_session, project_id=p.id, country='FR', company_name='FR co')
    svc.upsert_entity(db_session, project_id=p.id, country='DE', company_name='DE co')
    listed = svc.list_entities(db_session, p.id)
    assert [x.country for x in listed] == ['DE', 'FR']


def test_delete_entity_removes_row(db_session):
    p = _make_project(db_session)
    e = svc.upsert_entity(db_session, project_id=p.id, country='DE',
                          company_name='X', vat_id='')
    svc.delete_entity(db_session, e.id)
    assert db_session.get(VatEntity, e.id) is None


def test_ensure_vat_enabled_passes_when_enabled(db_session):
    p = _make_project(db_session, vat_enabled=True)
    out = svc.ensure_vat_enabled(db_session, p.id)
    assert out.id == p.id


def test_ensure_vat_enabled_raises_403_when_disabled(db_session):
    p = _make_project(db_session, name=_uid('OtherShop'), vat_enabled=False)
    with pytest.raises(HTTPException) as exc:
        svc.ensure_vat_enabled(db_session, p.id)
    assert exc.value.status_code == 403


def test_ensure_vat_enabled_raises_404_when_missing(db_session):
    with pytest.raises(HTTPException) as exc:
        svc.ensure_vat_enabled(db_session, 999_999_999)
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Invoice service (phase2-1)
# ---------------------------------------------------------------------------

from app.models.vat_invoice import VatInvoice, VatInvoiceLine  # noqa: E402


def _seed_project_and_seller(db_session, *, vat_id='DE123456789'):
    p = Project(project_name=_uid('VATshop'), sort_order=1, vat_enabled=True)
    db_session.add(p)
    db_session.flush()
    seller = svc.upsert_entity(
        db_session, project_id=p.id, country='DE',
        company_name='ACME', vat_id=vat_id,
    )
    db_session.flush()
    return p, seller


def _draft_payload(project_id, seller_entity_id):
    return {
        'project_id': project_id,
        'seller_entity_id': seller_entity_id,
        'currency': 'EUR',
        'order_id': 'ORDER-1',
        'invoice_date': __import__('datetime').date(2026, 7, 15),
        'buyer': {'name': 'Buyer', 'address_line': 'X', 'postal_code': '00000', 'city': 'C', 'country': 'DE'},
        'shipping_incl_vat': '10.00',
        'lines': [
            {'description': 'A', 'asin': 'A1', 'qty': 2,
             'unit_price_incl_vat': '119.00', 'vat_rate': '19'},
        ],
    }


def test_create_invoice_assigns_invoice_no_and_totals(db_session):
    from decimal import Decimal as D
    p, seller = _seed_project_and_seller(db_session)
    inv = svc.create_invoice(db_session, **_draft_payload(p.id, seller.id))
    db_session.commit()
    assert inv.invoice_no.startswith('INV-DE123456789-2026-')
    assert inv.invoice_no.endswith(f"{inv.id:06d}")
    assert inv.total_incl == D('248.00')  # 119*2 + 10
    assert inv.status == 'draft'
    assert len(inv.lines) == 1
    assert inv.lines[0].line_no == 1
    assert inv.seller_snapshot['vat_id'] == 'DE123456789'


def test_create_invoice_rejects_empty_lines(db_session):
    p, seller = _seed_project_and_seller(db_session)
    payload = _draft_payload(p.id, seller.id)
    payload['lines'] = []
    with pytest.raises(ValueError):
        svc.create_invoice(db_session, **payload)


def test_list_invoices_filters_by_project_and_status(db_session):
    from app.models.vat_invoice import VatInvoice as VI
    p, seller = _seed_project_and_seller(db_session)
    a = svc.create_invoice(db_session, **_draft_payload(p.id, seller.id))
    b = svc.create_invoice(db_session, **_draft_payload(p.id, seller.id))
    db_session.commit()
    svc.void_invoice(db_session, b.id, reason='test')
    db_session.commit()
    rows = svc.list_invoices(db_session, project_id=p.id, status='draft')
    assert {r.id for r in rows} == {a.id}
    assert db_session.get(VI, b.id).status == 'voided'


def test_void_invoice_sets_status(db_session):
    p, seller = _seed_project_and_seller(db_session)
    inv = svc.create_invoice(db_session, **_draft_payload(p.id, seller.id))
    db_session.commit()
    svc.void_invoice(db_session, inv.id, reason='oops')
    db_session.commit()
    reloaded = db_session.get(VatInvoice, inv.id)
    assert reloaded.status == 'voided'
    assert reloaded.void_reason == 'oops'


def test_attach_invoice_pdf_promotes_draft_to_issued(db_session):
    p, seller = _seed_project_and_seller(db_session)
    inv = svc.create_invoice(db_session, **_draft_payload(p.id, seller.id))
    db_session.commit()
    svc.attach_invoice_pdf(db_session, inv.id, r2_key='k', r2_url='https://r2/x.pdf')
    db_session.commit()
    reloaded = db_session.get(VatInvoice, inv.id)
    assert reloaded.r2_key == 'k'
    assert reloaded.status == 'issued'


def test_get_invoice_or_404_raises(db_session):
    with pytest.raises(HTTPException) as exc:
        svc.get_invoice_or_404(db_session, 999_999_999)
    assert exc.value.status_code == 404
