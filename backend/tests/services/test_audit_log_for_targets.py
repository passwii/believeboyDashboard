"""query_operation_audit_log_for_targets 新查询函数测试（BLF-442 spec §7）。"""

from __future__ import annotations

import uuid

import pytest

from app.db.session import SessionLocal
from app.models.operation_audit_log import OperationAuditLog
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log_for_targets,
)

_AGENT = "targets-query-agent"


@pytest.fixture
def seeded_rows():
    """提交 5 行 shop_calculation 审计（target 101-105）+ 1 行干扰（其他 target_type）。"""
    db = SessionLocal()
    try:
        for target_id in range(101, 106):
            append_operation_audit_log(
                db,
                action=f"shop_calculation.append.{target_id}",
                target_type="shop_calculation",
                target_id=str(target_id),
                operator=None,
                after={"target": target_id},
                agent_id=_AGENT,
                idempotency_key=f"ik-{target_id}",
            )
        append_operation_audit_log(
            db,
            action="other.type",
            target_type="shipment_schedule",
            target_id="101",
            agent_id=_AGENT,
        )
        db.commit()
    finally:
        db.close()
    yield
    db = SessionLocal()
    try:
        db.query(OperationAuditLog).filter(
            OperationAuditLog.agent_id == _AGENT
        ).delete()
        db.commit()
    finally:
        db.close()


def test_empty_target_ids_returns_empty(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db, target_type="shop_calculation", target_ids=[]
        )
        assert rows == []
    finally:
        db.close()


def test_in_clause_matches_only_given_targets(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db, target_type="shop_calculation", target_ids=[101, 103]
        )
        assert {int(row.target_id) for row in rows} == {101, 103}
        assert all(row.target_type == "shop_calculation" for row in rows)
    finally:
        db.close()


def test_target_type_scoped(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db, target_type="shipment_schedule", target_ids=[101]
        )
        assert len(rows) == 1 and rows[0].action == "other.type"
    finally:
        db.close()


def test_order_by_id_desc(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db, target_type="shop_calculation", target_ids=[101, 102, 103]
        )
        ids = [int(row.target_id) for row in rows]
        assert ids == sorted(ids, reverse=True), "id 倒序"
    finally:
        db.close()


def test_limit_applied(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db,
            target_type="shop_calculation",
            target_ids=list(range(101, 106)),
            limit=3,
        )
        assert len(rows) == 3
    finally:
        db.close()


def test_agent_fields_survive_query(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db, target_type="shop_calculation", target_ids=[104]
        )
        assert rows[0].agent_id == _AGENT
        assert rows[0].idempotency_key == "ik-104"
        assert rows[0].operator is None
    finally:
        db.close()


def test_unknown_targets_returns_empty(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log_for_targets(
            db, target_type="shop_calculation", target_ids=[999999]
        )
        assert rows == []
    finally:
        db.close()
