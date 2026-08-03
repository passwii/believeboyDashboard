"""Shared period parser — used by both internal and external API endpoints.

Centralises the dual-format period syntax documented in ``docs/external-api.md``:

  * Convenience aliases — ``?period=7d`` / ``14d`` / ``28d`` / ``30d`` /
    ``60d`` / ``90d`` / ``this_month`` / ``last_month`` / ``ytd``.
    End anchor is always T-1 (yesterday) for every alias *except*
    ``last_month``, which anchors to the last calendar day of the
    previous month (since "last month" is by definition a closed period).

  * Custom range — ``?period=custom&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD``.

When the caller passes both a convenience alias *and* ``start_date`` /
``end_date`` (or omits the required companion params for ``custom``) we
raise :class:`PeriodParseError` so the endpoint can surface a 400 with an
actionable message.

The ``today`` parameter is injected explicitly so unit tests can pin the
clock to a known date without monkey-patching ``date.today()``.

Originally lived at ``app.api.v1.endpoints.external._period``; moved here
when the inventory-ledger internal endpoints also adopted the ``?period=``
syntax (BEL-370 P1 #4). ``external/_period.py`` is now a thin re-export
shim for backward compatibility with existing ad-campaign imports.
"""

from __future__ import annotations

from calendar import monthrange
from datetime import date

from app.schemas.external.common import PeriodInfo, PeriodParseError


PERIOD_ALIASES: frozenset[str] = frozenset(
    {
        "7d",
        "14d",
        "28d",
        "30d",
        "60d",
        "90d",
        "this_month",
        "last_month",
        "ytd",
        "custom",
    }
)

_VALID_DATE_FORMATS: tuple[str, ...] = ("%Y-%m-%d",)


def _parse_date_string(value: str, *, field: str) -> date:
    """Parse a single ``YYYY-MM-DD`` value; raise ``PeriodParseError`` on
    malformed input.
    """
    if not value:
        raise PeriodParseError(f"{field} must be a non-empty YYYY-MM-DD string")
    candidate = value.strip()[:10]
    for fmt in _VALID_DATE_FORMATS:
        try:
            return date.fromisoformat(candidate)
        except ValueError:
            continue
    raise PeriodParseError(f"{field} must be YYYY-MM-DD, got {value!r}")


def _resolve_alias(alias: str, today: date) -> tuple[date, date]:
    """Translate a convenience alias into (start_date, end_date).

    Rules (anchored at T-1 for every alias except ``last_month``):

    =============  ==========================================
    Alias          Window
    =============  ==========================================
    ``7d``         today-6 .. today
    ``14d``        today-13 .. today
    ``28d``        today-27 .. today
    ``30d``        today-29 .. today
    ``60d``        today-59 .. today
    ``90d``        today-89 .. today
    ``this_month`` first day of today's month .. today
                   (or first day of last month .. last day of last
                    month when T-1 falls in the previous month)
    ``last_month`` first day of previous month .. last day of previous month
    ``ytd``        Jan 1 of today's year .. today
                   (or Jan 1 .. Dec 31 of previous year when T-1
                    falls in the previous calendar year)
    =============  ==========================================
    """
    anchor = today  # T-1 (the "today" parameter is already T-1 from the caller)

    if alias == "7d":
        return _shift_days(anchor, -6), anchor
    if alias == "14d":
        return _shift_days(anchor, -13), anchor
    if alias == "28d":
        return _shift_days(anchor, -27), anchor
    if alias == "30d":
        return _shift_days(anchor, -29), anchor
    if alias == "60d":
        return _shift_days(anchor, -59), anchor
    if alias == "90d":
        return _shift_days(anchor, -89), anchor

    if alias == "this_month":
        # If T-1 still falls in today's calendar month, use it as the end.
        # Otherwise (we crossed a month boundary), return the *previous*
        # full month so callers always see a meaningful window.
        if anchor.month == today.month and anchor.year == today.year:
            return today.replace(day=1), anchor
        return _full_previous_month(today)

    if alias == "last_month":
        return _full_previous_month(today)

    if alias == "ytd":
        if anchor.year == today.year:
            return today.replace(month=1, day=1), anchor
        # Crossed a year boundary — return the entire previous calendar year.
        return date(anchor.year, 1, 1), date(anchor.year, 12, 31)

    # Should be unreachable — the alias is validated by the caller.
    raise PeriodParseError(f"unknown period alias: {alias!r}")


def _shift_days(d: date, delta_days: int) -> date:
    """Return ``d + delta_days`` (handles month / year rollover)."""
    from datetime import timedelta

    return d + timedelta(days=delta_days)


def _full_previous_month(today: date) -> tuple[date, date]:
    """Return (first day, last day) of the calendar month preceding ``today``."""
    if today.month == 1:
        return date(today.year - 1, 12, 1), date(today.year - 1, 12, 31)
    return (
        date(today.year, today.month - 1, 1),
        date(today.year, today.month - 1, monthrange(today.year, today.month - 1)[1]),
    )


def parse_period(
    period: str | None,
    start_date: str | None,
    end_date: str | None,
    *,
    today: date,
) -> tuple[date, date]:
    """Parse the ``period`` (+ optional ``start_date`` / ``end_date``) query
    params into a normalised ``(start_date, end_date)`` tuple.

    Raises ``PeriodParseError`` on any validation failure. The caller is
    expected to catch this and translate to HTTP 400.

    Parameters
    ----------
    period
        The ``?period=`` query value. May be one of the convenience aliases
        (``7d``..``ytd``) or the literal string ``custom``.
    start_date, end_date
        Companion parameters for ``period=custom`` (``YYYY-MM-DD`` strings).
    today
        The "current" date used to anchor convenience aliases. **The caller
        must pass T-1 (yesterday) — not today** — per the P0 contract.
    """
    if period is None or period == "":
        raise PeriodParseError("period is required")

    period = period.strip().lower()
    if period not in PERIOD_ALIASES:
        raise PeriodParseError(
            f"period must be one of {sorted(PERIOD_ALIASES)}, got {period!r}"
        )

    if period == "custom":
        if not start_date or not end_date:
            raise PeriodParseError(
                "start_date and end_date are required when period=custom"
            )
        s = _parse_date_string(start_date, field="start_date")
        e = _parse_date_string(end_date, field="end_date")
        if s > e:
            raise PeriodParseError(f"start_date must be <= end_date, got {s} > {e}")
        return s, e

    # Convenience aliases — start_date / end_date must NOT be combined.
    if start_date or end_date:
        raise PeriodParseError("period cannot be combined with start_date / end_date")

    return _resolve_alias(period, today)


def parse_period_v2(
    period: str | None,
    start_date: str | None,
    end_date: str | None,
    *,
    today: date,
) -> PeriodInfo:
    """Like ``parse_period`` but returns a ``PeriodInfo`` pydantic object
    carrying the original alias / custom label plus the resolved dates.

    Used by the v1.0 aggregate / raw endpoints that need to embed the
    period metadata inside the response envelope.
    """
    raw_period = period or ""
    start, end = parse_period(raw_period, start_date, end_date, today=today)

    if raw_period.strip().lower() == "custom":
        return PeriodInfo(
            type="custom",
            value="custom",
            start_date=start,
            end_date=end,
        )
    return PeriodInfo(
        type="relative",
        value=raw_period.strip().lower(),
        start_date=start,
        end_date=end,
    )
