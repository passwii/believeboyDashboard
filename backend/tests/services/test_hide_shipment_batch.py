"""Tests for ``app.services.shipment.schedule.hide_shipment_batch``."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models import Project, ShipmentBatchDropdownHidden
from app.services.shipment.schedule import hide_shipment_batch

import app.models  # noqa: F401


@pytest.fixture
def db_session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(
        engine,
        tables=[Project.__table__, ShipmentBatchDropdownHidden.__table__],
    )
    TestingSession = sessionmaker(bind=engine, autoflush=True, autocommit=False, future=True)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _make_project(db: Session) -> Project:
    project = Project(project_name="项目A", is_active=True, sort_order=1)
    db.add(project)
    db.flush()
    return project


def test_inserts_hidden_row(db_session: Session):
    project = _make_project(db_session)

    hide_shipment_batch(
        db_session, operator="alice", project_id=project.id,
        country="US", shipment_batch="BATCH-A",
    )
    db_session.commit()

    rows = db_session.query(ShipmentBatchDropdownHidden).all()
    assert len(rows) == 1
    assert rows[0].operator == "alice"
    assert rows[0].country == "US"
    assert rows[0].shipment_batch == "BATCH-A"


def test_is_idempotent_on_repeat(db_session: Session):
    project = _make_project(db_session)

    hide_shipment_batch(
        db_session, operator="alice", project_id=project.id,
        country="US", shipment_batch="BATCH-A",
    )
    hide_shipment_batch(
        db_session, operator="alice", project_id=project.id,
        country="US", shipment_batch="BATCH-A",
    )
    db_session.commit()

    rows = db_session.query(ShipmentBatchDropdownHidden).all()
    assert len(rows) == 1


def test_normalizes_country_to_uppercase(db_session: Session):
    project = _make_project(db_session)

    hide_shipment_batch(
        db_session, operator="alice", project_id=project.id,
        country="us", shipment_batch="BATCH-A",
    )
    db_session.commit()

    row = db_session.query(ShipmentBatchDropdownHidden).one()
    assert row.country == "US"


def test_rejects_missing_operator(db_session: Session):
    project = _make_project(db_session)
    with pytest.raises(ValueError):
        hide_shipment_batch(
            db_session, operator="", project_id=project.id,
            country="US", shipment_batch="BATCH-A",
        )