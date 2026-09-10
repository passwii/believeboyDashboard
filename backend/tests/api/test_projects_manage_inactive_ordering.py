"""BLF-1024：停用项目整段排在启用项目之后（``/projects/manage`` 排序语义）。

覆盖两端：
- service：``project_service.list_project_items`` 在 ``include_inactive=True`` 时
  把停用项目整段排到启用项目之后（组内仍 ``sort_order`` 升序、``id`` 兜底）；
  ``include_inactive=False`` 时顺序与改动前 ``(sort_order, id)`` 逐行一致。
- HTTP：``GET /api/v1/projects/manage`` 的 ``show_inactive`` 两种口径同上——
  前端按返回顺序直接渲染，这条契约就是列表观感本身。

数据隔离：测试库（BLF_test）已被大量用例污染（7687 活跃 / 8 停用、``sort_order``
大量重复），因此
1. service 层用例用唯一 ``project_operator`` token 把可见集缩到自己种的行，且种子
   的 ``sort_order`` 取「全表 max + 偏移」，既不与存量行并列也可断言精确顺序；
2. HTTP 层用例断言与数据集无关的不变量（无「启用行排在停用行之后」、组内
   ``(sort_order, id)`` 升序），对全库 7695 行同样成立。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.main import app
from app.models.project import Project
from app.services import project_service

_SEED_BASE_OFFSET = 1000


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _seed_orders(db: Session) -> int:
    """种子 sort_order 起点：全表 max + 偏移（保证种子不并列、且是本组最大）。"""
    max_order = db.execute(
        select(func.coalesce(func.max(Project.sort_order), 0))
    ).scalar_one()
    return int(max_order) + _SEED_BASE_OFFSET


def _seed(
    db: Session,
    *,
    name: str,
    sort_order: int,
    is_active: bool,
    operator: str | None = None,
) -> Project:
    row = Project(
        project_name=name,
        sort_order=sort_order,
        is_active=is_active,
        project_operator=operator,
    )
    db.add(row)
    db.flush()
    return row


def _legacy_ordered_active_ids(db: Session, operator: str) -> list[int]:
    """改动前的排序口径（``sort_order, id``）+ 只含启用行，作为回归基线。"""
    return [
        int(row.id)
        for row in db.execute(
            select(Project)
            .where(Project.project_operator == operator, Project.is_active.is_(True))
            .order_by(Project.sort_order.asc(), Project.id.asc())
        )
        .scalars()
        .all()
    ]


def test_list_project_items_puts_inactive_group_last(db_session):
    """停用行即使 ``sort_order`` 比启用行小，也必须整段排在启用行之后。"""
    token = f"blf1024-order-{uuid.uuid4().hex[:8]}"
    base = _seed_orders(db_session)
    # 交错布置：停用行拥有更小的 sort_order，旧口径（仅 sort_order）会把它们夹在中间
    inactive_first = _seed(
        db_session,
        name=f"{token}-i0",
        sort_order=base,
        is_active=False,
        operator=token,
    )
    active_first = _seed(
        db_session,
        name=f"{token}-a1",
        sort_order=base + 1,
        is_active=True,
        operator=token,
    )
    inactive_second = _seed(
        db_session,
        name=f"{token}-i2",
        sort_order=base + 2,
        is_active=False,
        operator=token,
    )
    active_second = _seed(
        db_session,
        name=f"{token}-a3",
        sort_order=base + 3,
        is_active=True,
        operator=token,
    )

    rows = project_service.list_project_items(
        db_session, operator=token, is_admin=False, include_inactive=True
    )

    assert [row.id for row in rows] == [
        active_first.id,
        active_second.id,
        inactive_first.id,
        inactive_second.id,
    ]


def test_list_project_items_active_only_order_matches_legacy(db_session):
    """``include_inactive=False`` 的返回顺序与改动前（``sort_order, id``）逐行相等。"""
    token = f"blf1024-active-{uuid.uuid4().hex[:8]}"
    base = _seed_orders(db_session)
    # 同样交错，确保断言不受「停用行恰好都在后面」这种数据巧合保护
    _seed(db_session, name=f"{token}-i0", sort_order=base, is_active=False, operator=token)
    _seed(db_session, name=f"{token}-a1", sort_order=base + 1, is_active=True, operator=token)
    _seed(db_session, name=f"{token}-i2", sort_order=base + 2, is_active=False, operator=token)
    _seed(db_session, name=f"{token}-a3", sort_order=base + 3, is_active=True, operator=token)

    rows = project_service.list_project_items(
        db_session, operator=token, is_admin=False, include_inactive=False
    )

    assert [row.id for row in rows] == _legacy_ordered_active_ids(db_session, token)
    assert all(row.is_active for row in rows)


def test_list_project_items_active_only_order_matches_legacy_on_full_dataset(db_session):
    """全库（7695 行，含重复 sort_order）范围内同样逐行等于旧口径。"""
    rows = project_service.list_project_items(db_session, is_admin=True)
    legacy_ids = [
        int(row.id)
        for row in db_session.execute(
            select(Project)
            .where(Project.is_active.is_(True))
            .order_by(Project.sort_order.asc(), Project.id.asc())
        )
        .scalars()
        .all()
    ]
    assert [int(row.id) for row in rows] == legacy_ids


def test_manage_endpoint_always_returns_active_group_first(client, admin_headers):
    """HTTP 契约：``show_inactive=true`` 时启用行整段在前、组内 (sort_order, id) 升序。"""
    project_service.invalidate_projects_cache()

    resp = client.get(
        "/api/v1/projects/manage?show_inactive=true", headers=admin_headers
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert items, "测试库应至少有若干项目"

    flags = [bool(item["is_active"]) for item in items]
    assert flags == sorted(flags, reverse=True), (
        "停用项目必须整段排在启用项目之后；"
        f"首个倒序位置: {[(i, f) for i, f in enumerate(flags) if f != flags[0]][:1]}"
    )
    for group_active in (True, False):
        keys = [
            (item["sort_order"], item["id"])
            for item in items
            if bool(item["is_active"]) is group_active
        ]
        assert keys == sorted(keys), f"is_active={group_active} 组内未按 (sort_order, id) 升序"


def test_manage_endpoint_active_only_matches_legacy_order(client, db_session, admin_headers):
    """HTTP 契约：``show_inactive=false``（默认）顺序 = 旧口径 ``(sort_order, id)``。"""
    project_service.invalidate_projects_cache()

    resp = client.get("/api/v1/projects/manage", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    items = resp.json()

    legacy_keys = [
        (int(row.sort_order), int(row.id))
        for row in db_session.execute(
            select(Project)
            .where(Project.is_active.is_(True))
            .order_by(Project.sort_order.asc(), Project.id.asc())
        )
        .scalars()
        .all()
    ]
    assert [(item["sort_order"], item["id"]) for item in items] == legacy_keys
