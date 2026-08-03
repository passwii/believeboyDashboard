"""Shared helpers for the inventory-ledger internal + external endpoints.

Extracted during the BEL-370 P1 #4 work (``?period=`` syntax unification) so
the same period-input resolution logic is used by both
``app/api/v1/endpoints/inventory_ledger.py`` and
``app/api/v1/endpoints/external/inventory_ledger.py``.

Keeping these in their own module avoids the internal↔external cross-import
smell that would result from one endpoint file importing the other.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta

from fastapi import HTTPException

from app.schemas.external.common import PeriodParseError
from app.utils.period import parse_period_v2


def last_day_of_month(d: date) -> date:
    """Return the last calendar day of the month containing ``d``."""
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def resolve_period_inputs(
    report_month: str | None,
    start_date: date | None,
    end_date: date | None,
    period: str | None,
    *,
    today: date | None = None,
) -> tuple[date, date, date | None]:
    """Resolve the (start, end, report_month_for_integrity) triple.

    Precedence (mutually exclusive):
      1. ``period`` — parsed via :func:`app.utils.period.parse_period_v2`
         (handles its own validation)
      2. ``report_month`` / ``start_date`` + ``end_date`` — legacy, via
         :func:`app.services.inventory.ledger.resolve_period`

    ``report_month_for_integrity`` semantics:
      - Set to the resolved date when caller passed explicit ``report_month``
        (preserves existing behaviour — integrity runs on the full month)
      - Set to the first day of the resolved month when ``period`` resolves
        to a FULL calendar month (``start.day == 1`` and ``end`` is last day)
      - ``None`` otherwise (no integrity, matches existing range-mode behaviour)

    ``today`` is injected explicitly so unit tests can pin the clock to a
    known date without monkey-patching ``date.today()`` (which breaks
    ``timedelta`` arithmetic). Defaults to T-1.

    Raises ``HTTPException(400)`` on validation failure.
    """
    if today is None:
        today = date.today() - timedelta(days=1)
    if period:
        # Mutual exclusion with any explicit date param
        if report_month or start_date or end_date:
            raise HTTPException(
                status_code=400,
                detail=(
                    "period cannot be combined with report_month / "
                    "start_date / end_date"
                ),
            )
        try:
            info = parse_period_v2(
                period,
                None,
                None,
                today=today,
            )
        except PeriodParseError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        # Full-calendar-month detection — integrity only makes sense here
        report_month_for_integrity: date | None = None
        if info.start_date.day == 1 and info.end_date == last_day_of_month(
            info.end_date
        ):
            report_month_for_integrity = info.end_date.replace(day=1)
        return info.start_date, info.end_date, report_month_for_integrity

    # Legacy path — preserve existing behaviour.
    # Import resolve_period lazily to avoid pulling the inventory service
    # package at module-import time (which would cascade into Settings
    # instantiation and break unit tests without a DATABASE_URL env var).
    from app.services.inventory.ledger import resolve_period

    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return start, end, start if report_month else None
