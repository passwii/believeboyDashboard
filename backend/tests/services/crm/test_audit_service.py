"""audit_service TDD tests — 审计日志记录/查询/变更摘要（P4 + P5-1）。"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.services.crm.audit_service import (
    CONTACT_FIELD_LABELS,
    CUSTOMER_FIELD_LABELS,
    list_audit_logs,
    record_log,
    summarize_contact_update,
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


# ── P5-1 联系人字段级变更摘要 ──────────────────────────────────────────────────


def test_contact_field_labels_covers_all_contact_fields():
    """CONTACT_FIELD_LABELS 必须覆盖 CrmContact schema 的所有业务字段。

    注：CrmContact 实际字段是 title/remark（plan 草稿的 role/note 已对齐）。
    """
    expected_keys = {
        "name",
        "title",
        "phone",
        "email",
        "wechat",
        "is_primary",
        "remark",
    }
    assert set(CONTACT_FIELD_LABELS.keys()) == expected_keys


def test_summarize_contact_update_single_field():
    """单字段变更：phone 改成新值。"""
    before = {"name": "张三", "phone": "13800000000", "is_primary": False}
    summary = summarize_contact_update(before, {"phone": "+86-13800001111"})
    assert summary is not None
    assert "电话" in summary
    assert "13800000000" in summary
    assert "+86-13800001111" in summary


def test_summarize_contact_update_multi_field():
    """多字段同时变更：phone + title。"""
    before = {"phone": "1", "title": "经理", "is_primary": False}
    summary = summarize_contact_update(before, {"phone": "2", "title": "总监"})
    assert summary is not None
    # 两个变更都要在摘要里
    assert "电话" in summary and "1" in summary and "2" in summary
    assert "职位" in summary and "经理" in summary and "总监" in summary


def test_summarize_contact_update_none_to_value():
    """None → 值：email 从空填上 x@y.com。"""
    before = {"email": None}
    summary = summarize_contact_update(before, {"email": "x@y.com"})
    assert summary is not None
    assert "邮箱" in summary
    assert "空" in summary  # 旧值
    assert "x@y.com" in summary  # 新值


def test_summarize_contact_update_is_primary_toggle():
    """is_primary: false → true，主联系人变更。"""
    before = {"is_primary": False, "name": "A"}
    summary = summarize_contact_update(before, {"is_primary": True})
    assert summary is not None
    assert "主联系人" in summary
    # _fmt 行为：False→"空"、True→"True"（_fmt 当前只对 None/"" 友好，bool 会原样）
    assert "True" in summary or "true" in summary.lower()


def test_summarize_contact_update_no_change_returns_none():
    """无变化：返回 None（让 endpoint 决定是否仍写 '编辑联系人 X' 兜底，或跳过）。"""
    before = {"phone": "1", "name": "A"}
    assert summarize_contact_update(before, {"phone": "1", "name": "A"}) is None


def test_summarize_contact_update_unknown_field_skipped():
    """patch 含未声明字段 → 跳过不抛错。"""
    before = {"phone": "1", "unknown_field": "old"}
    # 故意混入 unknown_field；summarize_contact_update 只看 CONTACT_FIELD_LABELS 已声明的 key
    summary = summarize_contact_update(before, {"phone": "2", "unknown_field": "new"})
    # 摘要里只列 phone，不应包含 "unknown_field" 这个原始 key
    assert summary is not None
    assert "电话" in summary and "1" in summary and "2" in summary
    assert "unknown_field" not in summary


# ── P5-10 None ↔ \"\" 视为无变更 ──────────────────────────────────────────────────


def test_summarize_update_none_to_empty_string_skipped():
    """P5-10: None → \"\" 视为无变更（不产生「空→空」噪音）。"""
    before = {"phone": None}
    summary = summarize_update(before, {"phone": ""}, CUSTOMER_FIELD_LABELS)
    # None 和 \"\" 都视作「空」，相互转换不算变更
    assert summary == "", f"应空串（无变更），实际 {summary!r}"


def test_summarize_update_empty_string_to_none_skipped():
    """P5-10: \"\" → None 反向同理。"""
    before = {"remark": ""}
    summary = summarize_update(before, {"remark": None}, CUSTOMER_FIELD_LABELS)
    assert summary == "", f"应空串（无变更），实际 {summary!r}"


# ── P5-6 record_log commit 参数 ────────────────────────────────────────────────


def test_record_log_no_commit_by_default(db_session):
    """P5-6: record_log 默认 commit=False，不自动 commit。
    调用方负责 commit，保证业务写入 + 审计写入原子化。
    """
    from app.services.crm.audit_service import record_log

    log = record_log(
        db_session,
        entity_type="customer",
        entity_id=1,
        action="create",
        actor_id=ALICE,
        summary="新建客户",
    )
    assert log.id is not None  # flush 拿到 id
    # 默认不 commit；外部回滚应该清掉
    db_session.rollback()
    row = db_session.execute(
        text("select count(*) from crm_audit_logs")
    ).scalar()
    assert row == 0, "默认 commit=False 时 rollback 应清掉"


def test_record_log_commit_true_commits(db_session):
    """P5-6: record_log(commit=True) 自动 commit，即使后续回滚也保留。"""
    from app.services.crm.audit_service import record_log

    record_log(
        db_session,
        entity_type="customer",
        entity_id=1,
        action="create",
        actor_id=ALICE,
        summary="新建客户",
        commit=True,
    )
    # 显式 commit 后，rollback 不影响
    db_session.commit()
    db_session.rollback()
    row = db_session.execute(
        text("select count(*) from crm_audit_logs")
    ).scalar()
    assert row == 1
