from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SkuRecordItem(BaseModel):
    id: int
    project_name: str
    sku: str
    asin: str
    fnsku: str | None = None
    product_name: str | None = None
    fob_unit_cost: float
    first_leg_cost_rmb: float
    package_length_cm: float
    package_width_cm: float
    package_height_cm: float
    weight_kg: float
    carton_length_cm: float
    carton_width_cm: float
    carton_height_cm: float
    carton_weight_kg: float
    units_per_carton: int
    currency: str
    country: str
    sort_order: int
    is_active: bool
    sku_factory_info: dict | None = None
    sku_factory_info_updated_at: datetime | None = None
    sku_factory_info_updated_by: str | None = None
    fnsku_label_r2_key: str | None = None
    fnsku_label_r2_url: str | None = None
    product_image_r2_key: str | None = None
    product_image_r2_url: str | None = None
    product_image_thumbnail_r2_key: str | None = None
    product_image_thumbnail_r2_url: str | None = None
    product_image_uploaded_at: datetime | None = None
    product_image_uploaded_by: str | None = None
    # Canonical Amazon product-detail URL derived from (country, asin) via
    # app.utils.marketplace_url.build_marketplace_url; None when the country
    # is empty or not a known marketplace.
    marketplace_url: str | None = None


class SkuRecordsPage(BaseModel):
    items: list[SkuRecordItem]
    page: int
    page_size: int
    total: int | None = None
    has_next: bool


class SkuRecordCreate(BaseModel):
    project_name: str = Field(min_length=1)
    sku: str = Field(min_length=1)
    asin: str = ""
    fnsku: str | None = None
    product_name: str | None = None
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
    currency: str = "CNY"
    country: str = "US"
    sort_order: int | None = Field(default=None, ge=1)
    is_active: bool = True
    source_file: str | None = None
    sku_factory_info: dict | None = None


class SkuRecordUpdate(BaseModel):
    sku: str | None = None
    asin: str = ""
    fnsku: str | None = None
    product_name: str | None = None
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
    currency: str = "CNY"
    country: str = "US"
    sort_order: int | None = Field(default=None, ge=1)
    is_active: bool = True
    source_file: str | None = None
    sku_factory_info: dict | None = None


class SkuRecordSortMove(BaseModel):
    direction: Literal["up", "down"]


class SkuRecordBulkCreate(BaseModel):
    items: list[SkuRecordCreate] = Field(min_length=1, max_length=10000)
    source_file: str | None = None


class SkuRecordImportResponse(BaseModel):
    inserted: int
    updated: int
    total: int
    skipped: int = 0


class SkuRecordUpsertResponse(BaseModel):
    item: SkuRecordItem
    action: str


class SkuRecordBulkUpsertResponse(BaseModel):
    inserted: int
    updated: int
    total: int


class SkuRecordFirstLegRecalculateRequest(BaseModel):
    project_name: str = Field(min_length=1)
    unit_price_per_kg_rmb: float = Field(gt=0, le=1000000)
    sku: str | None = None
    asin: str | None = None
    country: str | None = None
    is_active: bool | None = None


class SkuRecordFirstLegRecalculateResponse(BaseModel):
    updated: int
    unit_price_per_kg_rmb: float


class BatchUpdateFactoryInfoRequest(BaseModel):
    """批量更新产品属性请求"""

    sku_ids: list[int] = Field(..., min_length=1, description="SKU 记录 ID 列表")
    sku_factory_info: dict[str, str] | None = Field(
        default=None, description="产品属性字典，传入 null 表示清除属性"
    )

    model_config = {"extra": "forbid"}


class BatchUpdateFactoryInfoResponse(BaseModel):
    """批量更新产品属性响应"""

    updated: int = Field(..., description="更新记录数")
    sku_ids: list[int] = Field(..., description="已更新的 SKU ID 列表")


class GetFnskuLabelsBySkusRequest(BaseModel):
    """通过 SKU 列表获取 FNSKU 标签信息的请求"""

    project_name: str = Field(..., min_length=1, description="项目名称")
    skus: list[str] = Field(..., min_length=1, description="SKU 列表")


class SkuRecordFnskuLabelItem(BaseModel):
    """SKU 记录的 FNSKU 标签信息"""

    id: int
    sku: str
    fnsku_label_r2_key: str | None = None


class FnskuLabelsResponse(BaseModel):
    """通过 SKU 列表获取 FNSKU 标签信息的响应"""

    sku_records: list[SkuRecordFnskuLabelItem]


class ParseFactoryInfoRequest(BaseModel):
    """解析产品属性请求"""

    description: str = Field(
        ..., min_length=1, max_length=2000, description="自然语言描述"
    )

    model_config = {"extra": "forbid"}


class ParseFactoryInfoResponse(BaseModel):
    """解析产品属性响应"""

    result: dict[str, str] = Field(default_factory=dict, description="解析后的键值对")
    raw: str = Field(..., description="原始 AI 输出")


class FnskuLabelUploadResponse(BaseModel):
    """FNSKU 标签上传响应"""

    sku_record_id: int
    fnsku_label_r2_key: str
    fnsku_label_r2_url: str
    fnsku_verified: bool = False
    fnsku_found_in_pdf: str | None = None
    fnsku_verification_message: str = ""


class BatchFnskuLabelDownloadRequest(BaseModel):
    """批量下载 FNSKU 标签请求"""

    sku_record_ids: list[int] = Field(
        ..., min_length=1, max_length=500, description="SKU 记录 ID 列表"
    )


class SkuProductImageUploadResponse(BaseModel):
    """SKU 产品图上传响应"""

    sku_record_id: int
    product_image_r2_key: str
    product_image_r2_url: str
    product_image_thumbnail_r2_key: str
    product_image_thumbnail_r2_url: str
    uploaded_at: str


class SkuProductImageDeleteResponse(BaseModel):
    """SKU 产品图删除响应"""

    sku_record_id: int
    deleted: bool
