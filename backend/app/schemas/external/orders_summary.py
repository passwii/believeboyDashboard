"""Orders Summary response schemas for the shared read-query layer.

原 external 命名空间的共享 schema（external 机制已退役删除，BLF-583），供 agent 原生域复用。"""

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
    """group_by 模式聚合行（BLF-558 spec §5.1；BLF-560 v0.2 加 country/currency）。

    字段按粒度选择性填充：
    * ``asin`` / ``asin_day`` → ``asin`` + ``product_name``（组内 raw_row 任一非空名）；
    * ``asin_day`` / ``day`` → ``date``（YYYY-MM-DD）；
    * ``day`` → ``unique_asins``（去重 ASIN 数）；
    * ``asin`` + ``include_share=true`` → ``share``（占**同国家**销售额比，4 位小数）；
    * v0.2 起每行固定带 ``country``（站点）+ ``currency``（该组国家币种，
      多站点时按国家独立结算，不做跨币种求和）。

    不适用粒度的字段为 null（缺省），调用方按 ``group_by`` 取值。
    """

    model_config = ConfigDict(from_attributes=True)

    country: str  # BLF-560 v0.2：站点（单/多站点均返回）
    currency: Optional[str] = None  # BLF-560 v0.2：该组国家币种（如 USD / EUR）
    asin: Optional[str] = None
    product_name: Optional[str] = None
    date: Optional[str] = None  # YYYY-MM-DD（asin_day / day）
    quantity: int
    sales_amount: float
    order_count: int  # count(distinct amazon_order_id) 去重订单数
    share: Optional[float] = None  # 仅 group_by=asin & include_share=true（国家内占比）
    unique_asins: Optional[int] = None  # 仅 group_by=day


class OrdersCountrySummary(BaseModel):
    """summary.by_country 子块（BLF-560 v0.2 spec §4.3）。

    每站独立币种结算：``currency`` + ``total_sales_amount`` 为该站点金额
    （不做跨币种求和——系统无通用 FX）；``total_orders``/``total_quantity``
    为无量纲计数，可跨站点直接合计。
    """

    model_config = ConfigDict(from_attributes=True)

    currency: Optional[str] = None
    total_sales_amount: float = 0.0
    total_orders: int = 0
    total_quantity: int = 0


class OrdersGroupedSummary(BaseModel):
    """orders/summary ``group_by`` 模式汇总（BLF-558 spec §4.3；BLF-560 v0.2）。

    ``summary`` 为 **SQL 全量汇总**（不受 limit/offset 影响），修复现有
    aggregate「页内汇总」失真。字段集与 :class:`OrdersSummaryAggregateRow`
    兼容（total_orders / total_quantity / total_sales_amount / currency /
    fba_orders / fbm_orders），v0.2 新增 ``by_country`` 分拆：

    * 单站点：顶层金额/币种照旧（向后兼容），``by_country`` 含单站子块；
    * 多站点：顶层 ``total_sales_amount``/``currency`` 为 ``None``（币种不可加），
      金额类全部在 ``by_country`` 内按国家分拆；``total_orders``/``total_quantity``
      仍为跨站点合计（无量纲）。
    """

    model_config = ConfigDict(from_attributes=True)

    total_orders: int = 0
    total_quantity: int = 0
    total_sales_amount: Optional[float] = None  # 多站点时 None（不做跨币种求和）
    currency: Optional[str] = None  # 多站点时 None
    fba_orders: int = 0
    fbm_orders: int = 0
    by_country: dict[str, OrdersCountrySummary] = Field(default_factory=dict)


class OrdersGroupedResponse(BaseModel):
    """orders/summary ``group_by`` 模式响应（BLF-558 spec §4.3；BLF-560 v0.2）。

    ``country`` 保持 v0.1 字符串语义（单站点 = 站点代码；多站点 = 逗号拼接），
    另加 ``countries`` 列表便于结构化消费；``summary`` 为
    :class:`OrdersGroupedSummary`（含 ``by_country`` 分拆）。
    """

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    countries: List[str] = Field(default_factory=list)  # BLF-560 v0.2：站点列表
    group_by: str
    rows: List[OrdersGroupedRow]
    total_rows: int
    summary: OrdersGroupedSummary
