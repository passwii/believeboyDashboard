"""
Payment report locale utilities — re-exported from app.utils.payment_locale.

This module exists for backward compatibility. All core logic lives in
app.utils.payment_locale to avoid heavy ORM/Settings imports in packages
that only need locale parsing (e.g. autoReportUpload, recognition utils).
"""
from app.utils.payment_locale import *  # noqa: F401, F403, E402
