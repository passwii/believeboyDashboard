"""Agent 访问日志管理端端点测试（agent_api_audit_log 查询）。

BLF-471 起列表还还原 agent_name（join agent_api_keys）与 project_name
（查 projects 表），运营/管理员看中文名而非英文 ID。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models.agent_api_audit_log import AgentApiAuditLog
from app.models.project import Project


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _insert_logs(rows: list[dict]) -> None:
    db = SessionLocal()
    try:
        for row in rows:
            db.add(AgentApiAuditLog(**row))
        db.commit()
    finally:
        db.close()


def _cleanup_logs() -> None:
    db = SessionLocal()
    try:
        db.execute(delete(AgentApiAuditLog))
        db.commit()
    finally:
        db.close()


def _make_project(name: str) -> int:
    """插一个唯一 project 行，返回 DB 分配的 id（用于 project_name 断言）。"""
    db = SessionLocal()
    try:
        project = Project(project_name=name, sort_order=0)
        db.add(project)
        db.commit()
        db.refresh(project)
        return int(project.id)
    finally:
        db.close()


def _cleanup_projects(project_ids: list[int]) -> None:
    if not project_ids:
        return
    db = SessionLocal()
    try:
        db.execute(delete(Project).where(Project.id.in_(project_ids)))
        db.commit()
    finally:
        db.close()


class TestAgentAccessLogsList:
    def test_list_joins_agent_identity(self, client, make_api_key):
        key = make_api_key(agent_id="access-test-agent", label="访问测试 key")
        _insert_logs(
            [
                {
                    "method": "GET",
                    "path": "/api/v1/agent/projects/1/shipments",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 12,
                    "ip_address": "1.2.3.4",
                },
                {
                    "method": "POST",
                    "path": "/api/v1/agent/projects/1/shipments",
                    "api_key_id": None,
                    "status_code": 401,
                    "latency_ms": 5,
                    "ip_address": "5.6.7.8",
                },
            ]
        )
        try:
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?page_size=50"
            )
            assert resp.status_code == 200, resp.text
            payload = resp.json()
            assert payload["total"] == 2
            by_path = {item["path"]: item for item in payload["items"]}
            authed = by_path["/api/v1/agent/projects/1/shipments"]
            assert authed["agent_id"] == "access-test-agent"
            assert authed["key_label"] == "访问测试 key"
            assert authed["api_key_id"] == key["id"]
            assert authed["status_code"] == 200
            anon = next(item for item in payload["items"] if item["method"] == "POST")
            assert anon["agent_id"] is None
            assert anon["api_key_id"] is None
        finally:
            _cleanup_logs()

    def test_list_agent_name_and_project_name(self, client, make_api_key):
        project_id = _make_project("BLF471 访问日志项目")
        key = make_api_key(
            agent_id="access-test-agent", label="访问测试 key", agent_name="货件助理"
        )
        _insert_logs(
            [
                {
                    "method": "GET",
                    "path": f"/api/v1/agent/projects/{project_id}/shipments",
                    "api_key_id": key["id"],
                    "project_id": project_id,
                    "operation_type": "shipments",
                    "status_code": 200,
                    "latency_ms": 12,
                    "ip_address": "1.2.3.4",
                },
                {
                    "method": "GET",
                    "path": "/api/v1/agent/health",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 3,
                    "ip_address": None,
                },
            ]
        )
        try:
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?page_size=50"
            )
            assert resp.status_code == 200, resp.text
            by_path = {item["path"]: item for item in resp.json()["items"]}
            shipment = by_path[f"/api/v1/agent/projects/{project_id}/shipments"]
            assert shipment["agent_name"] == "货件助理"
            assert shipment["project_name"] == "BLF471 访问日志项目"
            # 无项目路径 → project_name 为 null
            health = by_path["/api/v1/agent/health"]
            assert health["project_name"] is None
            assert health["agent_name"] == "货件助理"
        finally:
            _cleanup_logs()
            _cleanup_projects([project_id])

    def test_filters_keyword_method_result(self, client, make_api_key):
        key = make_api_key(agent_id="filter-agent", label="过滤测试")
        _insert_logs(
            [
                {
                    "method": "GET",
                    "path": "/api/v1/agent/health",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 3,
                    "ip_address": "1.1.1.1",
                },
                {
                    "method": "POST",
                    "path": "/api/v1/agent/projects/1/shipments",
                    "api_key_id": key["id"],
                    "status_code": 400,
                    "latency_ms": 8,
                    "ip_address": "2.2.2.2",
                },
                {
                    "method": "GET",
                    "path": "/api/v1/agent/projects/1/shipments",
                    "api_key_id": None,
                    "status_code": 401,
                    "latency_ms": 4,
                    "ip_address": "3.3.3.3",
                },
            ]
        )
        try:
            # keyword 命中 agent_id
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?keyword=filter-agent"
            )
            assert resp.json()["total"] == 2
            # method 过滤
            resp = client.get("/api/v1/system-management/agent-access-logs?method=GET")
            assert resp.json()["total"] == 2
            # result=success（2xx）
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?result=success"
            )
            assert resp.json()["total"] == 1
            # result=error（>=400）
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?result=error"
            )
            assert resp.json()["total"] == 2
            # status_code 精确
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?status_code=401"
            )
            assert resp.json()["total"] == 1
        finally:
            _cleanup_logs()

    def test_new_fields_project_and_operation_type(self, client, make_api_key):
        key = make_api_key(agent_id="meta-agent")
        _insert_logs(
            [
                {
                    "method": "GET",
                    "path": "/api/v1/agent/projects/12/shipments",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 3,
                    "ip_address": None,
                    "project_id": 12,
                    "operation_type": "shipments",
                },
                {
                    "method": "GET",
                    "path": "/api/v1/agent/health",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 3,
                    "ip_address": None,
                },
                {
                    "method": "GET",
                    "path": "/api/v1/external/projects/3/return-analysis",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 3,
                    "ip_address": None,
                    "project_id": 3,
                    "operation_type": "return_analysis",
                },
            ]
        )
        try:
            resp = client.get("/api/v1/system-management/agent-access-logs")
            assert resp.status_code == 200, resp.text
            by_path = {item["path"]: item for item in resp.json()["items"]}
            assert by_path["/api/v1/agent/projects/12/shipments"]["project_id"] == 12
            assert (
                by_path["/api/v1/agent/projects/12/shipments"]["operation_type"]
                == "shipments"
            )
            assert by_path["/api/v1/agent/health"]["project_id"] is None
            assert by_path["/api/v1/agent/health"]["operation_type"] is None
            assert (
                by_path["/api/v1/external/projects/3/return-analysis"]["operation_type"]
                == "return_analysis"
            )
            # project_id / operation_type 筛选
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?project_id=12"
            )
            payload = resp.json()
            assert payload["total"] == 1
            assert payload["items"][0]["path"] == "/api/v1/agent/projects/12/shipments"
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?operation_type=return_analysis"
            )
            assert resp.json()["total"] == 1
            # 组合筛选（交集为空）
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?project_id=3&operation_type=shipments"
            )
            assert resp.json()["total"] == 0
        finally:
            _cleanup_logs()

    def test_pagination(self, client, make_api_key):
        key = make_api_key(agent_id="page-agent")
        _insert_logs(
            [
                {
                    "method": "GET",
                    "path": f"/api/v1/agent/health/{i}",
                    "api_key_id": key["id"],
                    "status_code": 200,
                    "latency_ms": 1,
                    "ip_address": None,
                }
                for i in range(5)
            ]
        )
        try:
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?page=1&page_size=2"
            )
            payload = resp.json()
            assert payload["total"] == 5
            assert len(payload["items"]) == 2
            assert payload["has_next"] is True
            resp = client.get(
                "/api/v1/system-management/agent-access-logs?page=3&page_size=2"
            )
            payload = resp.json()
            assert len(payload["items"]) == 1
            assert payload["has_next"] is False
        finally:
            _cleanup_logs()


class TestAgentAccessLogsSummary:
    def test_summary_counts_and_top_agents(self, client, make_api_key):
        key_a = make_api_key(agent_id="summary-agent-a", label="A 组")
        key_b = make_api_key(agent_id="summary-agent-b", label="B 组")
        _insert_logs(
            [
                {
                    "method": "GET",
                    "path": "/api/v1/agent/health",
                    "api_key_id": key_a["id"],
                    "status_code": 200,
                    "latency_ms": 1,
                    "ip_address": None,
                },
                {
                    "method": "GET",
                    "path": "/api/v1/agent/health",
                    "api_key_id": key_a["id"],
                    "status_code": 200,
                    "latency_ms": 1,
                    "ip_address": None,
                },
                {
                    "method": "POST",
                    "path": "/api/v1/agent/projects/1/shipments",
                    "api_key_id": key_b["id"],
                    "status_code": 409,
                    "latency_ms": 1,
                    "ip_address": None,
                },
                {
                    "method": "GET",
                    "path": "/api/v1/agent/projects/1/shipments",
                    "api_key_id": None,
                    "status_code": 401,
                    "latency_ms": 1,
                    "ip_address": None,
                },
            ]
        )
        try:
            resp = client.get("/api/v1/system-management/agent-access-logs/summary")
            assert resp.status_code == 200, resp.text
            payload = resp.json()
            assert payload["total"] == 4
            assert payload["success_count"] == 2
            assert payload["error_count"] == 2
            assert payload["unique_agent_count"] == 2
            top = {item["agent_id"]: item for item in payload["top_agents"]}
            assert top["summary-agent-a"]["count"] == 2
            assert top["summary-agent-a"]["key_label"] == "A 组"
            assert top["summary-agent-b"]["count"] == 1
        finally:
            _cleanup_logs()
