"""项目「运营 / 助理运营」候选名单的取值口径（BLF-1441 / #775 review）。

这里**不是**展示名：候选值会原样写进 ``projects.project_operator``，是
``list_project_items`` / ``ensure_project_access`` 的匹配键（鉴权口径）。
所以它保持 ``operator_name_zh -> full_name``，与请求头 ``X-Operator``
（当前仍取 ``operatorNameZh``）同口径；等前端把 ``X-Operator`` 切到
``full_name`` 时再同批改这里。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select, text

from app.models.project import Project
from app.services.project_service import (
    ensure_project_access,
    list_project_operator_options,
)


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


def _next_sort_order(db_session) -> int:
    """共享测试库里有存量项目，种子一律取「全表 max + 1000」避免撞序。"""
    max_order = db_session.execute(
        select(func.coalesce(func.max(Project.sort_order), 0))
    ).scalar_one()
    return int(max_order) + 1000


def test_options_prefer_operator_name_zh(db_session, temp_accounts):
    """与 X-Operator 同口径：有运营名就取运营名，不取 full_name / 登录名。"""
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

    assert "桑工" in options
    assert "桑喜刚" not in options
    assert "Buck" not in options


def test_options_fall_back_to_full_name_without_operator_name_zh(
    db_session, temp_accounts
):
    """没有运营名的账号回落到 full_name（现网桑喜刚 / 临时账号就是这种）。"""
    email = _new_email("nofull")
    temp_accounts.append(email)
    _insert_account(
        db_session,
        name="Buck",
        full_name="桑喜刚",
        operator_name_zh=None,
        email=email,
    )

    options = list_project_operator_options(db_session)

    assert "桑喜刚" in options
    assert "Buck" not in options


def test_options_exclude_accounts_without_any_name(db_session, temp_accounts):
    """运营名与姓名都为空的账号不进候选名单（空键落库后对谁都不匹配）。"""
    email = _new_email("noname")
    temp_accounts.append(email)
    _insert_account(
        db_session,
        name="NoName",
        full_name=None,
        operator_name_zh="  ",
        email=email,
    )

    options = list_project_operator_options(db_session)

    assert "NoName" not in options
    assert "" not in options
    assert all(option.strip() for option in options)


def test_option_value_passes_project_access_as_request_operator(
    db_session, temp_accounts
):
    """下拉选出的值，用同名 X-Operator 必须能通过 ``ensure_project_access``。

    这是 #775 review 那条 P1 的回归锁：候选名单一旦单方面换键（比如只取
    ``full_name``）而请求头仍是 ``operatorNameZh``，管理员在下拉里选中的人
    打开自己的项目就会 403。
    """
    email = _new_email("access")
    temp_accounts.append(email)
    _insert_account(
        db_session,
        name="Buck",
        full_name="桑喜刚",
        operator_name_zh="桑工",
        email=email,
    )

    options = list_project_operator_options(db_session)
    chosen = next(option for option in options if option in {"桑工", "桑喜刚"})

    project = Project(
        project_name=f"blf1441-access-{uuid.uuid4().hex[:8]}",
        sort_order=_next_sort_order(db_session),
        is_active=True,
        project_operator=chosen,
    )
    db_session.add(project)
    db_session.flush()
    try:
        # 请求头 X-Operator 当前取的就是 operator_name_zh。
        row = ensure_project_access(
            db_session, project.id, operator="桑工", is_admin=False
        )
        assert row.id == project.id
    finally:
        db_session.delete(project)
        db_session.commit()


def test_options_are_deduplicated_and_sorted(db_session, temp_accounts):
    email_a = _new_email("dup1")
    email_b = _new_email("dup2")
    temp_accounts.extend([email_a, email_b])
    _insert_account(
        db_session,
        name="A",
        full_name="桑喜刚",
        operator_name_zh="同名的人",
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
