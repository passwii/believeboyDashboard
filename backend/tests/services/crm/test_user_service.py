"""user_service TDD tests — crm-user-select 数据源（活跃 user_accounts）。

只读 user_accounts，不写 CRM 表；用 conftest 的种子账户（真 UUID）断言字段映射。
"""
from __future__ import annotations

from app.schemas.crm import CrmUserItem
from app.services.crm.user_service import get_crm_user, list_crm_users


# ── list_crm_users ───────────────────────────────────────────────────────────

def test_list_crm_users_returns_user_items(db_session, test_admin):
    items = list_crm_users(db_session)
    assert items, "应至少返回种子用户"
    assert all(isinstance(i, CrmUserItem) for i in items)
    # 种子 admin 应在列表中
    assert any(i.id == str(test_admin["id"]) for i in items)


def test_list_crm_users_id_is_str(db_session):
    """user_accounts.id 是 UUID，CrmUserItem.id 必须转成 str（不能是 int）。"""
    items = list_crm_users(db_session)
    assert all(isinstance(i.id, str) for i in items)
    assert all(i.id for i in items)  # 非空


def test_list_crm_users_only_active(db_session):
    """列表用于选人，只给活跃用户。"""
    items = list_crm_users(db_session)
    assert all(i.is_active is True for i in items)


def test_list_crm_users_field_mapping(db_session, test_admin):
    """字段映射：name/email/role_type 与 user_accounts 一致。"""
    items = list_crm_users(db_session)
    mine = next(i for i in items if i.id == str(test_admin["id"]))
    assert mine.name == test_admin["name"]
    assert mine.email == test_admin["email"]
    assert mine.role_type == test_admin.get("role_type")


def test_list_crm_users_ordered_by_name(db_session):
    items = list_crm_users(db_session)
    names = [i.name for i in items]
    assert names == sorted(names)


# ── get_crm_user ─────────────────────────────────────────────────────────────

def test_get_crm_user_found(db_session, test_admin):
    item = get_crm_user(db_session, str(test_admin["id"]))
    assert item is not None
    assert item.id == str(test_admin["id"])
    assert item.name == test_admin["name"]
    assert item.email == test_admin["email"]
    assert item.role_type == test_admin.get("role_type")
    assert item.is_active is True


def test_get_crm_user_not_found(db_session):
    assert get_crm_user(db_session, "00000000-0000-0000-0000-000000000000") is None
