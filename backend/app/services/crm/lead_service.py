"""Lead domain service: CRUD + scope filter(mine/all/sea=线索池) + keyword + 池操作(transfer/move-pool/claim)."""
from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.crm import CrmLead
from app.schemas.crm import LeadCreate, LeadUpdate


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
        expected_amount=float(lead.expected_amount) if lead.expected_amount is not None else None,
        expected_close_date=lead.expected_close_date,
        remark=lead.remark,
        converted_to_customer_id=lead.converted_to_customer_id,
        converted_at=lead.converted_at,
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

    total = db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()

    sort_col = getattr(CrmLead, sort_by, CrmLead.updated_at)
    stmt = stmt.order_by(sort_col.desc() if sort_order == "desc" else sort_col.asc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = db.execute(stmt).scalars().all()

    owner_names = _owner_name_map(db, {r.owner_id for r in rows if r.owner_id})
    items = [_to_item(db, r, owner_names) for r in rows]
    return items, int(total)


def get_lead(db: Session, lead_id: int):
    lead = db.execute(
        select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))
    ).scalar_one_or_none()
    if lead is None:
        return None
    owner_names = _owner_name_map(db, {lead.owner_id} if lead.owner_id else set())
    return _to_item(db, lead, owner_names)


def create_lead(db: Session, payload: LeadCreate, *, user_id: str | None):
    cur = _current_user_id(user_id)
    lead = CrmLead(**payload.model_dump(exclude_unset=True), created_by=cur)
    if lead.owner_id is None and cur is not None:
        lead.owner_id = cur  # 默认归创建人
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def update_lead(db: Session, lead_id: int, payload: LeadUpdate):
    lead = db.execute(
        select(CrmLead).where(CrmLead.id == lead_id, CrmLead.is_deleted.is_(False))
    ).scalar_one_or_none()
    if lead is None:
        return None
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(lead, key, value)
    db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)


def batch_transfer(db: Session, ids: list[int], to_owner_id: str) -> int:
    rows = db.execute(
        select(CrmLead).where(CrmLead.id.in_(ids), CrmLead.is_deleted.is_(False))
    ).scalars().all()
    for lead in rows:
        lead.owner_id = to_owner_id
    db.commit()
    return len(rows)


def batch_move_to_pool(db: Session, ids: list[int]) -> int:
    rows = db.execute(
        select(CrmLead).where(CrmLead.id.in_(ids), CrmLead.is_deleted.is_(False))
    ).scalars().all()
    for lead in rows:
        lead.owner_id = None
    db.commit()
    return len(rows)


def claim_from_pool(db: Session, lead_id: int, *, user_id: str | None):
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
    db.commit()
    db.refresh(lead)
    return get_lead(db, lead.id)
