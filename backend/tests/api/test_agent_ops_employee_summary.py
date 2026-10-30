"""Agent 员工活动聚合端点测试(P3b,employee-summary)。

与 test_agent_ops_domain_summary 同构:按 ``api_key_id`` 分组聚合 audit 行。
覆盖:聚合口径 / NULL api_key_id 排除(匿名与 master 流量不属于任何员工)/
days 边界 / 401。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.agent_api_audit_log import AgentApiAuditLog

pytestmark = [
    pytest.mark.usefixtures("db_session"),
    pytest.mark.audit_table_isolation,
]

ENDPOINT = "/api/v1/agent-ops/employee-summary"


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def _row(**overrides) -> AgentApiAuditLog:
    base: dict = {
        "status_code": 200,
        "latency_ms": 3,
        "ip_address": None,
        "api_key_id": None,
        "operation_type": None,
    }
    base.update(overrides)
    return AgentApiAuditLog(**base)


@pytest.fixture
def seeded_now(db_session):
    """播种按凭据分布的 audit 行:员工 1(活跃,含写)、员工 2(7d 外)、匿名流量。"""
    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            # 员工 1(api_key_id=1):24h 内 GET + POST(写),3 天前 GET → 7d 共 3 次
            _row(api_key_id=1, method="GET", path="/x", created_at=now - timedelta(hours=2)),
            _row(api_key_id=1, method="POST", path="/x", created_at=now - timedelta(hours=1)),
            _row(api_key_id=1, method="GET", path="/x", created_at=now - timedelta(days=3)),
            # 员工 2(api_key_id=2):2 天前 1 次 500 写失败
            _row(
                api_key_id=2,
                method="POST",
                path="/x",
                status_code=500,
                created_at=now - timedelta(days=2),
            ),
            # 员工 3(api_key_id=3):10 天前 → 7d 窗口外
            _row(api_key_id=3, method="GET", path="/x", created_at=now - timedelta(days=10)),
            # 匿名 / master 流量:api_key_id NULL → 永不计入员工
            _row(method="GET", path="/x", created_at=now - timedelta(hours=2)),
        ]
    )
    db_session.commit()
    return now


def test_employee_summary_aggregates_by_key(client, admin_headers, seeded_now):
    r = client.get(ENDPOINT, headers=admin_headers)
    assert r.status_code == 200
    payload = r.json()
    assert payload["window_days"] == 7

    by_key = {item["api_key_id"]: item for item in payload["items"]}

    emp1 = by_key[1]
    assert emp1["calls_24h"] == 2
    assert emp1["calls_7d"] == 3
    assert emp1["writes_24h"] == 1
    assert emp1["writes_7d"] == 1
    assert emp1["errors_7d"] == 0
    last = datetime.fromisoformat(emp1["last_active_at"])
    elapsed = seeded_now - last
    assert timedelta(0) < elapsed <= timedelta(hours=2)

    emp2 = by_key[2]
    assert emp2["calls_7d"] == 1
    assert emp2["writes_7d"] == 1
    assert emp2["errors_7d"] == 1
    assert emp2["calls_24h"] == 0


def test_employee_summary_excludes_out_of_window_and_null_key(client, admin_headers, seeded_now):
    r = client.get(ENDPOINT, headers=admin_headers)
    assert r.status_code == 200
    key_ids = {item["api_key_id"] for item in r.json()["items"]}
    assert 3 not in key_ids  # 10 天前,7d 窗口外
    assert None not in key_ids  # 匿名流量不属于任何员工


def test_employee_summary_days_window_expands(client, admin_headers, seeded_now):
    r = client.get(f"{ENDPOINT}?days=30", headers=admin_headers)
    assert r.status_code == 200
    key_ids = {item["api_key_id"] for item in r.json()["items"]}
    assert 3 in key_ids


def test_employee_summary_requires_auth(client, seeded_now):
    r = client.get(ENDPOINT)
    assert r.status_code == 401


@pytest.mark.parametrize("days", ["0", "91"])
def test_employee_summary_days_bounds(client, admin_headers, seeded_now, days):
    r = client.get(f"{ENDPOINT}?days={days}", headers=admin_headers)
    assert r.status_code == 422
