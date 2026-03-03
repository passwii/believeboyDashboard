from typing import Literal

from pydantic import BaseModel, Field


class ProductCostItem(BaseModel):
    id: int
    project_name: str
    sku: str
    asin: str
    first_leg_unit_cost: float
    fob_unit_cost: float
    currency: str
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
    asin: str = Field(min_length=1)
    first_leg_unit_cost: float = 0
    fob_unit_cost: float = 0
    currency: str = 'USD'
    sort_order: int | None = Field(default=None, ge=1)
    is_active: bool = True
    source_file: str | None = None


class ProductCostUpdate(BaseModel):
    sku: str = Field(min_length=1)
    asin: str = Field(min_length=1)
    first_leg_unit_cost: float = 0
    fob_unit_cost: float = 0
    currency: str = 'USD'
    sort_order: int | None = Field(default=None, ge=1)
    is_active: bool = True
    source_file: str | None = None


class ProductCostSortMove(BaseModel):
    direction: Literal['up', 'down']


class ProductCostBulkCreate(BaseModel):
    items: list[ProductCostCreate] = Field(min_length=1, max_length=10000)
    source_file: str | None = None


class ProductCostUpsertResponse(BaseModel):
    item: ProductCostItem
    action: str


class ProductCostBulkUpsertResponse(BaseModel):
    inserted: int
    updated: int
    total: int
