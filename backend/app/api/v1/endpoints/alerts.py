"""Alert endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from datetime import datetime, timezone
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.models import AlertRule, AlertEvent, AlertPreference
from app.schemas.alert import (
    AlertEventItem,
    AlertEventListResponse,
    AlertRuleCreate,
    AlertRuleItem,
    AlertRuleUpdate,
    AlertStatsResponse,
    AlertPreferenceItem,
    AlertPreferenceUpdate,
    TriggerDetectionResponse,
    MetricOptionsResponse,
    MetricOption,
)
from app.services import project_service
from app.services.alert.detector import detect_anomalies
from app.services.alert.dispatcher import dispatch_alert, dispatch_batch

router = APIRouter(prefix="/alerts", tags=["alerts"], dependencies=[Depends(protected)])


# ─── Metric options ────────────────────────────────────────────────────────────

@router.get("/metrics", response_model=MetricOptionsResponse)
def list_metric_options() -> MetricOptionsResponse:
    return MetricOptionsResponse(
        metrics=[
            MetricOption(value="sales_amount", label="销售额", description="每日销售总额"),
            MetricOption(value="order_qty", label="订单量", description="每日订单总数"),
            MetricOption(value="ad_spend", label="广告花费", description="每日广告总支出"),
            MetricOption(value="acos", label="ACOS", description="广告销售成本比"),
            MetricOption(value="return_rate", label="退货率", description="退货占总订单比例"),
            MetricOption(value="inventory_risk", label="库存风险", description="库存缺货风险等级"),
            MetricOption(value="reconciliation_mismatch", label="报表核对异常", description="PDF与数据库数据匹配率低于阈值"),
        ]
    )


# ─── Rules ────────────────────────────────────────────────────────────────────

@router.get("/rules", response_model=list[AlertRuleItem])
def list_rules(
    project_id: int | None = Query(default=None),
    metric: str | None = Query(default=None),
    is_active: bool | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> list[AlertRuleItem]:
    q = db.query(AlertRule)
    if project_id is not None:
        project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
        q = q.filter(AlertRule.project_id == project_id)
    if metric:
        q = q.filter(AlertRule.metric == metric)
    if is_active is not None:
        q = q.filter(AlertRule.is_active == is_active)
    q = q.order_by(AlertRule.created_at.desc())
    return q.all()


@router.post("/rules", response_model=AlertRuleItem, status_code=201)
def create_rule(
    payload: AlertRuleCreate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AlertRule:
    project_service.ensure_project_access(
        db, payload.project_id, operator=operator, is_admin=bool(is_admin)
    )
    rule = AlertRule(
        **payload.model_dump(),
        created_by=operator or "system",
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.patch("/rules/{rule_id}", response_model=AlertRuleItem)
def update_rule(
    rule_id: int,
    payload: AlertRuleUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AlertRule:
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    project_service.ensure_project_access(
        db, rule.project_id, operator=operator, is_admin=bool(is_admin)
    )
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(rule, field, value)
    rule.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(
    rule_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> Response:
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    project_service.ensure_project_access(
        db, rule.project_id, operator=operator, is_admin=bool(is_admin)
    )
    db.delete(rule)
    db.commit()
    return Response(status_code=204)


# ─── Events ────────────────────────────────────────────────────────────────────

@router.get("/events", response_model=AlertEventListResponse)
def list_events(
    project_id: int | None = Query(default=None),
    severity: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AlertEventListResponse:
    q = db.query(AlertEvent)
    if project_id is not None:
        project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
        q = q.filter(AlertEvent.project_id == project_id)
    if severity:
        q = q.filter(AlertEvent.severity == severity)
    if status:
        q = q.filter(AlertEvent.status == status)

    total = q.count()
    offset = (page - 1) * page_size
    items = q.order_by(AlertEvent.triggered_at.desc()).offset(offset).limit(page_size).all()
    return AlertEventListResponse(items=items, total=total, page=page, page_size=page_size)


@router.post("/events/{event_id}/acknowledge", response_model=AlertEventItem)
def acknowledge_event(
    event_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AlertEvent:
    event = db.query(AlertEvent).filter(AlertEvent.id == event_id).first()
    if not event:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=404, detail="Event not found")
    project_service.ensure_project_access(db, event.project_id, operator=operator, is_admin=bool(is_admin))
    event.status = "acknowledged"
    event.acknowledged_at = datetime.now(timezone.utc)
    event.acknowledged_by = operator
    db.commit()
    db.refresh(event)
    return event


@router.post("/events/{event_id}/resolve", response_model=AlertEventItem)
def resolve_event(
    event_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> AlertEvent:
    event = db.query(AlertEvent).filter(AlertEvent.id == event_id).first()
    if not event:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=404, detail="Event not found")
    project_service.ensure_project_access(db, event.project_id, operator=operator, is_admin=bool(is_admin))
    event.status = "resolved"
    db.commit()
    db.refresh(event)
    return event


# ─── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats", response_model=AlertStatsResponse)
def get_stats(
    project_id: int | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> AlertStatsResponse:
    from datetime import date, timedelta
    today = date.today()

    q = db.query(AlertEvent)
    if project_id is not None:
        q = q.filter(AlertEvent.project_id == project_id)

    total_active = q.filter(AlertEvent.status == "active").count()
    critical_count = q.filter(AlertEvent.status == "active", AlertEvent.severity == "critical").count()
    warning_count = q.filter(AlertEvent.status == "active", AlertEvent.severity == "warning").count()
    info_count = q.filter(AlertEvent.status == "active", AlertEvent.severity == "info").count()
    acknowledged_today = q.filter(
        AlertEvent.acknowledged_at >= today,
    ).count()
    resolved_today = q.filter(
        AlertEvent.status == "resolved",
        func.date(AlertEvent.triggered_at) == today,
    ).count()

    return AlertStatsResponse(
        total_active=total_active,
        critical_count=critical_count,
        warning_count=warning_count,
        info_count=info_count,
        acknowledged_today=acknowledged_today,
        resolved_today=resolved_today,
    )


# ─── Preferences ───────────────────────────────────────────────────────────────

def _get_user_id_from_header(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> int | None:
    """Get user ID from X-User-Id header (same as scheduled_reports)."""
    if x_user_id is None:
        return None
    try:
        return int(x_user_id.strip())
    except (ValueError, TypeError):
        return None


@router.get("/preferences", response_model=AlertPreferenceItem)
def get_preferences(
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> AlertPreferenceItem:
    if not operator:
        raise HTTPException(status_code=401, detail="Operator required")
    user_id = _get_user_id_from_header(x_user_id)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    pref = db.query(AlertPreference).filter(AlertPreference.user_id == user_id).first()
    if not pref:
        pref = AlertPreference(
            user_id=user_id,
            email_enabled=True,
            in_app_enabled=True,
            min_severity="warning",
        )
        db.add(pref)
        db.commit()
        db.refresh(pref)
    return pref


@router.patch("/preferences", response_model=AlertPreferenceItem)
def update_preferences(
    payload: AlertPreferenceUpdate,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> AlertPreference:
    if not operator:
        raise HTTPException(status_code=401, detail="Operator required")
    user_id = _get_user_id_from_header(x_user_id)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    pref = db.query(AlertPreference).filter(AlertPreference.user_id == user_id).first()
    if not pref:
        pref = AlertPreference(user_id=user_id)
        db.add(pref)

    for field, value in payload.model_dump(exclude_unset=True).items():
        if field in ("quiet_hours_start", "quiet_hours_end") and value:
            import re
            if re.match(r"^\d{2}:\d{2}$", value):
                parts = value.split(":")
                from datetime import time as T
                setattr(pref, field, T(int(parts[0]), int(parts[1])))
        else:
            setattr(pref, field, value)
    db.commit()
    db.refresh(pref)
    return pref


# ─── Manual trigger (for testing / on-demand) ──────────────────────────────────

@router.post("/detect", response_model=TriggerDetectionResponse)
def trigger_detection(
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> TriggerDetectionResponse:
    """Manually run anomaly detection for all active rules."""
    if not is_admin:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=403, detail="Admin only")

    rules = db.query(AlertRule).filter(AlertRule.is_active == True).all()
    events = []
    for rule in rules:
        from app.services.alert.detector import _evaluate_rule
        evt = _evaluate_rule(db, rule)
        if evt:
            events.append(evt)
    db.commit()

    messages_sent = 0
    if events:
        dispatch_batch(db, events)
        messages_sent = len(events)

    return TriggerDetectionResponse(
        rules_evaluated=len(rules),
        events_created=len(events),
        messages_sent=messages_sent,
    )