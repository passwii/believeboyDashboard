"""Common schemas / exceptions for the external API namespace."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict


class PeriodParseError(ValueError):
    """Raised by ``app.api.v1.endpoints.external._period.parse_period`` when the
    ``period`` query param (and optional ``start_date`` / ``end_date``) cannot be
    interpreted. Endpoints catch this and translate it to HTTP 400.

    The ``str(exc)`` payload is exposed verbatim via ``HTTPException.detail`` so
    callers receive an actionable error message (no internal stack traces).
    """


class PeriodInfo(BaseModel):
    """Resolved period metadata embedded in every v1.0 aggregate / raw response.

    * ``type`` — ``"relative"`` (convenience alias) or ``"custom"``
    * ``value`` — the original alias (``"14d"``, ``"this_month"``) or
      the literal string ``"custom"``
    * ``start_date`` / ``end_date`` — resolved calendar dates
    """

    model_config = ConfigDict(from_attributes=True)

    type: str  # "relative" | "custom"
    value: str
    start_date: date
    end_date: date