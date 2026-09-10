"""客诉中心服务层（BLF-981）：批量 upsert + 查询。对齐 inventory/shipments project_id + country 模式。"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import case as sql_case, false as sql_false, func, select
from sqlalchemy.orm import Session

from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck
from app.models.project import Project
from app.models.project_shop import ProjectShop
from app.schemas.complaint_center import (
    IDENTITY_SOURCE,
    ComplaintIn,
    ComplaintPatchRequest,
    ComplaintRunBatchRequest,
    ShopCheckIn,
)
from app.utils.country import normalize_country


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
            ShopCheck.country == _normalize_country(country),
        )
    ).scalar_one_or_none()

def _normalize_country(value: str) -> str:
    """Use the warehouse canonical country (notably GB → UK)."""
    return normalize_country(value)


def _normalize_country_filter(value: str | None) -> str | None:
    if value is None:
        return None
    return _normalize_country(value)


def _message_identity(message: dict) -> tuple[str, str, str]:
    """Identify one buyer-authored message inside a conversation history."""
    message_date = message.get('message_date')
    if isinstance(message_date, (date, datetime)):
        message_date_text = message_date.isoformat()
    else:
        message_date_text = str(message_date)
    return (message_date_text, str(message.get('subject')), str(message.get('message_body')))


def _upsert_conversation_message(existing: Complaint, incoming: dict) -> None:
    """Merge one message snapshot without counting an exact replay twice."""
    messages = list(existing.messages or [])
    identity = _message_identity(incoming)
    for index, stored in enumerate(messages):
        if isinstance(stored, dict) and _message_identity(stored) == identity:
            messages[index] = incoming
            break
    else:
        messages.append(incoming)
    existing.messages = messages
    existing.message_count = len(messages)


def _find_complaint_conversation(
    db: Session,
    project_id: int,
    country: str,
    buyer_name: str,
    first_message_date: date,
) -> Complaint | None:
    """按对话级别自然键查找：(project_id, country, buyer_name, first_message_date)。"""
    return db.execute(
        select(Complaint).where(
            Complaint.project_id == project_id,
            Complaint.country == _normalize_country(country),
            Complaint.buyer_name == buyer_name,
            Complaint.first_message_date == first_message_date,
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


# ── 身份核验门禁（BLF-1022）──────────────────────────────────────
#
# 事务一致性选择：整批拒绝。任一 shop_check 身份校验失败，或任一 complaint
# 归属的 (project_id, country) 在本批次没有 ok && verified=true 的 shop_check，
# 整个 batch 返回 422 且不落库（调用方修正后整批重试，幂等语义不受影响）。
#
# 分层：service 只抛 IdentityGateError（code 即 agent ErrorCode 名），
# endpoint 的 _service_errors 负责翻译成 AgentApiError（services 不依赖 api 层）。

class IdentityGateError(Exception):
    """W1 身份门禁拒绝：整批 batch 不落库。"""

    def __init__(self, code: str, human_message: str, agent_hint: str) -> None:
        super().__init__(code)
        self.code = code
        self.human_message = human_message
        self.agent_hint = agent_hint


def _deny(code: str, human_message: str, agent_hint: str) -> IdentityGateError:
    return IdentityGateError(code, human_message, agent_hint)


def _identity_config(db: Session, project_id: int, country: str) -> ProjectShop | None:
    return db.execute(
        select(ProjectShop).where(
            ProjectShop.project_id == project_id,
            ProjectShop.country == country,
        )
    ).scalar_one_or_none()


def _recomputed_verified(
    *, expected_alias: str, extra_aliases: list, observed_alias: str | None,
    observed_country: list, target_country: str,
) -> bool:
    """服务端重算 verified：alias 精确命中且 observed_country 包含目标 country。"""
    allowed = {expected_alias} | {a for a in (extra_aliases or []) if isinstance(a, str)}
    alias_ok = observed_alias is not None and observed_alias in allowed
    country_ok = target_country in (observed_country or [])
    return bool(alias_ok and country_ok)


def _validate_identity_gate(db: Session, body: ComplaintRunBatchRequest) -> dict[tuple[int, str], bool]:
    """校验 W1 身份门禁，返回本批次可写集合 {(project_id, country)}。

    可写 ⇔ check_status=ok 且（无身份配置的 legacy 店铺，或 identity verified=true）。
    失败抛 IdentityGateError（code 即 agent ErrorCode 名），调用方整批拒绝。
    """
    seen: set[tuple[int, str]] = set()
    for sc in body.shop_checks:
        key = (sc.project_id, sc.country)
        if key in seen:
            raise _deny(
                'VALIDATION_FAILED',
                human_message=f"shop_checks 重复：project_id={sc.project_id} country={sc.country} 每批次最多一条",
                agent_hint="deduplicate shop_checks by (project_id, country) before retry",
            )
        seen.add(key)

    writable: dict[tuple[int, str], bool] = {}
    for sc in body.shop_checks:
        writable[(sc.project_id, sc.country)] = _validate_single_identity(db, sc)

    for c in body.complaints:
        if not writable.get((c.project_id, c.country), False):
            raise _deny(
                'IDENTITY_CHECK_REQUIRED',
                human_message=(
                    f"project_id={c.project_id} country={c.country} 没有 ok 且身份已核验的 shop_check，禁止写入客诉"
                ),
                agent_hint="only complaints whose (project_id, country) has check_status=ok and identity_check.verified=true in the same batch are accepted; fix identity_check or drop these complaints and retry the whole batch",
            )
    return writable


def _validate_single_identity(db: Session, sc: ShopCheckIn) -> bool:
    """校验单个 shop_check，返回其 (project_id, country) 是否可写。"""
    cfg = _identity_config(db, sc.project_id, sc.country)
    required = bool(cfg.seller_identity_required) if cfg is not None else False
    cfg_expected = (cfg.seller_identity_expected_alias or '').strip() if cfg is not None else ''
    cfg_aliases = list(cfg.seller_identity_aliases or []) if cfg is not None else []

    if required and not cfg_expected:
        raise _deny(
            'IDENTITY_EXPECTED_ALIAS_MISSING',
            human_message=(
                f"project_id={sc.project_id} country={sc.country} 要求身份核验但后端缺少 expected_alias"
            ),
            agent_hint="maintain seller_identity.expected_alias for this shop before writing complaints",
        )

    ic = sc.identity_check
    if ic is None:
        if sc.check_status == 'ok' and required:
            raise _deny(
                'IDENTITY_CHECK_REQUIRED',
                human_message=(
                    f"project_id={sc.project_id} country={sc.country} 缺少 identity_check，禁止写入客诉"
                ),
                agent_hint="probe amazon_seller_central_account_switcher and submit identity_check with verified=true before retry",
            )
        # legacy：无身份配置的 ok 店铺保持旧语义可写；非 ok 一律不可写。
        return sc.check_status == 'ok'

    expected = (ic.expected_alias or '').strip()
    if not expected:
        raise _deny(
            'IDENTITY_EXPECTED_ALIAS_MISSING',
            human_message="identity_check.expected_alias 不能为空",
            agent_hint="read expected_alias from R0 seller_identity and resubmit",
        )
    if cfg_expected and expected != cfg_expected:
        raise _deny(
            'IDENTITY_CHECK_INVALID',
            human_message=(
                f"project_id={sc.project_id} country={sc.country} 的 expected_alias 与后端期望不一致（可能用了过期 R0）"
            ),
            agent_hint="re-read R0 seller_identity.expected_alias and resubmit with the fresh value",
        )
    if ic.source != IDENTITY_SOURCE:
        raise _deny(
            'IDENTITY_CHECK_INVALID',
            human_message=f"identity_check.source 非法：{ic.source!r}",
            agent_hint=f"identity_check.source must be exactly {IDENTITY_SOURCE!r}",
        )

    recomputed = _recomputed_verified(
        expected_alias=expected,
        extra_aliases=cfg_aliases,
        observed_alias=ic.observed_alias,
        observed_country=ic.observed_country,
        target_country=sc.country,
    )
    if ic.verified and not recomputed:
        raise _deny(
            'IDENTITY_CHECK_INVALID',
            human_message=(
                f"project_id={sc.project_id} country={sc.country} 声明 verified=true 但页面观测不匹配"
            ),
            agent_hint="verified=true requires observed_alias to exactly match expected_alias/aliases and observed_country to contain the target country",
        )
    if sc.check_status == 'ok' and not ic.verified:
        raise _deny(
            'IDENTITY_CHECK_REQUIRED',
            human_message=(
                f"project_id={sc.project_id} country={sc.country} 身份核验未通过，禁止写入客诉"
            ),
            agent_hint="check observed_alias and observed_country before retry",
        )
    if sc.check_status == 'identity_mismatch' and ic.verified:
        raise _deny(
            'IDENTITY_CHECK_CONTRADICTION',
            human_message=(
                f"project_id={sc.project_id} country={sc.country} 自称 identity_mismatch 却声明 verified=true"
            ),
            agent_hint="identity_mismatch must pair with verified=false; re-probe the account switcher before retry",
        )
    return sc.check_status == 'ok' and ic.verified


def _identity_dump(sc: ShopCheckIn) -> dict:
    ic = sc.identity_check
    if ic is None:
        return {
            'identity_expected_alias': None,
            'identity_observed_alias': None,
            'identity_observed_country': [],
            'identity_verified': None,
            'identity_source': None,
        }
    return {
        'identity_expected_alias': (ic.expected_alias or '').strip() or None,
        'identity_observed_alias': ic.observed_alias,
        'identity_observed_country': list(ic.observed_country or []),
        'identity_verified': bool(ic.verified),
        'identity_source': ic.source,
    }


# ── 批量写入（一个事务收全家）──────────────────────────────────

def upsert_batch(db: Session, body: ComplaintRunBatchRequest, agent_id: str | None) -> ComplaintRun:
    """批量 upsert：run + shop_checks + complaints，一个事务。

    BLF-1022 事务一致性：先跑身份门禁（整批拒绝，不落库），再写 run。
    幂等：同一天 run_date 重复提交 → 更新原 run；shop_check 按 (run_id, project_id, country) upsert；
    complaint 按对话自然键 (project_id, country, buyer_name, first_message_date) upsert。
    同一对话的完全重复消息只保留一份；不同消息追加到 messages 并重算总数。
    """
    _validate_identity_gate(db, body)
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
        country = _normalize_country(sc.country)
        existing = _find_shop_check(db, run.id, sc.project_id, country)
        if existing is None:
            existing = ShopCheck(run_id=run.id, project_id=sc.project_id, country=country)
            db.add(existing)
        existing.check_status = sc.check_status
        existing.error_message = sc.error_message
        existing.metrics = sc.metrics.model_dump(mode='json') if sc.metrics is not None else {}
        for key, value in _identity_dump(sc).items():
            setattr(existing, key, value)
    db.flush()

    seen_conversations: dict[tuple[int, str, str, date], Complaint] = {}
    for c in body.complaints:
        country = _normalize_country(c.country)
        key = (c.project_id, country, c.buyer_name, c.first_message_date)
        existing = seen_conversations.get(key)
        if existing is None:
            existing = _find_complaint_conversation(
                db, c.project_id, country, c.buyer_name, c.first_message_date
            )
            if existing is None:
                existing = Complaint(**_build_complaint_in(c, run.id))
                existing.country = country
                db.add(existing)
                seen_conversations[key] = existing
                continue
            seen_conversations[key] = existing
        incoming = c.model_dump(mode='json')
        is_latest = c.message_date >= existing.message_date
        existing.message_date = max(existing.message_date, c.message_date)
        if is_latest:
            existing.subject = c.subject
            existing.message_body = c.message_body
            existing.triage = c.triage.model_dump(mode='json')
            existing.category = c.triage.category
            existing.has_order = c.triage.has_order
            if c.order is not None:
                existing.order_info = c.order.model_dump(exclude_none=False, mode='json')
            if c.sla is not None:
                existing.sla = c.sla.model_dump(exclude_none=True, mode='json')
        elif not existing.has_order and c.triage.has_order and c.order is not None:
            existing.has_order = True
            existing.order_info = c.order.model_dump(exclude_none=False, mode='json')
        if existing.sla is None and c.sla is not None:
            existing.sla = c.sla.model_dump(exclude_none=True, mode='json')
        existing.run_id = run.id
        existing.country = country
        _upsert_conversation_message(existing, incoming)
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
    country = _normalize_country_filter(country)
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
        filters.append(Complaint.country == _normalize_country(country))
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
        filters.append(Complaint.country == _normalize_country(country))
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
