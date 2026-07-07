from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.store_sku_pricing_snapshot import StoreSkuPricingSnapshotItem


# ── Summary (对齐 shop-calculation stat bar 4 个数字) ─────────────────────────
class PricingCalculationSnapshotSummary(BaseModel):
    total: int = 0
    calculated: int = 0
    profitable: int = 0
    passRate: float = 0.0


# ── Items 复用 StoreSkuPricingSnapshotItem，避免双份维护 ──────────────────────
# 业务含义一致：快照明细 = store_sku_pricing_snapshots 行的快照副本
PricingCalculationSnapshotItemSchema = StoreSkuPricingSnapshotItem


# ── List（不含 items，避免大 payload）────────────────────────────────────────
class PricingCalculationSnapshotListItem(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    snapshot_date: datetime
    name: str | None = None
    description: str | None = None
    row_count: int
    created_by: str | None = None
    created_at: str
    summary: PricingCalculationSnapshotSummary


# ── Detail（含 items + summary，前端回放用）────────────────────────────────
class PricingCalculationSnapshotDetail(BaseModel):
    id: int
    project_id: int
    project_name: str
    country: str
    snapshot_date: datetime
    name: str | None = None
    description: str | None = None
    row_count: int
    created_by: str | None = None
    created_at: str
    summary: PricingCalculationSnapshotSummary
    items: list[StoreSkuPricingSnapshotItem]


# ── Input ───────────────────────────────────────────────────────────────────
class CreatePricingCalculationSnapshotRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=4000)


class UpdatePricingCalculationSnapshotRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=4000)

    model_config = {
        'extra': 'forbid',
    }


# ── Items endpoint response（前端 loadSkusAndSnapshots 沿用 ShopCalculationItem 形状）──
class PricingCalculationSnapshotItemsResponse(BaseModel):
    """快照明细接口响应。

    ``items`` 形状与 ``store-sku-pricing-snapshots`` 列表保持一致，前端可直接按
    ``ShopCalculationItem`` 类型消费。
    """

    items: list[StoreSkuPricingSnapshotItem]
    summary: PricingCalculationSnapshotSummary
    row_count: int
    total: int
    page: int = 1
    page_size: int = 200
    has_next: bool = False
    snapshot_id: int
    snapshot_date: datetime
    snapshot_name: str | None = None
    snapshot_description: str | None = None
