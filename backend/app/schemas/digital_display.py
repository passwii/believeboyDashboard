from pydantic import BaseModel, Field


class DigitalDisplaySalesSnapshot(BaseModel):
    today_order_qty: int
    today_sales_amount: float
    today_sessions: int
    today_ordered_sales_amount: float
    prev_order_qty: int
    prev_sales_amount: float
    prev_sessions: int


class DigitalDisplaySalesTrendItem(BaseModel):
    date: str
    order_qty: int
    sales_amount: float
    sessions: int


class DigitalDisplayInventorySnapshot(BaseModel):
    sku_count: int
    out_of_stock_count: int
    available_qty: int


class DigitalDisplayShipmentSnapshot(BaseModel):
    in_transit_count: int
    in_transit_qty: int


class DigitalDisplayReturnSnapshot(BaseModel):
    total_returns: int
    total_quantity: int
    return_rate: float
    top_reason: str | None


class DigitalDisplayAdSnapshot(BaseModel):
    period_spend: float
    period_sales: float
    period_roas: float
    period_acos: float
    period_ctr: float
    period_impressions: int
    period_clicks: int
    period_orders: int


class DigitalDisplayResponse(BaseModel):
    project_id: int
    project_name: str
    country: str
    server_time: str
    sales: DigitalDisplaySalesSnapshot
    sales_trend: list[DigitalDisplaySalesTrendItem] = Field(default_factory=list)
    inventory: DigitalDisplayInventorySnapshot
    shipments: DigitalDisplayShipmentSnapshot
    returns: DigitalDisplayReturnSnapshot
    ads: DigitalDisplayAdSnapshot