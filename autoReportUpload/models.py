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
# Note: AnalysisAdProductRow intentionally removed — A 表 (analysis_ad_product_rows)
# 已废弃 (alembic 152 已 DROP). All ad data now lives in C 表 (ad_upload_files +
# 10 detail row tables). See backend/alembic/versions/20260601_152_drop_ad_product_report_from_a_table.py
from app.models import (  # noqa: E402
    AnalysisBusinessRow,
    AnalysisPaymentRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    # 库存分类账（BEL-428）：批次表用于 RPA 重复文件检测（_find_sha256_duplicates）
    InventoryLedgerIngestBatch,
    Project,
    ReportUploadLog,
    ReturnCustomerComment,
    SkuRecord as ProductCost,  # product_costs table — backend calls it SkuRecord
    AutoReportUploadLog,
    # Ad C 表 (ad_upload_*) — needed for ad report persistence
    AdUploadFile,
    AdUploadBudgetRow,
    AdUploadCampaignRow,
    AdUploadInvalidTrafficRow,
    AdUploadPlacementRow,
    AdUploadPromotedProductRow,
    AdUploadPurchasedProductRow,
    AdUploadSearchTermRow,
    AdUploadSearchTermShareRow,
    AdUploadTargetRow,
    AdUploadTimeTrendRow,
    # Digital Employee models — used by emit_event.py to report task progress
    DigitalEmployee,
    DigitalEmployeeTask,
    DigitalEmployeeLog,
)
