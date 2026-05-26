from __future__ import annotations

from pydantic import BaseModel


class DashboardOverviewSalesSnapshot(BaseModel):
    today_order_qty: int = 0
    today_sales_amount: float = 0.0
    prev_order_qty: int = 0
    prev_sales_amount: float = 0.0
    order_qty_change_pct: float = 0.0
    sales_change_pct: float = 0.0
    change_type_order_qty: str = "neutral"
    change_type_sales: str = "neutral"


class DashboardOverviewTrendItem(BaseModel):
    date: str
    order_qty: int = 0
    sales_amount: float = 0.0


class DashboardOverviewInventory(BaseModel):
    sku_count: int = 0
    out_of_stock_count: int = 0
    available_qty: int = 0


class DashboardOverviewShipments(BaseModel):
    in_transit_count: int = 0
    in_transit_qty: int = 0


class DashboardOverviewReturns(BaseModel):
    total_returns: int = 0
    total_quantity: int = 0
    return_rate: float = 0.0
    top_reason: str | None = None


class DashboardOverviewAds(BaseModel):
    period_spend: float = 0.0
    period_sales: float = 0.0
    period_roas: float = 0.0
    period_acos: float = 0.0
    period_ctr: float = 0.0
    period_impressions: int = 0
    period_clicks: int = 0
    period_orders: int = 0


class SkuSalesDetailItem(BaseModel):
    sku: str
    product_name: str | None = None
    quantity: int = 0
    sales_amount: float = 0.0


class DashboardOverviewResponse(BaseModel):
    project_ids: list[int] = []
    project_names: list[str] = []
    country: str
    days: int
    server_time: str
    sales: DashboardOverviewSalesSnapshot = DashboardOverviewSalesSnapshot()
    sales_trend: list[DashboardOverviewTrendItem] = []
    inventory: DashboardOverviewInventory = DashboardOverviewInventory()
    shipments: DashboardOverviewShipments = DashboardOverviewShipments()
    returns: DashboardOverviewReturns = DashboardOverviewReturns()
    ads: DashboardOverviewAds = DashboardOverviewAds()
    sku_sales_detail: list[SkuSalesDetailItem] = []