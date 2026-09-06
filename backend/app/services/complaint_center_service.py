"""客诉中心服务层（BLF-981）：批量 upsert + 查询。对齐 inventory/shipments project_id + country 模式。"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck
from app.models.project import Project
from app.schemas.complaint_center import (
    ComplaintIn,
    ComplaintPatchRequest,
    ComplaintRunBatchRequest,
    ShopCheckIn,
    SlaInfo,
    Triage,
)

# ── 状态机 ──────────────────────────────────────────────────────

COMPLAINT_STATUS_ORDER = (
    'pending',
    'drafted',
    'replied',
    'resolved',
    'closed_no_response',
)

SLA_SOON_THRESHOLD_HOURS = 24


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


def _find_complaint_natural(db: Session, project_id: int, country: str, buyer_name: str, message_date: date, subject: str) -> Complaint | None:
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
    """把 ComplaintIn 转为 ORM 构造字典。"""
    order_info = None
    if c.order is not None:
        order_info = c.order.model_dump(exclude_none=False, mode='json')
    sla_dump = None
    if c.sla is not None:
        sla_dump = c.sla.model_dump(exclude_none=True, mode='json')
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
    }


# ── 批量写入（一个事务收全家）──────────────────────────────────

def upsert_batch(db: Session, body: ComplaintRunBatchRequest, agent_id: str | None) -> ComplaintRun:
    """批量 upsert：run + shop_checks + complaints，一个事务。

    幂等：同一天 run_date 重复提交 → 更新原 run；shop_check 按 (run_id, project_id, country) upsert；
    complaint 按自然键 (project_id, country, buyer_name, message_date, subject) upsert。
    """
    run = get_run_by_date(db, body.run_date)
    if run is None:
        run = ComplaintRun(run_date=body.run_date)
        db.add(run)
        db.flush()
    # 更新 run 头信息（无论新旧都覆盖，保持最新快照）
    run.trigger = body.trigger
    run.shops_total = body.shops_total
    run.shops_checked = body.shops_checked
    run.shops_failed = body.shops_failed
    run.summary = body.summary.model_dump(mode='json')
    run.agent_id = agent_id
    db.flush()

    # shop_checks
    for sc in body.shop_checks:
        existing = _find_shop_check(db, run.id, sc.project_id, sc.country)
        if existing is None:
            existing = ShopCheck(run_id=run.id, project_id=sc.project_id, country=sc.country)
            db.add(existing)
        existing.check_status = sc.check_status
        existing.error_message = sc.error_message
        existing.metrics = sc.metrics.model_dump(mode='json')
    db.flush()

    # complaints
    for c in body.complaints:
        existing = _find_complaint_natural(db, c.project_id, c.country, c.buyer_name, c.message_date, c.subject)
        if existing is None:
            db.add(Complaint(**_build_complaint_in(c, run.id)))
        else:
            # 更新消息内容 / 分类 / SLA（不覆盖 status 与 handler_note — 人工流转不可被 Agent 覆写）
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
    """PATCH：状态机单向流转 + 字段更新。"""
    new_status = patch.status
    if new_status is not None and new_status != complaint.status:
        if not can_transition(complaint.status, new_status):
            raise StatusTransitionError(complaint.status, new_status)
        # 追加状态历史
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
        if isinstance(deadline_raw, str):
            deadline = datetime.fromisoformat(deadline_raw)
        else:
            deadline = deadline_raw
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

    # 当日店铺行
    shop_rows = db.execute(
        select(ShopCheck).where(ShopCheck.run_id == run.id).order_by(ShopCheck.project_id)
    ).scalars().all()

    # 当日 complaint（按 project_id 聚合）
    complaints = db.execute(
        select(Complaint).where(Complaint.run_id == run.id)
    ).scalars().all()

    from collections import defaultdict
    project_complaints: dict[tuple[int, str], list[Complaint]] = defaultdict(list)
    for c in complaints:
        project_complaints[(c.project_id, c.country)].append(c)

    total_needs_reply = 0
    total_reported_unresolved = 0
    total_resolved = 0
    sla_due_soon = 0
    sla_overdue = 0

    projects_payload = []
    for sc in shop_rows:
        if country and sc.country != country:
            continue
        key = (sc.project_id, sc.country)
        pc_list = project_complaints.get(key, [])
        needs = 0
        resolved = 0
        soon = 0
        overdue = 0
        for c in pc_list:
            lvl = _sla_level(c.status, c.sla)
            if c.status in ('replied', 'resolved', 'closed_no_response'):
                resolved += 1
            else:
                needs += 1
                if lvl == 'due_soon':
                    soon += 1
                elif lvl == 'overdue':
                    overdue += 1
        total_needs_reply += needs
        total_resolved += resolved
        sla_due_soon += soon
        sla_overdue += overdue
        # metrics from shop_check 优先，兜底用聚合
        metrics = sc.metrics or {}
        total_reported_unresolved += metrics.get('reported_unresolved', 0)
        # 获取 project name
        project = db.get(Project, sc.project_id)
        project_name = project.project_name if project else f'#{sc.project_id}'
        projects_payload.append({
            'project_id': sc.project_id,
            'project_name': project_name,
            'country': sc.country,
            'check_status': sc.check_status,
            'needs_reply': needs,
            'resolved': resolved,
            'sla_due_soon': soon,
            'sla_overdue': overdue,
        })

    # 近 30 天趋势（每个 run 的 summary.total_needs_reply）
    trend_start = target_date - timedelta(days=29)
    runs_30 = db.execute(
        select(ComplaintRun).where(ComplaintRun.run_date >= trend_start, ComplaintRun.run_date <= target_date).order_by(ComplaintRun.run_date)
    ).scalars().all()
    trend_map = {r.run_date: (r.summary or {}).get('total_needs_reply', 0) for r in runs_30}
    trend = [
        {'date': trend_start + timedelta(days=i), 'needs_reply': trend_map.get(trend_start + timedelta(days=i), 0)}
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

def fetch_complaints(
    db: Session,
    *,
    run_date: date | None = None,
    project_id: int | None = None,
    category: str | None = None,
    status_filter: str | None = None,
    country: str | None = None,
    keyword: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[Complaint], int]:
    stmt = select(Complaint)
    count_stmt = select(func.count(Complaint.id))
    filters = []
    if run_date is not None:
        run = get_run_by_date(db, run_date)
        if run is None:
            return [], 0
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
    if filters:
        stmt = stmt.where(*filters)
        count_stmt = count_stmt.where(*filters)
    total = db.execute(count_stmt).scalar_one()
    # 排序：pending 优先，SLA 最近到期在前
    stmt = stmt.order_by(
        # pending 优先：CASE WHEN status='pending' THEN 0 ELSE 1
        func.case({ 'pending': 0 }, value=Complaint.status, else_=1),
        Complaint.message_date.desc(),
    ).offset(offset).limit(limit)
    items = list(db.execute(stmt).scalars().all())
    return items, total


def get_complaint_by_id(db: Session, complaint_id: int) -> Complaint | None:
    return db.get(Complaint, complaint_id)
