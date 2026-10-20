"""Customer domain service: CRUD + scope filter + batch + sea + primary contact join."""

from __future__ import annotations

import re

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.crm import (
    CrmCategory,
    CrmContact,
    CrmCustomer,
    CrmCustomerCategory,
)
from app.schemas.crm import ContactCreate, CustomerCreate, CustomerUpdate
from app.services.crm import audit_service, contact_service


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
            .order_by(
                CrmContact.customer_id, CrmContact.is_primary.desc(), CrmContact.id
            )
        )
        .scalars()
        .all()
    )
    result: dict[int, CrmContact] = {}
    for c in rows:
        result.setdefault(
            c.customer_id, c
        )  # 第一条即主联系人（已按 is_primary desc 排序）
    return result


def _category_map(db: Session, customer_ids: list[int]) -> dict[int, list[CrmCategory]]:
    """P6b 批量加载客户类目，避免 N+1。"""
    if not customer_ids:
        return {}
    rows = db.execute(
        select(CrmCustomerCategory.customer_id, CrmCategory)
        .join(CrmCategory, CrmCategory.id == CrmCustomerCategory.category_id)
        .where(CrmCustomerCategory.customer_id.in_(customer_ids))
        .order_by(CrmCategory.sort_order, CrmCategory.id)
    ).all()
    result: dict[int, list[CrmCategory]] = {}
    for customer_id, cat in rows:
        result.setdefault(customer_id, []).append(cat)
    return result


def _to_item(
    db: Session,
    cust: CrmCustomer,
    owner_names: dict[str, str],
    primary: CrmContact | None,
    categories: list[CrmCategory] | None = None,
):
    from app.schemas.crm import CategoryBrief, CustomerItem

    return CustomerItem(
        id=cust.id,
        name=cust.name,
        short_name=cust.short_name,
        industry=cust.industry,
        customer_type=cust.customer_type,
        interested_service=cust.interested_service,
        rating=cust.rating,
        score_scale=cust.score_scale,
        score_pay=cust.score_pay,
        score_fit=cust.score_fit,
        score_coop=cust.score_coop,
        categories=[CategoryBrief(id=c.id, name=c.name) for c in (categories or [])],
        status=cust.status,
        source=cust.source,
        owner_id=cust.owner_id,
        owner_name=owner_names.get(cust.owner_id) if cust.owner_id else None,
        contact_name=primary.name if primary else None,
        contact_phone=primary.phone if primary else None,
        contact_email=primary.email if primary else None,
        contact_wechat=primary.wechat if primary else None,
        address=cust.address,
        website=cust.website,
        annual_revenue=float(cust.annual_revenue)
        if cust.annual_revenue is not None
        else None,
        employee_count=cust.employee_count,
        remark=cust.remark,
        last_follow_at=cust.last_follow_at,
        next_follow_at=cust.next_follow_at,
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
    filters: list[dict] | None = None,
    category_id: int | None = None,
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
        stmt = stmt.where(
            or_(CrmCustomer.name.ilike(like), CrmCustomer.short_name.ilike(like))
        )

    # P6b: 按类目筛客户（涉及某类目）
    if category_id is not None:
        stmt = stmt.join(
            CrmCustomerCategory,
            CrmCustomerCategory.customer_id == CrmCustomer.id,
        ).where(CrmCustomerCategory.category_id == category_id)

    # 高级筛选（P4）：白名单字段 → where；非法字段/运算符由 filter_engine 抛 ValueError/TypeError。
    if filters:
        from app.services.crm.filter_engine import CUSTOMER_FILTER_FIELDS, apply_filters

        stmt = apply_filters(stmt, CrmCustomer, filters, CUSTOMER_FILTER_FIELDS)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()

    sort_col = getattr(CrmCustomer, sort_by, CrmCustomer.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()

    owner_names = _owner_name_map(db, {r.owner_id for r in rows if r.owner_id})
    primary_map = _primary_contact_map(db, [r.id for r in rows])
    cat_map = _category_map(db, [r.id for r in rows])
    items = [
        _to_item(db, r, owner_names, primary_map.get(r.id), cat_map.get(r.id, []))
        for r in rows
    ]
    return items, int(total)


def get_customer(db: Session, customer_id: int):
    cust = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
        )
    ).scalar_one_or_none()
    if cust is None:
        return None
    owner_names = _owner_name_map(db, {cust.owner_id} if cust.owner_id else set())
    primary = _primary_contact_map(db, [cust.id]).get(cust.id)
    cats = _category_map(db, [cust.id]).get(cust.id, [])
    return _to_item(db, cust, owner_names, primary, cats)


