"""Business summary schemas for the external API."""
from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.external.common import PeriodInfo


class BusinessSummaryRow(BaseModel):
    """Single ASIN-level business row from analysis_business_rows."""

    model_config = ConfigDict(from_attributes=True)

    asin: Optional[str] = None
    page_views: int = 0
    sessions: int = 0
    units_ordered: int = 0
    ordered_sales_amount: float = 0.0
    cvr: float = 0.0  # percent


class BusinessSummaryShopCalculationRow(BaseModel):
    """Shop Calculation snapshot row (cost, profit, breakeven)."""

    model_config = ConfigDict(from_attributes=True)

    asin: Optional[str] = None
    sku: Optional[str] = None
    ddp_cost_rmb: float = 0.0
    fba_fee_usd: float = 0.0
    profit_amount_usd: float = 0.0
    profit_rate: float = 0.0  # percent
    breakeven_price_usd: float = 0.0
    breakeven_units: int = 0


class BusinessSummaryDetailRow(BaseModel):
    """Merged detail row: business metrics + shop calculation."""

    model_config = ConfigDict(from_attributes=True)

    asin: Optional[str] = None
    sku: Optional[str] = None
    page_views: int = 0
    sessions: int = 0
    units_ordered: int = 0
    ordered_sales_amount: float = 0.0
    cvr: float = 0.0
    ddp_cost_rmb: float = 0.0
    fba_fee_usd: float = 0.0
    profit_amount_usd: float = 0.0
    profit_rate: float = 0.0
    breakeven_price_usd: float = 0.0
    breakeven_units: int = 0


class BusinessSummaryAggregate(BaseModel):
    """Aggregate totals across all ASINs."""

    model_config = ConfigDict(from_attributes=True)

    total_asins: int = 0
    total_page_views: int = 0
    total_sessions: int = 0
    total_units_ordered: int = 0
    total_ordered_sales_amount: float = 0.0
    overall_cvr: float = 0.0
    total_profit_amount_usd: float = 0.0
    overall_profit_rate: float = 0.0


class BusinessSummaryAggregateRow(BaseModel):
    """Aggregated row per ASIN with shop calculation data."""

    model_config = ConfigDict(from_attributes=True)

    asin: str
    page_views: int = 0
    sessions: int = 0
    units_ordered: int = 0
    ordered_sales_amount: float = 0.0
    cvr: float = 0.0
    cost_total: float = 0.0
    profit: float = 0.0
    profit_rate: float = 0.0
    breakeven_units: int = 0


class BusinessSummaryDetailRow(BaseModel):
    """Merged detail row: business metrics + shop calculation."""

    model_config = ConfigDict(from_attributes=True)

    asin: str
    page_views: int = 0
    sessions: int = 0
    units_ordered: int = 0
    ordered_sales_amount: float = 0.0
    cvr: float = 0.0
    cost_total: float = 0.0
    profit: float = 0.0
    profit_rate: float = 0.0
    breakeven_units: int = 0


class BusinessSummaryAggregate(BaseModel):
    """Aggregate totals across all ASINs."""

    model_config = ConfigDict(from_attributes=True)

    total_asins: int = 0
    total_page_views: int = 0
    total_sessions: int = 0
    total_units_ordered: int = 0
    total_sales_amount: float = 0.0
    total_cost: float = 0.0
    total_profit: float = 0.0
    overall_cvr: float = 0.0
    overall_profit_rate: float = 0.0


class BusinessSummaryResponse(BaseModel):
    """Response wrapper for GET /external/projects/{project_id}/business-summary."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    detail: List[BusinessSummaryDetailRow] = Field(default_factory=list)
    aggregate: BusinessSummaryAggregate
    summary: BusinessSummaryAggregate  # alias for backwards compatibility