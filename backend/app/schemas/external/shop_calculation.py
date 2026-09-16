"""External schemas for the Shop Calculation endpoint.

BEL-378 / BEL-416 — exposes
``GET /api/v1/external/projects/{project_id}/shop-calculation-history``
and ``/shop-calculation/snapshots``.

Design notes:

* Field set is intentionally narrower than the internal
  ``ShopCalculationItem`` shape (which carries nested ``dimensions`` /
  ``weights`` / ``fees`` / ``profit`` objects). External callers ask
  flat questions across many SKUs; the nested objects would balloon
  payloads and force consumers to reach into JSON. The flat shape is
  the canonical BI-friendly cut.
* Both ``observed_at`` (append-only timestamp, BEL-378 Phase A) and
  ``source`` (manual / agent_listing_pull / external_api) are part of
  the public contract — BI tools use them to reason about data lineage.
* Sensitive / internal fields are **never** present:
    * ``created_by`` — internal operator
    * ``deleted_at`` — soft-delete marker (callers should never see
      deleted rows; the service layer filters them out)
    * ``warnings_json`` — debug blob
    * Fee-rule labels — long internal strings, low BI value
* Fields mirror the ROW_WHITELIST contract in
  ``app/api/v1/endpoints/agent/_whitelist.py`` — adding a
  **列-backed** field here **requires** extending that whitelist, and vice
  versa. ``breakeven_advertising_rate`` / ``max_ad_spend_per_unit_usd`` /
  ``target_advertising_rate``（BLF-1043）是**读取时派生**的（不是表列），
  所以它们不在 whitelist 里、也不可用作 ``order_by``。
"""

from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class AgentOkResponse(BaseModel, Generic[T]):
    """OpenAPI-visible success envelope for native Agent flat read routes."""

    ok: bool = True
    data: T


class ShopCalculationHistoryRow(BaseModel):
    """Single SKU row from ``shop_calculation`` flattened for BI consumption.

    Used by:

    * ``/shop-calculation-history`` — current-state list (per SKU latest
      non-deleted row)
    * ``/shop-calculation/snapshots`` — append-only time series filtered
      by ``?from=&to=&sku=&country=``

    The ``id`` is the underlying ``shop_calculation.id`` (PK). For the
    current-state endpoint each row is the latest non-deleted id for
    that ``(project_id, sku, country)`` group; for the history endpoint
    the same id may appear multiple times across different ``observed_at``
    snapshots.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    project_name: str
    sku: str
    asin: str | None = None
    country: str
    accounting_type: str = "profit_calc"
    # BEL-378 append-only time-series metadata
    observed_at: datetime
    source: str = "manual"
    # Headline economics (flat)
    sale_price_usd: float = 0.0
    profit_usd: float = 0.0
    profit_rate: float = 0.0  # ratio 0..1 (NOT percent — matches the raw column)
    payout_usd: float = 0.0
    total_fee_usd: float = 0.0
    # BLF-1043 定价派生列（服务端推，不改 append-only 语义）。
    # 扁平行没有费用拆项，所以消费方算不出锚，也解释不了锚偏低的原因；
    # 服务端显式补四个派生列：breakeven / non_ad_fee / max_ad_spend / target。
    # 口径见
    # ``app/services/pricing/anchor.py``（比率 4 位小数；sale_price=0 → null；
    # 不 clamp，负值是诊断信号）。
    breakeven_advertising_rate: float | None = None
    non_ad_fee_usd: float | None = None
    max_ad_spend_per_unit_usd: float | None = None
    target_advertising_rate: float | None = None
    created_at: datetime
    updated_at: datetime


class ShopCalculationHistoryResponse(BaseModel):
    """Wrapper for ``/shop-calculation-history`` (current-state list).

    ``total`` is the total number of *current-state* rows for the
    project (one per SKU/country group, with deleted rows excluded).
    """

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    country: str | None = None  # echo back when filter applied
    total: int = 0
    data: list[ShopCalculationHistoryRow] = Field(default_factory=list)


class ShopCalculationSnapshotsResponse(BaseModel):
    """Wrapper for ``/shop-calculation/snapshots`` (time-series).

    The endpoint exposes the full append-only history filtered by
    ``?from=&to=&sku=&country=``; no pagination is applied because
    callers are expected to use the date filter to bound the result.
    """

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    from_date: str | None = None  # ISO YYYY-MM-DD
    to_date: str | None = None
    sku: str | None = None
    country: str | None = None
    total: int = 0
    data: list[ShopCalculationHistoryRow] = Field(default_factory=list)


__all__ = [
    "AgentOkResponse",
    "ShopCalculationHistoryResponse",
    "ShopCalculationHistoryRow",
    "ShopCalculationSnapshotsResponse",
]
