"""项目「运营 / 助理运营」候选名单（BLF-1441）。

口径：候选名单只取 ``user_accounts.full_name``。这个值同时是
``projects.project_operator`` 的匹配键（鉴权口径），所以不能混入
``operator_name_zh`` / 登录名，否则下拉选出来的文本与鉴权键对不上。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.services.project_service import list_project_operator_options


@pytest.fixture
def temp_accounts(db_session):
    """登记本用例建过的邮箱，结束时删干净（不污染共享测试库）。"""
    created: list[str] = []
    yield created
    if created:
        db_session.execute(
            text("delete from public.user_accounts where email = any(:emails)"),
            {"emails": created},
        )
        db_session.commit()


def _insert_account(
    db_session,
    *,
    name: str,
    full_name: str | None,
    operator_name_zh: str | None,
    email: str,
) -> None:
    db_session.execute(
        text(
            """
            insert into public.user_accounts
                (name, email, password_hash, full_name, operator_name_zh, is_active)
            values (:name, :email, :h, :full_name, :operator_name_zh, true)
            """
        ),
        {
            "name": name,
            "email": email,
            "h": "x" * 24,
            "full_name": full_name,
            "operator_name_zh": operator_name_zh,
        },
    )
    db_session.commit()


def _new_email(tag: str) -> str:
    return f"blf1441-opt-{tag}-{uuid.uuid4().hex[:8]}@example.invalid"


def test_options_use_full_name_only(db_session, temp_accounts):
    """full_name 与 operator_name_zh 同时存在时，只出现 full_name。"""
    email = _new_email("both")
    temp_accounts.append(email)
    _insert_account(
        db_session,
        name="Buck",
        full_name="桑喜刚",
        operator_name_zh="桑工",
        email=email,
    )

    options = list_project_operator_options(db_session)

    assert "桑喜刚" in options
    assert "桑工" not in options
    assert "Buck" not in options


def test_options_exclude_accounts_without_full_name(db_session, temp_accounts):
    """没有 full_name 的账号不进候选名单（不回落登录名 / 运营名）。"""
    email = _new_email("nofull")
    temp_accounts.append(email)
    _insert_account(
        db_session,
        name="NoChineseName",
        full_name=None,
        operator_name_zh="某个运营名",
        email=email,
    )

    options = list_project_operator_options(db_session)

    assert "某个运营名" not in options
    assert "NoChineseName" not in options


def test_options_are_deduplicated_and_sorted(db_session, temp_accounts):
    email_a = _new_email("dup1")
    email_b = _new_email("dup2")
    temp_accounts.extend([email_a, email_b])
    _insert_account(
        db_session,
        name="A",
        full_name="同名的人",
        operator_name_zh=None,
        email=email_a,
    )
    _insert_account(
        db_session,
        name="B",
        full_name="同名的人",
        operator_name_zh=None,
        email=email_b,
    )

    options = list_project_operator_options(db_session)

    assert options.count("同名的人") == 1
    assert options == sorted(options)
