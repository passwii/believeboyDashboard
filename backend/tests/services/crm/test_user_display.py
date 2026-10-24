"""user_display TDD tests — 全局人物显示名唯一来源 = user_accounts.full_name。

BLF-1441 口径：
  * 账号存在 → 只取 ``full_name``，**不**回落到登录名 ``name`` / ``operator_name_zh``；
  * ``full_name`` 为空 → 解析不到（键缺失），由调用方按「没有名字」处理；
  * 账号不存在（离职删号 / 从未有账号）→ 解析不到，历史自由文本原样保留。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.services.user_display import resolve_display_name, resolve_display_names

FAKE_HASH = "x" * 24  # 满足 password_hash check (length >= 20)，不参与校验


def _insert_account(db, *, name: str, full_name: str | None, email: str) -> str:
    """插入一个临时账号，返回 id::text（测试结束后由 fixture 清理）。"""
    row = db.execute(
        text(
            """
            insert into public.user_accounts
                (name, email, password_hash, full_name, is_active)
            values (:name, :email, :password_hash, :full_name, true)
            returning id::text
            """
        ),
        {
            "name": name,
            "email": email,
            "password_hash": FAKE_HASH,
            "full_name": full_name,
        },
    ).scalar_one()
    db.commit()
    return str(row)


@pytest.fixture
def temp_accounts(db_session):
    """登记本用例建过的账号邮箱，结束时删干净（不污染共享测试库）。"""
    created: list[str] = []
    yield created
    if created:
        db_session.execute(
            text("delete from public.user_accounts where email = any(:emails)"),
            {"emails": created},
        )
        db_session.commit()


def _new_email(tag: str) -> str:
    return f"blf1441-{tag}-{uuid.uuid4().hex[:8]}@example.invalid"


def test_prefers_full_name_over_login_name(db_session, temp_accounts):
    """核心：登录名是英文 handle 时，显示名必须是 full_name。"""
    email = _new_email("prefer")
    temp_accounts.append(email)
    uid = _insert_account(
        db_session, name="DamonROCK", full_name="纪亚伟", email=email
    )

    assert resolve_display_names(db_session, {uid}) == {uid: "纪亚伟"}


def test_does_not_fall_back_to_operator_name_zh(db_session, temp_accounts):
    """operator_name_zh 已退化为历史别名，不参与展示。"""
    email = _new_email("alias")
    temp_accounts.append(email)
    uid = _insert_account(db_session, name="Buck", full_name="桑喜刚", email=email)
    db_session.execute(
        text("update public.user_accounts set operator_name_zh = :v where id = :id"),
        {"v": "桑工", "id": uid},
    )
    db_session.commit()

    assert resolve_display_names(db_session, {uid}) == {uid: "桑喜刚"}


def test_empty_full_name_is_not_resolved(db_session, temp_accounts):
    """full_name 为空 → 取不到（不能回落到登录名）。"""
    for tag, full_name in (("null", None), ("blank", "   ")):
        email = _new_email(tag)
        temp_accounts.append(email)
        uid = _insert_account(
            db_session, name=f"handle-{tag}", full_name=full_name, email=email
        )
        assert resolve_display_names(db_session, {uid}) == {}
        assert resolve_display_name(db_session, uid) is None


def test_unknown_id_is_not_resolved(db_session):
    """账号不存在（离职删号）→ 取不到，调用方保留历史文本。"""
    missing = str(uuid.uuid4())
    assert resolve_display_names(db_session, {missing}) == {}
    assert resolve_display_name(db_session, missing) is None


def test_full_name_is_stripped(db_session, temp_accounts):
    email = _new_email("strip")
    temp_accounts.append(email)
    uid = _insert_account(
        db_session, name="Leah", full_name="  刘心灵  ", email=email
    )

    assert resolve_display_names(db_session, {uid}) == {uid: "刘心灵"}


def test_empty_input_returns_empty_map(db_session):
    assert resolve_display_names(db_session, None) == {}
    assert resolve_display_names(db_session, set()) == {}
    assert resolve_display_name(db_session, None) is None


def test_batch_resolves_only_existing_accounts(db_session, test_admin):
    """批量解析：存在的账号进结果，不存在的 id 不进。"""
    admin_id = str(test_admin["id"])
    missing = str(uuid.uuid4())

    resolved = resolve_display_names(db_session, {admin_id, missing, ""})

    assert resolved == {admin_id: test_admin["full_name"]}
