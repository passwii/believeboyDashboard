"""BLF-1287: ``cancelled`` 货件状态的服务端支持（服务层）。

覆盖范围：
- ``shipment_status`` 合法值新增 ``cancelled``（create/update/CSV 共用入口）
- 货件列表：默认排除 cancelled，显式 ``shipment_status=cancelled`` 可查
- 批次选项：默认排除 cancelled 批次，支持显式按状态过滤
- 费用汇总 / SKU 汇总：未指定状态时排除 cancelled，显式 cancelled 时按其统计
- 补货在途的历史口径排除 cancelled

全部使用 sqlite 内存库，不依赖本地 Postgres。
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models import (
    Project,
    ShipmentBatchDropdownHidden,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.services.inventory.replenishment import _load_in_transit_map
from app.services.shipment.schedule import (
    list_shipment_batches,
    list_shipment_schedules,
)
from app.services.shipment.summary import (
    list_shipment_sku_summary,
    summarize_shipment_schedule_costs,
)
from app.services.shipment.validation import normalize_status

import app.models  # noqa: F401  触发所有模型注册到 Base.metadata


@pytest.fixture
def db_session() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)

    @event.listens_for(engine, "connect")
    def _enable_fk(dbapi_conn, _record):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(
        engine,
        tables=[
            Project.__table__,
            ShipmentSchedule.__table__,
            ShipmentScheduleItem.__table__,
            ShipmentBatchDropdownHidden.__table__,
        ],
    )
    TestingSession = sessionmaker(
        bind=engine, autoflush=True, autocommit=False, future=True
    )
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _make_project(db: Session, name: str = "项目A") -> Project:
    project = Project(project_name=name, is_active=True, sort_order=1)
    db.add(project)
    db.flush()
    return project


def _make_shipment(
    db: Session,
    *,
    project: Project,
    shipment_no: str,
    shipment_status: str,
    country: str = "US",
    shipment_batch: str | None = None,
    include_in_history: bool = True,
    quantity: int = 10,
    chargeable_weight_kg: float = 2.0,
    estimated_logistics_cost: float = 100.0,
    logistics_total_price: float = 100.0,
    created_at: dt.datetime | None = None,
    actual_inbound_date: dt.date | None = None,
) -> ShipmentSchedule:
    schedule = ShipmentSchedule(
        project_id=project.id,
        country=country,
        project_name_snapshot=project.project_name,
        shipment_no=shipment_no,
        shipping_method="sea",
        shipment_status=shipment_status,
        shipment_batch=shipment_batch,
        include_in_history_shipping_calc=include_in_history,
        logistics_total_price=logistics_total_price,
        total_chargeable_weight_kg=chargeable_weight_kg,
        created_date=dt.date(2026, 1, 1),
        actual_inbound_date=actual_inbound_date,
    )
    if created_at is not None:
        schedule.created_at = created_at
        schedule.updated_at = created_at
    db.add(schedule)
    db.flush()
    db.add(
        ShipmentScheduleItem(
            shipment_schedule_id=schedule.id,
            project_id=project.id,
            shipment_no=shipment_no,
            sku=f"SKU-{shipment_no}",
            quantity=quantity,
            chargeable_weight_kg=chargeable_weight_kg,
            estimated_logistics_cost=estimated_logistics_cost,
        )
    )
    db.flush()
    return schedule


# ============================================================
# 状态白名单
# ============================================================


def test_normalize_status_accepts_cancelled() -> None:
    assert normalize_status("cancelled") == "cancelled"
    assert normalize_status("  cancelled  ") == "cancelled"


def test_normalize_status_still_rejects_unknown() -> None:
    with pytest.raises(HTTPException) as exc_info:
        normalize_status("void")
    assert exc_info.value.status_code == 422
    assert "cancelled" in exc_info.value.detail


# ============================================================
# 列表过滤
# ============================================================


def _list_rows(db: Session, **kwargs) -> list[ShipmentSchedule]:
    defaults = dict(
        project_id=None,
        project_ids=None,
        country=None,
        shipment_status=None,
        shipping_method=None,
        shipment_no=None,
        created_date_from=None,
        created_date_to=None,
        etd_from=None,
        etd_to=None,
        eta_from=None,
        eta_to=None,
        page=1,
        page_size=50,
    )
    defaults.update(kwargs)
    rows, _total, _has_next = list_shipment_schedules(db, **defaults)
    return [row[0] for row in rows]


def test_list_default_excludes_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-DRAFT", shipment_status="draft"
    )
    _make_shipment(
        db_session, project=project, shipment_no="S-CANCELLED", shipment_status="cancelled"
    )
    db_session.commit()

    nos = [row.shipment_no for row in _list_rows(db_session, project_id=project.id)]

    assert nos == ["S-DRAFT"]


def test_list_default_total_excludes_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-DRAFT", shipment_status="draft"
    )
    _make_shipment(
        db_session, project=project, shipment_no="S-CANCELLED", shipment_status="cancelled"
    )
    db_session.commit()

    _rows, total, _has_next = list_shipment_schedules(
        db_session,
        project_id=project.id,
        project_ids=None,
        country=None,
        shipment_status=None,
        shipping_method=None,
        shipment_no=None,
        created_date_from=None,
        created_date_to=None,
        etd_from=None,
        etd_to=None,
        eta_from=None,
        eta_to=None,
        page=1,
        page_size=50,
        include_total=True,
    )

    assert total == 1


def test_list_explicit_cancelled_returns_only_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-DRAFT", shipment_status="draft"
    )
    _make_shipment(
        db_session, project=project, shipment_no="S-CANCELLED", shipment_status="cancelled"
    )
    db_session.commit()

    nos = [
        row.shipment_no
        for row in _list_rows(
            db_session, project_id=project.id, shipment_status="cancelled"
        )
    ]

    assert nos == ["S-CANCELLED"]


def test_list_explicit_draft_still_filters(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-DRAFT", shipment_status="draft"
    )
    _make_shipment(
        db_session, project=project, shipment_no="S-DONE", shipment_status="completed"
    )
    db_session.commit()

    nos = [
        row.shipment_no
        for row in _list_rows(db_session, project_id=project.id, shipment_status="draft")
    ]

    assert nos == ["S-DRAFT"]


# ============================================================
# 批次选项
# ============================================================


def test_batches_default_excludes_cancelled_only_batch(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-1",
        shipment_status="in_transit",
        shipment_batch="BATCH-ACTIVE",
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-2",
        shipment_status="cancelled",
        shipment_batch="BATCH-CANCELLED",
    )
    db_session.commit()

    batches = list_shipment_batches(db_session, project_id=project.id, country="US")

    assert batches == ["BATCH-ACTIVE"]


def test_batches_keep_batch_with_mixed_statuses(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-1",
        shipment_status="in_transit",
        shipment_batch="BATCH-MIXED",
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-2",
        shipment_status="cancelled",
        shipment_batch="BATCH-MIXED",
    )
    db_session.commit()

    batches = list_shipment_batches(db_session, project_id=project.id, country="US")

    assert batches == ["BATCH-MIXED"]


def test_batches_explicit_cancelled_includes_cancelled_batch(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-1",
        shipment_status="in_transit",
        shipment_batch="BATCH-ACTIVE",
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-2",
        shipment_status="cancelled",
        shipment_batch="BATCH-CANCELLED",
    )
    db_session.commit()

    batches = list_shipment_batches(
        db_session, project_id=project.id, country="US", shipment_status="cancelled"
    )

    assert batches == ["BATCH-CANCELLED"]


def test_batches_reject_invalid_status(db_session: Session) -> None:
    project = _make_project(db_session)
    db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        list_shipment_batches(
            db_session, project_id=project.id, country="US", shipment_status="void"
        )

    assert exc_info.value.status_code == 422


# ============================================================
# 费用汇总
# ============================================================


def _cost_summary(db_session: Session, project_id: int, shipment_status=None):
    return summarize_shipment_schedule_costs(
        db_session,
        project_id=project_id,
        project_ids=None,
        country=None,
        shipment_status=shipment_status,
        shipping_method=None,
        shipment_no=None,
        created_date_from=None,
        created_date_to=None,
    )


def test_cost_summary_default_excludes_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-DRAFT", shipment_status="draft"
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        quantity=999,
        logistics_total_price=9999.0,
        chargeable_weight_kg=999.0,
    )
    db_session.commit()

    summary = _cost_summary(db_session, project.id)

    assert summary["shipment_count"] == 1
    assert summary["total_sku"] == 1
    assert summary["total_quantity"] == 10
    assert summary["total_chargeable_weight_kg"] == 2.0
    assert summary["total_logistics_cost"] == 100.0


def test_cost_summary_explicit_cancelled_returns_cancelled_only(
    db_session: Session,
) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-DRAFT", shipment_status="draft"
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        quantity=999,
        logistics_total_price=9999.0,
    )
    db_session.commit()

    summary = _cost_summary(db_session, project.id, shipment_status="cancelled")

    assert summary["shipment_count"] == 1
    assert summary["total_quantity"] == 999
    assert summary["total_logistics_cost"] == 9999.0


# ============================================================
# SKU 汇总
# ============================================================


def _sku_summary(db_session: Session, project_id: int, shipment_status=None):
    return list_shipment_sku_summary(
        db_session,
        project_id=project_id,
        include_only_history_calc=True,
        shipment_status=shipment_status,
    )


def test_sku_summary_default_excludes_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-OK", shipment_status="in_transit"
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        quantity=999,
    )
    db_session.commit()

    # 不传状态（None 由调用方显式传入，等价于「无状态过滤」）
    rows = _sku_summary(db_session, project.id, shipment_status=None)

    assert [row["sku"] for row in rows] == ["SKU-S-OK"]
    assert rows[0]["total_quantity"] == 10


def test_sku_summary_explicit_cancelled_returns_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    _make_shipment(
        db_session, project=project, shipment_no="S-OK", shipment_status="in_transit"
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        quantity=999,
    )
    db_session.commit()

    rows = _sku_summary(db_session, project.id, shipment_status="cancelled")

    assert [row["sku"] for row in rows] == ["SKU-S-CANCELLED"]
    assert rows[0]["total_quantity"] == 999


# ============================================================
# 补货在途历史口径
# ============================================================


def test_in_transit_history_excludes_cancelled(db_session: Session) -> None:
    project = _make_project(db_session)
    report_date = dt.date(2026, 3, 1)
    created = dt.datetime(2026, 2, 1, 12, 0, 0)
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-DRAFT",
        shipment_status="draft",
        quantity=7,
        created_at=created,
    )
    _make_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        quantity=999,
        created_at=created,
    )
    db_session.commit()

    in_transit = _load_in_transit_map(db_session, project.id, "US", report_date)

    assert in_transit == {"SKU-S-DRAFT": 7}
