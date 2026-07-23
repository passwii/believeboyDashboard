"""CRM API endpoints。

权限（MVP，is_admin 二分，见 services/crm/permissions.py）：
- 普通销售：scope=all 降级 mine（只见自己+公海）；不可指派；不可写非自己名下记录。
- 管理员：scope=all 看全部；可指派/释放任意记录。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_user_id,
    protected,
)
from app.models.crm import CrmCustomer, CrmLead
from app.schemas.crm import (
    BatchIdsRequest,
    BatchTransferRequest,
    ContactCreate,
    ContactItem,
    ContactUpdate,
    ConvertLeadRequest,
    ConvertLeadResponse,
    CustomerCreate,
    CustomerItem,
    CustomerListResponse,
    CustomerUpdate,
    CrmUserItem,
    FollowCreate,
    FollowItem,
    LeadCreate,
    LeadItem,
    LeadListResponse,
    LeadUpdate,
)
from app.services.crm import contact_service, customer_service, follow_service, lead_service, user_service
from app.services.crm.lead_service import LeadAlreadyConverted
from app.services.crm.permissions import (
    filter_owned_ids,
    require_admin,
    require_owner_or_admin,
    resolve_scope,
)

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
    is_admin: bool = Depends(get_request_is_admin),
):
    items, total = customer_service.list_customers(
        db, user_id=user_id, scope=resolve_scope(scope, is_admin), keyword=keyword,
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
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    existing = customer_service.get_customer(db, customer_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    return customer_service.update_customer(db, customer_id, payload)


@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    existing = customer_service.get_customer(db, customer_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found")
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    customer_service.delete_customer(db, customer_id)


@router.post("/customers/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer(
    payload: BatchTransferRequest,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    customer_service.batch_transfer(db, payload.ids, payload.to_owner_id)


@router.post("/customers/batch-move-sea", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_to_sea(
    payload: BatchIdsRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    ids = filter_owned_ids(db, CrmCustomer, payload.ids, user_id, is_admin)
    customer_service.batch_move_to_sea(db, ids)


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


# ---------- Lead ----------
@router.get("/leads", response_model=LeadListResponse)
def list_leads(
    scope: str = Query("all"),
    keyword: str | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    items, total = lead_service.list_leads(
        db, user_id=user_id, scope=resolve_scope(scope, is_admin), keyword=keyword,
        page=page, page_size=page_size, sort_by=sort_by, sort_order=sort_order,
    )
    return LeadListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/leads", response_model=LeadItem, status_code=status.HTTP_201_CREATED)
def create_lead(
    payload: LeadCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    return lead_service.create_lead(db, payload, user_id=user_id)


@router.get("/leads/{lead_id}", response_model=LeadItem)
def get_lead(lead_id: int, db: Session = Depends(get_read_db_session)):
    item = lead_service.get_lead(db, lead_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found")
    return item


@router.patch("/leads/{lead_id}", response_model=LeadItem)
def update_lead(
    lead_id: int,
    payload: LeadUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    existing = lead_service.get_lead(db, lead_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found")
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    return lead_service.update_lead(db, lead_id, payload)


@router.post("/leads/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer_leads(
    payload: BatchTransferRequest,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    lead_service.batch_transfer(db, payload.ids, payload.to_owner_id)


@router.post("/leads/batch-move-pool", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_leads_to_pool(
    payload: BatchIdsRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    ids = filter_owned_ids(db, CrmLead, payload.ids, user_id, is_admin)
    lead_service.batch_move_to_pool(db, ids)


@router.post("/leads/{lead_id}/claim", response_model=LeadItem)
def claim_lead_from_pool(
    lead_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = lead_service.claim_from_pool(db, lead_id, user_id=user_id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Lead not in pool")
    return item


@router.post("/leads/{lead_id}/convert", response_model=ConvertLeadResponse)
def convert_lead(
    lead_id: int,
    payload: ConvertLeadRequest | None = None,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    existing = lead_service.get_lead(db, lead_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found")
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    try:
        resp = lead_service.convert_lead(db, lead_id, payload, user_id=user_id)
    except LeadAlreadyConverted:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Lead already converted")
    return resp


# ---------- Follow ----------
@router.get("/follows", response_model=list[FollowItem])
def list_follows(
    entity_type: str = Query(...),
    entity_id: int = Query(...),
    db: Session = Depends(get_read_db_session),
):
    return follow_service.list_follows(db, entity_type, entity_id)


@router.post("/follows", response_model=FollowItem, status_code=status.HTTP_201_CREATED)
def create_follow(
    payload: FollowCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    return follow_service.create_follow(db, payload, user_id=user_id)
