"""query_operation_audit_log（spec S7 的 service 层）。"""

from __future__ import annotations

import uuid

import pytest

from app.db.session import SessionLocal
from app.models.operation_audit_log import OperationAuditLog
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log,
)


@pytest.fixture
def seeded_rows():
    target_id = f"tgt-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        for i in range(3):
            append_operation_audit_log(
                db,
                action=f"agent.test.q{i}",
                target_type="shipment_schedule",
                target_id=target_id,
                agent_id="query-agent",
                after={"i": i},
            )
        # 干扰行：其他 target
        append_operation_audit_log(
            db,
            action="agent.test.other",
            target_type="shipment_schedule",
            target_id="other-target",
            agent_id="query-agent",
        )
        db.commit()
    finally:
        db.close()
    yield target_id
    db = SessionLocal()
    try:
        db.query(OperationAuditLog).filter(
            OperationAuditLog.agent_id == "query-agent"
        ).delete()
        db.commit()
    finally:
        db.close()


def test_query_filters_and_orders(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log(
            db, target_type="shipment_schedule", target_id=seeded_rows
        )
        assert len(rows) == 3
        assert rows[0].id > rows[1].id > rows[2].id  # id 倒序
        assert all(r.target_id == seeded_rows for r in rows)
    finally:
        db.close()


def test_query_limit(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log(
            db, target_type="shipment_schedule", target_id=seeded_rows, limit=2
        )
        assert len(rows) == 2
    finally:
        db.close()


def test_query_empty(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log(
            db, target_type="shipment_schedule", target_id="nonexistent"
        )
        assert rows == []
    finally:
        db.close()
