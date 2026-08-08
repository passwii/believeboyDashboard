"""工作流自动化设置 API 集成测试 — BLF-540。

覆盖：GET /api/v1/crm/settings/workflow
- 管理员可读/写；非管理员 403
- PUT 部分更新；天数越界 → 422
"""

from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.fixture(autouse=True)
def _reset_settings(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "update crm_workflow_settings set stale_days=7, stale_email_enabled=true"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def test_get_workflow_settings_admin(client, admin_headers):
    resp = client.get("/api/v1/crm/settings/workflow", headers=admin_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"stale_days": 7, "stale_email_enabled": True}


def test_get_workflow_settings_forbidden_for_operator(client, operator_headers):
    resp = client.get("/api/v1/crm/settings/workflow", headers=operator_headers)
    assert resp.status_code == 403


def test_put_workflow_settings_admin_partial(client, admin_headers):
    resp = client.put(
        "/api/v1/crm/settings/workflow",
        headers=admin_headers,
        json={"stale_days": 14},
    )
    assert resp.status_code == 200
    assert resp.json() == {"stale_days": 14, "stale_email_enabled": True}

    resp = client.put(
        "/api/v1/crm/settings/workflow",
        headers=admin_headers,
        json={"stale_email_enabled": False},
    )
    assert resp.status_code == 200
    assert resp.json() == {"stale_days": 14, "stale_email_enabled": False}


def test_put_workflow_settings_validation(client, admin_headers):
    resp = client.put(
        "/api/v1/crm/settings/workflow",
        headers=admin_headers,
        json={"stale_days": 0},
    )
    assert resp.status_code == 422

    resp = client.put(
        "/api/v1/crm/settings/workflow",
        headers=admin_headers,
        json={"stale_days": 400},
    )
    assert resp.status_code == 422


def test_put_workflow_settings_forbidden_for_operator(client, operator_headers):
    resp = client.put(
        "/api/v1/crm/settings/workflow",
        headers=operator_headers,
        json={"stale_days": 3},
    )
    assert resp.status_code == 403
