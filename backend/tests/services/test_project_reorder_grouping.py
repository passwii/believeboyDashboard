"""BLF-1024：``reorder_project`` 的上/下移只在同一 ``is_active`` 分组内换位。

两个必须成立的语义：
1. **组内换位**：上/下移与同组紧邻行交换 ``sort_order``，该行在组内前移/后移一位；
2. **不跨组**：全局紧邻行属于另一组时**不与之交换**——否则交换完它在自己组内的
   相对位置不变，按钮看起来完全失灵（前端每次调用后都按后端顺序重取列表）。

每个用例都用 ``_global_predecessor_id`` / ``_global_successor_id``（= 改动前的邻居
查询口径）显式断言「旧代码会挑中那个另一组的行」，用例因此能真正区分新旧行为。

数据隔离：测试库（BLF_test）有 7687 活跃 / 8 停用行且 ``sort_order`` 大量重复，
因此种子的 ``sort_order`` 一律取「全表 max + 偏移」，既与存量行不并列、也是本组
最大/边界行；断言全部基于**行身份的相对位置（索引位移）** 与「另一组的
``sort_order`` 快照不变」，不依赖存量行的具体取值。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.project import Project
from app.services import project_service

_SEED_BASE_OFFSET = 1000


def _seed_orders(db: Session) -> int:
    max_order = db.execute(
        select(func.coalesce(func.max(Project.sort_order), 0))
    ).scalar_one()
    return int(max_order) + _SEED_BASE_OFFSET


def _seed(db: Session, *, name: str, sort_order: int, is_active: bool) -> Project:
    row = Project(
        project_name=name,
        sort_order=sort_order,
        is_active=is_active,
        project_operator="blf1024-reorder",
    )
    db.add(row)
    db.flush()
    return row


def _ordered_ids(db: Session, *, is_active: bool) -> list[int]:
    """该分组在列表里的实际顺序（与 ``list_project_items`` 组内口径一致）。"""
    return [
        int(row.id)
        for row in db.execute(
            select(Project)
            .where(Project.is_active.is_(is_active))
            .order_by(Project.sort_order.asc(), Project.id.asc())
        )
        .scalars()
        .all()
    ]


def _order_snapshot(db: Session, *, is_active: bool) -> dict[int, int]:
    return {
        int(row.id): int(row.sort_order)
        for row in db.execute(select(Project).where(Project.is_active.is_(is_active)))
        .scalars()
        .all()
    }


def _global_neighbor_id(db: Session, row: Project, *, direction: str) -> int | None:
    """改动前的邻居口径：**不区分** ``is_active`` 的全局上/下一行。"""
    comparison = (
        Project.sort_order < row.sort_order
        if direction == "up"
        else Project.sort_order > row.sort_order
    )
    ordering = (
        Project.sort_order.desc() if direction == "up" else Project.sort_order.asc()
    )
    neighbor = (
        db.execute(
            select(Project).where(comparison).order_by(ordering).limit(1)
        )
        .scalars()
        .first()
    )
    return None if neighbor is None else int(neighbor.id)


def _index_of(db: Session, *, is_active: bool, project_id: int) -> int:
    return _ordered_ids(db, is_active=is_active).index(project_id)


def _suffix() -> str:
    return uuid.uuid4().hex[:8]


def test_reorder_down_swaps_with_next_active_row_not_inactive_neighbor(db_session):
    """启用行下移：全局后继是停用行时，与组内下一行（启用）交换，而不是停用行。"""
    base = _seed_orders(db_session)
    moved = _seed(
        db_session, name=f"blf1024-down-a-{_suffix()}", sort_order=base + 10, is_active=True
    )
    blocker = _seed(
        db_session, name=f"blf1024-down-i-{_suffix()}", sort_order=base + 11, is_active=False
    )
    below = _seed(
        db_session, name=f"blf1024-down-b-{_suffix()}", sort_order=base + 12, is_active=True
    )

    index_before = _index_of(db_session, is_active=True, project_id=moved.id)
    active_ids_before = _ordered_ids(db_session, is_active=True)
    inactive_orders_before = _order_snapshot(db_session, is_active=False)
    # 前提：moved 的全局后继是停用行 blocker（旧代码会挑中它），
    # 而它在启用组内还有下一行 below。
    assert _global_neighbor_id(db_session, moved, direction="down") == blocker.id
    assert active_ids_before[index_before + 1] == below.id

    project_service.reorder_project(db_session, moved.id, "down")

    assert _index_of(db_session, is_active=True, project_id=moved.id) == index_before + 1
    assert set(_ordered_ids(db_session, is_active=True)) == set(active_ids_before)
    # 停用组一行都没被动过（旧代码会把 blocker 的 sort_order 换走）
    assert _order_snapshot(db_session, is_active=False) == inactive_orders_before


def test_reorder_up_swaps_with_previous_active_row_not_inactive_neighbor(db_session):
    """启用行上移：全局前驱是停用行时，与组内上一行（启用）交换，而不是停用行。"""
    base = _seed_orders(db_session)
    blocker = _seed(
        db_session, name=f"blf1024-up-i-{_suffix()}", sort_order=base + 20, is_active=False
    )
    moved = _seed(
        db_session, name=f"blf1024-up-a-{_suffix()}", sort_order=base + 21, is_active=True
    )

    active_ids_before = _ordered_ids(db_session, is_active=True)
    index_before = active_ids_before.index(moved.id)
    assert index_before == len(active_ids_before) - 1, "前提：moved 是启用组最后一行"
    inactive_orders_before = _order_snapshot(db_session, is_active=False)
    assert _global_neighbor_id(db_session, moved, direction="up") == blocker.id

    project_service.reorder_project(db_session, moved.id, "up")

    assert _index_of(db_session, is_active=True, project_id=moved.id) == index_before - 1
    assert set(_ordered_ids(db_session, is_active=True)) == set(active_ids_before)
    assert _order_snapshot(db_session, is_active=False) == inactive_orders_before


def test_reorder_inactive_row_stays_inside_inactive_group(db_session):
    """停用行上移：全局前驱是启用行时，与停用组内上一行交换，且不扰动启用组。"""
    base = _seed_orders(db_session)
    previous_inactive = _seed(
        db_session, name=f"blf1024-inact-1-{_suffix()}", sort_order=base + 19, is_active=False
    )
    above = _seed(
        db_session, name=f"blf1024-inact-a-{_suffix()}", sort_order=base + 20, is_active=True
    )
    moved = _seed(
        db_session, name=f"blf1024-inact-2-{_suffix()}", sort_order=base + 21, is_active=False
    )

    inactive_ids_before = _ordered_ids(db_session, is_active=False)
    index_before = inactive_ids_before.index(moved.id)
    assert inactive_ids_before[index_before - 1] == previous_inactive.id
    active_orders_before = _order_snapshot(db_session, is_active=True)
    assert _global_neighbor_id(db_session, moved, direction="up") == above.id

    project_service.reorder_project(db_session, moved.id, "up")

    assert (
        _index_of(db_session, is_active=False, project_id=moved.id) == index_before - 1
    )
    assert set(_ordered_ids(db_session, is_active=False)) == set(inactive_ids_before)
    # 启用组的 sort_order 一个都没变（旧代码会把 above 的 sort_order 换给 moved）
    assert _order_snapshot(db_session, is_active=True) == active_orders_before


@pytest.mark.parametrize(
    "is_active,direction,detail",
    [
        (True, "up", "已在最顶部"),
        (True, "down", "已在最底部"),
        (False, "up", "已在最顶部"),
        (False, "down", "已在最底部"),
    ],
)
def test_reorder_group_boundary_returns_400_and_changes_nothing(
    db_session, is_active, direction, detail
):
    """组边界：组内首行上移 / 末行下移返回 400，且不产生任何 sort_order 变更。"""
    ids = _ordered_ids(db_session, is_active=is_active)
    assert ids, f"测试库应至少有一个 is_active={is_active} 的项目"
    target_id = ids[0] if direction == "up" else ids[-1]

    before = _order_snapshot(db_session, is_active=is_active)
    with pytest.raises(HTTPException) as exc_info:
        project_service.reorder_project(db_session, target_id, direction)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == detail
    assert _order_snapshot(db_session, is_active=is_active) == before
