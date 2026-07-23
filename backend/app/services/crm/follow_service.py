"""Follow service: 跟进记录列表/创建 + 回写客户 last_follow_at。"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmFollow
from app.schemas.crm import FollowCreate, FollowItem


def _current_user_id(user_id: str | None) -> str | None:
    if user_id is None:
        return None
    uid = user_id.strip()
    return uid or None


def _created_by_name_map(db: Session, user_ids: set[str]) -> dict[str, str]:
    """批量查 user_accounts.name，避免 N+1。返回 {str(id): name}。"""
    from sqlalchemy import text

    if not user_ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(user_ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def _to_item(db: Session, follow: CrmFollow, names: dict[str, str]) -> FollowItem:
    return FollowItem(
        id=follow.id,
        entity_type=follow.entity_type,
        entity_id=follow.entity_id,
        type=follow.type,
        content=follow.content,
        next_follow_at=follow.next_follow_at,
        created_by=follow.created_by,
        created_by_name=names.get(follow.created_by) if follow.created_by else None,
        created_at=follow.created_at,
    )


def list_follows(db: Session, entity_type: str, entity_id: int) -> list[FollowItem]:
    """某实体的跟进记录，按 created_at desc（id desc 兜底）。"""
    rows = (
        db.execute(
            select(CrmFollow)
            .where(CrmFollow.entity_type == entity_type, CrmFollow.entity_id == entity_id)
            .order_by(CrmFollow.created_at.desc(), CrmFollow.id.desc())
        )
        .scalars()
        .all()
    )
    names = _created_by_name_map(db, {r.created_by for r in rows if r.created_by})
    return [_to_item(db, r, names) for r in rows]


def create_follow(db: Session, payload: FollowCreate, *, user_id: str | None) -> FollowItem:
    """创建跟进；若挂客户则回写该客户 last_follow_at。"""
    cur = _current_user_id(user_id)
    follow = CrmFollow(
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        type=payload.type,
        content=payload.content,
        next_follow_at=payload.next_follow_at,
        created_by=cur,
    )
    db.add(follow)
    db.flush()
    if payload.entity_type == "customer":
        cust = db.execute(
            select(CrmCustomer).where(CrmCustomer.id == payload.entity_id)
        ).scalar_one_or_none()
        if cust is not None:
            cust.last_follow_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(follow)
    names = _created_by_name_map(db, {cur} if cur else set())
    return _to_item(db, follow, names)
