"""Agent 数据流总览聚合端点测试(P2b,domain-summary)。

覆盖:
1. 聚合口径:24h / 7d 双窗口调用量、写侧量(POST/PUT/PATCH/DELETE)、错误数
   (status>=400)、最近活动时间;
2. 排除口径:窗口外域不返回、``operation_type IS NULL`` 不返回;
3. ``days`` 参数生效(30d 窗口纳入 10 天前的行)与越界 422(0 / 91);
4. 鉴权:无 API key → 401。

播种说明:audit 行直接 INSERT 并 commit(``db_session`` 收尾回滚,行必须落库
才能被端点会话可见);测试结束由 tests/api 包级 autouse
``_cleanup_agent_audit_tables`` 清表,不污染后续测试的全局计数断言。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.agent_api_audit_log import AgentApiAuditLog

pytestmark = pytest.mark.usefixtures("db_session")

ENDPOINT = "/api/v1/agent-ops/domain-summary"


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(app)


def _row(**overrides) -> AgentApiAuditLog:
    base: dict = {
        "status_code": 200,
        "latency_ms": 3,
        "api_key_id": None,
        "ip_address": None,
    }
    base.update(overrides)
    return AgentApiAuditLog(**base)


@pytest.fixture
def seeded_now(db_session):
    """播种 6 行 audit 数据并 commit;返回播种时刻的 now 供时间断言。"""
    now = datetime.now(timezone.utc)
    db_session.add_all(
        [
            # complaint_center:24h 内 GET + POST(写),3 天前再 1 次 GET → 7d 共 3 次
            _row(
                method="GET",
                path="/api/v1/agent/complaint-center",
                operation_type="complaint_center",
                created_at=now - timedelta(hours=2),
            ),
            _row(
                method="POST",
                path="/api/v1/agent/complaint-center",
                operation_type="complaint_center",
                created_at=now - timedelta(hours=1),
            ),
            _row(
                method="GET",
                path="/api/v1/agent/complaint-center",
                operation_type="complaint_center",
                created_at=now - timedelta(days=3),
            ),
            # sku_info:2 天前 1 次 500 写失败 → 7d 内但 24h 外
            _row(
                method="POST",
                path="/api/v1/agent/sku-info",
                operation_type="sku_info",
                status_code=500,
                created_at=now - timedelta(days=2),
            ),
            # sales:10 天前 → 7d 窗口外、30d 窗口内
            _row(
                method="GET",
                path="/api/v1/agent/sales/summary",
                operation_type="sales",
                created_at=now - timedelta(days=10),
            ),
            # 未映射流量:operation_type NULL → 永不返回
            _row(
                method="GET",
                path="/api/v1/agent/unknown",
                operation_type=None,
                created_at=now - timedelta(hours=2),
            ),
        ]
    )
    db_session.commit()
    return now


def test_domain_summary_aggregates_windows(client, admin_headers, seeded_now):
    r = client.get(ENDPOINT, headers=admin_headers)
    assert r.status_code == 200
    payload = r.json()
    assert payload["window_days"] == 7
    assert payload["generated_at"]

    by_domain = {item["domain"]: item for item in payload["items"]}

    cc = by_domain["complaint_center"]
    assert cc["calls_24h"] == 2
    assert cc["calls_7d"] == 3
    assert cc["writes_24h"] == 1
    assert cc["writes_7d"] == 1
    assert cc["errors_7d"] == 0
    # 最近活动 = 播种时刻 - 1h(允许播种到请求之间的少量时钟流逝)
    last = datetime.fromisoformat(cc["last_active_at"])
    elapsed = seeded_now - last
    assert timedelta(0) < elapsed <= timedelta(hours=2)

    sku = by_domain["sku_info"]
    assert sku["calls_24h"] == 0
    assert sku["calls_7d"] == 1
    assert sku["writes_7d"] == 1
    assert sku["errors_7d"] == 1


def test_domain_summary_excludes_out_of_window_and_null_domain(client, admin_headers, seeded_now):
    r = client.get(ENDPOINT, headers=admin_headers)
    assert r.status_code == 200
    domains = {item["domain"] for item in r.json()["items"]}
    assert "sales" not in domains  # 10 天前,7d 窗口外
    assert None not in domains  # NULL 域不返回(JSON 里也不会出现)


def test_domain_summary_days_window_expands(client, admin_headers, seeded_now):
    r = client.get(f"{ENDPOINT}?days=30", headers=admin_headers)
    assert r.status_code == 200
    payload = r.json()
    assert payload["window_days"] == 30
    domains = {item["domain"] for item in payload["items"]}
    assert "sales" in domains  # 10 天前落入 30d 窗口


def test_domain_summary_requires_auth(client, seeded_now):
    r = client.get(ENDPOINT)
    assert r.status_code == 401


@pytest.mark.parametrize("days", ["0", "91"])
def test_domain_summary_days_bounds(client, admin_headers, seeded_now, days):
    r = client.get(f"{ENDPOINT}?days={days}", headers=admin_headers)
    assert r.status_code == 422
