from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class DailyAnalysisConsoleResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    start_date: str
    end_date: str
    requested_days: int
    summary_days: int
    detail_rows: int
    sales_source_days: int
    ad_source_days: int
    inventory_source_days: int
    missing_dates: list[str]
    latest_sales_date: str | None
    latest_ad_date: str | None
    latest_inventory_date: str | None


class DailyAnalysisSummaryRow(BaseModel):
    date: str
    order_qty: int
    sales_amount: float
    impressions: int
    clicks: int
    cpc: float
    ad_spend: float
    ad_orders: int
    available_qty: int


class DailyAnalysisDetailRow(BaseModel):
    date: str
    sku: str
    asin: str | None
    order_qty: int
    sales_amount: float
    impressions: int
    clicks: int
    cpc: float
    ad_spend: float
    ad_orders: int
    available_qty: int


class DailyAnalysisResponse(BaseModel):
    console: DailyAnalysisConsoleResponse
    summary_rows: list[DailyAnalysisSummaryRow]
    detail_rows: list[DailyAnalysisDetailRow]
    available_dates: dict[str, Any]
