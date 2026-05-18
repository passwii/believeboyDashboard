from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class InventoryReplenishmentSummary(BaseModel):
    sku_count: int
    out_of_stock_risk_count: int
    healthy_count: int
    slow_moving_count: int
    pending_data_count: int
    total_available_inventory: int
    total_in_transit_quantity: int


class InventoryReplenishmentListItem(BaseModel):
    project_id: int
    project_name: str
    sku: str
    country: str
    asin: str | None = None
    available_inventory: int
    in_transit_quantity: int
    dms_30: float | None = None
    dms_14: float | None = None
    dms_7: float | None = None
    dms_3: float | None = None
    base_dms: float | None = None
    safety_factor: float
    weighted_dms: float | None = None
    sellable_days: float | None = None
    sellout_date: str | None = None
    sellout_date_with_transit: str | None = None
    production_lead_days: int
    shipping_days: int
    replenishment_order_date: str | None = None
    warehouse_entry_date: str | None = None
    shipment_order_date: str | None = None
    estimated_replenishment_quantity: int | None = None
    risk_status: str
    risk_anchor_date: str | None = None


class InventoryReplenishmentListResponse(BaseModel):
    items: list[InventoryReplenishmentListItem]
    summary: InventoryReplenishmentSummary
    page: int
    page_size: int
    total: int
    has_next: bool


class InventoryReplenishmentSettingUpdate(BaseModel):
    asin: str | None = Field(default=None, max_length=64)
    production_lead_days: int = Field(ge=0)
    shipping_days: int = Field(ge=0)
    safety_factor: float = Field(ge=0)


class InventoryReplenishmentSettingItem(BaseModel):
    project_id: int
    project_name: str
    sku: str
    country: str
    asin: str | None = None
    production_lead_days: int
    shipping_days: int
    safety_factor: float


class InventoryReplenishmentShipmentItem(BaseModel):
    schedule_id: int
    shipment_no: str
    shipment_status: str
    shipping_method: str
    etd_date: str | None = None
    eta_date: str | None = None
    actual_inbound_date: str | None = None
    tracking_no: str | None = None
    quantity: int
    remark: str | None = None
    updated_at: str


class InventoryReplenishmentShipmentResponse(BaseModel):
    project_id: int
    sku: str
    items: list[InventoryReplenishmentShipmentItem]


class InventoryAnalysisSummary(BaseModel):
    sku_count: int
    out_of_stock_count: int
    aging_sku_count: int
    over_aged_sku_count: int
    total_available_qty: int
    total_age_0_90_qty: int
    total_age_91_180_qty: int
    total_age_181_270_qty: int
    total_age_271_365_qty: int
    total_age_365_plus_qty: int
    action_type_count: int


class InventoryAnalysisItem(BaseModel):
    project_id: int
    project_name: str
    country: str
    sku: str
    asin: str | None = None
    available_qty: int
    age_0_90_qty: int
    age_91_180_qty: int
    age_181_270_qty: int
    age_271_365_qty: int
    age_365_plus_qty: int
    recommended_action: str | None = None
    recommended_action_label: str
    stock_status: str
    aging_status: str


class InventoryAnalysisResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    report_date: date | None = None
    summary: InventoryAnalysisSummary
    action_options: list[str]
    items: list[InventoryAnalysisItem]


class InventorySnapshotOption(BaseModel):
    report_date: date
    is_current: bool


class CalendarRowItem(BaseModel):
    """Single SKU row for calendar/gantt view."""
    project_id: int
    project_name: str
    sku: str
    country: str
    risk_status: str
    # Timeline anchors
    today: str
    sellout_date: str | None = None
    order_date: str | None = None
    warehouse_entry_date: str | None = None
    # Current state
    available_inventory: int
    in_transit_quantity: int
    weighted_dms: float | None = None
    estimated_quantity: int | None = None
    # Warning flags
    is_slow_moving: bool = False
    is_critical: bool = False


class CalendarResponse(BaseModel):
    items: list[CalendarRowItem]
    page: int
    page_size: int
    total: int
    has_next: bool
