"""CRM API endpoints。

权限（MVP，is_admin 二分，见 services/crm/permissions.py）：
- 普通销售：scope=all 降级 mine（只见自己+公海）；不可指派；不可写非自己名下记录。
- 管理员：scope=all 看全部；可指派/释放任意记录。
"""

from __future__ import annotations

import json
from datetime import date
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
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
    AuditLogListResponse,
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
    DashboardStats,
    FollowCreate,
    FollowItem,
    FollowUpGroups,
    LeadCreate,
    LeadItem,
    LeadListResponse,
    LeadUpdate,
)
from app.services.crm import (
    audit_service,
    contact_service,
    customer_service,
    dashboard_service,
    export_service,
    follow_service,
    follow_up_service,
    lead_service,
    user_service,
)
from app.services.crm.audit_service import CUSTOMER_FIELD_LABELS, LEAD_FIELD_LABELS
from app.services.crm.lead_service import LeadAlreadyConverted
from app.services.crm.permissions import (
    filter_owned_ids,
    require_admin,
    require_owner_or_admin,
    resolve_scope,
)

router = APIRouter(prefix="/crm", tags=["crm"], dependencies=[Depends(protected)])


def _parse_filters(filters: str | None) -> list[dict] | None:
    """解析 filters 查询参数（FilterCondition JSON 数组）；非法 JSON 或非数组 → 400。

    字段白名单/运算符校验在 filter_engine（service 层）做，抛 ValueError/TypeError，
    由端点 catch 转 400。
    """
    if not filters:
        return None
    try:
        parsed = json.loads(filters)
    except json.JSONDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="filters 非法 JSON"
        )
    if not isinstance(parsed, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="filters 须为 JSON 数组"
        )
    return parsed


# ---------- Customer ----------
@router.get("/customers", response_model=CustomerListResponse)
def list_customers(
    scope: str = Query("all"),
    keyword: str | None = None,
    filters: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    parsed_filters = _parse_filters(filters)
    try:
        items, total = customer_service.list_customers(
            db,
            user_id=user_id,
            scope=resolve_scope(scope, is_admin),
            keyword=keyword,
            page=page,
            page_size=page_size,
            sort_by=sort_by,
            sort_order=sort_order,
            filters=parsed_filters,
        )
    except (ValueError, TypeError) as e:
        # 非白名单字段/未知运算符 → ValueError；畸形 between/in value → TypeError。统一 400。
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return CustomerListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


def _csv_response(content: str, filename: str) -> StreamingResponse:
    """CSV 下载响应：text/csv + UTF-8 BOM 已在 content 里；文件名 RFC5987 编码（中文）。"""
    encoded = quote(filename)
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"},
    )


