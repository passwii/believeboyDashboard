"""CRM 保存视图服务（Stage5-3，BLF-589，CordysCRM 7.3 模式）。

把客户/线索列表筛选状态（scope/keyword/filters/sort）保存为命名视图。
权限（MVP）：
- 列表：owner 自己的全部视图 + 全用户共享视图（is_shared=true）；
- 创建：任意登录用户，owner_id=本人；is_shared=true 仅 admin（V2 团队共享）；
- 修改/删除：个人视图仅 owner；共享视图 owner 或 admin；
- admin 不可改删他人个人视图（个人书签隐私）。

filters 校验复用 filter_engine 白名单：把条件构造成未执行的 SQL 表达式
（apply_filters），字段/运算符/值形状非法 → ValueError（端点转 400）。
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.crm import CrmCustomer, CrmLead, CrmSavedView
from app.schemas.crm import SavedViewCreate, SavedViewUpdate
from app.services.user_display import resolve_display_names


def _require_can_manage(
    view: CrmSavedView, user_id: str | None, is_admin: bool
) -> None:
    """个人视图仅 owner；共享视图 owner 或 admin。否则 403。"""
    if view.owner_id is not None and view.owner_id == user_id:
        return
    if view.is_shared and is_admin:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Not the view owner (shared views: owner or admin)",
    )


def _require_shared_eligible(is_admin: bool) -> None:
    """is_shared 置 true（团队共享 V2）仅 admin。"""
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin required to create shared views",
        )


def validate_filters(filters: list[dict] | None, entity_type: str) -> None:
    """用 filter_engine 白名单校验 filters；非法 → ValueError（端点转 400）。

    复用 apply_filters 构造未执行的 where 表达式：字段/运算符白名单、
    嵌套深度、值形状（between 二元组 / in 列表）全部在构造期暴露。
    """
    if not filters:
        return
    from app.services.crm.filter_engine import (
        CUSTOMER_FILTER_FIELDS,
        LEAD_FILTER_FIELDS,
        apply_filters,
    )

    model = CrmCustomer if entity_type == "customer" else CrmLead
    allowed = (
        CUSTOMER_FILTER_FIELDS if entity_type == "customer" else LEAD_FILTER_FIELDS
    )
    apply_filters(select(model), model, filters, allowed)


def to_item(db: Session, view: CrmSavedView) -> dict:
    """单视图 → 响应 dict（含 owner_name；POST/PATCH 端点复用）。"""
    owner_names = resolve_display_names(
        db, {view.owner_id} if view.owner_id else set()
    )
    return _to_dict(view, owner_names)


def list_views(
    db: Session, user_id: str | None, entity_type: str | None = None
) -> list[dict]:
    """可见视图：owner 自己的 + 全用户共享的；按 updated_at 倒序。"""
    stmt = select(CrmSavedView).where(
        or_(CrmSavedView.is_shared.is_(True), CrmSavedView.owner_id == user_id)
    )
    if entity_type:
        stmt = stmt.where(CrmSavedView.entity_type == entity_type)
    stmt = stmt.order_by(CrmSavedView.updated_at.desc(), CrmSavedView.id.desc())
    rows = db.execute(stmt).scalars().all()
    owner_names = resolve_display_names(db, {r.owner_id for r in rows if r.owner_id})
    return [_to_dict(r, owner_names) for r in rows]


def get_view(db: Session, view_id: int, user_id: str | None) -> CrmSavedView | None:
    """取单个视图：owner 自己的或共享的；他人个人视图 → None（不泄露存在）。"""
    stmt = select(CrmSavedView).where(
        CrmSavedView.id == view_id,
        or_(CrmSavedView.is_shared.is_(True), CrmSavedView.owner_id == user_id),
    )
    return db.execute(stmt).scalar_one_or_none()


def create_view(
    db: Session,
    payload: SavedViewCreate,
    user_id: str | None,
    is_admin: bool,
    commit: bool = True,
) -> CrmSavedView:
    """创建视图（owner_id=本人）。is_shared=true 仅 admin（V2 共享）。"""
    if payload.is_shared:
        _require_shared_eligible(is_admin)
    validate_filters(payload.filters, payload.entity_type)
    view = CrmSavedView(
        name=payload.name,
        entity_type=payload.entity_type,
        scope=payload.scope,
        keyword=payload.keyword,
        filters=payload.filters,
        sort_by=payload.sort_by,
        sort_order=payload.sort_order,
        is_shared=payload.is_shared,
        owner_id=user_id,
    )
    db.add(view)
    if commit:
        db.commit()
        db.refresh(view)
    return view


def update_view(
    db: Session,
    view_id: int,
    payload: SavedViewUpdate,
    user_id: str | None,
    is_admin: bool,
    commit: bool = True,
) -> CrmSavedView | None:
    """部分更新；返回 None 表示视图不可见（404）。校验失败 → ValueError。"""
    view = db.execute(
        select(CrmSavedView).where(CrmSavedView.id == view_id)
    ).scalar_one_or_none()
    if view is None or not _visible(view, user_id):
        return None
    _require_can_manage(view, user_id, is_admin)

    if payload.is_shared is True and not view.is_shared:
        # 个人 → 共享（V2 团队共享）仅 admin
        _require_shared_eligible(is_admin)
    if payload.filters is not None:
        validate_filters(payload.filters, view.entity_type)

    for field in ("name", "scope", "keyword", "sort_by", "sort_order", "is_shared"):
        value = getattr(payload, field)
        if value is not None:
            setattr(view, field, value)
    if payload.filters is not None:
        view.filters = payload.filters
    if commit:
        db.commit()
        db.refresh(view)
    return view


def delete_view(
    db: Session, view_id: int, user_id: str | None, is_admin: bool
) -> CrmSavedView | None:
    """删除视图；返回被删对象或 None（不可见/不存在）。"""
    view = db.execute(
        select(CrmSavedView).where(CrmSavedView.id == view_id)
    ).scalar_one_or_none()
    if view is None or not _visible(view, user_id):
        return None
    _require_can_manage(view, user_id, is_admin)
    db.delete(view)
    db.commit()
    return view


def _visible(view: CrmSavedView, user_id: str | None) -> bool:
    return view.is_shared or (view.owner_id is not None and view.owner_id == user_id)


def _to_dict(view: CrmSavedView, owner_names: dict[str, str]) -> dict:
    return {
        "id": view.id,
        "name": view.name,
        "entity_type": view.entity_type,
        "scope": view.scope,
        "keyword": view.keyword,
        "filters": view.filters,
        "sort_by": view.sort_by,
        "sort_order": view.sort_order,
        "is_shared": view.is_shared,
        "owner_id": view.owner_id,
        "owner_name": owner_names.get(view.owner_id) if view.owner_id else None,
        "created_at": view.created_at,
        "updated_at": view.updated_at,
    }
