"""Project country field endpoint tests (BLF-952).

Uses ``db_session`` + ``admin_headers`` fixtures (test Postgres DB)
and an httpx ``TestClient`` over the FastAPI app.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from app.main import app
from app.models.operation_audit_log import OperationAuditLog
from app.models.project import Project
from app.utils.country import get_country_label_cn

pytestmark = pytest.mark.audit_table_isolation


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _seed_project(db_session, *, name: str, country: str = "US") -> int:
    p = Project(project_name=name, sort_order=1, country=country)
    db_session.add(p)
    db_session.flush()
    db_session.commit()
    return p.id


def _seed_default_project(db_session) -> int:
    """Seed a project with no country set (inherits US from server_default)."""
    p = Project(
        project_name=f"DefProj-{__import__('uuid').uuid4().hex[:6]}", sort_order=1
    )
    db_session.add(p)
    db_session.flush()
    db_session.commit()
    return p.id


# ── GET /api/v1/projects (options) ──────────────────────────────────────


def test_list_project_options_contains_country(client, db_session, admin_headers):
    """GET /api/v1/projects returns country + country_name for each option."""
    pid = _seed_project(
        db_session, name=f"Opt-{__import__('uuid').uuid4().hex[:6]}", country="DE"
    )
    r = client.get("/api/v1/projects", headers=admin_headers)
    assert r.status_code == 200, r.text
    data = r.json()
    match = [p for p in data if p["id"] == pid]
    assert len(match) == 1, f"project {pid} not found in {data}"
    assert match[0]["country"] == "DE"
    assert match[0]["country_name"] == "德国站"


def test_list_project_options_default_country(client, db_session, admin_headers):
    """Project without explicit country defaults to US."""
    pid = _seed_default_project(db_session)
    r = client.get("/api/v1/projects", headers=admin_headers)
    assert r.status_code == 200, r.text
    match = [p for p in r.json() if p["id"] == pid]
    assert len(match) == 1
    assert match[0]["country"] == "US"
    assert match[0]["country_name"] == "美国站"


# ── GET /api/v1/projects/manage ─────────────────────────────────────────


def test_list_projects_manage_contains_country(client, db_session, admin_headers):
    """GET /api/v1/projects/manage returns country + country_name."""
    pid = _seed_project(
        db_session, name=f"Man-{__import__('uuid').uuid4().hex[:6]}", country="UK"
    )
    r = client.get("/api/v1/projects/manage", headers=admin_headers)
    assert r.status_code == 200, r.text
    match = [p for p in r.json() if p["id"] == pid]
    assert len(match) == 1
    assert match[0]["country"] == "UK"
    assert match[0]["country_name"] == "英国站"


# ── POST /api/v1/projects (create) ──────────────────────────────────────


def test_create_project_default_country(client, db_session, admin_headers):
    """POST /api/v1/projects with no country defaults to US."""
    name = f"CreateDef-{__import__('uuid').uuid4().hex[:6]}"
    r = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": name},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["country"] == "US"
    assert body["country_name"] == "美国站"


def test_create_project_specified_country(client, db_session, admin_headers):
    """POST /api/v1/projects with country=DE returns DE."""
    name = f"CreateDE-{__import__('uuid').uuid4().hex[:6]}"
    r = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": name, "country": "DE"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["country"] == "DE"
    assert body["country_name"] == "德国站"


def test_create_project_chinese_alias(client, db_session, admin_headers):
    """POST /api/v1/projects with Chinese alias \"英国站\" normalizes to UK."""
    name = f"CreateCN-{__import__('uuid').uuid4().hex[:6]}"
    r = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": name, "country": "英国站"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["country"] == "UK"
    assert body["country_name"] == "英国站"


def test_create_project_invalid_country_422(client, db_session, admin_headers):
    """POST /api/v1/projects with invalid country returns 422."""
    name = f"CreateBad-{__import__('uuid').uuid4().hex[:6]}"
    r = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": name, "country": "JP"},
    )
    assert r.status_code == 422, r.text


# ── PATCH /api/v1/projects/{id} (update) ────────────────────────────────


