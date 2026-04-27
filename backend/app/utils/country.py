"""
Shared country normalization utilities.

All modules that need to normalize country strings (US/DE/UK and their aliases)
should import from this module rather than defining their own copies.

Usage:
    from app.utils.country import _normalize_country, COUNTRY_ALIASES
"""
from __future__ import annotations

SUPPORTED_COUNTRIES: frozenset[str] = frozenset({"US", "DE", "UK"})

# Alias for backwards compatibility — some modules use ALLOWED_COUNTRIES
ALLOWED_COUNTRIES = SUPPORTED_COUNTRIES

COUNTRY_ALIASES: dict[str, str] = {
    # US variants
    "US": "US",
    "USA": "US",
    "美国": "US",
    "美国站": "US",
    # DE variants
    "DE": "DE",
    "GERMANY": "DE",
    "德国": "DE",
    "德国站": "DE",
    # UK variants
    "UK": "UK",
    "GB": "UK",
    "UNITED KINGDOM": "UK",
    "英国": "UK",
    "英国站": "UK",
}

COUNTRY_TO_CURRENCY: dict[str, str] = {
    "US": "USD",
    "DE": "EUR",
    "UK": "GBP",
}

COUNTRY_TO_LOCALE: dict[str, str] = {
    "US": "en",
    "DE": "de",
    "UK": "en",
}


def _normalize_country(value: str | None) -> str:
    """
    Normalize a country input to one of: US, DE, UK.

    Empty/whitespace-only strings return "US" as the default.
    All other inputs are looked up in COUNTRY_ALIASES first, then
    checked directly against SUPPORTED_COUNTRIES.

    Raises:
        ValueError: if the normalized value is not a supported country.
    """
    normalized = (value or "").strip().upper()
    if not normalized:
        return "US"

    # First try alias lookup
    mapped = COUNTRY_ALIASES.get(normalized)
    if mapped is not None:
        return mapped

    # Then check if it's already a canonical country code
    if normalized in SUPPORTED_COUNTRIES:
        return normalized

    allowed = ", ".join(sorted(SUPPORTED_COUNTRIES))
    raise ValueError(f"country must be one of: {allowed}")


def _normalize_country_http(value: str | None) -> str:
    """
    Normalize a country string, raising an HTTPException on invalid input.

    Use this variant in FastAPI endpoints where you want a proper
    HTTP 422 response instead of a plain ValueError.
    """
    from fastapi import HTTPException, status

    normalized = (value or "").strip().upper()
    if not normalized:
        return "US"

    mapped = COUNTRY_ALIASES.get(normalized)
    if mapped is not None:
        return mapped

    if normalized in SUPPORTED_COUNTRIES:
        return normalized

    allowed = ", ".join(sorted(SUPPORTED_COUNTRIES))
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"country must be one of: {allowed}",
    )


def is_valid_country(value: str | None) -> bool:
    """Return True if the value normalizes to a supported country."""
    if value is None:
        return True  # None is valid (normalizes to "US")
    normalized = value.strip().upper()
    if not normalized:
        return True
    return _normalize_country(value) in SUPPORTED_COUNTRIES


def get_currency(country: str) -> str:
    """Return the currency code for a normalized country (e.g. US -> USD)."""
    return COUNTRY_TO_CURRENCY.get(country, "USD")


def get_locale(country: str) -> str:
    """Return the locale code for a normalized country (e.g. DE -> de)."""
    return COUNTRY_TO_LOCALE.get(country, "en")
