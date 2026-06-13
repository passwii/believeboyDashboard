"""Per-frequency AI summary timeout (read from .env, default 30s).

`0` is an explicit opt-in to disable AI and force the fallback summary.
The previous "0 as default fallback" footgun (BEL-58) is gone: if you
want AI off, set the env var to 0; if you don't set it, the default 30s
applies.
"""

from __future__ import annotations

import logging
import os
from typing import Final

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT_SEC: Final[float] = 30.0


def get_ai_timeout_sec(frequency: str) -> float:
    """Per-frequency AI summary timeout in seconds.

    Env var name: ``AI_SUMMARY_TIMEOUT_SEC_<FREQ>`` (uppercase).
    Fallback: ``AI_SUMMARY_TIMEOUT_SEC`` (single shared value).
    Final fallback: ``30.0``.

    Returns 0.0 if the env var is explicitly "0" — the supported
    "disable AI" switch (the report will use the fallback text summary).
    """
    freq = (frequency or "daily").strip().lower()
    per_freq = os.environ.get(f"AI_SUMMARY_TIMEOUT_SEC_{freq.upper()}")
    if per_freq is not None and per_freq.strip():
        try:
            return float(per_freq)
        except ValueError:
            logger.warning(
                "AI_SUMMARY_TIMEOUT_SEC_%s=%r is not a number, falling back to default",
                freq.upper(),
                per_freq,
            )
    shared = os.environ.get("AI_SUMMARY_TIMEOUT_SEC")
    if shared is not None and shared.strip():
        try:
            return float(shared)
        except ValueError:
            logger.warning(
                "AI_SUMMARY_TIMEOUT_SEC=%r is not a number, falling back to default",
                shared,
            )
    return _DEFAULT_TIMEOUT_SEC
