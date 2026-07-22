"""Contact service: CRUD under a customer + single-primary enforcement."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer
from app.schemas.crm import ContactCreate, ContactUpdate


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
    others = db.execute(
        select(CrmContact).where(
            CrmContact.customer_id == customer_id,
            CrmContact.id != keep_id,
            CrmContact.is_primary.is_(True),
        )
    ).scalars().all()
    for c in others:
        c.is_primary = False


def create_contact(db: Session, customer_id: int, payload: ContactCreate) -> CrmContact | None:
    if not _customer_exists(db, customer_id):
        return None
    contact = CrmContact(customer_id=customer_id, **payload.model_dump(exclude_unset=True))
    db.add(contact)
    db.flush()  # 拿 id
    if contact.is_primary:
        _enforce_single_primary(db, customer_id, contact.id)
    else:
        # 客户首个联系人自动成为主联系人
        existing = db.execute(
            select(CrmContact).where(CrmContact.customer_id == customer_id, CrmContact.id != contact.id)
        ).scalars().all()
        if not existing:
            contact.is_primary = True
    db.commit()
    db.refresh(contact)
    return contact


def update_contact(db: Session, contact_id: int, payload: ContactUpdate) -> CrmContact | None:
    contact = db.execute(select(CrmContact).where(CrmContact.id == contact_id)).scalar_one_or_none()
    if contact is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(contact, key, value)
    db.flush()
    if contact.is_primary:
        _enforce_single_primary(db, contact.customer_id, contact.id)
    db.commit()
    db.refresh(contact)
    return contact


def delete_contact(db: Session, contact_id: int) -> bool:
    contact = db.execute(select(CrmContact).where(CrmContact.id == contact_id)).scalar_one_or_none()
    if contact is None:
        return False
    customer_id = contact.customer_id
    was_primary = contact.is_primary
    db.delete(contact)
    db.flush()
    if was_primary:
        remaining = db.execute(
            select(CrmContact).where(CrmContact.customer_id == customer_id).order_by(CrmContact.id)
        ).scalars().all()
        if remaining:
            remaining[0].is_primary = True
    db.commit()
    return True
