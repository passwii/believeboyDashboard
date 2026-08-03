"""Re-export shim — period helpers live in :mod:`app.utils.period`.

Kept so existing imports like
``from app.api.v1.endpoints.external._period import parse_period_v2``
(used by ad-campaign and other external endpoints) continue to work
without changes after the helpers were promoted to a shared util in
BEL-370 P1 #4 (inventory-ledger ``?period=`` syntax unification).

New code should import from :mod:`app.utils.period` directly.
"""

from app.utils.period import (
    PERIOD_ALIASES,
    parse_period,
    parse_period_v2,
)

__all__ = ["PERIOD_ALIASES", "parse_period", "parse_period_v2"]
