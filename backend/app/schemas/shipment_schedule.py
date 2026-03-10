from __future__ import annotations

from pydantic import BaseModel, Field


class ShipmentScheduleListItem(BaseModel):
    id: int
    project_id: int
    project_name: str
    shipment_no: str
    tracking_no: str | None = None
    warehouse_code: str | None = None
    supplier_name: str | None = None
    forwarder_name: str | None = None
    shipping_method: str
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    expected_inbound_start_date: str | None = None
    expected_inbound_end_date: str | None = None
    shipment_status: str
    stat_date: str | None = None
    forwarder_update: str | None = None
    remark: str | None = None
    sku_count: int
    total_quantity: int
    updated_at: str


class ShipmentScheduleListResponse(BaseModel):
    items: list[ShipmentScheduleListItem]
    page: int
    page_size: int
    total: int | None = None
    has_next: bool


class ShipmentScheduleItemRow(BaseModel):
    id: int
    item_date: str | None = None
    sku: str
    quantity: int
    remark: str | None = None


class ShipmentScheduleDetail(BaseModel):
    id: int
    project_id: int
    project_name: str
    shipment_no: str
    tracking_no: str | None = None
    warehouse_code: str | None = None
    supplier_name: str | None = None
    forwarder_name: str | None = None
    shipping_method: str
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    expected_inbound_start_date: str | None = None
    expected_inbound_end_date: str | None = None
    booking_note: str | None = None
    forwarder_update: str | None = None
    remark: str | None = None
    shipment_status: str
    stat_date: str | None = None
    sku_count: int
    total_quantity: int
    items: list[ShipmentScheduleItemRow]
    updated_at: str


class ShipmentScheduleCreate(BaseModel):
    project_id: int = Field(gt=0)
    shipment_no: str = Field(min_length=1, max_length=100)
    tracking_no: str | None = Field(default=None, max_length=100)
    warehouse_code: str | None = Field(default=None, max_length=100)
    supplier_name: str | None = Field(default=None, max_length=100)
    forwarder_name: str | None = Field(default=None, max_length=100)
    shipping_method: str = Field(min_length=1, max_length=50)
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    expected_inbound_start_date: str | None = None
    expected_inbound_end_date: str | None = None
    booking_note: str | None = None
    forwarder_update: str | None = None
    remark: str | None = None
    shipment_status: str = Field(min_length=1, max_length=30)
    stat_date: str | None = None
    source_file: str | None = None


class ShipmentScheduleUpdate(BaseModel):
    project_id: int = Field(gt=0)
    tracking_no: str | None = Field(default=None, max_length=100)
    warehouse_code: str | None = Field(default=None, max_length=100)
    supplier_name: str | None = Field(default=None, max_length=100)
    forwarder_name: str | None = Field(default=None, max_length=100)
    shipping_method: str = Field(min_length=1, max_length=50)
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    expected_inbound_start_date: str | None = None
    expected_inbound_end_date: str | None = None
    booking_note: str | None = None
    forwarder_update: str | None = None
    remark: str | None = None
    shipment_status: str = Field(min_length=1, max_length=30)
    stat_date: str | None = None
    source_file: str | None = None


class ShipmentItemsImportResponse(BaseModel):
    shipment_schedule_id: int
    shipment_no: str
    inserted: int
    replaced: int
    total_quantity: int
