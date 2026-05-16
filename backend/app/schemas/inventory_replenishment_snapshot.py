from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class InventoryReplenishmentSnapshotItemSchema(BaseModel):
    source_row_no: int
    sku: str
    asin: str | None = None
    available_inventory: int
    in_transit_quantity: int
    dms_30: float | None = None
    dms_14: float | None = None
    dms_7: float | None = None
    dms_3: float | None = None
    base_dms: float | None = None
    safety_factor: float
    production_lead_days: int
    shipping_days: int
    weighted_dms: float | None = None
    sellable_days: float | None = None
    sellout_date: str | None = None
    sellout_date_with_transit: str | None = None
    replenishment_order_date: str | None = None
    warehouse_entry_date: str | None = None
    shipment_order_date: str | None = None
    estimated_replenishment_quantity: int | None = None
    risk_status: str
    risk_anchor_date: str | None = None


class InventoryReplenishmentSnapshotSummary(BaseModel):
    sku_count: int
    out_of_stock_risk_count: int
    healthy_count: int
    slow_moving_count: int
    pending_data_count: int
    total_available_inventory: int
    total_in_transit_quantity: int


class InventoryReplenishmentSnapshotListItem(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    snapshot_date: date
    is_current: bool
    name: str | None = None
    description: str | None = None
    inventory_report_date: date | None = None
    business_report_date: date | None = None
    sales_report_date: date | None = None
    row_count: int
    created_by: str | None = None
    created_at: str
    summary: InventoryReplenishmentSnapshotSummary


class InventoryReplenishmentSnapshotDetail(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    snapshot_date: date
    is_current: bool
    name: str | None = None
    description: str | None = None
    inventory_report_date: date | None = None
    business_report_date: date | None = None
    sales_report_date: date | None = None
    row_count: int
    created_by: str | None = None
    created_at: str
    summary: InventoryReplenishmentSnapshotSummary
    items: list[InventoryReplenishmentSnapshotItemSchema]


class CreateSnapshotRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=512)