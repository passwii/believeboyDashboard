"""Compat shim — re-exports from app.services.daily.ad."""
from __future__ import annotations

import warnings

warnings.warn(
    "app.services.daily.ad_analysis is deprecated, use app.services.daily.ad instead",
    DeprecationWarning,
    stacklevel=2,
)

from app.services.daily.ad import _load_ad_metrics  # noqa: F401, E402
