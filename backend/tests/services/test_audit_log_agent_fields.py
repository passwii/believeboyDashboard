"""operation_audit_logs 的 agent 归因字段（Agent API 设计稿 §4.2 / spec E4）。

覆盖：
* agent 写调用落 agent_id / idempotency_key，operator 保持 NULL
* 缺 Idempotency-Key 时 after_json 打 no_idempotency 风险标记
* 人用 UI 的写调用（不传 agent kwargs）不受影响
"""

from __future__ import annotations

import pytest

from app.db.session import SessionLocal
from app.models.operation_audit_log import OperationAuditLog
from app.services.audit_log_service import append_operation_audit_log

ACTION = "agent.test.action"


@pytest.fixture
def audit_row_factory():
    """写一行审计并返回行对象；测试后清理。"""
    created_ids: list[int] = []

    def _write(**kwargs) -> OperationAuditLog:
        db = SessionLocal()
        try:
            append_operation_audit_log(
                db, action=ACTION, target_type="agent_test", **kwargs
            )
            db.commit()
            row = (
                db.query(OperationAuditLog)
                .filter_by(action=ACTION)
                .order_by(OperationAuditLog.id.desc())
                .first()
            )
            created_ids.append(row.id)
            db.expunge(row)
            return row
        finally:
            db.close()

    yield _write

    db = SessionLocal()
    try:
        for row_id in created_ids:
            obj = db.get(OperationAuditLog, row_id)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()


def test_agent_fields_persisted(audit_row_factory):
    row = audit_row_factory(
        agent_id="shipment-assistant-prod",
        agent_name="货件助理",
        idempotency_key="idem-123",
        after={"k": "v"},
    )
    assert row.operator is None
    assert row.agent_id == "shipment-assistant-prod"
    assert row.agent_name == "货件助理"
    assert row.idempotency_key == "idem-123"
    assert row.after_json == {"k": "v"}


def test_missing_idempotency_key_marks_risk(audit_row_factory):
    row = audit_row_factory(agent_id="shipment-assistant-prod", after={"k": "v"})
    assert row.idempotency_key is None
    assert row.after_json["risk"] == "no_idempotency"
    assert row.after_json["k"] == "v"


def test_missing_idempotency_key_without_after(audit_row_factory):
    row = audit_row_factory(agent_id="shipment-assistant-prod")
    assert row.after_json == {"risk": "no_idempotency"}


def test_human_write_unaffected(audit_row_factory):
    row = audit_row_factory(operator="damon", after={"k": "v"})
    assert row.operator == "damon"
    assert row.agent_id is None
    assert row.idempotency_key is None
    assert row.after_json == {"k": "v"}
