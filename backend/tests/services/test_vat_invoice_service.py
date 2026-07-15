"""VAT invoice service tests — entity CRUD (phase1-3).

Uses the real ``db_session`` fixture (test Postgres DB). Projects are
created inline (no ``project_factory`` fixture exists in this repo).
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.project import Project
from app.models.vat_entity import VatEntity
from app.services import vat_invoice as svc


def _make_project(db_session, *, name: str = 'SmokeShop', vat_enabled: bool = True) -> Project:
    p = Project(project_name=name, sort_order=1, vat_enabled=vat_enabled)
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
    p = _make_project(db_session, name='OtherShop', vat_enabled=False)
    with pytest.raises(HTTPException) as exc:
        svc.ensure_vat_enabled(db_session, p.id)
    assert exc.value.status_code == 403


def test_ensure_vat_enabled_raises_404_when_missing(db_session):
    with pytest.raises(HTTPException) as exc:
        svc.ensure_vat_enabled(db_session, 999_999_999)
    assert exc.value.status_code == 404
