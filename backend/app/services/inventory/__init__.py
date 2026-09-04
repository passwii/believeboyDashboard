"""Inventory services package.

Business logic for inventory analysis and replenishment.
"""
from __future__ import annotations

from app.services.inventory.replenishment import (
    IN_TRANSIT_STATUSES,
    RISK_HEALTHY,
    RISK_LONG_TERM_OUT_OF_STOCK,
    RISK_OUT_OF_STOCK,
    RISK_PENDING,
    RISK_SEVERE_SLOW_MOVING,
    RISK_SHORT_TERM_OUT_OF_STOCK,
    RISK_SLOW_MOVING,
    list_inventory_replenishment_analysis,
    list_inventory_replenishment_shipments,
    list_snapshot_options,
    upsert_inventory_replenishment_setting,
)

__all__ = [
    "IN_TRANSIT_STATUSES",
    "RISK_HEALTHY",
    "RISK_LONG_TERM_OUT_OF_STOCK",
    "RISK_OUT_OF_STOCK",
    "RISK_PENDING",
    "RISK_SEVERE_SLOW_MOVING",
    "RISK_SHORT_TERM_OUT_OF_STOCK",
    "RISK_SLOW_MOVING",
    "list_inventory_replenishment_analysis",
    "list_inventory_replenishment_shipments",
    "list_snapshot_options",
    "upsert_inventory_replenishment_setting",
]
