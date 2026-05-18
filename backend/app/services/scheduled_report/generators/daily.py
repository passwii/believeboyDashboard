"""Daily report data generator."""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlalchemy.orm import Session

from app.models import ScheduledReportSubscription
from app.services.dashboard_overview_service import build_dashboard_overview

logger = logging.getLogger(__name__)


def collect_daily_report_data(
    db: Session,
    subscription: ScheduledReportSubscription,
) -> dict[str, Any]:
    """收集每日报告所需数据。复用 dashboard_overview_service 的聚合逻辑。"""
    project_ids = subscription.project_id_list or None
    country = subscription.country or "US"

    overview = build_dashboard_overview(
        db,
        project_ids=project_ids,
        operator=None,
        is_admin=True,
        country=country,
        days=7,
    )

    report_date = date.today().isoformat()

    return {
        "report_date": report_date,
        "country": country,
        "project_ids": overview.get("project_ids", []),
        "project_names": overview.get("project_names", []),
        "sales": overview.get("sales", {}),
        "inventory": overview.get("inventory", {}),
        "ads": overview.get("ads", {}),
        "returns": overview.get("returns", {}),
        "sales_trend": overview.get("sales_trend", []),
    }