def create_customer(
    db: Session, payload: CustomerCreate, *, user_id: str | None, commit: bool = True
):
    cur = _current_user_id(user_id)
    data = payload.model_dump(exclude_unset=True)
    # 联系人字段不属于 CrmCustomer 列，先弹出，避免传给模型构造器报错
    contact_name = (data.pop("contact_name", None) or "").strip() or None
    contact_phone = data.pop("contact_phone", None)
    contact_email = data.pop("contact_email", None)
    cust = CrmCustomer(**data, created_by=cur)
    if cust.owner_id is None and cur is not None:
        cust.owner_id = cur  # 默认归创建人
    db.add(cust)
    db.flush()
    if contact_name:
        contact_service.create_contact(
            db,
            cust.id,
            ContactCreate(
                name=contact_name,
                phone=contact_phone or None,
                email=contact_email or None,
                is_primary=True,
            ),
            commit=False,
        )
    if commit:
        db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


def update_customer(
    db: Session, customer_id: int, payload: CustomerUpdate, *, commit: bool = True
):
    cust = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
        )
    ).scalar_one_or_none()
    if cust is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(cust, key, value)
    db.flush()
    if commit:
        db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


def delete_customer(db: Session, customer_id: int, *, commit: bool = True) -> bool:
    cust = db.execute(
        select(CrmCustomer).where(
            CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
        )
    ).scalar_one_or_none()
    if cust is None:
        return False
    cust.is_deleted = True
    db.flush()
    if commit:
        db.commit()
    return True


def batch_transfer(
    db: Session, ids: list[int], to_owner_id: str, *, commit: bool = True
) -> int:
    rows = (
        db.execute(
            select(CrmCustomer).where(
                CrmCustomer.id.in_(ids), CrmCustomer.is_deleted.is_(False)
            )
        )
        .scalars()
        .all()
    )
    for cust in rows:
        cust.owner_id = to_owner_id
    db.flush()
    if commit:
        db.commit()
    return len(rows)


def batch_move_to_sea(db: Session, ids: list[int], *, commit: bool = True) -> int:
    rows = (
        db.execute(
            select(CrmCustomer).where(
                CrmCustomer.id.in_(ids), CrmCustomer.is_deleted.is_(False)
            )
        )
        .scalars()
        .all()
    )
    for cust in rows:
        cust.owner_id = None
    db.flush()
    if commit:
        db.commit()
    return len(rows)


def claim_from_sea(
    db: Session, customer_id: int, *, user_id: str | None, commit: bool = True
):
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
    db.flush()
    if commit:
        db.commit()
    db.refresh(cust)
    return get_customer(db, cust.id)


# ── 公海批量导入 ─────────────────────────────────────────────────────────────
_RATINGS = {"A", "B", "C", "D"}
_STATUSES = {"active", "lost", "signed", "on_hold"}
_SOURCES = {
    "referral",
    "exhibition",
    "online_ad",
    "cold_call",
    "self_developed",
    "other",
}
_CUSTOMER_TYPES = {"工厂", "贸易商", "同行", "其他"}
_INTERESTED_SERVICES = {"代运营", "AI运营", "运营服务", "其他"}
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _norm_name(s: str | None) -> str:
    return (s or "").strip()


def _norm_phone(s: str | None) -> str:
    return "".join(ch for ch in (s or "") if ch not in " -")


