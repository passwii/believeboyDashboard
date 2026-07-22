"""Customer domain service: CRUD + scope filter + batch + sea + primary contact join."""
from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import CustomerCreate, CustomerUpdate


def _current_user_id(user_id: str | None) -> str | None:
    if user_id is None:
        return None
    uid = user_id.strip()
    return uid or None


def _owner_name_map(db: Session, owner_ids: set[str]) -> dict[str, str]:
    """批量查 user_accounts.name，避免 N+1。

    owner_id 现为 String(36)（user_accounts.id UUID），类型匹配，正常 join。
    返回 {str(id): name}。
    """
    from sqlalchemy import text

    if not owner_ids:
        return {}
    rows = db.execute(
        text("select id, name from public.user_accounts where id = any(:ids)"),
        {"ids": list(owner_ids)},
    ).all()
    return {str(r[0]): r[1] for r in rows}


def _primary_contact_map(db: Session, customer_ids: list[int]) -> dict[int, CrmContact]:
    """每个客户的主联系人（is_primary=true，无主则取最早一条）。"""
    if not customer_ids:
        return {}
    rows = (
        db.execute(
            select(CrmContact)
            .where(CrmContact.customer_id.in_(customer_ids))
            .order_by(CrmContact.customer_id, CrmContact.is_primary.desc(), CrmContact.id)
        )
        .scalars()
        .all()
    )
    result: dict[int, CrmContact] = {}
    for c in rows:
        result.setdefault(c.customer_id, c)  # 第一条即主联系人（已按 is_primary desc 排序）
    return result


def _to_item(db: Session, cust: CrmCustomer, owner_names: dict[str, str], primary: CrmContact | None):
    from app.schemas.crm import CustomerItem

    return CustomerItem(
        id=cust.id,
        name=cust.name,
        short_name=cust.short_name,
        industry=cust.industry,
        rating=cust.rating,
        status=cust.status,
        source=cust.source,
        owner_id=cust.owner_id,
        owner_name=owner_names.get(cust.owner_id) if cust.owner_id else None,
        contact_name=primary.name if primary else None,
        contact_phone=primary.phone if primary else None,
        contact_email=primary.email if primary else None,
        address=cust.address,
        website=cust.website,
        annual_revenue=float(cust.annual_revenue) if cust.annual_revenue is not None else None,
        employee_count=cust.employee_count,
        remark=cust.remark,
        last_follow_at=cust.last_follow_at,
        created_by=cust.created_by,
        created_at=cust.created_at,
        updated_at=cust.updated_at,
    )


def list_customers(
    db: Session,
    *,
    user_id: str | None,
    scope: str = "all",
    keyword: str | None = None,
    page: int = 1,
    page_size: int = 20,
    sort_by: str = "updated_at",
    sort_order: str = "desc",
) -> tuple[list, int]:
    cur = _current_user_id(user_id)
    stmt = select(CrmCustomer).where(CrmCustomer.is_deleted.is_(False))

    if scope == "mine" and cur is not None:
        stmt = stmt.where(CrmCustomer.owner_id == cur)
    elif scope == "sea":
        stmt = stmt.where(CrmCustomer.owner_id.is_(None))
    # scope == "all": 不加 owner 过滤（P4 引入部门粒度后按角色收紧）

    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(or_(CrmCustomer.name.ilike(like), CrmCustomer.short_name.ilike(like)))

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()

    sort_col = getattr(CrmCustomer, sort_by, CrmCustomer.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()

    owner_names = _owner_name_map(db, {r.owner_id for r in rows if r.owner_id})
    primary_map = _primary_contact_map(db, [r.id for r in rows])
    items = [_to_item(db, r, owner_names, primary_map.get(r.id)) for r in rows]
    return items, int(total)


def get_customer(db: Session, customer_id: int):
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return None
    owner_names = _owner_name_map(db, {cust.owner_id} if cust.owner_id else set())
    primary = _primary_contact_map(db, [cust.id]).get(cust.id)
    return _to_item(db, cust, owner_names, primary)


def create_customer(db: Session, payload: CustomerCreate, *, user_id: str | None):
    cur = _current_user_id(user_id)
    cust = CrmCustomer(**payload.model_dump(exclude_unset=True), created_by=cur)
    if cust.owner_id is None and cur is not None:
        cust.owner_id = cur  # 默认归创建人
    db.add(cust)
    db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


def update_customer(db: Session, customer_id: int, payload: CustomerUpdate):
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(cust, key, value)
    db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


def delete_customer(db: Session, customer_id: int) -> bool:
    cust = db.execute(
        select(CrmCustomer).where(CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False))
    ).scalar_one_or_none()
    if cust is None:
        return False
    cust.is_deleted = True
    db.commit()
    return True


def batch_transfer(db: Session, ids: list[int], to_owner_id: str) -> int:
    rows = db.execute(
        select(CrmCustomer).where(CrmCustomer.id.in_(ids), CrmCustomer.is_deleted.is_(False))
    ).scalars().all()
    for cust in rows:
        cust.owner_id = to_owner_id
    db.commit()
    return len(rows)


def batch_move_to_sea(db: Session, ids: list[int]) -> int:
    rows = db.execute(
        select(CrmCustomer).where(CrmCustomer.id.in_(ids), CrmCustomer.is_deleted.is_(False))
    ).scalars().all()
    for cust in rows:
        cust.owner_id = None
    db.commit()
    return len(rows)


def claim_from_sea(db: Session, customer_id: int, *, user_id: str | None):
    cur = _current_user_id(user_id)
    if cur is None:
        return None
    cust = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id,
            CrmCustomer.is_deleted.is_(False),
            CrmCustomer.owner_id.is_(None),
        )
    ).scalar_one_or_none()
    if cust is None:
        return None  # 不在公海或不存在
    cust.owner_id = cur
    db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)
