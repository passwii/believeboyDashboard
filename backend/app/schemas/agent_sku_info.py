"""Agent SKU Info 域请求 schema（BLF-579 S2，spec §5）。

``AgentSkuRecordUpsertRequest`` 镜像内部 ``SkuRecordCreate`` 全字段（去掉
服务端派生项：``project_name`` / ``currency`` / ``source_file``，路由层派生），
``source`` 收紧为必填 agent 采集渠道枚举（D4，禁 manual），``asin`` / ``country``
收紧为必填（主数据唯一键 ``(project_id, sku, asin, country)`` 组成；spec §9 #3
Agent 侧 asin 必填拍板）。

``AgentSkuRecordUpdateRequest`` 是 W2 局部更新：全 Optional（只更新显式提供字段，
读-改-写合并），**不含身份字段**（sku / asin / country——W2 禁改身份，spec §4）。

``AgentSkuRecordStatusRequest`` 是 W3 上/下架：``{"is_active": bool}`` + source。

``AgentSkuListingCopyBatchRequest`` / ``...Item`` 是 W6 批量文案写入（BLF-1083）：
一次事务写多 SKU 的文案字段，item 用 ``sku_record_id`` 定位（**不接受**批量
insert，记录必须已存在且属于路径 ``project_id``）。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

# Agent 写入允许的采集渠道（spec §3 D4：必填，禁 manual —— 审计溯源要求声明渠道）。
# 对齐 ``AgentCalculationSource`` 模式（new_product_calculation_agent.py），裁剪
# 不适用的 review_scrape/market_research，新增 ``agent_user_supplied`` 覆盖
# 「用户对话提供」渠道。
AgentSkuSource = Literal[
    "agent_listing_pull",
    "agent_user_supplied",
    "external_api",
]


class AgentSkuRecordUpsertRequest(BaseModel):
    """W1 新建 / upsert 请求（spec §5.1）。

    唯一键 ``(project_id, sku, asin, country)`` 命中则更新、否则插入。
    ``project_id`` / ``project_name`` / ``currency`` / ``source_file`` 服务端派生。
    """

    sku: str = Field(min_length=1, max_length=255)
    asin: str = Field(min_length=1, max_length=255)
    country: str = Field(min_length=2, max_length=2)
    source: AgentSkuSource

    fnsku: str | None = Field(default=None, max_length=255)
    product_name: str | None = Field(default=None, max_length=255)
    father_id: str | None = Field(default=None, max_length=255)
    fob_unit_cost: float | None = Field(default=None, ge=0, le=100000000)
    first_leg_cost_rmb: float | None = Field(default=None, ge=0, le=100000000)
    package_length_cm: float | None = Field(default=None, ge=0, le=100000)
    package_width_cm: float | None = Field(default=None, ge=0, le=100000)
    package_height_cm: float | None = Field(default=None, ge=0, le=100000)
    weight_kg: float | None = Field(default=None, ge=0, le=100000)
    carton_length_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_width_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_height_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_weight_kg: float | None = Field(default=None, ge=0, le=100000)
    units_per_carton: int | None = Field(default=None, ge=0, le=100000000)
    is_active: bool = True
    sort_order: int | None = Field(default=None, ge=1)
    sku_factory_info: dict | None = None
    # 产品文案（Listing Copy，BLF-1080）：与通用 SKU schema 对齐。
    listing_title: str | None = Field(default=None, max_length=500)
    listing_bullet_1: str | None = None
    listing_bullet_2: str | None = None
    listing_bullet_3: str | None = None
    listing_bullet_4: str | None = None
    listing_bullet_5: str | None = None
    listing_description: str | None = None
    listing_selling_points: str | None = None


class AgentSkuRecordUpdateRequest(BaseModel):
    """W2 局部更新请求（spec §5.2）。

    全 Optional——只更新显式提供的字段（读-改-写合并，spec §9 #2 默认值陷阱规避）。
    不含 sku / asin / country（身份字段 W2 禁改，spec §4）；extra=forbid 让
    身份字段传值直接 400 ``VALIDATION_FAILED``。
    """

    source: AgentSkuSource

    fnsku: str | None = Field(default=None, max_length=255)
    product_name: str | None = Field(default=None, max_length=255)
    father_id: str | None = Field(default=None, max_length=255)
    fob_unit_cost: float | None = Field(default=None, ge=0, le=100000000)
    first_leg_cost_rmb: float | None = Field(default=None, ge=0, le=100000000)
    package_length_cm: float | None = Field(default=None, ge=0, le=100000)
    package_width_cm: float | None = Field(default=None, ge=0, le=100000)
    package_height_cm: float | None = Field(default=None, ge=0, le=100000)
    weight_kg: float | None = Field(default=None, ge=0, le=100000)
    carton_length_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_width_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_height_cm: float | None = Field(default=None, ge=0, le=100000)
    carton_weight_kg: float | None = Field(default=None, ge=0, le=100000)
    units_per_carton: int | None = Field(default=None, ge=0, le=100000000)
    is_active: bool | None = None
    sort_order: int | None = Field(default=None, ge=1)
    sku_factory_info: dict | None = None
    # 产品文案（Listing Copy，BLF-1080）：只处理显式提供字段；null/空串清空。
    listing_title: str | None = Field(default=None, max_length=500)
    listing_bullet_1: str | None = None
    listing_bullet_2: str | None = None
    listing_bullet_3: str | None = None
    listing_bullet_4: str | None = None
    listing_bullet_5: str | None = None
    listing_description: str | None = None
    listing_selling_points: str | None = None

    model_config = {"extra": "forbid"}


class AgentSkuRecordStatusRequest(BaseModel):
    """W3 上/下架请求（spec §5.3）。"""

    is_active: bool
    source: AgentSkuSource


class AgentSkuListingCopyBatchItem(BaseModel):
    """W6 批量文案写入的单行项（BLF-1083，spec §5）。

    ``sku_record_id`` 定位既有 SKU 行（必须属于路径 ``project_id``，否则整批
    404——不回显 skipped，避免泄露他项目行存在性）。文案字段只写**显式提供**
    的（``model_fields_set``）：未提供的保持原值，显式 ``null`` / 空串清空。
    溯源列（``listing_copy_updated_*``）由服务端写入，``extra=forbid`` 拒绝。
    """

    sku_record_id: int = Field(..., description="SKU 记录 ID（须属于路径项目）")
    listing_title: str | None = Field(default=None, max_length=500)
    listing_bullet_1: str | None = None
    listing_bullet_2: str | None = None
    listing_bullet_3: str | None = None
    listing_bullet_4: str | None = None
    listing_bullet_5: str | None = None
    listing_description: str | None = None
    listing_selling_points: str | None = None

    model_config = {"extra": "forbid"}


class AgentSkuListingCopyBatchRequest(BaseModel):
    """W6 批量文案写入请求（BLF-1083，spec §5）。

    ``source`` 是全批共用的溯源枚举（D4：必填，禁 ``manual``）。
    """

    items: list[AgentSkuListingCopyBatchItem] = Field(
        ..., min_length=1, max_length=500, description="文案更新项"
    )
    source: AgentSkuSource

    model_config = {"extra": "forbid"}
