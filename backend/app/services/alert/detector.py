"""Anomaly detection engine for alerts."""

from __future__ import annotations

import logging
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AlertRule,
    AlertEvent,
    AlertEventStatus,
    AnalysisSalesOrderRow,
    AnalysisBusinessRow,
    AnalysisSourceFile,
    AdSourceFile,
    AdCampaignReportRow,
    Project,
)

logger = logging.getLogger(__name__)


def detect_anomalies(db: Session) -> list[AlertEvent]:
    """
    Run anomaly detection for all active rules.
    Returns list of newly created AlertEvent objects.
    """
    rules = db.query(AlertRule).filter(AlertRule.is_active == True).all()
    events = []

    for rule in rules:
        try:
            event = _evaluate_rule(db, rule)
            if event:
                events.append(event)
        except Exception as e:
            logger.error(f"Error evaluating rule {rule.id}: {e}")

    return events


def _evaluate_rule(db: Session, rule: AlertRule) -> AlertEvent | None:
    """Evaluate a single rule and create event if threshold exceeded."""
    baseline_value, current_value = _get_metric_values(db, rule)
    if baseline_value is None or current_value is None:
        return None

    deviation_pct = ((current_value - baseline_value) / baseline_value * 100) if baseline_value != 0 else 0.0

    triggered = False
    condition = rule.condition
    threshold = rule.threshold

    if condition == "below":
        triggered = current_value < baseline_value * (1 - threshold / 100)
    elif condition == "above":
        triggered = current_value > baseline_value * (1 + threshold / 100)
    elif condition == "drop_pct":
        triggered = deviation_pct < -threshold
    elif condition == "rise_pct":
        triggered = deviation_pct > threshold

    if not triggered:
        return None

    # Check for duplicate within last 24h
    recent = db.query(AlertEvent).filter(
        AlertEvent.rule_id == rule.id,
        AlertEvent.status == AlertEventStatus.ACTIVE,
        AlertEvent.triggered_at >= func.now() - timedelta(hours=24),
    ).first()
    if recent:
        return None

    message = _build_message(rule.metric, rule.condition, current_value, baseline_value, deviation_pct)

    event = AlertEvent(
        rule_id=rule.id,
        project_id=rule.project_id,
        metric=rule.metric,
        current_value=current_value,
        baseline_value=baseline_value,
        deviation_pct=deviation_pct,
        severity=rule.severity,
        message=message,
        status=AlertEventStatus.ACTIVE,
    )
    db.add(event)
    db.flush()
    return event


def _get_metric_values(db: Session, rule: AlertRule) -> tuple[float | None, float | None]:
    """Fetch baseline (rolling avg over window) and current value for a metric."""
    metric = rule.metric
    window = rule.window_days or 7
    today = date.today()

    if metric in ("sales_amount", "order_qty"):
        return _get_sales_metric(db, rule.project_id, rule.country, metric, window, today)
    elif metric in ("ad_spend", "acos"):
        return _get_ad_metric(db, rule.project_id, rule.country, metric, window, today)
    elif metric == "return_rate":
        return _get_return_rate_metric(db, rule.project_id, rule.country, window, today)

    return None, None


def _get_sales_metric(
    db: Session, project_id: int, country: str, metric: str, window: int, today: date
) -> tuple[float | None, float | None]:
    """Get sales_amount or order_qty baseline (avg) and current (latest day)."""
    col = AnalysisBusinessRow.sales_amount if metric == "sales_amount" else AnalysisBusinessRow.ordered_sales_amount
    if metric == "order_qty":
        col = AnalysisBusinessRow.ordered_qty

    end = today - timedelta(days=1)
    start = end - timedelta(days=window - 1)

    # Current: latest day's value
    current_stmt = (
        select(func.coalesce(func.sum(col), 0))
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisBusinessRow.source_file_id)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.report_date == end,
        )
    )
    current = db.execute(current_stmt).scalar() or 0.0

    # Baseline: rolling average over window
    baseline_stmt = (
        select(func.coalesce(func.avg(col), 0))
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisBusinessRow.source_file_id)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.report_date >= start,
            AnalysisSourceFile.report_date <= end,
        )
    )
    baseline = db.execute(baseline_stmt).scalar() or 0.0

    return baseline if baseline > 0 else None, current if current > 0 else None


def _get_ad_metric(
    db: Session, project_id: int, country: str, metric: str, window: int, today: date
) -> tuple[float | None, float | None]:
    """Get ad_spend or acos baseline and current."""
    end = today - timedelta(days=1)
    start = end - timedelta(days=window - 1)

    if metric == "ad_spend":
        col = func.coalesce(func.sum(AdCampaignReportRow.spend), 0.0)
    else:  # acos
        # acos = spend / sales * 100
        col = func.coalesce(
            func.sum(AdCampaignReportRow.spend) / func.nullif(func.sum(AdCampaignReportRow.sales), 0) * 100,
            0.0
        )

    stmt = (
        select(col)
        .join(AdSourceFile, AdSourceFile.id == AdCampaignReportRow.source_file_id)
        .where(
            AdSourceFile.project_id == project_id,
            AdSourceFile.country == country,
            AdSourceFile.is_current.is_(True),
            AdSourceFile.report_date == end,
        )
    )
    current = db.execute(stmt).scalar() or 0.0

    if metric == "acos":
        # baseline acos for window
        baseline_stmt = (
            select(
                func.coalesce(
                    func.sum(AdCampaignReportRow.spend) / func.nullif(func.sum(AdCampaignReportRow.sales), 0) * 100,
                    0.0
                )
            )
            .join(AdSourceFile, AdSourceFile.id == AdCampaignReportRow.source_file_id)
            .where(
                AdSourceFile.project_id == project_id,
                AdSourceFile.country == country,
                AdSourceFile.is_current.is_(True),
                AdSourceFile.report_date >= start,
                AdSourceFile.report_date <= end,
            )
        )
        baseline = db.execute(baseline_stmt).scalar() or 0.0
    else:
        baseline = current  # fallback for ad_spend

    return baseline if baseline > 0 else None, current if current > 0 else None


def _get_return_rate_metric(
    db: Session, project_id: int, country: str, window: int, today: date
) -> tuple[float | None, float | None]:
    """Get return_rate baseline and current."""
    return None, None  # TODO: implement when return data is available


def _build_message(metric: str, condition: str, current: float, baseline: float, deviation: float) -> str:
    metric_labels = {
        "sales_amount": "销售额",
        "order_qty": "订单量",
        "ad_spend": "广告花费",
        "acos": "ACOS",
        "return_rate": "退货率",
        "inventory_risk": "库存风险",
    }
    label = metric_labels.get(metric, metric)
    deviation_str = f"{deviation:+.1f}%"

    if condition in ("below", "drop_pct"):
        return f"{label}下降 {deviation_str}，当前 {current:.0f}，基线 {baseline:.0f}"
    else:
        return f"{label}上升 {deviation_str}，当前 {current:.0f}，基线 {baseline:.0f}"