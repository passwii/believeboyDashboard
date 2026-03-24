from typing import Literal

from pydantic import BaseModel, Field


class ProductCostItem(BaseModel):
    id: int
    project_name: str
    sku: str
    asin: str
    fnsku: str | None = None
    product_name: str | None = None
    fob_unit_cost: float
    first_leg_cost_rmb: float
    package_length_cm: float
    package_width_cm: float
    package_height_cm: float
    weight_kg: float
    carton_length_cm: float
    carton_width_cm: float
    carton_height_cm: float
    carton_weight_kg: float
    units_per_carton: int
    currency: str
    country: str
    sort_order: int
    is_active: bool


class ProductCostsPage(BaseModel):
    items: list[ProductCostItem]
    page: int
    page_size: int
    total: int | None = None
    has_next: bool


class ProductCostCreate(BaseModel):
    project_name: str = Field(min_length=1)
    sku: str = Field(min_length=1)
    asin: str = ""
    fnsku: str | None = None
    product_name: str | None = None
    fob_unit_cost: float | None = Field(default=None, ge=0, le=100000000)
    first_leg_cost_rmb: float | None = Field(default=None, ge=0, le=100000000)
    package_length_cm: float | None = Field(default=None, ge=0, le=100000)
    package_width_cm: float | None = Field(default=None, ge=0, le=100000)
    package_height_cm: float | None = Field(default=None, ge=0, le=100000)
    weight_kg: float | None = Field(default=None, ge=0, le=100000)
    carton_length_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_width_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_height_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_weight_kg: float | None = Field(default=None, ge=0, le=100000)
    units_per_carton: int | None = Field(default=None, ge=0, le=100000000)
    currency: str = "CNY"
    country: str = "US"
    sort_order: int | None = Field(default=None, ge=1)
    is_active: bool = True
    source_file: str | None = None


class ProductCostUpdate(BaseModel):
    sku: str = Field(min_length=1)
    asin: str = ""
    fnsku: str | None = None
    product_name: str | None = None
    fob_unit_cost: float | None = Field(default=None, ge=0, le=100000000)
    first_leg_cost_rmb: float | None = Field(default=None, ge=0, le=100000000)
    package_length_cm: float | None = Field(default=None, ge=0, le=100000)
    package_width_cm: float | None = Field(default=None, ge=0, le=100000)
    package_height_cm: float | None = Field(default=None, ge=0, le=100000)
    weight_kg: float | None = Field(default=None, ge=0, le=100000)
    carton_length_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_width_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_height_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_weight_kg: float | None = Field(default=None, ge=0, le=100000)
    units_per_carton: int | None = Field(default=None, ge=0, le=100000000)
    currency: str = "CNY"
    country: str = "US"
    sort_order: int | None = Field(default=None, ge=1)
    is_active: bool = True
    source_file: str | None = None


class ProductCostSortMove(BaseModel):
    direction: Literal["up", "down"]


class ProductCostBulkCreate(BaseModel):
    items: list[ProductCostCreate] = Field(min_length=1, max_length=10000)
    source_file: str | None = None


class ProductCostImportResponse(BaseModel):
    inserted: int
    updated: int
    total: int
    skipped: int = 0


class ProductCostUpsertResponse(BaseModel):
    item: ProductCostItem
    action: str


class ProductCostBulkUpsertResponse(BaseModel):
    inserted: int
    updated: int
    total: int


class ProductCostFirstLegRecalculateRequest(BaseModel):
    project_name: str = Field(min_length=1)
    unit_price_per_kg_rmb: float = Field(gt=0, le=1000000)
    sku: str | None = None
    asin: str | None = None
    country: str | None = None
    is_active: bool | None = None


class ProductCostFirstLegRecalculateResponse(BaseModel):
    updated: int
    unit_price_per_kg_rmb: float
