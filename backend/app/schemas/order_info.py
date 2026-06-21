"""
BEL-157 订单信息页面 Schemas

字段定义基于 Amazon "按 SKU 维度" 订单报告（Sales > Orders > By SKU），
来源表 backend.app.models.product_analysis_source.AnalysisSalesOrderRow
及其 raw_row JSON。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class OrderInfoItem(BaseModel):
    """单条订单（一条 = 一个 SKU 行）"""

    id: int
    # ===== 项目 / 店铺 =====
    project_id: int
    project_name: str
    brand_name: str | None = None
    source_file_id: int

    # ===== 时间 =====
    # 数据库原始 UTC 时间（带时区）
    purchase_at_utc: datetime
    # 当地时间（亚马逊后台下载的"订单日期"，原始 PT，已转 America/Los_Angeles 之外的 country 会另存）
    purchase_at_pt: datetime
    purchase_date_pt: str  # YYYY-MM-DD, PT 日期，用于按日聚合

    # ===== 订单 =====
    amazon_order_id: str
    order_status: str
    # Amazon 原始: FBA=Amazon, FBM=Merchant
    fulfillment_channel: str
    fulfillment_label: str  # "FBA（亚马逊配送）" | "FBM（自发货配送）"
    ship_service_level: str | None = None

    # ===== 商品 =====
    sku: str | None = None
    asin: str | None = None
    product_name: str | None = None
    quantity: int

    # ===== 金额 =====
    item_price: float
    shipping_price: float
    currency: str | None = None

    # ===== 收货 =====
    country: str
    state: str | None = None
    city: str | None = None
    postal_code: str | None = None

    # ===== 元信息 =====
    is_counted_sales: bool
    created_at: datetime


class OrderInfoListResponse(BaseModel):
    items: list[OrderInfoItem]
    total: int
    page: int
    page_size: int


class OrderInfoFilterOptions(BaseModel):
    """筛选器下拉选项（项目 / 订单状态 / 订单类型 / 国家 / 币种）"""

    projects: list["FilterOption"]
    order_statuses: list["FilterOption"]
    fulfillment_channels: list["FilterOption"]
    countries: list["FilterOption"]
    currencies: list["FilterOption"]


class FilterOption(BaseModel):
    value: str
    label: str


class OrderInfoStats(BaseModel):
    """顶部 stat bar 数据"""

    total_orders: int = 0
    total_quantity: int = 0
    total_amount: float = 0.0
    currency: str | None = None
    fba_count: int = 0
    fbm_count: int = 0


class OrderInfoPageData(BaseModel):
    """一次性返回：列表 + 筛选器选项 + 顶部统计（前端首屏渲染用）"""

    items: list[OrderInfoItem]
    total: int
    page: int
    page_size: int
    stats: OrderInfoStats
    filter_options: OrderInfoFilterOptions


# === Bulk export ===
class OrderInfoExportRequest(BaseModel):
    """导出 CSV 请求；filter 与 list 接口对齐"""

    project_ids: list[int] = Field(default_factory=list)
    fulfillment_channels: list[str] = Field(default_factory=list)  # Amazon / Merchant
    order_statuses: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    sku_keyword: str | None = None
    order_id_keyword: str | None = None
    asin_keyword: str | None = None
    date_from: str | None = None  # YYYY-MM-DD, 按 PT 日期
    date_to: str | None = None


class OrderInfoExportResponse(BaseModel):
    filename: str
    content_type: str
    content_base64: str  # utf-8 csv 内容 base64 编码


OrderInfoFilterOptions.model_rebuild()