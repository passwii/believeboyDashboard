"""Country normalization utilities.

This module is the single canonical source for country normalization
and currency/locale mapping across both the backend service and autoReportUpload.

All consumers should import from here:
    from app.utils.country import normalize_country, get_currency, get_locale, get_today_for_country
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

SUPPORTED_COUNTRIES: frozenset[str] = frozenset({"US", "DE", "UK"})

COUNTRY_ALIASES: dict[str, str] = {
    "US": "US",
    "USA": "US",
    "美国": "US",
    "美国站": "US",
    "DE": "DE",
    "GERMANY": "DE",
    "德国": "DE",
    "德国站": "DE",
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

# Amazon 各站点报告时区（与 purchase_date_pt 等日期字段对齐）
# US/CA: Pacific Time, UK: London, DE: Berlin, JP: Tokyo
COUNTRY_TO_TIMEZONE: dict[str, ZoneInfo] = {
    "US": ZoneInfo("America/Los_Angeles"),
    "CA": ZoneInfo("America/Los_Angeles"),   # 北美统一使用 PT
    "DE": ZoneInfo("Europe/Berlin"),
    "UK": ZoneInfo("Europe/London"),
    "JP": ZoneInfo("Asia/Tokyo"),
}


def normalize_country(value: str | None, *, default: str = "strict") -> str:
    """Normalize a country value to one of US, DE, UK.

    Args:
        value: Country string (e.g. ``"US"``, ``"USA"``, ``"德国"``).
        default: Behaviour for unrecognised values:
            - ``"strict"`` (default) — raises :class:`ValueError`.
            - A valid country code (e.g. ``"US"``) — returned silently.

    Returns:
        Normalised country code (``"US"``, ``"DE"`` or ``"UK"``).

    Raises:
        ValueError: If *default* is ``"strict"`` and the value cannot be mapped.
    """
    normalized = (value or "").strip().upper()
    if not normalized:
        return "US"

    mapped = COUNTRY_ALIASES.get(normalized, normalized)

    if mapped in SUPPORTED_COUNTRIES:
        return mapped

    if default == "strict":
        raise ValueError(
            f"country must be one of: {', '.join(sorted(SUPPORTED_COUNTRIES))}"
        )
    if default in SUPPORTED_COUNTRIES:
        return default

    raise ValueError(
        f"default must be 'strict' or one of: "
        f"{', '.join(sorted(SUPPORTED_COUNTRIES))}"
    )


def get_currency(country: str) -> str:
    """Return the currency code for a normalized country (e.g. US -> USD)."""
    return COUNTRY_TO_CURRENCY.get(country, "USD")


def get_locale(country: str) -> str:
    """Return the locale code for a normalized country (e.g. DE -> de)."""
    return COUNTRY_TO_LOCALE.get(country, "en")


def get_today_for_country(country: str) -> date:
    """返回指定国家站点当前的本地日期。

    用于确保数据查询的日期窗口与 Amazon 报告时区一致。
    例如：中国 5月22日上午 → 美国 (PT) 还是5月21日，
    此时美国站的 "昨日" 应该是5月20日，而非5月21日。

    Args:
        country: 国家代码 (US, DE, UK, CA, JP)

    Returns:
        该国家当前的本地日期
    """
    tz = COUNTRY_TO_TIMEZONE.get(country, ZoneInfo("UTC"))
    return datetime.now(UTC).astimezone(tz).date()
