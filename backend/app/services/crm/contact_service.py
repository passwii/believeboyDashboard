"""Contact service: CRUD under a customer + single-primary enforcement."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import ContactCreate, ContactUpdate
from app.services.crm.audit_service import summarize_contact_update


def _customer_exists(db: Session, customer_id: int) -> bool:
    return (
        db.execute(
            select(CrmCustomer.id).where(
                CrmCustomer.id == customer_id, CrmCustomer.is_deleted.is_(False)
            )
        ).scalar_one_or_none()
        is not None
    )


def list_contacts(db: Session, customer_id: int) -> list[CrmContact]:
    return (
        db.execute(
            select(CrmContact)
            .where(CrmContact.customer_id == customer_id)
            .order_by(CrmContact.is_primary.desc(), CrmContact.id)
        )
        .scalars()
        .all()
    )


def _enforce_single_primary(db: Session, customer_id: int, keep_id: int) -> None:
    """把同客户下其他联系人的 is_primary 置 False。"""
    others = (
        db.execute(
            select(CrmContact).where(
                CrmContact.customer_id == customer_id,
                CrmContact.id != keep_id,
                CrmContact.is_primary.is_(True),
            )
        )
        .scalars()
        .all()
    )
    for c in others:
        c.is_primary = False


def create_contact(
    db: Session, customer_id: int, payload: ContactCreate
) -> CrmContact | None:
    if not _customer_exists(db, customer_id):
        return None
    contact = CrmContact(
        customer_id=customer_id, **payload.model_dump(exclude_unset=True)
    )
    db.add(contact)
    db.flush()  # 拿 id
    if contact.is_primary:
        _enforce_single_primary(db, customer_id, contact.id)
    else:
        # 客户首个联系人自动成为主联系人
        existing = (
            db.execute(
                select(CrmContact).where(
                    CrmContact.customer_id == customer_id, CrmContact.id != contact.id
                )
            )
            .scalars()
            .all()
        )
        if not existing:
            contact.is_primary = True
    db.commit()
    db.refresh(contact)
    return contact


def update_contact(
    db: Session, contact_id: int, payload: ContactUpdate
) -> tuple[CrmContact | None, str | None]:
    """更新联系人；返回 ``(contact, summary)``。

    summary 由 ``summarize_contact_update`` 计算（P5-1 字段级变更摘要）；
    无变化返回 ``None``，让调用方决定是否仍写兜底审计或跳过。
    commit 边界仍由本函数负责（待 P5-6 强一致改造再调整）。
    """
    contact = db.execute(
        select(CrmContact).where(CrmContact.id == contact_id)
    ).scalar_one_or_none()
    if contact is None:
        return None, None
    # 在 mutate 之前快照原值，喂给 summarize_contact_update。
    # 字段名对齐 CrmContact（title/remark，plan 草稿的 role/note 已修正）。
    before_snapshot: dict = {
        "name": contact.name,
        "title": contact.title,
        "phone": contact.phone,
        "email": contact.email,
        "wechat": contact.wechat,
        "is_primary": contact.is_primary,
        "remark": contact.remark,
    }
    patch = payload.model_dump(exclude_unset=True)
    for key, value in patch.items():
        setattr(contact, key, value)
    summary = summarize_contact_update(before_snapshot, patch)
    db.flush()
    if contact.is_primary:
        _enforce_single_primary(db, contact.customer_id, contact.id)
    db.commit()
    db.refresh(contact)
    return contact, summary


def delete_contact(db: Session, contact_id: int) -> bool:
    contact = db.execute(
        select(CrmContact).where(CrmContact.id == contact_id)
    ).scalar_one_or_none()
    if contact is None:
        return False
    customer_id = contact.customer_id
    was_primary = contact.is_primary
    db.delete(contact)
    db.flush()
    if was_primary:
        remaining = (
            db.execute(
                select(CrmContact)
                .where(CrmContact.customer_id == customer_id)
                .order_by(CrmContact.id)
            )
            .scalars()
            .all()
        )
        if remaining:
            remaining[0].is_primary = True
    db.commit()
    return True
