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

    r = client.get('/api/v1/projects/manage', headers=admin_headers)
    assert r.status_code == 200, r.text
    by_name = {it['name']: it for it in r.json()}
    assert on_name in by_name, f'{on_name} not in {[i["name"] for i in r.json()][:5]}...'
    assert by_name[on_name]['vat_enabled'] is True
    assert by_name[off_name]['vat_enabled'] is False
