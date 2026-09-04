"""DEPRECATED — analysis models now live in ``app.models`` (Alembic-managed).

All consumers should import from ``app.models`` directly.
This module re-exports the canonical names as a safety net for any
callers that were not yet updated.

Do NOT add new models or edits here.
"""
from __future__ import annotations

# Re-export from canonical source so any stale imports still resolve
from app.models import (  # noqa: F401
    AnalysisAdProductRow,
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
)
