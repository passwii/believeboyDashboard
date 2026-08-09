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


class OrdersGroupedRow(BaseModel):
    """group_by 模式聚合行（BLF-558 spec §5.1）。

    字段按粒度选择性填充：
    * ``asin`` / ``asin_day`` → ``asin`` + ``product_name``（组内 raw_row 任一非空名）；
    * ``asin_day`` / ``day`` → ``date``（YYYY-MM-DD）；
    * ``day`` → ``unique_asins``（去重 ASIN 数）；
    * ``asin`` + ``include_share=true`` → ``share``（占全量销售额比，4 位小数）。

    不适用粒度的字段为 null（缺省），调用方按 ``group_by`` 取值。
    """

    model_config = ConfigDict(from_attributes=True)

    asin: Optional[str] = None
    product_name: Optional[str] = None
    date: Optional[str] = None  # YYYY-MM-DD（asin_day / day）
    quantity: int
    sales_amount: float
    order_count: int  # count(distinct amazon_order_id) 去重订单数
    share: Optional[float] = None  # 仅 group_by=asin & include_share=true
    unique_asins: Optional[int] = None  # 仅 group_by=day


class OrdersGroupedResponse(BaseModel):
    """orders/summary ``group_by`` 模式响应（BLF-558 spec §4.3）。

    ``summary`` 复用 :class:`OrdersSummaryAggregateRow`（字段集相同），为
    **SQL 全量汇总**（不受 limit/offset 影响），修复现有 aggregate「页内汇总」失真。
    """

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    group_by: str
    rows: List[OrdersGroupedRow]
    total_rows: int
    summary: OrdersSummaryAggregateRow
