"""Agent 操作日志管理端端点测试（BLF-460 写操作明细上架 + BLF-471 可读性）。

覆盖：列表（agent 行限定 / 人工行排除）、各过滤维度、project_id 派生
（request_path 优先 / before 兜底）、operation_type 派生、agent_name /
target_label / project_name（BLF-471）、summary、分页。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models.operation_audit_log import OperationAuditLog
from app.models.project import Project

pytestmark = pytest.mark.audit_table_isolation


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _insert_rows(rows: list[dict]) -> None:
    db = SessionLocal()
    try:
        for row in rows:
            db.add(OperationAuditLog(**row))
        db.commit()
    finally:
        db.close()


def _cleanup_rows() -> None:
    db = SessionLocal()
    try:
        db.execute(delete(OperationAuditLog))
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


def _agent_row(**overrides) -> dict:
    base = {
        "action": "shipment.status.transition",
        "target_type": "shipment_schedule",
        "target_id": "42",
        "result": "success",
        "agent_id": "ops-agent-a",
        "agent_name": "货件助理",
        "request_method": "POST",
        "request_path": "/api/v1/agent/projects/7/shipments/SHP001/status",
        "before_json": {"shipment_status": "in_transit"},
        "after_json": {"shipment_status": "complete"},
        "idempotency_key": "idem-1",
    }
    base.update(overrides)
    return base


class TestAgentOperationLogsList:
    def test_list_agent_rows_only_and_fields(self, client):
        _insert_rows(
            [
                _agent_row(),
                _agent_row(
                    action="shipment.create",
                    target_id="43",
                    request_path="/api/v1/agent/projects/7/shipments",
                    before_json=None,
                    after_json={
                        "shipment_no": "SHP002",
                        "project_id": 7,
                        "status": "in_transit",
                    },
                    agent_id="ops-agent-b",
                ),
                # 人工 operator 行必须被排除
                _agent_row(
                    agent_id=None,
                    operator="admin",
                    request_path="/api/v1/shipment-schedules/44",
                ),
            ]
        )
        try:
            resp = client.get("/api/v1/system-management/agent-operation-logs")
            assert resp.status_code == 200, resp.text
            payload = resp.json()
            assert payload["total"] == 2
            items = payload["items"]
            assert all(item["agent_id"] for item in items)

            status_item = next(
                item for item in items if item["action"] == "shipment.status.transition"
            )
            assert status_item["project_id"] == 7
            assert status_item["operation_type"] == "shipments"
            assert status_item["before_json"] == {"shipment_status": "in_transit"}
            assert status_item["after_json"] == {"shipment_status": "complete"}
            assert status_item["idempotency_key"] == "idem-1"
            assert status_item["target_id"] == "42"
            # BLF-471：agent 中文名 + 货件对象标识派生
            assert status_item["agent_name"] == "货件助理"
            assert status_item["target_label"] == "SHP001"

            create_item = next(
                item for item in items if item["action"] == "shipment.create"
            )
            # request_path 无 project_id → before/after 兜底
            assert create_item["project_id"] == 7
            assert create_item["operation_type"] == "shipments"
        finally:
            _cleanup_rows()

    def test_agent_name_and_project_name_and_target_label(self, client):
        project_id = _make_project("BLF471 操作日志项目")
        _insert_rows(
            [
                _agent_row(
                    agent_name="货件助理",
                    request_path=f"/api/v1/agent/projects/{project_id}/shipments/SHP001/status",
                ),
                # 未填 agent_name 的存量行回退 null；before/after 内嵌 shipment_no 优先
                _agent_row(
                    agent_id="ops-agent-c",
                    agent_name=None,
                    action="shipment.create",
                    target_id="43",
                    request_path=f"/api/v1/agent/projects/{project_id}/shipments",
                    before_json=None,
                    after_json={
                        "shipment_no": "SHP002",
                        "project_id": project_id,
                        "status": "in_transit",
                    },
                ),
            ]
        )
        try:
            resp = client.get("/api/v1/system-management/agent-operation-logs")
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]
            by_action = {item["action"]: item for item in items}

            status_item = by_action["shipment.status.transition"]
            assert status_item["agent_name"] == "货件助理"
            assert status_item["project_name"] == "BLF471 操作日志项目"
            # 状态推进无 shipment_no 落 JSON → path 派生
            assert status_item["target_label"] == "SHP001"

            create_item = by_action["shipment.create"]
            assert create_item["agent_name"] is None
            assert create_item["project_name"] == "BLF471 操作日志项目"
            # create 无 /shipments/ 段 → before/after 内嵌 shipment_no 兜底
            assert create_item["target_label"] == "SHP002"
        finally:
            _cleanup_rows()
            _cleanup_projects([project_id])

    def test_filters_agent_project_action_result_keyword(self, client):
        _insert_rows(
            [
                _agent_row(agent_id="ops-agent-a"),
                _agent_row(
                    agent_id="ops-agent-b",
                    action="shop_calculation.append",
                    target_type="shop_calculation",
                    target_id="9",
                    request_path="/api/v1/agent/projects/3/shop-calculations",
                    before_json=None,
                    after_json={"project_id": 3},
                    result="failure",
                    error_message="sku not found",
                ),
                _agent_row(
                    agent_id="ops-agent-a",
                    action="shipment.items.replace",
                    target_id="44",
                    request_path="/api/v1/agent/projects/7/shipments/SHP001/items",
                ),
            ]
        )
        try:
            base = "/api/v1/system-management/agent-operation-logs"
            # agent_id 过滤
            assert client.get(f"{base}?agent_id=ops-agent-b").json()["total"] == 1
            # project_id 过滤（request_path LIKE）
            assert client.get(f"{base}?project_id=3").json()["total"] == 1
            # action 过滤
            assert client.get(f"{base}?action=shipment.").json()["total"] == 2
            # result 过滤
            assert client.get(f"{base}?result=failure").json()["total"] == 1
            # keyword 命中 target_id / error_message
            assert client.get(f"{base}?keyword=44").json()["total"] == 1
            assert client.get(f"{base}?keyword=sku not found").json()["total"] == 1
        finally:
            _cleanup_rows()

    def test_pagination(self, client):
        _insert_rows(
            [_agent_row(target_id=str(i), idempotency_key=f"k-{i}") for i in range(5)]
        )
        try:
            resp = client.get(
                "/api/v1/system-management/agent-operation-logs?page=1&page_size=2"
            )
            payload = resp.json()
            assert payload["total"] == 5
            assert len(payload["items"]) == 2
            assert payload["has_next"] is True
            assert payload["page_size"] == 2
            resp = client.get(
                "/api/v1/system-management/agent-operation-logs?page=3&page_size=2"
            )
            payload = resp.json()
            assert len(payload["items"]) == 1
            assert payload["has_next"] is False
        finally:
            _cleanup_rows()


class TestAgentOperationLogsSummary:
    def test_summary_counts_and_tops(self, client):
        _insert_rows(
            [
                _agent_row(agent_id="ops-agent-a"),
                _agent_row(agent_id="ops-agent-a"),
                _agent_row(agent_id="ops-agent-b", result="failure"),
                _agent_row(
                    agent_id="ops-agent-a", action="shipment.create", target_id="50"
                ),
                _agent_row(agent_id=None, operator="admin"),  # 人工行排除
            ]
        )
        try:
            resp = client.get("/api/v1/system-management/agent-operation-logs/summary")
            assert resp.status_code == 200, resp.text
            payload = resp.json()
            assert payload["total"] == 4
            assert payload["success_count"] == 3
            assert payload["failure_count"] == 1
            assert payload["unique_agent_count"] == 2
            top_agents = {
                item["agent_id"]: item["count"] for item in payload["top_agents"]
            }
            assert top_agents == {"ops-agent-a": 3, "ops-agent-b": 1}
            top_actions = {
                item["action"]: item["count"] for item in payload["top_actions"]
            }
            assert top_actions["shipment.status.transition"] == 3
            assert top_actions["shipment.create"] == 1
        finally:
            _cleanup_rows()


class TestOperationTypeDerivation:
    def test_action_prefix_mapping(self, client):
        # 直接经端点断言 operation_type 派生正确
        _insert_rows(
            [
                _agent_row(action="shipment.status.transition", target_id="1"),
                _agent_row(
                    action="shop_calculation.compute",
                    target_type="shop_calculation",
                    target_id="2",
                ),
                _agent_row(
                    action="new_product_calculation.compute",
                    target_type="new_product_calculation",
                    target_id="3",
                ),
                _agent_row(action="custom.unknown_op", target_type="x", target_id="4"),
            ]
        )
        try:
            resp = client.get("/api/v1/system-management/agent-operation-logs")
            by_action = {
                item["action"]: item["operation_type"] for item in resp.json()["items"]
            }
            assert by_action["shipment.status.transition"] == "shipments"
            assert by_action["shop_calculation.compute"] == "shop_calculations"
            assert (
                by_action["new_product_calculation.compute"]
                == "new_product_calculations"
            )
            assert by_action["custom.unknown_op"] is None
        finally:
            _cleanup_rows()
