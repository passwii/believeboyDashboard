"""Shared query-param helpers for the agent API endpoints.

Currently just a thin wrapper around ``app.utils.country.normalize_country``
that re-raises ``ValueError`` as ``PeriodParseError`` so the endpoint
catch-block can return a uniform 400 envelope.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.schemas.external.common import PeriodParseError
from app.utils.country import normalize_country

FLAT_ANCHOR_FIELDS = (
    "breakeven_advertising_rate",
    "non_ad_fee_usd",
    "max_ad_spend_per_unit_usd",
    "target_advertising_rate",
)


def render_flat_anchor_response(
    value: BaseModel, *, include_anchor: bool
) -> dict[str, Any]:
    """Serialize a flat response and optionally remove all derived anchor fields."""
    payload = value.model_dump(mode="json")
    if include_anchor:
        return payload
    rows = payload.get("data", [])
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            for field in FLAT_ANCHOR_FIELDS:
                row.pop(field, None)
    return payload


def parse_country(value: str | None) -> str:
    """Normalize and validate a country query param.

    Raises ``PeriodParseError`` on unknown values *and* on empty input
    (the agent contract requires ``country`` to be supplied — silently
    defaulting to ``"US"`` would mask caller bugs).
    """
    if not value or not value.strip():
        raise PeriodParseError("country is required")
    try:
        return normalize_country(value, default="strict")
    except ValueError as exc:
        raise PeriodParseError(str(exc)) from exc


def parse_countries(value: str | None) -> list[str]:
    """Normalize and validate a comma-separated country list (BLF-560 v0.2).

    单项目多站点聚合：``country=US,DE`` → ``["US", "DE"]``（归一化 + 去重、
    保序）。空输入 / 全空段 / 任一段非法 → ``PeriodParseError``（端点 400）。
    单站点 ``country=US`` 行为与 :func:`parse_country` 一致（向后兼容）。
    """
    if not value or not value.strip():
        raise PeriodParseError("country is required")
    parts = [p.strip() for p in value.split(",") if p.strip()]
    if not parts:
        raise PeriodParseError("country is required")
    seen: list[str] = []
    for part in parts:
        try:
            code = normalize_country(part, default="strict")
        except ValueError as exc:
            raise PeriodParseError(str(exc)) from exc
        if code not in seen:
            seen.append(code)
    return seen
