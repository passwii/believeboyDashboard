"""Marketplace URL builders.

Single canonical source for "given a (country, asin) pair, what is the
canonical product-detail URL?". Shared by:

- The internal SKU Info API (``/api/v1/sku-info``)
- The External API (``/api/v1/external/projects/{id}/sku-info``)

The mapping is intentionally a static module-level constant — Amazon's
marketplace domains are not under our control and the cadence of change
is measured in years. If/when we surface non-Amazon marketplaces (Walmart,
Rakuten, etc.), extend ``MARKETPLACE_DOMAINS`` rather than introducing a
per-marketplace module.

Consumers should import from here::

    from app.utils.marketplace_url import build_marketplace_url

Usage::

    >>> build_marketplace_url("US", "B0DRV1KJTF")
    'https://www.amazon.com/dp/B0DRV1KJTF'
    >>> build_marketplace_url("de", "B0DRV1KJTF")  # case-insensitive
    'https://www.amazon.de/dp/B0DRV1KJTF'
    >>> build_marketplace_url("", "B0DRV1KJTF")     # empty country → None
    >>> build_marketplace_url("ZZ", "B0DRV1KJTF")  # unknown country → None
"""

from __future__ import annotations

# Country (ISO-2) → Amazon marketplace host (no scheme, no trailing slash).
# Add new sites here when the business opens them — do not scatter literals
# across endpoints / frontends.
MARKETPLACE_DOMAINS: dict[str, str] = {
    "US": "www.amazon.com",
    "UK": "www.amazon.co.uk",
    "DE": "www.amazon.de",
    "FR": "www.amazon.fr",
    "IT": "www.amazon.it",
    "ES": "www.amazon.es",
    "JP": "www.amazon.co.jp",
    "CA": "www.amazon.ca",
    "MX": "www.amazon.com.mx",
}


def build_marketplace_url(country: str | None, asin: str | None) -> str | None:
    """Build a canonical Amazon product-detail URL for the given SKU.

    Returns ``https://<host>/dp/<asin>`` for known marketplaces. Country
    matching is case-insensitive and whitespace-stripped (matching
    ``app.utils.country.normalize_country`` semantics).

    Returns ``None`` when any of the following is true:

    - ``country`` is empty / whitespace / not in the mapping table
    - ``asin`` is empty / whitespace
    - Either argument is ``None``

    The function never raises — it is called from request hot paths
    (one call per SKU row in the list response), so silent ``None``
    keeps the endpoint contract simple. Callers should render ``None``
    as a plain (non-link) ASIN cell on the UI.
    """
    if not asin or not asin.strip():
        return None
    if not country or not country.strip():
        return None

    normalized = country.strip().upper()
    host = MARKETPLACE_DOMAINS.get(normalized)
    if host is None:
        return None

    return f"https://{host}/dp/{asin.strip()}"
