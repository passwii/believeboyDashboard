"""External schemas for the New Product Calculation endpoint.

BEL-378 / BEL-416 — exposes
``GET /api/v1/external/projects/{project_id}/new-product-calculations``.

Design notes:

* Mirrors the Shop Calculation external schema but with the
  ``calculation_type`` field instead of ``accounting_type`` and
  ``target_profit_rate`` (used by ``profit_reverse``) added.
* The endpoint is paginated because new-product tables can grow large
  (per project × per SKU × per calculation_type).
* Fields mirror the ROW_WHITELIST contract in
  ``backend/app/api/v1/endpoints/external/_whitelist.py``.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field


class NewProductCalculationRow(BaseModel):
    """Single SKU row from ``new_product_calculations`` flattened for BI."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    project_name: str
    sku: str
    asin: Optional[str] = None
    country: Optional[str] = None
    calculation_type: str = "profit_calc"
    sale_price_usd: float = 0.0
    target_profit_rate: Optional[float] = None  # only set for profit_reverse
    profit_usd: float = 0.0
    profit_rate: float = 0.0  # ratio 0..1
    payout_usd: float = 0.0
    total_fee_usd: float = 0.0
    created_at: datetime
    updated_at: datetime


class NewProductCalculationListResponse(BaseModel):
    """Wrapper for ``/new-product-calculations`` (paginated list)."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    country: Optional[str] = None
    calculation_type: Optional[str] = None
    total: int = 0
    page: int = 1
    page_size: int = 200
    data: List[NewProductCalculationRow] = Field(default_factory=list)


__all__ = [
    "NewProductCalculationRow",
    "NewProductCalculationListResponse",
]
