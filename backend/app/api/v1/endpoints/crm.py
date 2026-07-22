"""CRM API endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_user_id, protected
from app.schemas.crm import (
    BatchIdsRequest,
    BatchTransferRequest,
    ContactCreate,
    ContactItem,
    ContactUpdate,
    CustomerCreate,
    CustomerItem,
    CustomerListResponse,
    CustomerUpdate,
    CrmUserItem,
)
from app.services.crm import contact_service, customer_service, user_service

router = APIRouter(prefix="/crm", tags=["crm"], dependencies=[Depends(protected)])


# ---------- Customer ----------
@router.get("/customers", response_model=CustomerListResponse)
def list_customers(
    scope: str = Query("all"),
    keyword: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    items, total = customer_service.list_customers(
        db, user_id=user_id, scope=scope, keyword=keyword,
        page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order,
    )
    return CustomerListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/customers", response_model=CustomerItem, status_code=status.HTTP_201_CREATED)
def create_customer(
    payload: CustomerCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    return customer_service.create_customer(db, payload, user_id=user_id)


@router.get("/customers/{customer_id}", response_model=CustomerItem)
def get_customer(customer_id: int, db: Session = Depends(get_read_db_session)):
    item = customer_service.get_customer(db, customer_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return item


@router.patch("/customers/{customer_id}", response_model=CustomerItem)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    db: Session = Depends(get_primary_db_session),
):
    item = customer_service.update_customer(db, customer_id, payload)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return item


@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(customer_id: int, db: Session = Depends(get_primary_db_session)):
    if not customer_service.delete_customer(db, customer_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")


@router.post("/customers/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer(payload: BatchTransferRequest, db: Session = Depends(get_primary_db_session)):
    customer_service.batch_transfer(db, payload.ids, payload.to_owner_id)


@router.post("/customers/batch-move-sea", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_to_sea(payload: BatchIdsRequest, db: Session = Depends(get_primary_db_session)):
    customer_service.batch_move_to_sea(db, payload.ids)


@router.post("/customers/{customer_id}/claim", response_model=CustomerItem)
def claim_from_sea(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = customer_service.claim_from_sea(db, customer_id, user_id=user_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Customer not in sea")
    return item


# ---------- Contact ----------
@router.get("/customers/{customer_id}/contacts", response_model=list[ContactItem])
def list_contacts(customer_id: int, db: Session = Depends(get_read_db_session)):
    return contact_service.list_contacts(db, customer_id)


@router.post("/customers/{customer_id}/contacts", response_model=ContactItem, status_code=status.HTTP_201_CREATED)
def create_contact(
    customer_id: int,
    payload: ContactCreate,
    db: Session = Depends(get_primary_db_session),
):
    contact = contact_service.create_contact(db, customer_id, payload)
    if contact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    return contact


@router.patch("/contacts/{contact_id}", response_model=ContactItem)
def update_contact(contact_id: int, payload: ContactUpdate, db: Session = Depends(get_primary_db_session)):
    contact = contact_service.update_contact(db, contact_id, payload)
    if contact is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")
    return contact


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(contact_id: int, db: Session = Depends(get_primary_db_session)):
    if not contact_service.delete_contact(db, contact_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")


# ---------- User ----------
@router.get("/users", response_model=list[CrmUserItem])
def list_users(db: Session = Depends(get_read_db_session)):
    return user_service.list_crm_users(db)


@router.get("/users/{user_id}", response_model=CrmUserItem)
def get_user(user_id: str, db: Session = Depends(get_read_db_session)):
    item = user_service.get_crm_user(db, user_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return item
