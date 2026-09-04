"""Services package.

This module re-exports all service modules for backward compatibility.
New code should import directly from subpackages.
"""
from __future__ import annotations

__all__ = [
    # Legacy service modules (kept for backward compatibility)
    "analysis_report_runtime_service",
    "job_service",
    "monthly_report_runtime_service",
    "project_service",
    "upload_service",
    "exchange_rate_service",
    "inventory_analysis_service",
    "project_goal_service",
    "reconciliation_service",
    "report_reconciliation_service",
    # Subpackages
    "ad",
    "ai",
    "category",
    "daily",
    "data",
    "digital",
    "financial",
    "infra",
    "inventory",
    "payment",
    "pricing",
    "product",
    "report",
    "shipment",
]
