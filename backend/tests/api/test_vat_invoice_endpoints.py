"""VAT entity endpoint tests (phase1-3).

Uses the real ``db_session`` + ``admin_headers`` fixtures (test Postgres DB)
and an httpx ``TestClient`` over the FastAPI app. Projects are seeded inline
(no ``project_factory`` fixture exists in this repo).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.project import Project


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _seed_project(db_session, *, name: str, vat_enabled: bool = True) -> int:
    p = Project(project_name=name, sort_order=1, vat_enabled=vat_enabled)
    db_session.add(p)
    db_session.flush()
    # commit so the app's own SessionLocal (used by TestClient) can see the row
    db_session.commit()
    return p.id


def test_list_vat_entities_empty(client, db_session, admin_headers):
    pid = _seed_project(db_session, name=f'EmptyShop-{__import__("uuid").uuid4().hex[:6]}')
    r = client.get(f'/api/v1/vat-entities?project_id={pid}', headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_create_then_list_then_patch_then_delete(client, db_session, admin_headers):
    pid = _seed_project(db_session, name=f'Shop-{__import__("uuid").uuid4().hex[:6]}')

    # create
    r = client.post(
        '/api/v1/vat-entities',
        headers=admin_headers,
        json={
            'project_id': pid, 'country': 'DE',
            'company_name': 'ACME', 'vat_id': 'DE1',
            'address_line': '', 'postal_code': '', 'city': '', 'email': '',
        },
    )
    assert r.status_code == 201, r.text
    entity_id = r.json()['id']

    # list
    r = client.get(f'/api/v1/vat-entities?project_id={pid}', headers=admin_headers)
    assert r.status_code == 200
    assert len(r.json()) == 1

    # patch
    r = client.patch(
        f'/api/v1/vat-entities/{entity_id}', headers=admin_headers,
        json={'company_name': 'ACME New'},
    )
    assert r.status_code == 200, r.text
    assert r.json()['company_name'] == 'ACME New'

    # delete
    r = client.delete(f'/api/v1/vat-entities/{entity_id}', headers=admin_headers)
    assert r.status_code == 204


def test_create_blocks_when_vat_disabled(client, db_session, admin_headers):
    pid = _seed_project(
        db_session, name=f'DisabledShop-{__import__("uuid").uuid4().hex[:6]}',
        vat_enabled=False,
    )
    r = client.post(
        '/api/v1/vat-entities',
        headers=admin_headers,
        json={
            'project_id': pid, 'country': 'DE',
            'company_name': 'X', 'vat_id': '',
        },
    )
    assert r.status_code == 403, r.text


def test_patch_missing_returns_404(client, admin_headers):
    r = client.patch(
        '/api/v1/vat-entities/999999999',
        headers=admin_headers,
        json={'company_name': 'nope'},
    )
    assert r.status_code == 404


# ---- phase1-4: projects.vat_enabled wiring ----

def test_projects_manage_includes_vat_enabled(client, db_session, admin_headers):
    import uuid
    on_name = f'VATonShop-{uuid.uuid4().hex[:6]}'
    off_name = f'VAToffShop-{uuid.uuid4().hex[:6]}'
    db_session.add(Project(project_name=on_name, sort_order=1, vat_enabled=True))
    db_session.add(Project(project_name=off_name, sort_order=2, vat_enabled=False))
    db_session.flush()
    db_session.commit()  # so TestClient (own session) can see the rows

    r = client.get('/api/v1/projects/manage', headers=admin_headers)
    assert r.status_code == 200, r.text
    by_name = {it['name']: it for it in r.json()}
    assert on_name in by_name, f'{on_name} not in {[i["name"] for i in r.json()][:5]}...'
    assert by_name[on_name]['vat_enabled'] is True
    assert by_name[off_name]['vat_enabled'] is False


# ---- phase2-2: invoice endpoints ----

def _seed_invoice_setup(db_session, *, vat_id='DE999'):
    """Create an enabled Project + VatEntity, return (project_id, entity_id)."""
    import uuid
    p = Project(
        project_name=f'InvShop-{uuid.uuid4().hex[:6]}',
        sort_order=1, vat_enabled=True,
    )
    db_session.add(p)
    db_session.flush()
    # insert VatEntity directly (avoids coupling to svc.upsert_entity for setup)
    from app.models.vat_entity import VatEntity
    e = VatEntity(project_id=p.id, country='DE', company_name='ACME', vat_id=vat_id)
    db_session.add(e)
    db_session.flush()
    # commit so the app's own SessionLocal (used by TestClient) can see the rows
    db_session.commit()
    return p.id, e.id


def test_create_list_detail_void_invoice(client, db_session, admin_headers):
    pid, eid = _seed_invoice_setup(db_session)

    r = client.post(
        '/api/v1/vat-invoices',
        headers=admin_headers,
        json={
            'project_id': pid, 'seller_entity_id': eid,
            'currency': 'EUR', 'order_id': 'O1',
            'invoice_date': '2026-07-15',
            'buyer': {'name': 'Buyer', 'address_line': 'A',
                      'postal_code': '00000', 'city': 'C', 'country': 'DE'},
            'shipping_incl_vat': '10.00',
            'lines': [{'description': 'A', 'asin': 'A1', 'qty': 2,
                       'unit_price_incl_vat': '119.00', 'vat_rate': '19'}],
        },
    )
    assert r.status_code == 201, r.text
    inv = r.json()
    inv_id = inv['id']
    assert inv['invoice_no'].startswith('INV-DE999-2026-')
    assert inv['total_incl'] == '248.00'

    r = client.get(
        f'/api/v1/vat-invoices?project_id={pid}&status=draft',
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert any(it['id'] == inv_id for it in r.json())

    r = client.get(f'/api/v1/vat-invoices/{inv_id}', headers=admin_headers)
    assert r.status_code == 200
    assert r.json()['total_incl'] == '248.00'
    assert len(r.json()['lines']) == 1

    r = client.post(
        f'/api/v1/vat-invoices/{inv_id}/void',
        headers=admin_headers,
        json={'reason': 'test'},
    )
    assert r.status_code == 200, r.text
    assert r.json()['status'] == 'voided'
    assert r.json()['void_reason'] == 'test'


def test_invoice_create_blocks_when_vat_disabled(client, db_session, admin_headers):
    import uuid
    p = Project(
        project_name=f'DisabledInv-{uuid.uuid4().hex[:6]}',
        sort_order=1, vat_enabled=False,
    )
    db_session.add(p)
    db_session.flush()
    db_session.commit()  # so TestClient (own session) can see the row
    r = client.post(
        '/api/v1/vat-invoices',
        headers=admin_headers,
        json={
            'project_id': p.id, 'currency': 'EUR', 'invoice_date': '2026-07-15',
            'buyer': {'name': 'B', 'address_line': '', 'postal_code': '',
                      'city': '', 'country': 'DE'},
            'shipping_incl_vat': '0',
            'lines': [{'description': 'A', 'qty': 1,
                       'unit_price_incl_vat': '10', 'vat_rate': '19'}],
        },
    )
    assert r.status_code == 403


def test_invoice_pdf_without_upload_returns_409(client, db_session, admin_headers):
    pid, eid = _seed_invoice_setup(db_session)
    r = client.post(
        '/api/v1/vat-invoices',
        headers=admin_headers,
        json={
            'project_id': pid, 'seller_entity_id': eid,
            'currency': 'EUR', 'order_id': 'O-NOPDF',
            'invoice_date': '2026-07-15',
            'buyer': {'name': 'B', 'address_line': '', 'postal_code': '',
                      'city': '', 'country': 'DE'},
            'shipping_incl_vat': '0',
            'lines': [{'description': 'A', 'qty': 1,
                       'unit_price_incl_vat': '10', 'vat_rate': '19'}],
        },
    )
    assert r.status_code == 201, r.text
    inv_id = r.json()['id']
    r = client.get(f'/api/v1/vat-invoices/{inv_id}/pdf', headers=admin_headers)
    assert r.status_code == 409
