"""task_service TDD tests (BLF-510) — CRUD / 状态流转 / 权限 / 排序筛选白名单。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.models.crm import CrmTask
from app.schemas.crm import TaskCreate, TaskUpdate
from app.services.crm.task_service import (
    cancel_task,
    complete_task,
    create_task,
    get_task,
    get_task_orm,
    list_tasks,
    set_task_status,
    update_task,
)

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """每个测试前清空 CRM 表（独立 session + commit）。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_audit_logs, crm_tasks, crm_follows, crm_opportunities, "
                "crm_contacts, crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _mk_customer(db, name="客户A", owner=ALICE):
    from app.models.crm import CrmCustomer

    row = CrmCustomer(name=name, owner_id=owner)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _mk_lead(db, name="线索A", owner=ALICE):
    from app.models.crm import CrmLead

    row = CrmLead(name=name, owner_id=owner)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _mk_task(db, *, owner=ALICE, **kw):
    t = CrmTask(title=kw.pop("title", "任务A"), owner_id=owner, **kw)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def _real_user(db, is_admin=False):
    cond = "and is_admin = true" if is_admin else "and is_admin = false"
    row = db.execute(
        text(
            f"select id::text, name from public.user_accounts "
            f"where is_active = true {cond} order by name limit 1"
        )
    ).first()
    return (row[0], row[1]) if row else None


def test_create_task_defaults_owner_to_self(db_session):
    item = create_task(db_session, TaskCreate(title="打电话"), user_id=ALICE)
    assert item.title == "打电话"
    assert item.owner_id == ALICE  # 默认=创建人
    assert item.status == "pending"
    assert item.priority == "medium"
    assert item.type == "custom"
    assert item.created_by == ALICE
    assert item.completed_at is None


def test_create_task_admin_can_assign_owner(db_session):
    item = create_task(
        db_session,
        TaskCreate(title="指派任务", owner_id=BOB),
        user_id=ALICE,
        is_admin=True,
    )
    assert item.owner_id == BOB


def test_create_task_non_admin_assign_owner_forbidden(db_session):
    with pytest.raises(HTTPException) as ei:
        create_task(
            db_session,
            TaskCreate(title="指派任务", owner_id=BOB),
            user_id=ALICE,
            is_admin=False,
        )
    assert ei.value.status_code == 403


def test_create_task_with_customer_lead_links(db_session):
    cust = _mk_customer(db_session)
    lead = _mk_lead(db_session)
    item = create_task(
        db_session,
        TaskCreate(title="拜访客户", customer_id=cust.id, lead_id=lead.id),
        user_id=ALICE,
    )
    assert item.customer_id == cust.id
    assert item.lead_id == lead.id
    # 联查字段（BLF-511 预留：本期 schema 已含 join 字段）
    got = get_task(db_session, item.id)
    assert got is not None
    assert got.customer_name == "客户A"
    assert got.lead_name == "线索A"


def test_create_task_with_customer_links_owner_name(db_session):
    u = _real_user(db_session, is_admin=False)
    if u is None:
        pytest.skip("no seeded active user in test DB")
    uid, uname = u
    item = create_task(db_session, TaskCreate(title="我的任务"), user_id=uid)
    assert item.owner_id == uid
    assert item.owner_name == uname


def test_get_task_not_found(db_session):
    assert get_task(db_session, 99999) is None
    assert get_task_orm(db_session, 99999) is None


def test_update_task_fields(db_session):
    task = _mk_task(db_session)
    item = update_task(
        db_session,
        task,
        TaskUpdate(title="新标题", priority="high", due_date=None),
        user_id=ALICE,
    )
    assert item.title == "新标题"
    assert item.priority == "high"


def test_update_task_owner_non_admin_forbidden(db_session):
    task = _mk_task(db_session)
    with pytest.raises(HTTPException) as ei:
        update_task(
            db_session,
            task,
            TaskUpdate(owner_id=BOB),
            user_id=ALICE,
            is_admin=False,
        )
    assert ei.value.status_code == 403


def test_update_task_owner_admin_allowed(db_session):
    task = _mk_task(db_session)
    item = update_task(
        db_session, task, TaskUpdate(owner_id=BOB), user_id=ALICE, is_admin=True
    )
    assert item.owner_id == BOB


def test_list_tasks_scope_mine(db_session):
    _mk_task(db_session, owner=ALICE, title="我的")
    _mk_task(db_session, owner=BOB, title="别人的")
    items, total = list_tasks(db_session, user_id=ALICE, scope="mine")
    assert total == 1
    assert items[0].owner_id == ALICE


def test_list_tasks_scope_all(db_session):
    _mk_task(db_session, owner=ALICE)
    _mk_task(db_session, owner=BOB)
    _, total = list_tasks(db_session, user_id=ALICE, scope="all")
    assert total == 2


def test_list_tasks_filters_whitelist(db_session):
    t1 = _mk_task(
        db_session, owner=ALICE, type="call", priority="high", status="pending"
    )
    _mk_task(db_session, owner=ALICE, type="visit", priority="low", status="done")

    items, total = list_tasks(
        db_session,
        user_id=ALICE,
        scope="all",
        filters={"type": "call", "priority": "high", "status": "pending"},
    )
    assert total == 1
    assert items[0].id == t1.id


