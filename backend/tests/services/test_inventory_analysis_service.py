"""Integration tests for ``app.services.inventory_analysis_service.list_inventory_analysis``.

Covers the two new features:
  * ``product_name`` (中文品名) matched by SKU / ASIN
  * dynamic ``shipment_columns`` + per-row ``shipment_quantities`` for in-transit
    shipments (shipment_status='in_transit'), plus ``shipment_column_totals``.
"""
from __future__ import annotations

from datetime import date, datetime

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models import (
    AnalysisSourceFile,
    InventorySnapshotRow,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
    SkuRecord,
)
from app.services.inventory_analysis_service import list_inventory_analysis

# 引入 app.models 触发所有模型注册到 Base.metadata（create_all 需要完整表集合）
import app.models  # noqa: F401


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
            SkuRecord.__table__,
            AnalysisSourceFile.__table__,
            InventorySnapshotRow.__table__,
            ShipmentSchedule.__table__,
            ShipmentScheduleItem.__table__,
        ],
    )
    TestingSession = sessionmaker(bind=engine, autoflush=True, autocommit=False, future=True)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _make_project(db: Session, name: str = "测试项目A") -> Project:
    project = Project(project_name=name, is_active=True, sort_order=1)
    db.add(project)
    db.flush()
    return project


def _make_sku_record(
    db: Session,
    *,
    project: Project,
    sku: str,
    asin: str | None,
    product_name: str | None,
) -> None:
    db.add(
        SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku=sku,
            asin=asin or "",
            product_name=product_name,
            country="US",
            is_active=True,
        )
    )


def _make_source(db: Session, project: Project) -> AnalysisSourceFile:
    source = AnalysisSourceFile(
        project_id=project.id,
        report_type="inventory_report",
        country="US",
        report_date=date(2026, 7, 1),
        snapshot_at=datetime(2026, 7, 1, 12, 0, 0),
        version=1,
        is_current=True,
        upload_file_id="test",
        upload_file_path="/tmp/test",
        stored_filename="test.csv",
        logical_filename="test.csv",
        storage_key="test.csv",
        ingestion_status="success",
        row_count_total=1,
        row_count_included=1,
    )
    db.add(source)
    db.flush()
    return source


def _make_inventory_row(
    db: Session, source: AnalysisSourceFile, *, sku: str, asin: str | None, row_no: int = 1
) -> None:
    db.add(
        InventorySnapshotRow(
            source_file_id=source.id,
            source_row_no=row_no,
            sku=sku,
            asin=asin,
            available_qty=10,
            age_0_90_qty=10,
            age_91_180_qty=0,
            age_181_270_qty=0,
            age_271_365_qty=0,
            age_365_plus_qty=0,
            recommended_action="Replenish",
            stock_status="in_stock",
            aging_status="fresh",
            raw_row={},
        )
    )


def _make_shipment(
    db: Session,
    *,
    project: Project,
    shipment_no: str,
    status: str,
    items: list[tuple[str, int]],
) -> None:
    schedule = ShipmentSchedule(
        project_id=project.id,
        country="US",
        project_name_snapshot=project.project_name,
        shipment_no=shipment_no,
        shipping_method="sea",
        shipment_status=status,
    )
    db.add(schedule)
    db.flush()
    for sku, quantity in items:
        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=project.id,
                shipment_no=shipment_no,
                sku=sku,
                quantity=quantity,
            )
        )


def _item_by_sku(payload: dict, sku: str) -> dict:
    return next(item for item in payload["items"] if item["sku"] == sku)


class TestProductName:
    def test_matches_by_sku(self, db_session: Session):
        project = _make_project(db_session)
        _make_sku_record(db_session, project=project, sku="SKU-001", asin="ASIN001", product_name="品名A")
        source = _make_source(db_session, project)
        _make_inventory_row(db_session, source, sku="SKU-001", asin="ASIN001")

        payload = list_inventory_analysis(db_session, project_id=project.id, country="US")

        assert _item_by_sku(payload, "SKU-001")["product_name"] == "品名A"

    def test_falls_back_to_asin(self, db_session: Session):
        project = _make_project(db_session)
        # 同 sku 无品名，但 asin 命中另一条带品名的记录
        _make_sku_record(db_session, project=project, sku="SKU-002", asin="ASIN002", product_name=None)
        _make_sku_record(db_session, project=project, sku="SKU-OTHER", asin="ASIN002", product_name="品名B")
        source = _make_source(db_session, project)
        _make_inventory_row(db_session, source, sku="SKU-002", asin="ASIN002")

        payload = list_inventory_analysis(db_session, project_id=project.id, country="US")

        assert _item_by_sku(payload, "SKU-002")["product_name"] == "品名B"

    def test_missing_name_is_none(self, db_session: Session):
        project = _make_project(db_session)
        _make_sku_record(db_session, project=project, sku="SKU-001", asin="ASIN001", product_name=None)
        source = _make_source(db_session, project)
        _make_inventory_row(db_session, source, sku="SKU-001", asin="ASIN001")

        payload = list_inventory_analysis(db_session, project_id=project.id, country="US")

        assert _item_by_sku(payload, "SKU-001")["product_name"] is None


class TestInTransitShipmentColumns:
    def test_only_in_transit_and_displayed_skus(self, db_session: Session):
        project = _make_project(db_session)
        _make_sku_record(db_session, project=project, sku="SKU-001", asin="ASIN001", product_name="品名A")
        _make_sku_record(db_session, project=project, sku="SKU-002", asin="ASIN002", product_name="品名B")
        source = _make_source(db_session, project)
        _make_inventory_row(db_session, source, sku="SKU-001", asin="ASIN001", row_no=1)
        _make_inventory_row(db_session, source, sku="SKU-002", asin="ASIN002", row_no=2)

        # 在途货件，含本页两个 SKU
        _make_shipment(db_session, project=project, shipment_no="SHIP-A", status="in_transit",
                       items=[("SKU-001", 5), ("SKU-002", 3)])
        # 已完成货件，应被排除
        _make_shipment(db_session, project=project, shipment_no="SHIP-DONE", status="completed",
                       items=[("SKU-001", 99)])
        # 在途但 SKU 不在本页，应被排除
        _make_shipment(db_session, project=project, shipment_no="SHIP-OTHER", status="in_transit",
                       items=[("SKU-UNKNOWN", 7)])

        payload = list_inventory_analysis(db_session, project_id=project.id, country="US")

        shipment_nos = [col["shipment_no"] for col in payload["shipment_columns"]]
        assert shipment_nos == ["SHIP-A"]
        assert payload["shipment_column_totals"] == {"SHIP-A": 8}
        assert _item_by_sku(payload, "SKU-001")["shipment_quantities"] == {"SHIP-A": 5}
        assert _item_by_sku(payload, "SKU-002")["shipment_quantities"] == {"SHIP-A": 3}

    def test_no_in_transit_shipments_returns_empty(self, db_session: Session):
        project = _make_project(db_session)
        _make_sku_record(db_session, project=project, sku="SKU-001", asin="ASIN001", product_name="品名A")
        source = _make_source(db_session, project)
        _make_inventory_row(db_session, source, sku="SKU-001", asin="ASIN001")
        _make_shipment(db_session, project=project, shipment_no="SHIP-A", status="draft",
                       items=[("SKU-001", 5)])

        payload = list_inventory_analysis(db_session, project_id=project.id, country="US")

        assert payload["shipment_columns"] == []
        assert payload["shipment_column_totals"] == {}
        assert _item_by_sku(payload, "SKU-001")["shipment_quantities"] == {}
