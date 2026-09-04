"""Tests for DELETE /api/v1/shipment-schedules/batches/hidden.

验证：
- 204 返回
- 幂等（重复 DELETE 仍 204）
- 缺 X-Operator 时 401

注：本测试需要 backend/.env 配置数据库连接才能跑（执行前需先 alembic upgrade head）。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models import Project, ShipmentBatchDropdownHidden


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


def _admin_headers() -> dict[str, str]:
    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Operator": "alice",
        "X-Is-Admin": "true",
    }


def _make_project(db: Session, operator: str) -> Project:
    """插入一个临时项目，project_operator 与 assistant_operator 都包含 operator 以保证 admin 头能 bypass。"""
    project = Project(
        project_name=f"hide-batch-test-{uuid.uuid4().hex[:8]}",
        project_operator=operator,
        assistant_operator=None,
        sort_order=0,
        is_active=True,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def test_hide_endpoint_returns_204_and_is_idempotent(
    client: TestClient, db_session: Session
):
    project = _make_project(db_session, operator="alice")
    try:
        payload = {
            "project_id": project.id,
            "country": "US",
            "shipment_batch": "BATCH-A",
        }
        headers = _admin_headers()

        r1 = client.request(
            "DELETE",
            "/api/v1/shipment-schedules/batches/hidden",
            json=payload,
            headers=headers,
        )
        r2 = client.request(
            "DELETE",
            "/api/v1/shipment-schedules/batches/hidden",
            json=payload,
            headers=headers,
        )

        assert r1.status_code == 204, f"first DELETE: {r1.status_code} {r1.text}"
        assert r2.status_code == 204, f"second DELETE: {r2.status_code} {r2.text}"

        rows = (
            db_session.query(ShipmentBatchDropdownHidden)
            .filter(
                ShipmentBatchDropdownHidden.project_id == project.id,
                ShipmentBatchDropdownHidden.shipment_batch == "BATCH-A",
            )
            .all()
        )
        assert len(rows) == 1
        assert rows[0].operator == "alice"
        assert rows[0].country == "US"
    finally:
        db_session.query(ShipmentBatchDropdownHidden).filter(
            ShipmentBatchDropdownHidden.project_id == project.id
        ).delete()
        db_session.query(Project).filter(Project.id == project.id).delete()
        db_session.commit()


def test_hide_endpoint_rejects_missing_operator(client: TestClient):
    """无 X-Operator 应返回 401。"""
    settings = get_settings()
    r = client.request(
        "DELETE",
        "/api/v1/shipment-schedules/batches/hidden",
        json={"project_id": 1, "country": "US", "shipment_batch": "BATCH-A"},
        headers={"X-API-Key": settings.api_key, "X-Is-Admin": "true"},
    )
    assert r.status_code == 401, f"expected 401, got {r.status_code} {r.text}"