def test_list_tasks_customer_lead_filter(db_session):
    cust = _mk_customer(db_session)
    lead = _mk_lead(db_session)
    t1 = _mk_task(db_session, owner=ALICE, customer_id=cust.id)
    t2 = _mk_task(db_session, owner=ALICE, lead_id=lead.id)
    items, _ = list_tasks(
        db_session, user_id=ALICE, scope="all", filters={"customer_id": cust.id}
    )
    assert [i.id for i in items] == [t1.id]
    items, _ = list_tasks(
        db_session, user_id=ALICE, scope="all", filters={"lead_id": lead.id}
    )
    assert [i.id for i in items] == [t2.id]


def test_list_tasks_owner_filter_admin_only(db_session):
    with pytest.raises(ValueError):
        list_tasks(
            db_session,
            user_id=ALICE,
            scope="all",
            filters={"owner_id": BOB},
            is_admin=False,
        )
    _mk_task(db_session, owner=BOB)
    _, total = list_tasks(
        db_session, user_id=ALICE, scope="all", filters={"owner_id": BOB}, is_admin=True
    )
    assert total == 1


def test_list_tasks_unknown_filter_field_rejected(db_session):
    with pytest.raises(ValueError):
        list_tasks(db_session, user_id=ALICE, scope="all", filters={"hacked_col": 1})


def test_list_tasks_unknown_sort_field_rejected(db_session):
    with pytest.raises(ValueError):
        list_tasks(db_session, user_id=ALICE, scope="all", sort_by="not_a_col")


def test_list_tasks_default_sort_due_date_asc_priority_desc(db_session):
    # 紧迫的在前：due_date asc；同截止 priority 高的在前；null 截止垫底
    far = datetime.now(timezone.utc) + timedelta(days=5)
    near = datetime.now(timezone.utc) + timedelta(days=1)
    _mk_task(db_session, owner=ALICE, title="低优-远", priority="low", due_date=far)
    _mk_task(db_session, owner=ALICE, title="高优-近", priority="high", due_date=near)
    _mk_task(db_session, owner=ALICE, title="中优-远", priority="medium", due_date=far)
    _mk_task(
        db_session, owner=ALICE, title="无截止-急", priority="urgent", due_date=None
    )

    items, _ = list_tasks(db_session, user_id=ALICE, scope="all")
    titles = [i.title for i in items]
    # 最紧迫的在前
    assert titles[0] == "高优-近"
    # 无截止垫底
    assert titles[-1] == "无截止-急"
    # 同截止（far）按 priority desc：中优-远 在 低优-远 之前
    assert titles.index("中优-远") < titles.index("低优-远")


def test_complete_task_sets_done_and_completed_at(db_session):
    task = _mk_task(db_session)
    assert task.completed_at is None
    item = complete_task(db_session, task, user_id=ALICE)
    assert item.status == "done"
    assert item.completed_at is not None


def test_complete_task_after_cancelled_conflict(db_session):
    task = _mk_task(db_session, status="cancelled")
    with pytest.raises(HTTPException) as ei:
        complete_task(db_session, task, user_id=ALICE)
    assert ei.value.status_code == 409


def test_cancel_task(db_session):
    task = _mk_task(db_session)
    item = cancel_task(db_session, task, user_id=ALICE)
    assert item.status == "cancelled"


def test_cancel_task_after_done_conflict(db_session):
    task = _mk_task(db_session, status="done")
    with pytest.raises(HTTPException) as ei:
        cancel_task(db_session, task, user_id=ALICE)
    assert ei.value.status_code == 409


def test_set_task_status_kanban_flow(db_session):
    task = _mk_task(db_session)
    item = set_task_status(db_session, task, "in_progress", user_id=ALICE)
    assert item.status == "in_progress"
    item2 = set_task_status(db_session, task, "done", user_id=ALICE)
    assert item2.status == "done"
    assert item2.completed_at is not None


def test_set_task_status_after_terminal_forbidden(db_session):
    for terminal in ("done", "cancelled"):
        task = _mk_task(db_session, status=terminal)
        with pytest.raises(HTTPException) as ei:
            set_task_status(db_session, task, "pending", user_id=ALICE)
        assert ei.value.status_code == 409


def test_set_task_status_invalid_value(db_session):
    task = _mk_task(db_session)
    with pytest.raises(HTTPException) as ei:
        set_task_status(db_session, task, "weird", user_id=ALICE)
    assert ei.value.status_code == 400


def test_complete_task_not_create_follow_yet(db_session):
    """§3.3 done 联动生成 follow 属 BLF-515，本期不生成 follow。"""
    task = _mk_task(db_session, type="call")
    complete_task(db_session, task, user_id=ALICE)
    follows = db_session.execute(text("select count(*) from crm_follows")).scalar_one()
    assert follows == 0


def test_list_tasks_pagination(db_session):
    for i in range(5):
        _mk_task(db_session, owner=ALICE, title=f"任务{i}")
    items, total = list_tasks(
        db_session, user_id=ALICE, scope="all", page=1, page_size=2
    )
    assert total == 5
    assert len(items) == 2
