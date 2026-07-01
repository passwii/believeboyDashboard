"""Shared helpers for the external API endpoints.

Currently just a thin wrapper around ``app.utils.country.normalize_country``
that re-raises ``ValueError`` as ``PeriodParseError`` so the endpoint
catch-block can return a uniform 400 envelope.
"""
from __future__ import annotations

from app.schemas.external.common import PeriodParseError
from app.utils.country import normalize_country


def parse_country(value: str | None) -> str:
    """Normalize and validate a country query param.

    Raises ``PeriodParseError`` on unknown values *and* on empty input
    (the P0 contract requires ``country`` to be supplied — silently
    defaulting to ``"US"`` would mask caller bugs).
    """
    if not value or not value.strip():
        raise PeriodParseError("country is required")
    try:
        return normalize_country(value, default="strict")
    except ValueError as exc:
        raise PeriodParseError(str(exc)) from exc