@router.get("/customers/export")
def export_customers(
    scope: str = Query("all"),
    keyword: str | None = None,
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """按当前 scope/keyword 导出客户清单为 CSV（不分页，导出全部命中）。"""
    content = export_service.export_customers_csv(
        db, user_id=user_id, scope=resolve_scope(scope, is_admin), keyword=keyword
    )
    return _csv_response(content, f"客户_{date.today():%Y%m%d}.csv")


@router.post(
    "/customers", response_model=CustomerItem, status_code=status.HTTP_201_CREATED
)
def create_customer(
    payload: CustomerCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = customer_service.create_customer(db, payload, user_id=user_id)
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=item.id,
        action="create",
        actor_id=user_id,
        summary="新建客户",
    )
    return item


@router.get("/customers/{customer_id}", response_model=CustomerItem)
def get_customer(customer_id: int, db: Session = Depends(get_read_db_session)):
    item = customer_service.get_customer(db, customer_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    before = existing.model_dump()
    item = customer_service.update_customer(db, customer_id, payload)
    summary = audit_service.summarize_update(
        before, payload.model_dump(exclude_unset=True), CUSTOMER_FIELD_LABELS
    )
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=customer_id,
        action="update",
        actor_id=user_id,
        summary=summary,
    )
    return item


@router.delete("/customers/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_customer(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    existing = customer_service.get_customer(db, customer_id)
    if existing is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    customer_service.delete_customer(db, customer_id)
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=customer_id,
        action="delete",
        actor_id=user_id,
        summary=f"删除客户 {existing.name}",
    )


@router.post("/customers/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer(
    payload: BatchTransferRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    customer_service.batch_transfer(db, payload.ids, payload.to_owner_id)
    for cid in payload.ids:
        audit_service.record_log(
            db,
            entity_type="customer",
            entity_id=cid,
            action="transfer",
            actor_id=user_id,
            summary="指派负责人",
        )


@router.post("/customers/batch-move-sea", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_to_sea(
    payload: BatchIdsRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    ids = filter_owned_ids(db, CrmCustomer, payload.ids, user_id, is_admin)
    customer_service.batch_move_to_sea(db, ids)
    for cid in ids:
        audit_service.record_log(
            db,
            entity_type="customer",
            entity_id=cid,
            action="move_sea",
            actor_id=user_id,
            summary="释放至公海",
        )


@router.post("/customers/{customer_id}/claim", response_model=CustomerItem)
def claim_from_sea(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = customer_service.claim_from_sea(db, customer_id, user_id=user_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Customer not in sea"
        )
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=item.id,
        action="claim",
        actor_id=user_id,
        summary="从公海领取",
    )
    return item


# ---------- Contact ----------
@router.get("/customers/{customer_id}/contacts", response_model=list[ContactItem])
def list_contacts(customer_id: int, db: Session = Depends(get_read_db_session)):
    return contact_service.list_contacts(db, customer_id)


@router.post(
    "/customers/{customer_id}/contacts",
    response_model=ContactItem,
    status_code=status.HTTP_201_CREATED,
)
def create_contact(
    customer_id: int,
    payload: ContactCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    contact = contact_service.create_contact(db, customer_id, payload)
    if contact is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
    audit_service.record_log(
        db,
        entity_type="contact",
        entity_id=contact.id,
        action="create",
        actor_id=user_id,
        summary=f"新增联系人 {contact.name}",
    )
    return contact


@router.patch("/contacts/{contact_id}", response_model=ContactItem)
def update_contact(
    contact_id: int,
    payload: ContactUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    contact, summary = contact_service.update_contact(db, contact_id, payload)
    if contact is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found"
        )
    # P5-1：字段级变更摘要；无变化时（summary is None）兜底写"编辑联系人 X"
    audit_summary = summary or f"编辑联系人 {contact.name}"
    audit_service.record_log(
        db,
        entity_type="contact",
        entity_id=contact.id,
        action="update",
        actor_id=user_id,
        summary=audit_summary,
    )
    return contact


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(
    contact_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    if not contact_service.delete_contact(db, contact_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found"
        )
    audit_service.record_log(
        db,
        entity_type="contact",
        entity_id=contact_id,
        action="delete",
        actor_id=user_id,
        summary="删除联系人",
    )


# ---------- User ----------
@router.get("/users", response_model=list[CrmUserItem])
def list_users(db: Session = Depends(get_read_db_session)):
    return user_service.list_crm_users(db)


@router.get("/users/{user_id}", response_model=CrmUserItem)
def get_user(user_id: str, db: Session = Depends(get_read_db_session)):
    item = user_service.get_crm_user(db, user_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
        )
    return item


# ---------- Lead ----------
@router.get("/leads", response_model=LeadListResponse)
def list_leads(
    scope: str = Query("all"),
    keyword: str | None = None,
    filters: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    sort_by: str = "updated_at",
    sort_order: str = "desc",
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    parsed_filters = _parse_filters(filters)
    try:
        items, total = lead_service.list_leads(
            db,
            user_id=user_id,
            scope=resolve_scope(scope, is_admin),
            keyword=keyword,
            page=page,
            page_size=page_size,
            sort_by=sort_by,
            sort_order=sort_order,
            filters=parsed_filters,
        )
    except (ValueError, TypeError) as e:
        # 非白名单字段/未知运算符 → ValueError；畸形 between/in value → TypeError。统一 400。
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return LeadListResponse(items=items, total=total, page=page, page_size=page_size)


@router.get("/leads/export")
def export_leads(
    scope: str = Query("all"),
    keyword: str | None = None,
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """按当前 scope/keyword 导出线索清单为 CSV（不分页，导出全部命中）。"""
    content = export_service.export_leads_csv(
        db, user_id=user_id, scope=resolve_scope(scope, is_admin), keyword=keyword
    )
    return _csv_response(content, f"线索_{date.today():%Y%m%d}.csv")


@router.post("/leads", response_model=LeadItem, status_code=status.HTTP_201_CREATED)
def create_lead(
    payload: LeadCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = lead_service.create_lead(db, payload, user_id=user_id)
    audit_service.record_log(
        db,
        entity_type="lead",
        entity_id=item.id,
        action="create",
        actor_id=user_id,
        summary="新建线索",
    )
    return item


@router.get("/leads/{lead_id}", response_model=LeadItem)
def get_lead(lead_id: int, db: Session = Depends(get_read_db_session)):
    item = lead_service.get_lead(db, lead_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found"
        )
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found"
        )
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    before = existing.model_dump()
    item = lead_service.update_lead(db, lead_id, payload)
    summary = audit_service.summarize_update(
        before, payload.model_dump(exclude_unset=True), LEAD_FIELD_LABELS
    )
    audit_service.record_log(
        db,
        entity_type="lead",
        entity_id=lead_id,
        action="update",
        actor_id=user_id,
        summary=summary,
    )
    return item


@router.post("/leads/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer_leads(
    payload: BatchTransferRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    lead_service.batch_transfer(db, payload.ids, payload.to_owner_id)
    for lid in payload.ids:
        audit_service.record_log(
            db,
            entity_type="lead",
            entity_id=lid,
            action="transfer",
            actor_id=user_id,
            summary="指派负责人",
        )


@router.post("/leads/batch-move-pool", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_leads_to_pool(
    payload: BatchIdsRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    ids = filter_owned_ids(db, CrmLead, payload.ids, user_id, is_admin)
    lead_service.batch_move_to_pool(db, ids)
    for lid in ids:
        audit_service.record_log(
            db,
            entity_type="lead",
            entity_id=lid,
            action="move_sea",
            actor_id=user_id,
            summary="释放至线索池",
        )


@router.post("/leads/{lead_id}/claim", response_model=LeadItem)
def claim_lead_from_pool(
    lead_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = lead_service.claim_from_pool(db, lead_id, user_id=user_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Lead not in pool"
        )
    audit_service.record_log(
        db,
        entity_type="lead",
        entity_id=item.id,
        action="claim",
        actor_id=user_id,
        summary="从线索池领取",
    )
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found"
        )
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    try:
        resp = lead_service.convert_lead(db, lead_id, payload, user_id=user_id)
    except LeadAlreadyConverted:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Lead already converted"
        )
    audit_service.record_log(
        db,
        entity_type="lead",
        entity_id=lead_id,
        action="convert",
        actor_id=user_id,
        summary="线索转化为客户",
    )
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


# ---------- Follow-up 待跟进视图（P2b） ----------
@router.get("/follow-ups", response_model=FollowUpGroups)
def list_follow_ups(
    scope: str = Query("mine"),
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    return follow_up_service.list_follow_ups(
        db, user_id=user_id, scope=resolve_scope(scope, is_admin)
    )


# ---------- Audit Log 审计日志（P4，仅管理员） ----------
@router.get("/audit-logs", response_model=AuditLogListResponse)
def list_audit_logs(
    entity_type: str | None = Query(None),
    entity_id: int | None = Query(None),
    actor_id: str | None = Query(None),
    action: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """审计日志查询（仅管理员）。"""
    require_admin(is_admin)
    items, total = audit_service.list_audit_logs(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        actor_id=actor_id,
        action=action,
        page=page,
        page_size=page_size,
    )
    return AuditLogListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


# ---------- Dashboard 数据看板（P3c，仅管理员） ----------
@router.get("/dashboard/stats", response_model=DashboardStats)
def get_dashboard_stats(
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    return dashboard_service.get_dashboard_stats(db, is_admin=is_admin)
