"""audit_service TDD tests — 审计日志记录/查询/变更摘要（P4）。"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.services.crm.audit_service import (
    CUSTOMER_FIELD_LABELS,
    list_audit_logs,
    record_log,
    summarize_update,
)

ALICE = "11111111-1111-1111-1111-111111111111"


@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("truncate crm_audit_logs restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def test_record_log_persists(db_session):
    log = record_log(
        db_session,
        entity_type="customer",
        entity_id=1,
        action="create",
        actor_id=ALICE,
        summary="新建客户",
    )
    assert log.id is not None
    row = db_session.execute(
        text(
            "select entity_type, entity_id, action, actor_id, summary from crm_audit_logs"
        )
    ).one()
    assert row == ("customer", 1, "create", ALICE, "新建客户")


def test_list_audit_logs_filter_by_entity_and_order(db_session):
    record_log(
        db_session, entity_type="customer", entity_id=1, action="create", actor_id=ALICE
    )
    record_log(
        db_session,
        entity_type="customer",
        entity_id=1,
        action="update",
        actor_id=ALICE,
        summary="评级: B→A",
    )
    record_log(
        db_session, entity_type="lead", entity_id=2, action="create", actor_id=ALICE
    )
    items, total = list_audit_logs(db_session, entity_type="customer", entity_id=1)
    assert total == 2
    assert [i.action for i in items] == ["update", "create"]  # created_at desc


def test_list_audit_logs_filter_by_action_and_actor(db_session):
    record_log(
        db_session,
        entity_type="customer",
        entity_id=1,
        action="transfer",
        actor_id=ALICE,
    )
    record_log(
        db_session, entity_type="customer", entity_id=1, action="create", actor_id=None
    )
    _, total = list_audit_logs(db_session, action="transfer")
    assert total == 1
    _, total2 = list_audit_logs(db_session, actor_id=ALICE)
    assert total2 == 1


def test_summarize_update_only_changed_fields():
    before = {"rating": "B", "status": "active", "name": "客户A"}
    summary = summarize_update(
        before, {"rating": "A", "status": "active"}, CUSTOMER_FIELD_LABELS
    )
    assert "等级" in summary and "B→A" in summary
    assert "状态" not in summary  # 未变化不列
    assert "客户名" not in summary  # patch 里没有


def test_summarize_update_no_change_returns_empty():
    assert (
        summarize_update({"rating": "B"}, {"rating": "B"}, CUSTOMER_FIELD_LABELS) == ""
    )


def test_summarize_update_handles_none_and_missing_label():
    summary = summarize_update(
        {"owner_id": None, "source": "referral"},
        {"owner_id": "u1", "source": None},
        CUSTOMER_FIELD_LABELS,
    )
    assert "负责人" in summary
    assert "source" in summary or "来源" in summary
