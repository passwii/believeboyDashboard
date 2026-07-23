"""CRM 操作级权限（MVP：is_admin 二分，身份来自 deps.get_request_is_admin）。

规则（用户拍板 2026-07-23）：
- 普通销售：``scope=all`` 降级为 ``mine``（只见自己名下；公海/线索池仍由 ``scope=sea`` 显式访问）；
  不可指派负责人（batch-transfer）；不可写非自己名下记录（编辑/删除/转化/领取）。
- 管理员（is_admin）：``scope=all`` 看全部（含别人私海）；可指派/释放任意记录。

全部(all) ⊇ 我的(mine)；公海 = owner_id IS NULL。
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session


def resolve_scope(scope: str, is_admin: bool) -> str:
    """非管理员请求 ``all`` → 降级为 ``mine``（看不到别人私海）。"""
    if scope == "all" and not is_admin:
        return "mine"
    return scope


def require_admin(is_admin: bool) -> None:
    """仅管理员可执行（如指派负责人）；否则 403。"""
    if not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required")


def require_owner_or_admin(record_owner_id: str | None, user_id: str | None, is_admin: bool) -> None:
    """非管理员只能操作自己名下记录；管理员放行。

    记录无主（在公海/线索池）时，非管理员不可直接写（须先领取）→ 403。
    """
    if is_admin:
        return
    if record_owner_id is None or record_owner_id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the record owner")


def filter_owned_ids(db: Session, model, ids: list[int], user_id: str | None, is_admin: bool) -> list[int]:
    """批量「释放回公海/线索池」：非管理员只保留自己名下的 id，管理员全保留。"""
    if is_admin:
        return ids
    rows = db.execute(
        select(model.id).where(model.id.in_(ids), model.owner_id == user_id)
    ).scalars().all()
    return list(rows)