def test_update_project_country(client, db_session, admin_headers):
    """PATCH /api/v1/projects/{id} with country=UK updates the field."""
    pid = _seed_project(
        db_session, name=f"Upd-{__import__('uuid').uuid4().hex[:6]}", country="US"
    )
    r = client.patch(
        f"/api/v1/projects/{pid}",
        headers=admin_headers,
        json={"name": f"Upd-{__import__('uuid').uuid4().hex[:6]}", "country": "UK"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["country"] == "UK"
    assert body["country_name"] == "英国站"


def test_update_project_country_unchanged_when_none(client, db_session, admin_headers):
    """PATCH with country omitted keeps the existing value."""
    pid = _seed_project(
        db_session, name=f"UpdNone-{__import__('uuid').uuid4().hex[:6]}", country="DE"
    )
    r = client.patch(
        f"/api/v1/projects/{pid}",
        headers=admin_headers,
        json={"name": f"UpdNone-{__import__('uuid').uuid4().hex[:6]}"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["country"] == "DE"
    assert body["country_name"] == "德国站"


def test_update_project_invalid_country_422(client, db_session, admin_headers):
    """PATCH /api/v1/projects/{id} with invalid country returns 422."""
    pid = _seed_project(
        db_session, name=f"UpdBad-{__import__('uuid').uuid4().hex[:6]}", country="US"
    )
    r = client.patch(
        f"/api/v1/projects/{pid}",
        headers=admin_headers,
        json={"name": f"UpdBad-{__import__('uuid').uuid4().hex[:6]}", "country": "XYZ"},
    )
    assert r.status_code == 422, r.text


# ── Round-trip: create → list → update → list ──────────────────────────


def test_project_country_roundtrip(client, db_session, admin_headers):
    """Create a project, verify GET /projects, then PATCH and verify again."""
    name = f"RTrip-{__import__('uuid').uuid4().hex[:6]}"
    r = client.post(
        "/api/v1/projects",
        headers=admin_headers,
        json={"name": name, "country": "DE"},
    )
    assert r.status_code == 200, r.text
    created = r.json()
    assert created["country"] == "DE"
    assert created["country_name"] == "德国站"

    # Verify in GET /projects
    r2 = client.get("/api/v1/projects", headers=admin_headers)
    assert r2.status_code == 200
    match = [p for p in r2.json() if p["id"] == created["id"]]
    assert len(match) == 1
    assert match[0]["country"] == "DE"
    assert match[0]["country_name"] == "德国站"

    # PATCH to UK
    pid = created["id"]
    r3 = client.patch(
        f"/api/v1/projects/{pid}",
        headers=admin_headers,
        json={"name": name, "country": "UK"},
    )
    assert r3.status_code == 200, r3.text
    assert r3.json()["country"] == "UK"
    assert r3.json()["country_name"] == "英国站"

    # Verify in GET /projects/manage
    r4 = client.get("/api/v1/projects/manage", headers=admin_headers)
    assert r4.status_code == 200
    match2 = [p for p in r4.json() if p["id"] == pid]
    assert len(match2) == 1
    assert match2[0]["country"] == "UK"
    assert match2[0]["country_name"] == "英国站"


def test_project_shop_management_roundtrip(client, db_session, admin_headers):
    """Manage project shop mapping through list/upsert/delete routes."""
    project_id = _seed_project(
        db_session, name=f"ShopMap-{__import__('uuid').uuid4().hex[:6]}"
    )
    try:
        listed = client.get(
            f"/api/v1/projects/{project_id}/shops", headers=admin_headers
        )
        assert listed.status_code == 200, listed.text
        assert listed.json() == []

        created = client.put(
            f"/api/v1/projects/{project_id}/shops/US",
            headers=admin_headers,
            json={"shop_id": "shop-management-us"},
        )
        assert created.status_code == 200, created.text
        assert created.json()["country"] == "US"
        assert created.json()["shop_id"] == "shop-management-us"

        updated = client.put(
            f"/api/v1/projects/{project_id}/shops/GB",
            headers=admin_headers,
            json={"shop_id": "shop-management-uk"},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["country"] == "UK"

        listed = client.get(
            f"/api/v1/projects/{project_id}/shops", headers=admin_headers
        )
        assert listed.json() == [
            {
                "id": listed.json()[0]["id"],
                "country": "UK",
                "shop_id": "shop-management-uk",
                "shop_name": None,
                "seller_identity_expected_alias": None,
                "seller_identity_aliases": [],
                "seller_identity_source": None,
                "seller_identity_required": True,
            },
            {
                "id": listed.json()[1]["id"],
                "country": "US",
                "shop_id": "shop-management-us",
                "shop_name": None,
                "seller_identity_expected_alias": None,
                "seller_identity_aliases": [],
                "seller_identity_source": None,
                "seller_identity_required": True,
            },
        ]

        deleted = client.delete(
            f"/api/v1/projects/{project_id}/shops/UK", headers=admin_headers
        )
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {
            "deleted": True,
            "project_id": project_id,
            "country": "UK",
        }

        deleted_again = client.delete(
            f"/api/v1/projects/{project_id}/shops/UK", headers=admin_headers
        )
        assert deleted_again.status_code == 200, deleted_again.text
        assert deleted_again.json()["deleted"] is False
    finally:
        db_session.execute(delete(Project).where(Project.id == project_id))
        db_session.commit()


def test_project_shop_management_validates_country_and_shop_id(
    client, db_session, admin_headers
):
    project_id = _seed_project(
        db_session, name=f"ShopMapValidation-{__import__('uuid').uuid4().hex[:6]}"
    )
    try:
        invalid_country = client.put(
            f"/api/v1/projects/{project_id}/shops/FR",
            headers=admin_headers,
            json={"shop_id": "shop-invalid-country"},
        )
        assert invalid_country.status_code == 422, invalid_country.text

        blank_shop_id = client.put(
            f"/api/v1/projects/{project_id}/shops/US",
            headers=admin_headers,
            json={"shop_id": "   "},
        )
        assert blank_shop_id.status_code == 422, blank_shop_id.text
    finally:
        db_session.execute(delete(Project).where(Project.id == project_id))
        db_session.commit()


def test_project_shop_management_rejects_duplicate_shop_id(
    client, db_session, admin_headers
):
    first_id = _seed_project(
        db_session, name=f"ShopMapConflictA-{__import__('uuid').uuid4().hex[:6]}"
    )
    second_id = _seed_project(
        db_session, name=f"ShopMapConflictB-{__import__('uuid').uuid4().hex[:6]}"
    )
    try:
        first = client.put(
            f"/api/v1/projects/{first_id}/shops/US",
            headers=admin_headers,
            json={"shop_id": "shop-global-unique"},
        )
        assert first.status_code == 200, first.text

        duplicate = client.put(
            f"/api/v1/projects/{second_id}/shops/US",
            headers=admin_headers,
            json={"shop_id": "shop-global-unique"},
        )
        assert duplicate.status_code == 409, duplicate.text

        actions = db_session.query(OperationAuditLog.action).filter(
            OperationAuditLog.target_type == "project_shop",
            OperationAuditLog.action == "projects.shops.upsert",
        ).all()
        assert actions
    finally:
        db_session.execute(delete(Project).where(Project.id.in_([first_id, second_id])))
        db_session.commit()
