"""Lead domain service: CRUD + scope filter(mine/all/sea=线索池) + keyword + 池操作(transfer/move-pool/claim)."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.models.crm import CrmContact, CrmCustomer, CrmFollow, CrmLead
from app.schemas.crm import (
    ConvertLeadRequest,
    ConvertLeadResponse,
    LeadCreate,
    LeadUpdate,
)
from app.services.user_display import resolve_display_names


class LeadAlreadyConverted(Exception):
    """线索已转化过，不能重复转化。"""


def _apply_status_change(lead: CrmLead, new_status: str) -> None:
    """P8 (BLF-517, 决策 #5)：状态变更统一写入点。

    - 只有 status 真的变化时才重记 entered_stage_at（同一状态重复写入不更新）；
    - 所有改变 CrmLead.status 的路径（update_lead / convert_lead）收敛到这里。
    """
    if new_status != lead.status:
        lead.status = new_status
        lead.entered_stage_at = datetime.now(timezone.utc)


def _current_user_id(user_id: str | None) -> str | None:
    if user_id is None:
        return None
    uid = user_id.strip()
    return uid or None


def _to_item(db: Session, lead: CrmLead, owner_names: dict[str, str]):
    from app.schemas.crm import LeadItem

    return LeadItem(
        id=lead.id,
        name=lead.name,
        company=lead.company,
        phone=lead.phone,
        email=lead.email,
        wechat=lead.wechat,
        source=lead.source,
        status=lead.status,
        intent=lead.intent,
        customer_type=lead.customer_type,
        interested_service=lead.interested_service,
        owner_id=lead.owner_id,
        owner_name=owner_names.get(lead.owner_id) if lead.owner_id else None,
        expected_amount=float(lead.expected_amount)
        if lead.expected_amount is not None
        else None,
        expected_close_date=lead.expected_close_date,
        remark=lead.remark,
        next_follow_at=lead.next_follow_at,
        converted_to_customer_id=lead.converted_to_customer_id,
        converted_at=lead.converted_at,
        entered_stage_at=lead.entered_stage_at,
        created_by=lead.created_by,
        created_at=lead.created_at,
        updated_at=lead.updated_at,
    )


def list_leads(
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
) -> tuple[list, int]:
    cur = _current_user_id(user_id)
    stmt = select(CrmLead).where(CrmLead.is_deleted.is_(False))

    if scope == "mine" and cur is not None:
        stmt = stmt.where(CrmLead.owner_id == cur)
    elif scope == "sea":
        stmt = stmt.where(CrmLead.owner_id.is_(None))  # 线索池 = 无负责人
    # scope == "all": 不加 owner 过滤（权限层在任务 6b 按角色收紧）

    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(or_(CrmLead.name.ilike(like), CrmLead.company.ilike(like)))

    # 高级筛选（P4）：白名单字段 → where；非法字段/运算符由 filter_engine 抛 ValueError/TypeError。
    if filters:
        from app.services.crm.filter_engine import LEAD_FILTER_FIELDS, apply_filters

        stmt = apply_filters(stmt, CrmLead, filters, LEAD_FILTER_FIELDS)

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()

    sort_col = getattr(CrmLead, sort_by, CrmLead.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()

    owner_names = resolve_display_names(db, {r.owner_id for r in rows if r.owner_id})
    items = [_to_item(db, r, owner_names) for r in rows]
    return items, int(total)


def get_lead(db: Session, lead_id: int):
    lead = db.execute(
        select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))
    ).scalar_one_or_none()
    if lead is None:
        return None
    owner_names = resolve_display_names(
        db, {lead.owner_id} if lead.owner_id else set()
    )
    return _to_item(db, lead, owner_names)


def create_lead(
    db: Session, payload: LeadCreate, *, user_id: str | None, commit: bool = True
):
    cur = _current_user_id(user_id)
    lead = CrmLead(**payload.model_dump(exclude_unset=True), created_by=cur)
    if lead.owner_id is None and cur is not None:
        lead.owner_id = cur  # 默认归创建人
    # P8 (BLF-517): 创建即进入当前状态（默认 new），记录进入时间
    lead.entered_stage_at = datetime.now(timezone.utc)
    db.add(lead)
    db.flush()
    if commit:
        db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def update_lead(db: Session, lead_id: int, payload: LeadUpdate, *, commit: bool = True):
    lead = db.execute(
        select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))
    ).scalar_one_or_none()
    if lead is None:
        return None
    updates = payload.model_dump(exclude_unset=True)
    status = updates.pop("status", None)
    if status is not None:
        _apply_status_change(lead, status)
    for key, value in updates.items():
        setattr(lead, key, value)
    db.flush()
    if commit:
        db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def batch_transfer(
    db: Session, ids: list[int], to_owner_id: str, *, commit: bool = True
) -> int:
    rows = (
        db.execute(
            select(CrmLead).where(CrmLead.id.in_(ids), CrmLead.is_deleted.is_(False))
        )
        .scalars()
        .all()
    )
    for lead in rows:
        lead.owner_id = to_owner_id
    db.flush()
    if commit:
        db.commit()
    return len(rows)


def batch_move_to_pool(db: Session, ids: list[int], *, commit: bool = True) -> int:
    rows = (
        db.execute(
            select(CrmLead).where(CrmLead.id.in_(ids), CrmLead.is_deleted.is_(False))
        )
        .scalars()
        .all()
    )
    for lead in rows:
        lead.owner_id = None
    db.flush()
    if commit:
        db.commit()
    return len(rows)


def claim_from_pool(
    db: Session, lead_id: int, *, user_id: str | None, commit: bool = True
):
    cur = _current_user_id(user_id)
    if cur is None:
        return None
    lead = db.execute(
        select(CrmLead).where(
            CrmLead.id == lead_id,
            CrmLead.is_deleted.is_(False),
            CrmLead.owner_id.is_(None),
        )
    ).scalar_one_or_none()
    if lead is None:
        return None  # 不在线索池或不存在
    lead.owner_id = cur
    db.flush()
    if commit:
        db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def convert_lead(
    db: Session,
    lead_id: int,
    payload: ConvertLeadRequest | None = None,
    *,
    user_id: str | None,
    commit: bool = True,
) -> ConvertLeadResponse | None:
    """线索转客户（单事务，原子）：

    1. 建客户：name 取 override.name 或 lead.company 或 lead.name；customer_type/
       interested_service/source 带过去；rating 默认 C；owner=lead.owner；created_by=当前用户。
    2. 建主联系人：name/phone/email/wechat 来自线索，is_primary=True。
    3. re-parent 跟进：该线索的 crm_follows 改挂到新客户（entity_type lead→customer）。
    4. 标记线索 converted：status/converted_to_customer_id/converted_at。

    线索不存在返回 None；已转化抛 LeadAlreadyConverted。任一步失败整体回滚（单次 commit）。
    """
    from app.services.crm.customer_service import get_customer

    lead = db.execute(
        select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))
    ).scalar_one_or_none()
    if lead is None:
        return None
    if lead.converted_to_customer_id is not None:
        raise LeadAlreadyConverted(f"lead {lead_id} already converted")

    ov = payload.model_dump(exclude_unset=True) if payload else {}
    cur = _current_user_id(user_id)

    cust = CrmCustomer(
        name=ov.get("name") or lead.company or lead.name,
        customer_type=lead.customer_type,
        interested_service=lead.interested_service,
        source=ov.get("source") or lead.source,
        rating=ov.get("rating") or "C",
        status="active",
        owner_id=lead.owner_id,
        remark=ov.get("remark") or lead.remark,
        created_by=cur,
    )
    db.add(cust)
    db.flush()  # 拿 cust.id

    contact = CrmContact(
        customer_id=cust.id,
        name=lead.name,
        phone=lead.phone,
        email=lead.email,
        wechat=lead.wechat,
        is_primary=True,
    )
    db.add(contact)

    # 跟进搬迁：lead → customer
    db.execute(
        update(CrmFollow)
        .where(CrmFollow.entity_type == "lead", CrmFollow.entity_id == lead.id)
        .values(entity_type="customer", entity_id=cust.id)
    )

    # 标记线索已转化
    _apply_status_change(lead, "converted")
    lead.converted_to_customer_id = cust.id
    lead.converted_at = datetime.now(timezone.utc)

    db.flush()
    if commit:
        db.commit()

    return ConvertLeadResponse(
        lead=get_lead(db, lead.id), customer=get_customer(db, cust.id)
    )
