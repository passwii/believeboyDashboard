"""Shipment utility helpers."""

from __future__ import annotations


def date_text(value: object) -> str | None:
    """Convert a value to its string representation, returning None for None."""
    if value is None:
        return None
    return str(value)
