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
    period: str | None,
    start_date: date | None,
    end_date: date | None,
    *,
    today: date | None = None,
) -> tuple[date, date, date | None]:
    """Resolve the (start, end, report_month_for_integrity) triple from the
    single ``period`` query param + optional companions.

    The inventory-ledger API exposes **one** period-input convention — every
    call must supply ``?period=<value>``. ``start_date`` / ``end_date`` are
    ONLY accepted as companions of ``period=custom`` (so callers can pick
    any arbitrary date range). For any other period value, providing
    ``start_date`` / ``end_date`` is a 400 — keeps the surface small so
    agents don't drift into multiple calling patterns.

    ``report_month_for_integrity`` semantics:
      - Set to the first day of the resolved month when ``period`` resolves
        to a FULL calendar month (``last_month``, ``this_month``, ``ytd``
        cross-year degenerate, ``YYYY-MM``, ``YYYY-MM-DD``, etc.)
      - ``None`` for partial windows (``7d`` / ``30d`` / ``custom`` etc.) —
        integrity check is meaningless when the window doesn't align with
        a single ledger partition

    Raises ``HTTPException(400)`` on:
      - ``period`` missing or empty
      - Unknown / malformed period alias
      - ``start_date`` / ``end_date`` given with non-custom period

    ``today`` is injected explicitly so unit tests can pin the clock to a
    known date without monkey-patching ``date.today()`` (which breaks
    ``timedelta`` arithmetic). Defaults to T-1.
    """
    if not period:
        raise HTTPException(
            status_code=400,
            detail=(
                "period is required (use an alias like 'last_month', a "
                "relative window like '30d', or a YYYY-MM month string)"
            ),
        )
    if today is None:
        today = date.today() - timedelta(days=1)

    try:
        info = parse_period_v2(
            period,
            start_date.isoformat() if start_date else None,
            end_date.isoformat() if end_date else None,
            today=today,
        )
    except PeriodParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Full-calendar-month detection — integrity only makes sense here
    report_month_for_integrity: date | None = None
    if info.start_date.day == 1 and info.end_date == last_day_of_month(info.end_date):
        report_month_for_integrity = info.end_date.replace(day=1)
    return info.start_date, info.end_date, report_month_for_integrity
