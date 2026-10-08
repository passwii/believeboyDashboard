"""BLF-1287: ``cancelled`` 货件状态的 HTTP 契约测试。

覆盖：
- POST/PATCH 接受 ``shipment_status=cancelled``，详情回显该状态
- 列表默认排除 cancelled 与分页总数；``shipment_status=cancelled`` 可查
- ``/cost-summary``、``/sku-summary`` 未指定状态时排除 cancelled，显式 cancelled 时按其统计
- ``/batches`` 默认排除 cancelled 批次，支持 ``shipment_status`` 过滤
- 非法状态仍然 422

使用本地 BLF_test（pytest 入口），并绕过 Redis 缓存以保证读到数据库真实结果。
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models import Project, ShipmentSchedule, ShipmentScheduleItem


@pytest.fixture(autouse=True)
def _disable_cache(monkeypatch):
    """绕过 Redis 缓存，保证每个断言都走数据库真实口径。"""
    from app.services.infra import cache as cache_module

    monkeypatch.setattr(cache_module, "cache_get", lambda *a, **k: None)
    monkeypatch.setattr(cache_module, "cache_set", lambda *a, **k: None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Session:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def project(db_session: Session):
    """临时项目，测试结束后连同其货件一并清理。"""
    row = Project(
        project_name=f"blf1287-{uuid.uuid4().hex[:8]}",
        project_operator="alice",
        assistant_operator=None,
        sort_order=0,
        is_active=True,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    try:
        yield row
    finally:
        db_session.rollback()
        db_session.query(ShipmentScheduleItem).filter(
            ShipmentScheduleItem.project_id == row.id
        ).delete()
        db_session.query(ShipmentSchedule).filter(
            ShipmentSchedule.project_id == row.id
        ).delete()
        db_session.query(Project).filter(Project.id == row.id).delete()
        db_session.commit()


def _headers() -> dict[str, str]:
    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Operator": "alice",
        "X-Is-Admin": "true",
    }


def _add_shipment(
    db: Session,
    *,
    project: Project,
    shipment_no: str,
    shipment_status: str,
    quantity: int = 10,
    logistics_total_price: float = 100.0,
    shipment_batch: str | None = None,
) -> ShipmentSchedule:
    schedule = ShipmentSchedule(
        project_id=project.id,
        country="US",
        project_name_snapshot=project.project_name,
        shipment_no=shipment_no,
        shipping_method="sea",
        shipment_status=shipment_status,
        shipment_batch=shipment_batch,
        logistics_total_price=logistics_total_price,
        total_chargeable_weight_kg=2.0,
    )
    db.add(schedule)
    db.flush()
    db.add(
        ShipmentScheduleItem(
            shipment_schedule_id=schedule.id,
            project_id=project.id,
            shipment_no=shipment_no,
            sku=f"SKU-{shipment_no}",
            quantity=quantity,
            estimated_logistics_cost=logistics_total_price,
        )
    )
    db.commit()
    return schedule


# ============================================================
# 写入 + 读取
# ============================================================


def test_create_cancelled_shipment_is_accepted(
    client: TestClient, db_session: Session, project: Project
):
    shipment_no = f"CANCEL-{uuid.uuid4().hex[:8].upper()}"
    response = client.post(
        "/api/v1/shipment-schedules",
        json={
            "project_id": project.id,
            "country": "US",
            "shipment_no": shipment_no,
            "shipping_method": "sea",
            "shipment_status": "cancelled",
        },
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["shipment_status"] == "cancelled"

    detail = client.get(
        f"/api/v1/shipment-schedules/{body['id']}", headers=_headers()
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["shipment_status"] == "cancelled"

    listed = client.get(
        "/api/v1/shipment-schedules",
        params={"project_id": project.id, "shipment_status": "cancelled"},
        headers=_headers(),
    )
    assert listed.status_code == 200, listed.text
    assert [item["shipment_no"] for item in listed.json()["items"]] == [shipment_no]

    default_list = client.get(
        "/api/v1/shipment-schedules",
        params={"project_id": project.id},
        headers=_headers(),
    )
    assert default_list.status_code == 200, default_list.text
    assert default_list.json()["items"] == []


def test_update_to_cancelled_is_accepted(
    client: TestClient, db_session: Session, project: Project
):
    shipment_no = f"PATCHCANCEL-{uuid.uuid4().hex[:8].upper()}"
    schedule = _add_shipment(
        db_session, project=project, shipment_no=shipment_no, shipment_status="draft"
    )

    response = client.patch(
        f"/api/v1/shipment-schedules/{schedule.id}",
        json={
            "project_id": project.id,
            "country": "US",
            "shipment_no": shipment_no,
            "shipping_method": "sea",
            "shipment_status": "cancelled",
        },
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["shipment_status"] == "cancelled"


def test_invalid_status_still_rejected(
    client: TestClient, db_session: Session, project: Project
):
    response = client.post(
        "/api/v1/shipment-schedules",
        json={
            "project_id": project.id,
            "country": "US",
            "shipment_no": f"BAD-{uuid.uuid4().hex[:8].upper()}",
            "shipping_method": "sea",
            "shipment_status": "void",
        },
        headers=_headers(),
    )
    assert response.status_code == 422, response.text


# ============================================================
# 列表 / 统计排除
# ============================================================


def _seed_mixed(db: Session, project: Project) -> None:
    _add_shipment(
        db, project=project, shipment_no="S-DRAFT", shipment_status="draft", quantity=1
    )
    _add_shipment(
        db,
        project=project,
        shipment_no="S-TRANSIT",
        shipment_status="in_transit",
        quantity=2,
    )
    _add_shipment(
        db,
        project=project,
        shipment_no="S-DONE",
        shipment_status="completed",
        quantity=4,
    )
    _add_shipment(
        db,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        quantity=999,
        logistics_total_price=9999.0,
    )


def test_list_default_excludes_cancelled_and_total(
    client: TestClient, db_session: Session, project: Project
):
    _seed_mixed(db_session, project)

    response = client.get(
        "/api/v1/shipment-schedules",
        params={"project_id": project.id, "include_total": "true"},
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    numbers = {item["shipment_no"] for item in body["items"]}
    assert "S-CANCELLED" not in numbers
    assert numbers == {"S-DRAFT", "S-TRANSIT", "S-DONE"}
    assert body["total"] == 3


def test_cost_summary_excludes_cancelled_by_default(
    client: TestClient, db_session: Session, project: Project
):
    _seed_mixed(db_session, project)

    response = client.get(
        "/api/v1/shipment-schedules/cost-summary",
        params={"project_id": project.id},
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["shipment_count"] == 3
    assert body["total_quantity"] == 7
    assert body["total_logistics_cost"] == 300.0


def test_cost_summary_explicit_cancelled_returns_cancelled(
    client: TestClient, db_session: Session, project: Project
):
    _seed_mixed(db_session, project)

    response = client.get(
        "/api/v1/shipment-schedules/cost-summary",
        params={"project_id": project.id, "shipment_status": "cancelled"},
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["shipment_count"] == 1
    assert body["total_quantity"] == 999
    assert body["total_logistics_cost"] == 9999.0


def test_sku_summary_default_excludes_cancelled(
    client: TestClient, db_session: Session, project: Project
):
    _seed_mixed(db_session, project)

    response = client.get(
        "/api/v1/shipment-schedules/sku-summary",
        params={"project_id": project.id},
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    skus = {item["sku"] for item in response.json()["items"]}
    assert skus == {"SKU-S-TRANSIT", "SKU-S-DONE"}


def test_sku_summary_explicit_cancelled_returns_cancelled(
    client: TestClient, db_session: Session, project: Project
):
    _seed_mixed(db_session, project)

    response = client.get(
        "/api/v1/shipment-schedules/sku-summary",
        params={"project_id": project.id, "shipment_status": "cancelled"},
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert {item["sku"] for item in items} == {"SKU-S-CANCELLED"}
    assert items[0]["total_quantity"] == 999


# ============================================================
# 批次选项
# ============================================================


def test_batches_endpoint_excludes_cancelled_batch_by_default(
    client: TestClient, db_session: Session, project: Project
):
    _add_shipment(
        db_session,
        project=project,
        shipment_no="S-ACTIVE",
        shipment_status="in_transit",
        shipment_batch="BATCH-ACTIVE",
    )
    _add_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        shipment_batch="BATCH-CANCELLED",
    )

    response = client.get(
        "/api/v1/shipment-schedules/batches",
        params={"project_id": project.id, "country": "US"},
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["batches"] == ["BATCH-ACTIVE"]


def test_batches_endpoint_supports_status_filter(
    client: TestClient, db_session: Session, project: Project
):
    _add_shipment(
        db_session,
        project=project,
        shipment_no="S-ACTIVE",
        shipment_status="in_transit",
        shipment_batch="BATCH-ACTIVE",
    )
    _add_shipment(
        db_session,
        project=project,
        shipment_no="S-CANCELLED",
        shipment_status="cancelled",
        shipment_batch="BATCH-CANCELLED",
    )

    response = client.get(
        "/api/v1/shipment-schedules/batches",
        params={
            "project_id": project.id,
            "country": "US",
            "shipment_status": "cancelled",
        },
        headers=_headers(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["batches"] == ["BATCH-CANCELLED"]


def test_batches_endpoint_rejects_invalid_status(
    client: TestClient, db_session: Session, project: Project
):
    response = client.get(
        "/api/v1/shipment-schedules/batches",
        params={"project_id": project.id, "country": "US", "shipment_status": "void"},
        headers=_headers(),
    )
    assert response.status_code == 422, response.text
