"""Project country field endpoint tests (BLF-952).

Uses ``db_session`` + ``admin_headers`` fixtures (test Postgres DB)
and an httpx ``TestClient`` over the FastAPI app.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.project import Project
from app.utils.country import get_country_label_cn


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
