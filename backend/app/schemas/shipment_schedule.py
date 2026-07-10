from __future__ import annotations

from pydantic import BaseModel, Field


class ShipmentScheduleListItem(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    shipment_no: str
    tracking_no: str | None = None
    warehouse_code: str | None = None
    forwarder_name: str | None = None
    shipping_method: str
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    actual_inbound_date: str | None = None
    shipment_status: str
    remark: str | None = None
    sku_count: int
    total_quantity: int
    logistics_unit_price: float
    total_volume_m3: float
    total_chargeable_weight_kg: float
    logistics_total_price: float
    include_in_history_shipping_calc: bool
    updated_at: str
    shipment_batch: str | None = None


class ShipmentScheduleListResponse(BaseModel):
    items: list[ShipmentScheduleListItem]
    page: int
    page_size: int
    total: int | None = None
    has_next: bool


class ShipmentScheduleCostSummary(BaseModel):
    shipment_count: int
    total_sku: int
    total_quantity: int
    total_chargeable_weight_kg: float
    total_logistics_cost: float


class ShipmentScheduleItemRow(BaseModel):
    id: int
    item_date: str | None = None
    sku: str
    quantity: int
    carton_count: int | None = None
    remark: str | None = None
    volume_m3: float = 0
    actual_weight_kg: float = 0
    volumetric_weight_kg: float = 0
    chargeable_weight_kg: float = 0
    estimated_logistics_cost: float = 0
    average_logistics_unit_price: float = 0


class ShipmentScheduleItemInput(BaseModel):
    sku: str = Field(min_length=1, max_length=100)
    quantity: int = Field(gt=0)
    carton_count: int | None = Field(default=None, ge=0)
    item_date: str | None = None
    remark: str | None = None


class ShipmentScheduleDetail(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    shipment_no: str
    tracking_no: str | None = None
    warehouse_code: str | None = None
    forwarder_name: str | None = None
    shipping_method: str
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    actual_inbound_date: str | None = None
    remark: str | None = None
    shipment_status: str
    sku_count: int
    total_quantity: int
    logistics_unit_price: float
    total_volume_m3: float
    total_chargeable_weight_kg: float
    logistics_total_price: float
    include_in_history_shipping_calc: bool
    items: list[ShipmentScheduleItemRow]
    updated_at: str
    shipment_batch: str | None = None


class ShipmentCostCalculateRequest(BaseModel):
    logistics_unit_price: float = Field(ge=0)


class ShipmentScheduleCreate(BaseModel):
    project_id: int = Field(gt=0)
    country: str = Field(default='US', min_length=2, max_length=8)
    shipment_no: str = Field(min_length=1, max_length=100)
    tracking_no: str | None = Field(default=None, max_length=100)
    warehouse_code: str | None = Field(default=None, max_length=100)
    forwarder_name: str | None = Field(default=None, max_length=100)
    shipping_method: str = Field(min_length=1, max_length=50)
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    actual_inbound_date: str | None = None
    logistics_unit_price: float = Field(default=0, ge=0)
    include_in_history_shipping_calc: bool = True
    remark: str | None = None
    shipment_status: str = Field(min_length=1, max_length=30)
    source_file: str | None = None
    shipment_batch: str | None = Field(default=None, max_length=100)


class ShipmentScheduleUpdate(BaseModel):
    project_id: int = Field(gt=0)
    country: str = Field(default='US', min_length=2, max_length=8)
    shipment_no: str = Field(min_length=1, max_length=100)
    tracking_no: str | None = Field(default=None, max_length=100)
    warehouse_code: str | None = Field(default=None, max_length=100)
    forwarder_name: str | None = Field(default=None, max_length=100)
    shipping_method: str = Field(min_length=1, max_length=50)
    created_date: str | None = None
    etd_date: str | None = None
    eta_date: str | None = None
    actual_inbound_date: str | None = None
    logistics_unit_price: float = Field(default=0, ge=0)
    include_in_history_shipping_calc: bool = True
    remark: str | None = None
    shipment_status: str = Field(min_length=1, max_length=30)
    source_file: str | None = None
    items: list[ShipmentScheduleItemInput] | None = None
    shipment_batch: str | None = Field(default=None, max_length=100)


class ShipmentItemsImportResponse(BaseModel):
    shipment_schedule_id: int
    shipment_no: str
    inserted: int
    replaced: int
    total_quantity: int


class ShipmentSchedulesImportResponse(BaseModel):
    inserted: int
    shipment_nos: list[str]


class ShipmentSkuSummaryItem(BaseModel):
    project_id: int
    project_name: str
    country: str
    sku: str
    shipment_count: int
    total_quantity: int
    total_chargeable_weight_kg: float
    total_logistics_cost: float
    average_logistics_unit_price: float


class ShipmentSkuSummaryResponse(BaseModel):
    items: list[ShipmentSkuSummaryItem]


class ShipmentFbaBoxDetailItem(BaseModel):
    project_id: int
    project_name: str
    country: str
    shipment_no: str
    warehouse_code: str | None = None
    sku: str
    product_name: str | None = None
    asin: str | None = None
    fnsku: str | None = None
    package_length_cm: float | None = None
    package_width_cm: float | None = None
    package_height_cm: float | None = None
    weight_kg: float | None = None
    length_cm: float
    width_cm: float
    height_cm: float
    carton_weight_kg: float | None = None
    quantity: int
    units_per_carton: int
    carton_count: int
    full_carton_count: int
    partial_carton_units: int
    outer_box_text: str
    total_weight_kg: float
    total_volume_m3: float
    fba_label_prefix: str
    tracking_no: str | None = None
    product_image_thumbnail_r2_url: str | None = None
    product_image_r2_url: str | None = None


class ShipmentFbaBoxDetailResponse(BaseModel):
    project_ids: list[int]
    project_names: list[str]
    countries: list[str]
    shipment_nos: list[str]
    items: list[ShipmentFbaBoxDetailItem]


class ShipmentBatchHiddenDeleteRequest(BaseModel):
    project_id: int = Field(gt=0)
    country: str = Field(min_length=2, max_length=8)
    shipment_batch: str = Field(min_length=1, max_length=100)
