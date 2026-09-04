"""Tests for ``app.services.shipment.schedule.list_shipment_batches``.

覆盖：
- 仅返回当前 project_id + country 下的非空去重批次
- 过滤掉 NULL 批次
- 过滤掉其它项目/国家的批次
- 按 MAX(updated_at) DESC 排序
- 过滤掉当前 operator 已隐藏的批次
"""
from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models import Project, ShipmentBatchDropdownHidden, ShipmentSchedule
from app.services.shipment.schedule import list_shipment_batches

import app.models  # noqa: F401  触发所有模型注册到 Base.metadata


@pytest.fixture
def db_session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(
        engine,
        tables=[Project.__table__, ShipmentSchedule.__table__, ShipmentBatchDropdownHidden.__table__],
    )
    TestingSession = sessionmaker(bind=engine, autoflush=True, autocommit=False, future=True)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _make_project(db: Session, name: str) -> Project:
    project = Project(project_name=name, is_active=True, sort_order=1)
    db.add(project)
    db.flush()
    return project


def _make_shipment(
    db: Session,
    *,
    project: Project,
    country: str,
    shipment_no: str,
    shipment_batch: str | None,
) -> None:
    db.add(
        ShipmentSchedule(
            project_id=project.id,
            country=country,
            project_name_snapshot=project.project_name,
            shipment_no=shipment_no,
            shipping_method="sea",
            shipment_status="draft",
            shipment_batch=shipment_batch,
        )
    )
    db.flush()


def _set_updated_at(db: Session, shipment_no: str, when: dt.datetime) -> None:
    db.execute(
        ShipmentSchedule.__table__.update()
        .where(ShipmentSchedule.shipment_no == shipment_no)
        .values(updated_at=when)
    )


def test_returns_distinct_non_null_batches_for_project_and_country(db_session: Session):
    project_a = _make_project(db_session, "项目A")
    base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    _make_shipment(
        db_session,
        project=project_a,
        country="US",
        shipment_no="SHIP-1",
        shipment_batch="BATCH-2026Q1",
    )
    _make_shipment(
        db_session,
        project=project_a,
        country="US",
        shipment_no="SHIP-2",
        shipment_batch="BATCH-2026Q1",
    )
    _make_shipment(
        db_session,
        project=project_a,
        country="US",
        shipment_no="SHIP-3",
        shipment_batch="BATCH-2026Q2",
    )
    _set_updated_at(db_session, "SHIP-1", base)
    _set_updated_at(db_session, "SHIP-2", base + dt.timedelta(seconds=1))
    _set_updated_at(db_session, "SHIP-3", base + dt.timedelta(seconds=2))
    db_session.commit()

    batches = list_shipment_batches(
        db_session, project_id=project_a.id, country="US"
    )

    assert batches == ["BATCH-2026Q2", "BATCH-2026Q1"]


def test_excludes_null_batches(db_session: Session):
    project = _make_project(db_session, "项目A")
    _make_shipment(
        db_session,
        project=project,
        country="US",
        shipment_no="SHIP-NULL-1",
        shipment_batch=None,
    )
    _make_shipment(
        db_session,
        project=project,
        country="US",
        shipment_no="SHIP-NULL-2",
        shipment_batch=None,
    )
    _make_shipment(
        db_session,
        project=project,
        country="US",
        shipment_no="SHIP-WITH",
        shipment_batch="BATCH-A",
    )

    batches = list_shipment_batches(db_session, project_id=project.id, country="US")

    assert batches == ["BATCH-A"]


def test_excludes_other_projects_and_countries(db_session: Session):
    project_a = _make_project(db_session, "项目A")
    project_b = _make_project(db_session, "项目B")
    _make_shipment(
        db_session,
        project=project_a,
        country="US",
        shipment_no="A-US-1",
        shipment_batch="BATCH-A-US",
    )
    _make_shipment(
        db_session,
        project=project_b,
        country="US",
        shipment_no="B-US-1",
        shipment_batch="BATCH-B-US",
    )
    _make_shipment(
        db_session,
        project=project_a,
        country="DE",
        shipment_no="A-DE-1",
        shipment_batch="BATCH-A-DE",
    )

    batches = list_shipment_batches(
        db_session, project_id=project_a.id, country="US"
    )

    assert batches == ["BATCH-A-US"]


def test_returns_empty_when_no_batches(db_session: Session):
    project = _make_project(db_session, "项目A")
    _make_shipment(
        db_session,
        project=project,
        country="US",
        shipment_no="SHIP-1",
        shipment_batch=None,
    )

    batches = list_shipment_batches(db_session, project_id=project.id, country="US")

    assert batches == []


def test_normalizes_country_to_uppercase(db_session: Session):
    project = _make_project(db_session, "项目A")
    _make_shipment(
        db_session,
        project=project,
        country="US",
        shipment_no="SHIP-1",
        shipment_batch="BATCH-1",
    )

    batches = list_shipment_batches(
        db_session, project_id=project.id, country="us"
    )

    assert batches == ["BATCH-1"]


def test_excludes_batches_hidden_by_current_operator(db_session: Session):
    project = _make_project(db_session, "项目A")
    base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    _make_shipment(
        db_session, project=project, country="US",
        shipment_no="SHIP-1", shipment_batch="BATCH-A",
    )
    _make_shipment(
        db_session, project=project, country="US",
        shipment_no="SHIP-2", shipment_batch="BATCH-B",
    )
    _set_updated_at(db_session, "SHIP-1", base)
    _set_updated_at(db_session, "SHIP-2", base + dt.timedelta(seconds=1))
    db_session.add(
        ShipmentBatchDropdownHidden(
            operator="alice", project_id=project.id, country="US", shipment_batch="BATCH-A"
        )
    )
    db_session.commit()

    visible_alice = list_shipment_batches(
        db_session, project_id=project.id, country="US", operator="alice"
    )
    visible_bob = list_shipment_batches(
        db_session, project_id=project.id, country="US", operator="bob"
    )

    assert visible_alice == ["BATCH-B"]
    assert visible_bob == ["BATCH-B", "BATCH-A"]


def test_orders_batches_by_latest_updated_at_desc(db_session: Session):
    project = _make_project(db_session, "项目A")
    base = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    rows = [
        ("SHIP-OLD", "BATCH-OLD", base),
        ("SHIP-MID", "BATCH-MID", base + dt.timedelta(days=2)),
        ("SHIP-NEW", "BATCH-NEW", base + dt.timedelta(days=5)),
    ]
    for no, batch, ts in rows:
        _make_shipment(
            db_session, project=project, country="US",
            shipment_no=no, shipment_batch=batch,
        )
        db_session.flush()
        db_session.execute(
            ShipmentSchedule.__table__.update()
            .where(ShipmentSchedule.shipment_no == no)
            .values(updated_at=ts)
        )
    db_session.commit()

    batches = list_shipment_batches(
        db_session, project_id=project.id, country="US"
    )

    assert batches == ["BATCH-NEW", "BATCH-MID", "BATCH-OLD"]
