"""Agent 退货分析 R5 覆盖度测试（BLF-470 spec §7：报表上传 / snapshot fresh / data_span）。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

from conftest import seed_return_analysis


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(env) -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/return-analysis/coverage"


class TestR5Coverage:
    def test_coverage_no_data(self, client, shipment_env):
        """无任何退货数据：空 uploads + snapshot 空 + fresh=False。"""
        resp = client.get(_url(shipment_env) + "?country=US", headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_id"] == shipment_env["project_id"]
        assert data["country"] == "US"
        assert data["report_uploads"] == []
        assert data["snapshot"]["last_computed_at"] is None
        assert data["snapshot"]["fresh"] is False
        assert data["snapshot"]["staleness_threshold_hours"] == 25
        assert data["data_span"]["min_return_date"] is None
        assert data["data_span"]["max_return_date"] is None

    def test_coverage_with_report_and_fresh_snapshot(self, client, shipment_env):
        d = date.today() - timedelta(days=1)
        seed_return_analysis(
            shipment_env["project_id"],
            return_rows=[
                {
                    "return_date": d,
                    "order_id": "O-1",
                    "sku": "X-001",
                    "quantity": 2,
                }
            ],
            aggregate_rows=[
                {
                    "sku": "X-001",
                    "data_date": d,
                    "return_quantity": 2,
                    "sales_quantity": 10,
                    "risk_level": "critical",
                }
            ],
        )
        resp = client.get(_url(shipment_env) + "?country=US", headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert len(data["report_uploads"]) == 1
        upload = data["report_uploads"][0]
        assert upload["ingestion_status"] == "success"
        assert upload["row_count"] == 1
        assert upload["is_current"] is True
        assert upload["period_start_date"] is not None
        assert upload["period_end_date"] is not None
        # aggregate 未传 computed_at → server_default=now() → fresh
        assert data["snapshot"]["last_computed_at"] is not None
        assert data["snapshot"]["fresh"] is True
        assert data["data_span"]["min_return_date"] == d.isoformat()
        assert data["data_span"]["max_return_date"] == d.isoformat()

    def test_coverage_missing_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis/coverage?country=US",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestBusinessScope:
    def test_business_scope_allows_return_analysis(self, client, make_api_key):
        """business_scope 含 return_analysis → 放行（read 正常）。"""
        agent_id = "ret-scope-allow"
        key = make_api_key(agent_id=agent_id, business_scope="return_analysis")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis/coverage?country=US",
            headers=headers,
        )
        # project 99999999 不存在 → 404 RESOURCE_NOT_FOUND（说明过了域校验，进入项目校验）
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_business_scope_denies_other_domain(self, client, make_api_key):
        """business_scope 不含 return_analysis → 403 AGENT_BUSINESS_OUT_OF_SCOPE。"""
        agent_id = "ret-scope-deny"
        key = make_api_key(agent_id=agent_id, business_scope="shipments")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }
        resp = client.get(
            "/api/v1/agent/projects/99999999/return-analysis/coverage?country=US",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
