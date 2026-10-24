"""项目「运营 / 助理运营」候选名单的取值口径（BLF-1441 / #775 / #776）。

这里**不是**展示名：候选值会原样写进 ``projects.project_operator``，是
``list_project_items`` / ``ensure_project_access`` 的匹配键（鉴权口径）。
口径 = ``user_accounts.full_name``，与请求头 ``X-Operator`` 同源；登录名
（``user_accounts.name``，username）是系统内部标识，不进展示候选。运营名
``operator_name_zh`` 已在 BLF-1441 第二轮删除（与 ``full_name`` 重复）。

候选名单与请求头必须逐字同口径：任何一侧单独换键，管理员在下拉里选中的人
打开自己的项目就会 403。
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
    email: str,
) -> None:
    db_session.execute(
        text(
            """
            insert into public.user_accounts
                (name, email, password_hash, full_name, is_active)
            values (:name, :email, :h, :full_name, true)
            """
        ),
        {
            "name": name,
            "email": email,
            "h": "x" * 24,
            "full_name": full_name,
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


def test_options_take_full_name_not_login_name(db_session, temp_accounts):
    """与 X-Operator 同口径：只取 full_name，登录名（username）不进候选。"""
    email = _new_email("both")
    temp_accounts.append(email)
    _insert_account(db_session, name="Buck", full_name="桑喜刚", email=email)

    options = list_project_operator_options(db_session)

    assert "桑喜刚" in options
    assert "Buck" not in options


def test_options_exclude_accounts_without_full_name(db_session, temp_accounts):
    """full_name 为空的账号不进候选（也不回落到登录名）。

    空键落库后对谁都不匹配，登录名兜底会造出「下拉里选得到、本人却 403」的键。
    """
    blank_email = _new_email("noname")
    whitespace_email = _new_email("spaces")
    temp_accounts.extend([blank_email, whitespace_email])
    _insert_account(
        db_session,
        name="NoName",
        full_name=None,
        email=blank_email,
    )
    _insert_account(
        db_session,
        name="Spaces",
        full_name="   ",
        email=whitespace_email,
    )

    options = list_project_operator_options(db_session)

    assert "NoName" not in options
    assert "Spaces" not in options
    assert "" not in options
    assert all(option.strip() for option in options)


def test_option_value_passes_project_access_as_request_operator(
    db_session, temp_accounts
):
    """下拉选出的值，用同名 X-Operator 必须能通过 ``ensure_project_access``。

    这是 #775 review 那条 P1 的回归锁：候选名单与请求头必须同口径。前端
    ``X-Operator`` 取的是账号的 ``full_name``（#776），所以「下拉值」必须等于
    「库里该账号的 full_name」——两边任一单独换键，这里就会 403。
    """
    email = _new_email("access")
    temp_accounts.append(email)
    _insert_account(db_session, name="Buck", full_name="桑喜刚", email=email)

    options = list_project_operator_options(db_session)
    chosen = next(option for option in options if option == "桑喜刚")
    # 请求头 X-Operator 的独立来源：账号表里的 full_name，不是下拉的返回值。
    request_operator = db_session.execute(
        text("select full_name from public.user_accounts where email = :email"),
        {"email": email},
    ).scalar_one()
    assert chosen == request_operator

    project = Project(
        project_name=f"blf1441-access-{uuid.uuid4().hex[:8]}",
        sort_order=_next_sort_order(db_session),
        is_active=True,
        project_operator=chosen,
    )
    db_session.add(project)
    db_session.flush()
    try:
        row = ensure_project_access(
            db_session, project.id, operator=request_operator, is_admin=False
        )
        assert row.id == project.id
    finally:
        db_session.delete(project)
        db_session.commit()


def test_options_are_deduplicated_and_sorted(db_session, temp_accounts):
    """同名（含前后空格差异）只出现一次，结果按字典序。"""
    email_a = _new_email("dup1")
    email_b = _new_email("dup2")
    temp_accounts.extend([email_a, email_b])
    _insert_account(db_session, name="A", full_name="同名的人", email=email_a)
    _insert_account(db_session, name="B", full_name="  同名的人  ", email=email_b)

    options = list_project_operator_options(db_session)

    assert options.count("同名的人") == 1
    assert options == sorted(options)
