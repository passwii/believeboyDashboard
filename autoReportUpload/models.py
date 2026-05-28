"""
SQLAlchemy models for the auto-report-upload service.

All ORM models are imported from the backend (``backend/app/models/``), which
is the Alembic-managed single source of truth.  ``autoReportUpload`` adds the
backend directory to ``sys.path`` at startup so every import resolves against
the same ``Base`` / ``MetaData`` instance — avoiding duplicate-table errors.
"""

from __future__ import annotations

import sys
from pathlib import Path

# ── Add backend to path so we can import app.models / app.db.session ──────
_BACKEND_PATH = Path(__file__).resolve().parent.parent / "backend"
if str(_BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(_BACKEND_PATH))

# Re-export every model that autoReportUpload code needs, from the single
# canonical source.  Do NOT re-declare any table that backend models already
# define — SQLAlchemy raises ``InvalidRequestError: Table '…' is already
# defined for this MetaData instance`` otherwise.

from app.db.session import Base  # noqa: E402, F401

# Analysis models
from app.models import (  # noqa: E402
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    Project,
    ReportUploadLog,
    ReturnCustomerComment,
    SkuRecord as ProductCost,  # product_costs table — backend calls it SkuRecord
)