def _is_email(s: str) -> bool:
    return bool(_EMAIL_RE.match(s))


def _is_duplicate(db: Session, name: str, phone_key: str) -> bool:
    match_ids = [
        r[0]
        for r in db.execute(
            select(CrmCustomer.id).where(
                CrmCustomer.is_deleted.is_(False),
                func.lower(func.trim(CrmCustomer.name)) == name.lower(),
            )
        ).all()
    ]
    if not match_ids:
        return False
    if not phone_key:
        return True  # 仅按名字：同名即重复
    phones = (
        db.execute(
            select(CrmContact.phone).where(CrmContact.customer_id.in_(match_ids))
        )
        .scalars()
        .all()
    )
    return any(_norm_phone(p) == phone_key for p in phones if p)


def import_customers_to_sea(
    db: Session, rows: list, *, user_id: str | None, commit: bool = True
) -> dict:
    cur = _current_user_id(user_id)
    created = 0
    skipped_dupes = 0
    failed: list[dict] = []
    seen_keys: set[tuple[str, str]] = set()

    for idx, row in enumerate(rows, start=1):
        name = _norm_name(row.name)
        if not name:
            failed.append({"row": idx, "field": "name", "reason": "客户名必填"})
            continue
        if row.rating and row.rating not in _RATINGS:
            failed.append(
                {"row": idx, "field": "rating", "reason": f"等级无效：{row.rating}"}
            )
            continue
        if row.status and row.status not in _STATUSES:
            failed.append(
                {"row": idx, "field": "status", "reason": f"状态无效：{row.status}"}
            )
            continue
        if row.source and row.source not in _SOURCES:
            failed.append(
                {"row": idx, "field": "source", "reason": f"来源无效：{row.source}"}
            )
            continue
        if row.customer_type and row.customer_type not in _CUSTOMER_TYPES:
            failed.append(
                {
                    "row": idx,
                    "field": "customer_type",
                    "reason": f"对象类型无效：{row.customer_type}",
                }
            )
            continue
        if (
            row.interested_service
            and row.interested_service not in _INTERESTED_SERVICES
        ):
            failed.append(
                {
                    "row": idx,
                    "field": "interested_service",
                    "reason": f"意向服务无效：{row.interested_service}",
                }
            )
            continue
        if row.contact_email and not _is_email(row.contact_email):
            failed.append(
                {"row": idx, "field": "contact_email", "reason": "邮箱格式不正确"}
            )
            continue

        phone_key = _norm_phone(row.contact_phone)
        key = (name.lower(), phone_key)
        if key in seen_keys:
            skipped_dupes += 1
            continue
        if _is_duplicate(db, name, phone_key):
            skipped_dupes += 1
            seen_keys.add(key)
            continue
        seen_keys.add(key)

        cust = CrmCustomer(
            name=name,
            short_name=row.short_name or None,
            industry=row.industry or None,
            customer_type=row.customer_type or None,
            interested_service=row.interested_service or None,
            rating=row.rating or "C",
            status=row.status or "active",
            source=row.source or None,
            owner_id=None,  # 公海
            address=row.address or None,
            website=row.website or None,
            annual_revenue=row.annual_revenue,
            employee_count=row.employee_count,
            remark=row.remark or None,
            created_by=cur,
        )
        db.add(cust)
        db.flush()

        contact_name = _norm_name(row.contact_name)
        if contact_name:
            contact_service.create_contact(
                db,
                cust.id,
                ContactCreate(
                    name=contact_name,
                    phone=row.contact_phone or None,
                    email=row.contact_email or None,
                    is_primary=True,
                ),
                commit=False,
            )

        audit_service.record_log(
            db,
            entity_type="customer",
            entity_id=cust.id,
            action="create",
            actor_id=cur,
            summary="公海导入",
        )
        created += 1

    if commit:
        db.commit()
    return {"created": created, "skipped_dupes": skipped_dupes, "failed": failed}
