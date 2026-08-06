"""Pytest setup for autoReportUpload unit tests.

Unit tests only — no real database.  ``autoReportUpload/config.py`` resolves
``DATABASE_URL`` at import time and exits when it is unset, so a dummy value
must be in place before any daemon module is imported.  Every test mocks the
DB session, so the URL never gets connected to.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_AUTOREPORT_ROOT = Path(__file__).resolve().parents[1]  # autoReportUpload/
_REPO_ROOT = _AUTOREPORT_ROOT.parent

for _path in (str(_REPO_ROOT / "backend"), str(_AUTOREPORT_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://dummy:dummy@localhost:5432/dummy",
)
