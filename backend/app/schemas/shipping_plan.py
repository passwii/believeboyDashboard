from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ShippingPlanSkuItem(BaseModel):
    sku: str
    asin: str | None = None
    product_name: str | None = None
    available_inventory: int | None = None
    inventory_snapshot_date: date | None = None
    base_dms: Decimal | None = None
    growth_factor: Decimal = Decimal("1.0")
    demand_source: str = "default"
    in_transit_quantity: int = 0
    draft_quantity: int = 0
    active_plan_remaining_quantity: int = 0
    confirmed_180d_sales_upper_bound: Decimal | None = None
    planned_180d_sales_upper_bound: Decimal | None = None
    data_quality: list[str] = Field(default_factory=list)


class ShippingPlanSkuListResponse(BaseModel):
    items: list[ShippingPlanSkuItem]
    total: int
    page: int
    page_size: int
    valid_forecast_sku_count: int
    missing_forecast_sku_count: int
    known_confirmed_sales_upper_bound: Decimal
    known_planned_sales_upper_bound: Decimal


class ShippingPlanGrowthFactorUpdate(BaseModel):
    project_id: int = Field(gt=0)
    country: str = Field(min_length=2, max_length=2)
    growth_factor: Decimal = Field(ge=0, max_digits=8, decimal_places=4)


class ShippingPlanGrowthFactorResponse(BaseModel):
    project_id: int
    country: str
    sku: str
    growth_factor: Decimal
    demand_source: str = "manual"


class ForecastPoint(BaseModel):
    forecast_date: date
    demand: Decimal | None
    confirmed_sales: Decimal | None
    planned_sales: Decimal | None
    confirmed_closing_inventory: Decimal | None
    planned_closing_inventory: Decimal | None
    historical_order_sales: int | None = None


class ForecastArrival(BaseModel):
    arrival_date: date | None
    sku: str
    quantity: int
    source_type: str
    reference: str | None = None
    data_quality: str | None = None


class ShippingPlanForecastResponse(BaseModel):
    project_id: int
    country: str
    sku: str
    as_of_date: date
    forecast_start_date: date
    forecast_end_date: date
    inventory_snapshot_date: date | None
    sales_baseline_start_date: date
    sales_baseline_end_date: date
    base_dms: Decimal | None
    growth_factor: Decimal
    demand_source: str
    data_quality: list[str]
    daily_points: list[ForecastPoint]
    arrivals: list[ForecastArrival]
    confirmed_180d_sales_upper_bound: Decimal | None
    planned_180d_sales_upper_bound: Decimal | None
    unverified_completed_quantity: int = 0
    overdue_shipment_quantity: int = 0
    overdue_plan_quantity: int = 0


class ShipmentHistoryMonth(BaseModel):
    month: str
    shipment_count: int
    quantity: int


class ShipmentHistoryResponse(BaseModel):
    project_id: int
    country: str
    etd_from: date
    etd_to: date
    months: list[ShipmentHistoryMonth]
    missing_etd_shipment_count: int
    missing_etd_quantity: int
    included_statuses: list[str] = ["in_transit", "completed"]
    date_basis: str = "ETD 作为 V1 计划发运日期代理，不代表实际离港日"


class ShippingPlanItemInput(BaseModel):
    sku: str = Field(min_length=1, max_length=128)
    quantity: int = Field(gt=0)

    @field_validator("sku")
    @classmethod
    def normalize_sku(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("sku cannot be empty")
        return value


class ShippingPlanBatchCreate(BaseModel):
    project_id: int = Field(gt=0)
    country: str = Field(min_length=2, max_length=2)
    name: str = Field(min_length=1, max_length=255)
    expected_arrival_date: date
    remark: str | None = None
    items: list[ShippingPlanItemInput] = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name cannot be empty")
        return value

    @model_validator(mode="after")
    def unique_skus(self) -> ShippingPlanBatchCreate:
        skus = [item.sku for item in self.items]
        if len(set(skus)) != len(skus):
            raise ValueError("batch SKU must be unique")
        return self


class ShippingPlanBatchUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    expected_arrival_date: date | None = None
    remark: str | None = None
    items: list[ShippingPlanItemInput] | None = None

    @model_validator(mode="after")
    def unique_skus(self) -> ShippingPlanBatchUpdate:
        if self.items is not None:
            skus = [item.sku for item in self.items]
            if len(set(skus)) != len(skus):
                raise ValueError("batch SKU must be unique")
        return self


class ShippingPlanAllocationCreate(BaseModel):
    plan_item_id: int = Field(gt=0)
    shipment_schedule_id: int = Field(gt=0)
    quantity: int = Field(gt=0)


class ShippingPlanAllocationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plan_item_id: int
    shipment_schedule_id: int
    sku: str
    quantity: int


class ShippingPlanBatchItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sku: str
    quantity: int
    allocated_quantity: int
    remaining_quantity: int
    allocations: list[ShippingPlanAllocationResponse]


class ShippingPlanBatchResponse(BaseModel):
    id: int
    project_id: int
    country: str
    name: str
    expected_arrival_date: date
    status: str
    remark: str | None
    items: list[ShippingPlanBatchItemResponse]


class ShippingPlanBatchListResponse(BaseModel):
    items: list[ShippingPlanBatchResponse]
    total: int


class ShippingPlanAllocationResult(BaseModel):
    allocation: ShippingPlanAllocationResponse
    plan_item_remaining_quantity: int
    shipment_sku_remaining_quantity: int
