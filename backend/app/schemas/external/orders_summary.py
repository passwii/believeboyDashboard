"""Orders Summary response schemas for the external API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.external.common import PeriodInfo


class OrdersSummaryRow(BaseModel):
    """Single row in the orders summary — aggregated by order (deduplicated)."""

    model_config = ConfigDict(from_attributes=True)

    amazon_order_id: str
    purchase_date_pt: str  # YYYY-MM-DD
    order_status: str
    fulfillment_channel: str  # "Amazon" | "Merchant"
    fulfillment_label: str  # "FBA（亚马逊配送）" | "FBM（自发货配送）"
    sku: Optional[str] = None
    asin: Optional[str] = None
    product_name: Optional[str] = None
    quantity: int
    item_price: float
    shipping_price: float
    currency: Optional[str] = None
    country: str
    is_counted_sales: bool


class OrdersSummaryAggregateRow(BaseModel):
    """Aggregated orders summary (when aggregate=true)."""

    model_config = ConfigDict(from_attributes=True)

    total_orders: int = 0
    total_quantity: int = 0
    total_sales_amount: float = Field(default=0.0, alias="total_sales_amount")
    currency: Optional[str] = None
    fba_orders: int = 0
    fbm_orders: int = 0


class OrdersSummaryResponse(BaseModel):
    """Response wrapper for GET /external/projects/{project_id}/orders/summary."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    data: List[OrdersSummaryRow]
    aggregate: Optional[OrdersSummaryAggregateRow] = None
    summary: Optional[OrdersSummaryAggregateRow] = None


class OrdersSummaryRawResponse(BaseModel):
    """Response wrapper for GET /external/projects/{project_id}/orders/summary-raw (if needed)."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    data: List[OrdersSummaryRow]
    summary: dict = Field(default_factory=dict)