"""
BEL-157 订单信息页面 Schemas

字段定义基于 Amazon "按 SKU 维度" 订单报告（Sales > Orders > By SKU），
来源表 backend.app.models.product_analysis_source.AnalysisSalesOrderRow
及其 raw_row JSON。
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from pydantic import BaseModel, Field, field_serializer


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

    # ===== FBM 自发货补录字段（迁移 20260627_200 新增）=====
    carrier: str | None = None
    tracking_no: str | None = None
    shipped_at: datetime | None = None
    updated_by: str | None = None
    updated_at: datetime | None = None

    @field_serializer("purchase_at_utc", "created_at", "shipped_at", "updated_at")
    def _serialize_utc(self, value: datetime) -> str:
        """强制以 UTC 发出，避免后端 PG session TZ（Shanghai）影响前端换算。

        后端 PG 连接 session timezone = Asia/Shanghai 时，`timestamptz` 列读取后会显示为 +08:00
        但其实代表同一瞬间。给前端时统一换成 UTC ISO 字符串，前端自己负责转北京时间展示。
        """
        if value is None:
            return ""
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()

    @field_serializer("purchase_at_pt")
    def _serialize_naive(self, value: datetime) -> str:
        """PT 列是 naive datetime（PG `timestamp` 不带 tz），保持原样序列化即可。"""
        if value is None:
            return ""
        return value.isoformat()


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


class OrderInfoOverview(BaseModel):
    """一次请求返回：列表 + 顶部统计（不含 filter_options）。

    筛选、日期或项目条件变化时调用 ``/overview`` 以重算统计；仅翻页或排序时
    使用 ``/list`` 取新列表并复用本响应中的 ``stats``，因统计不依赖 page / sort。
    """

    items: list[OrderInfoItem]
    total: int
    page: int
    page_size: int
    stats: OrderInfoStats


# === Bulk export ===
class OrderInfoExportRequest(BaseModel):
    """导出 CSV 请求；filter 与 list 接口对齐"""

    project_ids: list[int] = Field(default_factory=list)
    fulfillment_channels: list[str] = Field(default_factory=list)  # Amazon / Merchant
    order_statuses: list[str] = Field(default_factory=list)
    countries: list[str] = Field(default_factory=list)
    currencies: list[str] = Field(default_factory=list)
    sku_keyword: str | None = None
    order_id_keyword: str | None = None
    asin_keyword: str | None = None
    date_from: str | None = None  # YYYY-MM-DD, 按 PT 日期
    date_to: str | None = None


class OrderInfoExportResponse(BaseModel):
    filename: str
    content_type: str
    content_base64: str  # utf-8 csv 内容 base64 编码


class OrderLiveStreamItem(BaseModel):
    """今日出单流单条事件（BLF-839）。

    对齐前端 ``TerminalInspector`` 的 ``LiveStreamItem`` 插槽契约
    （PR #425：``{ id, title, timeLabel }``），并附带扩展上下文字段
    （shell 层按需取用，多带不破坏最小集）：

    * ``id`` → LiveStreamItem.id（唯一键，``{project}:{order}``）；
    * ``title`` → LiveStreamItem.title（订单摘要，服务端拼好金额）；
    * ``time_label`` → LiveStreamItem.timeLabel（北京时间 ``HH:MM``；
      前端也可用 ``occurred_at`` 自行格式化）；
    * ``occurred_at`` 强制以 UTC ISO 序列化（同 :class:`OrderInfoItem` 口径）。
    """

    id: str
    title: str
    time_label: str
    occurred_at: datetime
    project_id: int
    project_name: str | None = None
    country: str | None = None
    currency: str | None = None
    amount: float = 0.0
    quantity: int = 0
    order_status: str | None = None

    @field_serializer("occurred_at")
    def _serialize_utc(self, value: datetime) -> str:
        """强制 UTC ISO 输出，避免 PG session TZ 影响（与 OrderInfoItem 同口径）。"""
        if value is None:
            return ""
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()


class OrderInfoUpdate(BaseModel):
    """FBM 订单补录/编辑请求体。所有字段可选，未传入则不改。

    与 sku_info.SkuRecordUpdate 风格一致，使用 model_dump(exclude_unset=True) 做增量更新。
    """

    carrier: str | None = None
    tracking_no: str | None = None
    shipped_at: datetime | None = None
    updated_by: str | None = None


OrderInfoFilterOptions.model_rebuild()
