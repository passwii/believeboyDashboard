"""客诉中心服务层（BLF-981）：批量 upsert + 查询。对齐 inventory/shipments project_id + country 模式。"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import case as sql_case, false as sql_false, func, select
from sqlalchemy.orm import Session

from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck
from app.models.project import Project
from app.schemas.complaint_center import ComplaintIn, ComplaintPatchRequest, ComplaintRunBatchRequest


COMPLAINT_STATUS_ORDER = (
    'pending',
    'drafted',
    'replied',
    'resolved',
    'closed_no_response',
)
SLA_SOON_THRESHOLD_HOURS = 24
ComplaintSort = Literal['sla_asc', 'sla_desc', 'date_asc', 'date_desc']


def _status_index(status: str) -> int:
    try:
        return COMPLAINT_STATUS_ORDER.index(status)
    except ValueError:
        return -1


def can_transition(from_status: str, to_status: str) -> bool:
    """单向流转：只能向前（index 变大），不可回退。"""
    return _status_index(to_status) >= _status_index(from_status)


# ── 查询 helper ─────────────────────────────────────────────────

def get_run_by_date(db: Session, run_date: date) -> ComplaintRun | None:
    return db.execute(
        select(ComplaintRun).where(ComplaintRun.run_date == run_date)
    ).scalar_one_or_none()


def _find_shop_check(db: Session, run_id: int, project_id: int, country: str) -> ShopCheck | None:
    return db.execute(
        select(ShopCheck).where(
            ShopCheck.run_id == run_id,
            ShopCheck.project_id == project_id,
            ShopCheck.country == country,
        )
    ).scalar_one_or_none()

def _find_complaint_natural(
    db: Session,
    project_id: int,
    country: str,
    buyer_name: str,
    message_date: date,
    subject: str,
) -> Complaint | None:
    return db.execute(
        select(Complaint).where(
            Complaint.project_id == project_id,
            Complaint.country == country,
            Complaint.buyer_name == buyer_name,
            Complaint.message_date == message_date,
            Complaint.subject == subject,
        )
    ).scalar_one_or_none()

def _build_complaint_in(c: ComplaintIn, run_id: int) -> dict:
    order_info = c.order.model_dump(exclude_none=False, mode='json') if c.order is not None else None
    sla_dump = c.sla.model_dump(exclude_none=True, mode='json') if c.sla is not None else None
    return {
        'run_id': run_id,
        'project_id': c.project_id,
        'country': c.country,
        'buyer_name': c.buyer_name,
        'message_date': c.message_date,
        'subject': c.subject,
        'message_body': c.message_body,
        'triage': c.triage.model_dump(mode='json'),
        'category': c.triage.category,
        'has_order': c.triage.has_order,
        'order_info': order_info,
        'sla': sla_dump,
        'status': 'pending',
        'status_history': [],
        'first_message_date': c.first_message_date,
        'message_count': c.message_count,
        'messages': [c.model_dump(mode='json')],
    }


# ── 批量写入（一个事务收全家）──────────────────────────────────

def upsert_batch(db: Session, body: ComplaintRunBatchRequest, agent_id: str | None) -> ComplaintRun:
    """批量 upsert：run + shop_checks + complaints，一个事务。"""
    run = get_run_by_date(db, body.run_date)
    if run is None:
        run = ComplaintRun(run_date=body.run_date)
        db.add(run)
        db.flush()
    run.trigger = body.trigger
    run.shops_total = body.shops_total
    run.shops_checked = body.shops_checked
    run.shops_failed = body.shops_failed
    run.summary = body.summary.model_dump(mode='json')
    run.agent_id = agent_id
    db.flush()

    for sc in body.shop_checks:
        existing = _find_shop_check(db, run.id, sc.project_id, sc.country)
        if existing is None:
            existing = ShopCheck(run_id=run.id, project_id=sc.project_id, country=sc.country)
            db.add(existing)
        existing.check_status = sc.check_status
        existing.error_message = sc.error_message
        existing.metrics = sc.metrics.model_dump(mode='json')
    db.flush()

    for c in body.complaints:
        existing = _find_complaint_natural(db, c.project_id, c.country, c.buyer_name, c.message_date, c.subject)
        if existing is None:
            db.add(Complaint(**_build_complaint_in(c, run.id)))
        else:
            existing.message_body = c.message_body
            existing.triage = c.triage.model_dump(mode='json')
            existing.category = c.triage.category
            existing.has_order = c.triage.has_order
            if c.order is not None:
                existing.order_info = c.order.model_dump(exclude_none=False, mode='json')
            if c.sla is not None:
                existing.sla = c.sla.model_dump(exclude_none=True, mode='json')
            existing.run_id = run.id
            existing.country = c.country
            existing.messages = (existing.messages or []) + [c.model_dump(mode='json')]
            existing.message_count = (existing.message_count or 1) + 1
    db.flush()
    return run


# ── 状态流转 ────────────────────────────────────────────────────

class StatusTransitionError(Exception):
    def __init__(self, from_status: str, to_status: str) -> None:
        super().__init__(f"非法状态流转：{from_status} → {to_status}")
        self.from_status = from_status
        self.to_status = to_status


def patch_complaint(
    db: Session,
    complaint: Complaint,
    patch: ComplaintPatchRequest,
    operator: str | None,
) -> Complaint:
    new_status = patch.status
    if new_status is not None and new_status != complaint.status:
        if not can_transition(complaint.status, new_status):
            raise StatusTransitionError(complaint.status, new_status)
        complaint.status_history = list(complaint.status_history or []) + [
            {
                'from': complaint.status,
                'to': new_status,
                'at': datetime.now(timezone.utc).isoformat(),
                'by': operator or 'unknown',
            }
        ]
        complaint.status = new_status
    if patch.draft_path is not None:
        complaint.draft_path = patch.draft_path
    if patch.reply_sent_at is not None:
        complaint.reply_sent_at = patch.reply_sent_at
    if patch.handler_note is not None:
        complaint.handler_note = patch.handler_note
    db.flush()
    return complaint


# ── 概览 ────────────────────────────────────────────────────────

def _sla_level(status: str, sla: dict | None) -> str:
    if status in ('replied', 'resolved', 'closed_no_response'):
        return 'closed'
    if not sla:
        return 'ok'
    deadline_raw = sla.get('reply_deadline')
    if not deadline_raw:
        return 'ok'
    try:
        deadline = datetime.fromisoformat(deadline_raw) if isinstance(deadline_raw, str) else deadline_raw
    except (TypeError, ValueError):
        return 'ok'
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if deadline <= now:
        return 'overdue'
    if (deadline - now) < timedelta(hours=SLA_SOON_THRESHOLD_HOURS):
        return 'due_soon'
    return 'ok'


def fetch_overview(db: Session, target_date: date, country: str | None = None) -> dict:
    run = get_run_by_date(db, target_date)
    if run is None:
        return {
            'date': target_date,
            'run': None,
            'metrics': {
                'total_needs_reply': 0,
                'total_reported_unresolved': 0,
                'total_resolved': 0,
                'sla_due_soon': 0,
                'sla_overdue': 0,
            },
            'trend': [],
            'projects': [],
        }

    shop_rows = db.execute(
        select(ShopCheck).where(ShopCheck.run_id == run.id).order_by(ShopCheck.project_id)
    ).scalars().all()
    complaints = db.execute(select(Complaint).where(Complaint.run_id == run.id)).scalars().all()
    project_complaints: dict[tuple[int, str], list[Complaint]] = defaultdict(list)
    for complaint in complaints:
        project_complaints[(complaint.project_id, complaint.country)].append(complaint)

    total_needs_reply = 0
    total_reported_unresolved = 0
    total_resolved = 0
    sla_due_soon = 0
    sla_overdue = 0
    projects_payload = []
    for shop_check in shop_rows:
        if country and shop_check.country != country:
            continue
        needs = 0
        resolved = 0
        soon = 0
        overdue = 0
        for complaint in project_complaints.get((shop_check.project_id, shop_check.country), []):
            level = _sla_level(complaint.status, complaint.sla)
            if complaint.status in ('replied', 'resolved', 'closed_no_response'):
                resolved += 1
            else:
                needs += 1
                soon += level == 'due_soon'
                overdue += level == 'overdue'
        total_needs_reply += needs
        total_resolved += resolved
        sla_due_soon += soon
        sla_overdue += overdue
        metrics = shop_check.metrics or {}
        total_reported_unresolved += metrics.get('reported_unresolved', 0)
        project = db.get(Project, shop_check.project_id)
        projects_payload.append({
            'project_id': shop_check.project_id,
            'project_name': project.project_name if project else f'#{shop_check.project_id}',
            'country': shop_check.country,
            'check_status': shop_check.check_status,
            'needs_reply': needs,
            'resolved': resolved,
            'sla_due_soon': soon,
            'sla_overdue': overdue,
        })

    trend_start = target_date - timedelta(days=29)
    runs_30 = db.execute(
        select(ComplaintRun).where(
            ComplaintRun.run_date >= trend_start,
            ComplaintRun.run_date <= target_date,
        ).order_by(ComplaintRun.run_date)
    ).scalars().all()
    trend_map = {run.run_date: (run.summary or {}).get('total_needs_reply', 0) for run in runs_30}
    trend = [
        {
            'date': trend_start + timedelta(days=i),
            'needs_reply': trend_map.get(trend_start + timedelta(days=i), 0),
        }
        for i in range(30)
    ]

    return {
        'date': target_date,
        'run': run,
        'metrics': {
            'total_needs_reply': total_needs_reply,
            'total_reported_unresolved': total_reported_unresolved,
            'total_resolved': total_resolved,
            'sla_due_soon': sla_due_soon,
            'sla_overdue': sla_overdue,
        },
        'trend': trend,
        'projects': projects_payload,
    }


# ── 列表查询 ────────────────────────────────────────────────────

def _complaint_query(
    db: Session,
    *,
    run_date: date | None,
    project_id: int | None,
    category: str | None,
    status_filter: str | None,
    country: str | None,
    keyword: str | None,
):
    stmt = select(Complaint, Project.project_name).join(Project, Complaint.project_id == Project.id)
    filters = []
    if run_date is not None:
        run = get_run_by_date(db, run_date)
        if run is None:
            return stmt.where(sql_false()), [sql_false()]
        filters.append(Complaint.run_id == run.id)
    if project_id is not None:
        filters.append(Complaint.project_id == project_id)
    if country is not None:
        filters.append(Complaint.country == country)
    if category is not None:
        filters.append(Complaint.category == category)
    if status_filter is not None:
        filters.append(Complaint.status == status_filter)
    if keyword:
        kw = f'%{keyword}%'
        filters.append(
            (Complaint.buyer_name.ilike(kw))
            | (Complaint.subject.ilike(kw))
            | (Complaint.message_body.ilike(kw))
        )
    return stmt.where(*filters), filters


def _sla_sort_key():
    return Complaint.sla['reply_deadline'].as_string()


def fetch_complaints(
    db: Session,
    *,
    run_date: date | None = None,
    project_id: int | None = None,
    category: str | None = None,
    status_filter: str | None = None,
    country: str | None = None,
    keyword: str | None = None,
    first_message_date: date | None = None,
    sort: ComplaintSort | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[Complaint], int]:
    stmt, filters = _complaint_query(
        db,
        run_date=run_date,
        project_id=project_id,
        category=category,
        status_filter=status_filter,
        country=country,
        keyword=keyword,
    )
    if first_message_date is not None:
        first_date_filter = Complaint.first_message_date == first_message_date
        filters.append(first_date_filter)
        stmt = stmt.where(first_date_filter)
    total = db.execute(select(func.count(Complaint.id)).where(*filters)).scalar_one()

    if sort is None:
        stmt = stmt.order_by(
            sql_case((Complaint.status == 'pending', 0), else_=1),
            Complaint.message_date.desc(),
            Complaint.id.asc(),
        )
    elif sort == 'sla_asc':
        stmt = stmt.order_by(_sla_sort_key().asc().nulls_last(), Complaint.id.asc())
    elif sort == 'sla_desc':
        stmt = stmt.order_by(_sla_sort_key().desc().nulls_last(), Complaint.id.asc())
    elif sort == 'date_asc':
        stmt = stmt.order_by(Complaint.message_date.asc(), Complaint.id.asc())
    elif sort == 'date_desc':
        stmt = stmt.order_by(Complaint.message_date.desc(), Complaint.id.asc())
    else:
        raise ValueError(f'不支持的客诉排序：{sort}')

    rows = db.execute(stmt.offset(offset).limit(limit)).all()
    items: list[Complaint] = []
    for complaint, project_name in rows:
        complaint.project_name = project_name
        items.append(complaint)
    return items, total


def count_spam_complaints(
    db: Session,
    *,
    run_date: date | None = None,
    project_id: int | None = None,
    country: str | None = None,
) -> int:
    filters = [Complaint.category == 'spam']
    if run_date is not None:
        run = get_run_by_date(db, run_date)
        if run is None:
            return 0
        filters.append(Complaint.run_id == run.id)
    if project_id is not None:
        filters.append(Complaint.project_id == project_id)
    if country is not None:
        filters.append(Complaint.country == country)
    return db.execute(select(func.count(Complaint.id)).where(*filters)).scalar_one()


def get_complaint_by_id(db: Session, complaint_id: int) -> Complaint | None:
    row = db.execute(
        select(Complaint, Project.project_name)
        .join(Project, Complaint.project_id == Project.id)
        .where(Complaint.id == complaint_id)
    ).first()
    if row is None:
        return None
    complaint, project_name = row
    complaint.project_name = project_name
    return complaint
