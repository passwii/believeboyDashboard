"""P6b 产品类目服务：管理员 CRUD + 客户类目整体替换（返回增删差异供审计摘要）。"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.crm import CrmCategory, CrmCustomer, CrmCustomerCategory

SEED_CATEGORIES: tuple[str, ...] = (
    "家居",
    "3C",
    "服装",
    "家纺",
    "科学配件",
    "工业配件",
    "工具配件",
    "电动工具",
    "户外用品",
)


def list_categories(db: Session) -> list[CrmCategory]:
    """按 sort_order 排序返回全部类目。"""
    return list(
        db.execute(select(CrmCategory).order_by(CrmCategory.sort_order, CrmCategory.id))
        .scalars()
        .all()
    )


def get_category(db: Session, category_id: int) -> CrmCategory | None:
    return db.get(CrmCategory, category_id)


def create_category(
    db: Session,
    name: str,
    *,
    sort_order: int = 0,
    commit: bool = True,
) -> CrmCategory:
    """建类目；重名 → 抛 ValueError（端点层转 409）。"""
    name = name.strip()
    exists = db.execute(select(CrmCategory.id).where(CrmCategory.name == name)).first()
    if exists:
        raise ValueError(f"类目「{name}」已存在")
    cat = CrmCategory(name=name, sort_order=sort_order)
    db.add(cat)
    db.flush()
    db.refresh(cat)
    if commit:
        db.commit()
    return cat


def update_category(
    db: Session,
    category_id: int,
    *,
    name: str | None = None,
    sort_order: int | None = None,
    commit: bool = True,
) -> CrmCategory | None:
    """改名/改排序；重名 → ValueError。类目不存在 → None。"""
    cat = db.get(CrmCategory, category_id)
    if cat is None:
        return None
    if name is not None:
        name = name.strip()
        dup = db.execute(
            select(CrmCategory.id).where(
                CrmCategory.name == name, CrmCategory.id != category_id
            )
        ).first()
        if dup:
            raise ValueError(f"类目「{name}」已存在")
        cat.name = name
    if sort_order is not None:
        cat.sort_order = sort_order
    db.flush()
    if commit:
        db.commit()
    return cat


def delete_category(
    db: Session,
    category_id: int,
    *,
    commit: bool = True,
) -> CrmCategory | None:
    """删类目；关联行 ON DELETE CASCADE 自动解除。不存在 → None。"""
    cat = db.get(CrmCategory, category_id)
    if cat is None:
        return None
    db.execute(
        delete(CrmCustomerCategory).where(
            CrmCustomerCategory.category_id == category_id
        )
    )
    db.delete(cat)
    db.flush()
    if commit:
        db.commit()
    return cat


def list_customer_categories(db: Session, customer_id: int) -> list[CrmCategory]:
    return list(
        db.execute(
            select(CrmCategory)
            .join(
                CrmCustomerCategory, CrmCustomerCategory.category_id == CrmCategory.id
            )
            .where(CrmCustomerCategory.customer_id == customer_id)
            .order_by(CrmCategory.sort_order, CrmCategory.id)
        )
        .scalars()
        .all()
    )


def set_customer_categories(
    db: Session,
    customer_id: int,
    category_ids: list[int],
    *,
    commit: bool = True,
) -> tuple[CrmCustomer | None, dict, list[CrmCategory]]:
    """整体替换客户类目集（幂等、去重）。

    返回 (customer, diff, 新类目列表)。diff = {"added": [str], "removed": [str]}，
    供审计摘要「产品类目：+家居 +户外 −服装」。customer 不存在 → (None, {}, [])。
    """
    customer = db.get(CrmCustomer, customer_id)
    if customer is None:
        return None, {}, []

    ids = list(dict.fromkeys(category_ids))  # 去重保序
    # 校验所有 id 存在，防脏数据
    if ids:
        existing = set(
            db.execute(select(CrmCategory.id).where(CrmCategory.id.in_(ids)))
            .scalars()
            .all()
        )
        missing = [i for i in ids if i not in existing]
        if missing:
            raise ValueError(f"类目不存在: {missing}")

    before = {c.id: c.name for c in list_customer_categories(db, customer_id)}
    after_ids = set(ids)

    to_remove = [cid for cid in before if cid not in after_ids]
    if to_remove:
        db.execute(
            delete(CrmCustomerCategory).where(
                CrmCustomerCategory.customer_id == customer_id,
                CrmCustomerCategory.category_id.in_(to_remove),
            )
        )
    to_add = [cid for cid in ids if cid not in before]
    for cid in to_add:
        db.add(CrmCustomerCategory(customer_id=customer_id, category_id=cid))

    diff = {"added": [], "removed": []}
    if to_add:
        names = dict(
            db.execute(
                select(CrmCategory.id, CrmCategory.name).where(
                    CrmCategory.id.in_(to_add)
                )
            ).all()
        )
        diff["added"] = [names[cid] for cid in to_add]
    if to_remove:
        diff["removed"] = [before[cid] for cid in to_remove]

    db.flush()
    if commit:
        db.commit()
    return customer, diff, list_customer_categories(db, customer_id)
