"""Shared constants used across multiple services.

This module centralizes hard-coded values that appear in (or may be
needed by) more than one service, so every downstream module can import
a single canonical definition instead of maintaining its own copy.
"""

from __future__ import annotations

from decimal import Decimal

TWO_DP = Decimal("0.01")

# ─── Time-zone offset (used by parsers, monthly-report, etc.) ────────────────

TZ_OFFSET_BY_ABBR: dict[str, int] = {
    "UTC": 0,
    "GMT": 0,
    "PST": -8,
    "PDT": -7,
    "MST": -7,
    "MDT": -6,
    "CST": -6,
    "CDT": -5,
    "EST": -5,
    "EDT": -4,
}

# ─── Inventory / replenishment constants ────────────────────────────────────

RECENT_SALES_LAG_DAYS: int = 2
"""Number of lag days applied when computing the recent-sales window."""

RECENT_SALES_WINDOW_DAYS: int = 3
"""Size (in days) of the recent-sales counting window."""

DEFAULT_PRODUCTION_LEAD_DAYS: int = 20
DEFAULT_SHIPPING_DAYS: int = 25
DEFAULT_SAFETY_FACTOR: Decimal = Decimal("0.20")

# ─── Default country ────────────────────────────────────────────────────────

DEFAULT_COUNTRY: str = "US"

# Report types that are stored per-period (period_start_date / period_end_date).
# Inventory reports use snapshot_at instead and are NOT in this set.
PERIODIC_REPORT_TYPES: set[str] = {
    "business_report",
    "payment_report",
    "ad_product_report",
    "sales_report",
    "return_report",
}

SUPPORTED_REPORT_TYPES = {
    "inventory_report",
    # 旧值仅保留给历史调用方（入库层仍按表头路由），新识别不再输出。
    "inventory_ledger",
    "inventory_ledger_summary",
    "inventory_ledger_detail",
    "business_report",
    # ad_product_report 已于 2026-06-01 迁到 C 表（ad_upload_files / ad_upload_promoted_product_rows），
    # 不再通过 /api/v1/report-upload/commit 入库。如需提交广告报表，请使用 /api/v1/ad-upload/commit。
    "ad_search_term_report",
    "sales_report",
    "payment_report",
    "return_report",
}

# ─── File-upload limits ─────────────────────────────────────────────────────

MAX_CONTENT_LENGTH: int = 50000  # AI text upload max characters
MAX_EXCEL_ROWS: int = 1000  # AI file upload max rows
MAX_EXCEL_COLS: int = 20  # AI file upload max columns

# ─── AI Chat / search constants ──────────────────────────────────────────────

AI_CHAT_SEARCH_SNIPPET_MAX_LENGTH: int = 1200
AI_CHAT_SEARCH_SOURCE_CARD_MAX_LENGTH: int = 280
AI_CHAT_MAX_RETRIES: int = 2

# ─── Inventory match thresholds (used by parsers) ─────────────────────────────

INVENTORY_PROJECT_MATCH_MIN_ROWS: int = 5
INVENTORY_PROJECT_MATCH_MIN_RATIO: float = 0.6

# ─── Pagination defaults ────────────────────────────────────────────────────

DEFAULT_PAGE: int = 1
DEFAULT_PAGE_SIZE: int = 20

# ─── Business enumerations (shared by multiple services) ─────────────────────

ALLOWED_COMMISSION_BASIS = {"sales_amount", "cash_received", "profit_margin"}
ALLOWED_METRIC_TYPES = {"sales_amount"}
