"""CRM API endpoints。

权限（MVP，is_admin 二分，见 services/crm/permissions.py）：
- 普通销售：scope=all 降级 mine（只见自己+公海）；不可指派；不可写非自己名下记录。
- 管理员：scope=all 看全部；可指派/释放任意记录。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_user_id,
    protected,
)
from app.db.session import SessionLocal
from app.models.crm import CrmCustomer, CrmLead
from app.schemas.crm import (
    AuditLogListResponse,
    BatchIdsRequest,
    BatchTransferRequest,
    CategoryCreate,
    CategoryItem,
    CategoryUpdate,
    ContactCreate,
    ContactItem,
    ContactUpdate,
    ConvertLeadRequest,
    ConvertLeadResponse,
    CrmUserItem,
    CustomerCategoriesUpdate,
    CustomerCreate,
    CustomerItem,
    CustomerListResponse,
    CustomerSeaImportRequest,
    CustomerSeaImportResult,
    CustomerUpdate,
    DashboardStats,
    FollowCreate,
    FollowItem,
    FollowUpGroups,
    FunnelMetrics,
    LeadCreate,
    LeadItem,
    LeadListResponse,
    LeadUpdate,
    LifecycleBoard,
    PerformanceBoard,
    RuleCreate,
    RuleItem,
    RuleUpdate,
    StageDetail,
    TaskCompleteRequest,
    TaskCreate,
    TaskItem,
    TaskListResponse,
    TaskStatusUpdate,
    TaskUpdate,
    ValueScoresUpdate,
    WorkflowSettings,
    WorkflowSettingsUpdate,
)
from app.services.crm import (
    audit_service,
    category_service,
    contact_service,
    customer_service,
    dashboard_service,
    export_service,
    follow_service,
    follow_up_service,
    lead_service,
    rule_crud_service,
    stale_email_service,
    task_service,
    user_service,
    value_score_service,
)
from app.services.crm.audit_service import (
    CUSTOMER_FIELD_LABELS,
    LEAD_FIELD_LABELS,
    RULE_FIELD_LABELS,
)
from app.services.crm.lead_service import LeadAlreadyConverted
from app.services.crm.permissions import (
    filter_owned_ids,
    require_admin,
    require_owner_or_admin,
    resolve_scope,
)

logger = logging.getLogger(__name__)

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
    item = customer_service.create_customer(db, payload, user_id=user_id, commit=False)
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=item.id,
        action="create",
        actor_id=user_id,
        summary="新建客户",
    )
    db.commit()
    return item


@router.post("/customers/import-sea", response_model=CustomerSeaImportResult)
def import_customers_to_sea(
    payload: CustomerSeaImportRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    return customer_service.import_customers_to_sea(db, payload.rows, user_id=user_id)


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
    item = customer_service.update_customer(db, customer_id, payload, commit=False)
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
    db.commit()
    return item


def _summarize_value_scores(
    payload: dict, rating_changed: bool, new_rating: str | None
) -> str:
    labels = {
        "score_scale": "体量",
        "score_pay": "付费",
        "score_fit": "匹配",
        "score_coop": "合作",
    }
    parts = [f"{labels[k]}{v}" for k, v in payload.items() if v is not None]
    head = "价值评分：" + " ".join(parts)
    if rating_changed and new_rating is not None:
        return f"{head} → 综合{new_rating}"
    return f"{head}（评分待完善）"


@router.patch("/customers/{customer_id}/value-scores", response_model=CustomerItem)
def update_value_scores(
    customer_id: int,
    payload: ValueScoresUpdate,
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
    try:
        cust, _old, rating_changed = value_score_service.update_scores(
            db,
            customer_id,
            payload.model_dump(exclude_unset=True),
            user_id=user_id,
            commit=False,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if cust is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
        )
    summary = _summarize_value_scores(
        payload.model_dump(exclude_unset=True), rating_changed, cust.rating
    )
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=customer_id,
        action="update",
        actor_id=user_id,
        summary=summary,
    )
    db.commit()
    return customer_service.get_customer(db, customer_id)


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
    customer_service.delete_customer(db, customer_id, commit=False)
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=customer_id,
        action="delete",
        actor_id=user_id,
        summary=f"删除客户 {existing.name}",
    )
    db.commit()


@router.post("/customers/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer(
    payload: BatchTransferRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    customer_service.batch_transfer(db, payload.ids, payload.to_owner_id, commit=False)
    for cid in payload.ids:
        audit_service.record_log(
            db,
            entity_type="customer",
            entity_id=cid,
            action="transfer",
            actor_id=user_id,
            summary="指派负责人",
        )
    db.commit()


@router.post("/customers/batch-move-sea", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_to_sea(
    payload: BatchIdsRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    ids = filter_owned_ids(db, CrmCustomer, payload.ids, user_id, is_admin)
    customer_service.batch_move_to_sea(db, ids, commit=False)
    for cid in ids:
        audit_service.record_log(
            db,
            entity_type="customer",
            entity_id=cid,
            action="move_sea",
            actor_id=user_id,
            summary="释放至公海",
        )
    db.commit()


@router.post("/customers/{customer_id}/claim", response_model=CustomerItem)
def claim_from_sea(
    customer_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = customer_service.claim_from_sea(
        db, customer_id, user_id=user_id, commit=False
    )
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
    db.commit()
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
    contact = contact_service.create_contact(db, customer_id, payload, commit=False)
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
    db.commit()
    return contact


@router.patch("/contacts/{contact_id}", response_model=ContactItem)
def update_contact(
    contact_id: int,
    payload: ContactUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    contact, summary = contact_service.update_contact(
        db, contact_id, payload, commit=False
    )
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
    db.commit()
    return contact


@router.delete("/contacts/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_contact(
    contact_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    if not contact_service.delete_contact(db, contact_id, commit=False):
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
    db.commit()


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
    item = lead_service.create_lead(db, payload, user_id=user_id, commit=False)
    audit_service.record_log(
        db,
        entity_type="lead",
        entity_id=item.id,
        action="create",
        actor_id=user_id,
        summary="新建线索",
    )
    db.commit()
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
    item = lead_service.update_lead(db, lead_id, payload, commit=False)
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
    db.commit()
    return item


@router.post("/leads/batch-transfer", status_code=status.HTTP_204_NO_CONTENT)
def batch_transfer_leads(
    payload: BatchTransferRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    lead_service.batch_transfer(db, payload.ids, payload.to_owner_id, commit=False)
    for lid in payload.ids:
        audit_service.record_log(
            db,
            entity_type="lead",
            entity_id=lid,
            action="transfer",
            actor_id=user_id,
            summary="指派负责人",
        )
    db.commit()


@router.post("/leads/batch-move-pool", status_code=status.HTTP_204_NO_CONTENT)
def batch_move_leads_to_pool(
    payload: BatchIdsRequest,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    ids = filter_owned_ids(db, CrmLead, payload.ids, user_id, is_admin)
    lead_service.batch_move_to_pool(db, ids, commit=False)
    for lid in ids:
        audit_service.record_log(
            db,
            entity_type="lead",
            entity_id=lid,
            action="move_sea",
            actor_id=user_id,
            summary="释放至线索池",
        )
    db.commit()


@router.post("/leads/{lead_id}/claim", response_model=LeadItem)
def claim_lead_from_pool(
    lead_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
):
    item = lead_service.claim_from_pool(db, lead_id, user_id=user_id, commit=False)
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
    db.commit()
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
        resp = lead_service.convert_lead(
            db, lead_id, payload, user_id=user_id, commit=False
        )
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
    # P5-2: 补 customer create + contact create 留痕（让客户审计时间线有起点）。
    # P5-6a: service.convert_lead 改为 commit=False（仅 flush），端点统一 commit，
    # 使转化业务 + 3 条审计留痕原子化。按 customer_id 反查 primary contact id。
    customer_id = resp.customer.id
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=customer_id,
        action="create",
        actor_id=user_id,
        summary="新建客户",
    )
    primary_contact_id = db.execute(
        text(
            "select id from crm_contacts where customer_id = :cid and is_primary = true limit 1"
        ),
        {"cid": customer_id},
    ).scalar_one_or_none()
    if primary_contact_id is not None:
        audit_service.record_log(
            db,
            entity_type="contact",
            entity_id=int(primary_contact_id),
            action="create",
            actor_id=user_id,
            summary="新建联系人",
        )
    db.commit()
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
    entity_types: list[str] | None = Query(None),
    entity_ids: list[int] | None = Query(None),
    actor_id: str | None = Query(None),
    action: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """审计日志查询（仅管理员）。

    P5-9: 支持 entity_types + entity_ids 多值过滤（前端客户抽屉同时查
    客户审计 + 客户下所有联系人审计）。
    """
    require_admin(is_admin)
    items, total = audit_service.list_audit_logs(
        db,
        entity_type=entity_type,
        entity_id=entity_id,
        entity_types=entity_types,
        entity_ids=entity_ids,
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


# ---------- 漏斗指标（P8, BLF-517，仅管理员） ----------
@router.get("/dashboard/funnel", response_model=FunnelMetrics)
def get_funnel_metrics(
    dimension: Literal["owner", "source", "time"] = Query(
        ..., description="聚合维度：owner=按负责人 / source=按来源 / time=按月份"
    ),
    start_at: datetime | None = Query(
        None, description="时间范围起点（Asia/Shanghai，含）；按 entered_stage_at 计"
    ),
    end_at: datetime | None = Query(
        None, description="时间范围终点（Asia/Shanghai，不含）"
    ),
    owner_id: str | None = Query(None, description="只看某负责人"),
    source: str | None = Query(None, description="只看某来源"),
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """按 时间/角色/来源 聚合的漏斗数据（漏斗二层设计决策，BLF-517）。"""
    require_admin(is_admin)
    try:
        return dashboard_service.get_funnel_metrics(
            db,
            is_admin=is_admin,
            dimension=dimension,
            start_at=start_at,
            end_at=end_at,
            owner_id=owner_id,
            source=source,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/dashboard/funnel/stage/{stage}", response_model=StageDetail)
def get_funnel_stage_detail(
    stage: str,
    sort_by: Literal["dwell", "recent"] = Query(
        "dwell", description="dwell=按停留时长降序（默认）/ recent=按最后动作倒序"
    ),
    stuck_days: int = Query(7, ge=1, le=365, description="卡点阈值（天）"),
    start_at: datetime | None = Query(None),
    end_at: datetime | None = Query(None),
    owner_id: str | None = Query(None),
    source: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """某阶段的复盘明细（漏斗二层面板数据，BLF-517）。"""
    require_admin(is_admin)
    try:
        return dashboard_service.get_stage_detail(
            db,
            is_admin=is_admin,
            stage=stage,
            sort_by=sort_by,
            start_at=start_at,
            end_at=end_at,
            owner_id=owner_id,
            source=source,
            stuck_days=stuck_days,
            page=page,
            page_size=page_size,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------- 业绩看板（P8, BLF-519） ----------
@router.get("/dashboard/performance", response_model=PerformanceBoard)
def get_performance_board(
    scope: Literal["mine", "all"] = Query(
        "mine",
        description="mine=个人业绩（员工看自己，任何人可访问）；all=全局+排名表（仅管理员）",
    ),
    month: str | None = Query(
        None, description="YYYY-MM，缺省当前月（Asia/Shanghai 口径）"
    ),
    sort_by: Literal[
        "converted_count", "new_customers", "follow_count", "completion_rate"
    ] = Query(
        "converted_count",
        description="排名主键：转化数（默认）/新增客户/跟进数/完成率",
    ),
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """业绩看板：本月新增客户/转化数/跟进数/完成率 + 按人排名（BLF-519）。

    权限：scope=mine 员工看自己；scope=all 仅管理员（非 admin → 403）。
    """
    try:
        return dashboard_service.get_performance_board(
            db,
            user_id=user_id,
            is_admin=is_admin,
            scope=scope,
            month=month,
            sort_by=sort_by,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------- 生命周期看板（P8, BLF-520，仅管理员） ----------
@router.get("/dashboard/lifecycle", response_model=LifecycleBoard)
def get_lifecycle_board(
    db: Session = Depends(get_read_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """生命周期看板：客户从创建到 首次跟进/转化/流失 的时间分布（BLF-520）。

    仅管理员。三种分布（分桶直方图 + 均值/中位/P90）+ 当前公海客户数；
    前端渲染直方图 + 转化时间漏斗叠加。
    """
    require_admin(is_admin)
    return dashboard_service.get_lifecycle_board(db, is_admin=is_admin)


# ---------- Task (P7, BLF-510) ----------
@router.get("/tasks", response_model=TaskListResponse)
def list_tasks(
    scope: str = Query("mine"),
    type: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    priority: str | None = Query(None),
    owner_id: str | None = Query(None),
    customer_id: int | None = Query(None),
    lead_id: int | None = Query(None),
    sort_by: str = "due_date",
    sort_order: str = "asc",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """任务列表：scope=mine/all（非 admin 的 all 降级 mine）+ 筛选白名单 + 排序白名单。

    owner_id 筛选仅管理员可用（非 admin scope 已降级 mine，再按他人过滤会串权 → 403）。
    """
    if owner_id is not None and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="owner_id 筛选仅管理员可用"
        )
    filters = {
        "type": type,
        "status": status_filter,
        "priority": priority,
        "owner_id": owner_id,
        "customer_id": customer_id,
        "lead_id": lead_id,
    }
    try:
        items, total = task_service.list_tasks(
            db,
            user_id=user_id,
            scope=resolve_scope(scope, is_admin),
            filters=filters,
            sort_by=sort_by,
            sort_order=sort_order,
            page=page,
            page_size=page_size,
            is_admin=is_admin,
        )
    except ValueError as e:
        # 非白名单筛选/排序字段 → 400
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return TaskListResponse(items=items, total=total, page=page, page_size=page_size)


# ---------- Task 提醒 SSE（P7-4, BLF-513） ----------
# 轮询间隔：每 60s 查一次当前用户应提醒任务（每小时级低频事件，延迟可接受）
TASK_REMINDER_TICK_SECONDS = 60


def _fetch_user_reminders(user_id: str | None) -> list[dict]:
    """SSE 每 tick 的同步查询：当前用户应提醒且未过期的任务（独立 session，用完即关）。

    返回 [{task_id, title, due_date}]，供流式推送（数字员工 _build_tick_sync 同款模式）。
    """
    db = SessionLocal()
    try:
        rows = task_service.list_user_reminder_tasks(db, user_id=user_id)
        return [
            {
                "task_id": t.id,
                "title": t.title,
                "due_date": t.due_date.isoformat() if t.due_date else None,
            }
            for t in rows
        ]
    finally:
        db.close()


async def _task_reminder_stream(request: Request, user_id: str | None):
    """SSE 生成器：每 tick 在线程池查 DB，diff 后只推送新增的提醒，不阻塞事件循环。

    - 首次连接即推送当前全部应提醒任务（重放离线期错过的提醒）；
    - 之后仅推送新出现的 task_id（同一连接内不重复轰炸）；
    - keep-alive 注释行防代理超时；is_disconnected 断连退出。
    """
    pushed_ids: set[int] = set()
    while True:
        # 客户端断连 → 退出
        if await request.is_disconnected():
            break
        try:
            reminders = await asyncio.to_thread(_fetch_user_reminders, user_id)
            fresh = [r for r in reminders if r["task_id"] not in pushed_ids]
            for r in fresh:
                pushed_ids.add(r["task_id"])
                yield f"event: task_reminder\ndata: {json.dumps(r, ensure_ascii=False)}\n\n"
        except Exception:
            logger.exception("task reminder stream tick failed")
            # 发注释行保持连接，不断流
            yield ": tick-error\n\n"
        # keep-alive 注释行（防代理 60s 超时）
        yield ": keep-alive\n\n"
        await asyncio.sleep(TASK_REMINDER_TICK_SECONDS)


@router.get("/tasks/reminders/stream")
async def task_reminders_stream(
    request: Request,
    user_id: str | None = Depends(get_request_user_id),
):
    """任务到期提醒 SSE：event: task_reminder + {task_id, title, due_date}（登录态）。"""
    return StreamingResponse(
        _task_reminder_stream(request, user_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------- 7 天无跟进提醒 SSE（P9-1, BLF-539） ----------
# 轮询间隔：每 60s 查一次当前用户应提醒的 stale 客户/线索（每日级低频事件，延迟可接受）
FOLLOW_UP_REMINDER_TICK_SECONDS = 60


def _fetch_user_follow_up_reminders(user_id: str | None) -> list[dict]:
    """SSE 每 tick 的同步查询：当前用户应提醒的 stale 客户/线索（独立 session，用完即关）。

    返回 [{entity_type, entity_id, name, days}]，供流式推送（数字员工
    _build_tick_sync 同款模式）。days=实际未跟进天数。
    """
    from app.core.config import get_settings
    from app.services.crm.follow_up_reminder_service import (
        list_user_stale_reminders,
    )

    db = SessionLocal()
    try:
        return list_user_stale_reminders(
            db,
            user_id=user_id,
            days=get_settings().crm_follow_up_reminder_days,
        )
    finally:
        db.close()


async def _follow_up_reminder_stream(request: Request, user_id: str | None):
    """SSE 生成器：每 tick 在线程池查 DB，diff 后只推送新增提醒，不阻塞事件循环。

    - 首次连接即推送当前全部应提醒实体（重放离线期错过的提醒）；
    - 之后仅推送新出现的 (entity_type, entity_id)（同一连接内不重复轰炸）；
    - keep-alive 注释行防代理超时；is_disconnected 断连退出。
    """
    pushed_keys: set[tuple[str, int]] = set()
    while True:
        # 客户端断连 → 退出
        if await request.is_disconnected():
            break
        try:
            reminders = await asyncio.to_thread(
                _fetch_user_follow_up_reminders, user_id
            )
            fresh = [
                r
                for r in reminders
                if (r["entity_type"], r["entity_id"]) not in pushed_keys
            ]
            for r in fresh:
                pushed_keys.add((r["entity_type"], r["entity_id"]))
                yield (
                    f"event: follow_up_reminder\n"
                    f"data: {json.dumps(r, ensure_ascii=False)}\n\n"
                )
        except Exception:
            logger.exception("follow-up reminder stream tick failed")
            # 发注释行保持连接，不断流
            yield ": tick-error\n\n"
        # keep-alive 注释行（防代理 60s 超时）
        yield ": keep-alive\n\n"
        await asyncio.sleep(FOLLOW_UP_REMINDER_TICK_SECONDS)


@router.get("/follow-ups/reminders/stream")
async def follow_up_reminders_stream(
    request: Request,
    user_id: str | None = Depends(get_request_user_id),
):
    """7 天无跟进提醒 SSE：event: follow_up_reminder + {entity_type, entity_id, name, days}（登录态）。"""
    return StreamingResponse(
        _follow_up_reminder_stream(request, user_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/tasks", response_model=TaskItem, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """建任务；owner 默认=自己；admin 可指派他人；关联客户/线索须存在（404）。"""
    _validate_task_links(db, payload.customer_id, payload.lead_id)
    try:
        item = task_service.create_task(
            db, payload, user_id=user_id, is_admin=is_admin, commit=False
        )
    except HTTPException:
        raise
    audit_service.record_log(
        db,
        entity_type="task",
        entity_id=item.id,
        action="create",
        actor_id=user_id,
        summary=f"新建任务 {item.title}",
    )
    db.commit()
    return item


@router.get("/tasks/{task_id}", response_model=TaskItem)
def get_task(
    task_id: int,
    db: Session = Depends(get_read_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """任务详情（联查客户名/线索名/owner 名）；owner/admin 可见。"""
    task = task_service.get_task_orm(db, task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    require_owner_or_admin(task.owner_id, user_id, is_admin)
    return task_service.get_task(db, task_id)


@router.patch("/tasks/{task_id}", response_model=TaskItem)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """改 title/description/due_date/priority/type/customer_id/lead_id；
    owner_id 仅 admin 可改（非 admin 传 owner_id → 403）。
    """
    task = task_service.get_task_orm(db, task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    require_owner_or_admin(task.owner_id, user_id, is_admin)
    # 二选一校验按“合并后状态”算（未传字段沿用任务现有关联；显式 null 视为清除）
    data = payload.model_dump(exclude_unset=True)
    _validate_task_links(
        db,
        data.get("customer_id", task.customer_id),
        data.get("lead_id", task.lead_id),
    )
    # 先快照改前值（update_task 会原地改 ORM 对象），再调 service
    before = {k: getattr(task, k, None) for k in data}
    try:
        item = task_service.update_task(
            db, task, payload, user_id=user_id, commit=False, is_admin=is_admin
        )
    except HTTPException:
        raise
    summary = _summarize_task_update(before, payload)
    audit_service.record_log(
        db,
        entity_type="task",
        entity_id=task_id,
        action="update",
        actor_id=user_id,
        summary=summary or f"编辑任务 {task.title}",
    )
    db.commit()
    return item


@router.post("/tasks/{task_id}/status", response_model=TaskItem)
def set_task_status(
    task_id: int,
    payload: TaskStatusUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """看板拖拽流转：{status} ∈ pending/in_progress/done（done/cancelled 后不可再流转）。"""
    task = task_service.get_task_orm(db, task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    require_owner_or_admin(task.owner_id, user_id, is_admin)
    item = task_service.set_task_status(
        db, task, payload.status, user_id=user_id, commit=False
    )
    audit_service.record_log(
        db,
        entity_type="task",
        entity_id=task_id,
        action="status",
        actor_id=user_id,
        summary=f"状态变更: {task.title}",
    )
    db.commit()
    return item


@router.post("/tasks/{task_id}/complete", response_model=TaskItem)
def complete_task(
    task_id: int,
    payload: TaskCompleteRequest | None = None,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """完成任务：status→done + completed_at + §3.3 完成联动。

    §3.3 方案 A（用户已拍板）：互动类任务（follow_up/call/visit）完成时同一事务内
    自动生成 follow（type 映射 call→phone / visit→visit / follow_up→note，content=
    任务标题可带完成备注）+ 回写实体 last_follow_at=now + next_follow_at 设值/未填清空
    （完成表单可选「下次跟进时间」）。custom 类不联动（可手动补跟进）。
    """
    task = task_service.get_task_orm(db, task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    require_owner_or_admin(task.owner_id, user_id, is_admin)
    item = task_service.complete_task(
        db, task, user_id=user_id, payload=payload, commit=False
    )
    audit_service.record_log(
        db,
        entity_type="task",
        entity_id=task_id,
        action="complete",
        actor_id=user_id,
        summary=f"完成任务 {task.title}",
    )
    db.commit()
    return item


@router.post("/tasks/{task_id}/cancel", response_model=TaskItem)
def cancel_task(
    task_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """取消：status→cancelled。"""
    task = task_service.get_task_orm(db, task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    require_owner_or_admin(task.owner_id, user_id, is_admin)
    item = task_service.cancel_task(db, task, user_id=user_id, commit=False)
    audit_service.record_log(
        db,
        entity_type="task",
        entity_id=task_id,
        action="cancel",
        actor_id=user_id,
        summary=f"取消任务 {task.title}",
    )
    db.commit()
    return item


def _validate_task_links(
    db: Session, customer_id: int | None, lead_id: int | None
) -> None:
    """任务关联校验（设计文档 §6.2 / BLF-511）：

    - 同时关联客户与线索 → 400（业务上二选一；update 传合并后状态）。
    - 关联的客户/线索不存在 → 404。
    """
    if customer_id is not None and lead_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="任务只能关联客户或线索之一（二选一）",
        )
    if customer_id is not None:
        exists = db.execute(
            text("select 1 from crm_customers where id = :cid limit 1"),
            {"cid": customer_id},
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Customer not found"
            )
    if lead_id is not None:
        exists = db.execute(
            text("select 1 from crm_leads where id = :lid limit 1"),
            {"lid": lead_id},
        ).scalar_one_or_none()
        if exists is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Lead not found"
            )


def _summarize_task_update(before: dict, payload: TaskUpdate) -> str | None:
    """任务 update 中文变更摘要（只列有变化的字段）。before 为改前快照。"""
    labels = {
        "title": "标题",
        "description": "描述",
        "due_date": "截止",
        "priority": "优先级",
        "type": "类型",
        "owner_id": "负责人",
        "customer_id": "关联客户",
        "lead_id": "关联线索",
    }
    parts: list[str] = []
    for key, new in payload.model_dump(exclude_unset=True).items():
        old = before.get(key)
        if old == new:
            continue
        label = labels.get(key, key)
        parts.append(f"{label}: {_fmt_task_val(old)}→{_fmt_task_val(new)}")
    return "; ".join(parts) if parts else None


def _fmt_task_val(value) -> str:
    if value is None or value == "":
        return "空"
    return str(value)


def _summarize_rule_update(before: dict, payload: RuleUpdate) -> str | None:
    """规则 PATCH 变更摘要（P9-8）。仅列有变化的头字段；conditions/actions
    为子表整体重建，摘要里用「条件/动作已更新」表述。无变化返回 None。"""
    updates = payload.model_dump(exclude_unset=True)
    parts: list[str] = []
    if "conditions" in updates:
        parts.append("条件已更新")
    if "actions" in updates:
        parts.append("动作已更新")
    for key, new in updates.items():
        if key in ("conditions", "actions"):
            continue
        old = before.get(key)
        if old == new:
            continue
        label = RULE_FIELD_LABELS.get(key, key)
        parts.append(f"{label}: {_fmt_rule_val(old)}→{_fmt_rule_val(new)}")
    return "; ".join(parts) if parts else None


def _fmt_rule_val(value) -> str:
    if value is None or value == "":
        return "空"
    return str(value)


# ---------- 规则引擎 CRUD（P9-7b, BLF-561，仅管理员） ----------
@router.get("/rules", response_model=list[RuleItem])
def list_rules(
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    return [
        rule_crud_service.to_rule_item(db, r) for r in rule_crud_service.list_rules(db)
    ]


@router.post("/rules", response_model=RuleItem, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: RuleCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    try:
        rule = rule_crud_service.create_rule(db, payload, created_by=user_id)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e
    audit_service.record_log(
        db,
        entity_type="rule",
        entity_id=rule.id,
        action="create",
        actor_id=user_id,
        summary=f"新建规则「{rule.name}」",
    )
    db.commit()
    db.refresh(rule)
    return rule_crud_service.to_rule_item(db, rule)


@router.patch("/rules/{rule_id}", response_model=RuleItem)
def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    rule = rule_crud_service.get_rule(db, rule_id)
    if rule is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found"
        )
    before = {
        "name": rule.name,
        "description": rule.description,
        "entity_type": rule.entity_type,
        "event_type": rule.event_type,
        "enabled": rule.enabled,
        "priority": rule.priority,
    }
    try:
        rule = rule_crud_service.update_rule(db, rule, payload)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e
    summary = _summarize_rule_update(before, payload)
    audit_service.record_log(
        db,
        entity_type="rule",
        entity_id=rule_id,
        action="update",
        actor_id=user_id,
        summary=summary,
    )
    db.commit()
    db.refresh(rule)
    return rule_crud_service.to_rule_item(db, rule)


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(
    rule_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    rule = rule_crud_service.get_rule(db, rule_id)
    if rule is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found"
        )
    rule_crud_service.delete_rule(db, rule)
    audit_service.record_log(
        db,
        entity_type="rule",
        entity_id=rule_id,
        action="delete",
        actor_id=user_id,
        summary=f"删除规则「{rule.name}」",
    )
    db.commit()


# ---------- P9 工作流自动化设置（BLF-540） ----------
@router.get("/settings/workflow", response_model=WorkflowSettings)
def get_workflow_settings(
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """工作流自动化设置（7 天无跟进提醒邮件阈值/开关）。仅管理员。"""
    require_admin(is_admin)
    row = stale_email_service.get_workflow_settings(db)
    return WorkflowSettings(
        stale_days=row.stale_days, stale_email_enabled=row.stale_email_enabled
    )


@router.put("/settings/workflow", response_model=WorkflowSettings)
def update_workflow_settings(
    payload: WorkflowSettingsUpdate,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    """更新工作流自动化设置（部分更新）。仅管理员。"""
    require_admin(is_admin)
    row = stale_email_service.update_workflow_settings(
        db,
        stale_days=payload.stale_days,
        stale_email_enabled=payload.stale_email_enabled,
    )
    return WorkflowSettings(
        stale_days=row.stale_days, stale_email_enabled=row.stale_email_enabled
    )

# ---------- P6b 产品类目 ----------
@router.get("/categories", response_model=list[CategoryItem])
def list_categories(db: Session = Depends(get_read_db_session)):
    """列出全部产品类目（登录即可，供多选下拉）。"""
    return category_service.list_categories(db)


@router.post(
    "/categories", response_model=CategoryItem, status_code=status.HTTP_201_CREATED
)
def create_category(
    body: CategoryCreate,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    try:
        cat = category_service.create_category(
            db, body.name, sort_order=body.sort_order
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    audit_service.record_log(
        db,
        entity_type="category",
        entity_id=cat.id,
        action="create",
        summary=f"新建产品类目「{cat.name}」",
        actor_id=None,
        commit=True,
    )
    return cat


@router.patch("/categories/{category_id}", response_model=CategoryItem)
def update_category(
    category_id: int,
    body: CategoryUpdate,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    try:
        cat = category_service.update_category(
            db, category_id, name=body.name, sort_order=body.sort_order
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    if cat is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="类目不存在")
    audit_service.record_log(
        db,
        entity_type="category",
        entity_id=cat.id,
        action="update",
        summary=f"编辑产品类目「{cat.name}」",
        actor_id=None,
        commit=True,
    )
    return cat


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: int,
    db: Session = Depends(get_primary_db_session),
    is_admin: bool = Depends(get_request_is_admin),
):
    require_admin(is_admin)
    cat = category_service.delete_category(db, category_id)
    if cat is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="类目不存在")
    audit_service.record_log(
        db,
        entity_type="category",
        entity_id=cat.id,
        action="delete",
        summary=f"删除产品类目「{cat.name}」",
        actor_id=None,
        commit=True,
    )
    return None


@router.put("/customers/{customer_id}/categories", response_model=CustomerItem)
def set_customer_categories(
    customer_id: int,
    body: CustomerCategoriesUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: str | None = Depends(get_request_user_id),
    is_admin: bool = Depends(get_request_is_admin),
):
    """整体替换客户类目集（幂等去重）。owner/admin 可操作。"""
    existing = db.execute(
        text(
            "SELECT id, owner_id FROM crm_customers WHERE id = :id AND is_deleted = false"
        ),
        {"id": customer_id},
    ).first()
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="客户不存在")
    require_owner_or_admin(existing.owner_id, user_id, is_admin)
    try:
        _, diff, _cats = category_service.set_customer_categories(
            db, customer_id, body.category_ids, commit=False
        )
    except ValueError as e:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    parts: list[str] = []
    for name in diff["added"]:
        parts.append(f"+{name}")
    for name in diff["removed"]:
        parts.append(f"-{name}")
    summary = f"产品类目：{' '.join(parts)}" if parts else "产品类目：无变更"
    audit_service.record_log(
        db,
        entity_type="customer",
        entity_id=customer_id,
        action="update",
        summary=summary,
        actor_id=user_id,
        commit=False,
    )
    db.commit()
    item = customer_service.get_customer(db, customer_id)
