"""External API namespace — ``/api/v1/external/*``.

P0 contract (no auth, no rate limiting, network isolation handled at the
gateway layer). See ``docs/deployment/external-api-network-isolation.md``
and ``backend/docs/external-api.md`` for the full design.

Endpoint layout:

  # Inventory & replenishment analysis.
  GET  /external/projects/{id}/replenishment-analysis

  # Return analysis (BEL-374).
  GET  /external/projects/{id}/return-analysis
  GET  /external/projects/{id}/return-analysis-raw

  # Shop / new-product calculation (BEL-378 / BEL-416).
  GET  /external/projects/{id}/new-product-calculations

  # 其余原 external 读路由已全部原生化收口进 agent 原生域：
  #  - ad 9 域（BLF-580 样板 + BLF-581）
  #  - projects 列表 / sku_info / inventory_ledger / shop_calculation /
  #    pricing_snapshots（BLF-582）
  # 对应端点模块已删除，见各 agent/*.py 模块 docstring。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.external_security import (
    require_external_api_key,
    require_external_rate_limit,
)

from app.api.v1.endpoints.external.replenishment_analysis import (
    router as replenishment_analysis_router,
)
from app.api.v1.endpoints.external.return_analysis import (
    router as return_analysis_router,
)
from app.api.v1.endpoints.external.new_product_calculations import (
    router as new_product_calculations_router,
)


# BEL-377 (P1): application-layer auth + rate limiting now guard the whole
# namespace. Both are feature-flagged (``external_api_require_auth`` /
# ``external_api_rate_limit_enabled``, default off) so the rollout never
# breaks existing consumers; network isolation at the gateway remains the
# backstop. ``require_external_rate_limit`` also pulls in the auth dependency,
# but we list both for clarity (FastAPI de-dupes the shared sub-dependency).
external_router = APIRouter(
    prefix="/external",
    tags=["external"],
    dependencies=[
        Depends(require_external_api_key),
        Depends(require_external_rate_limit),
    ],
)

external_router.include_router(replenishment_analysis_router)
external_router.include_router(return_analysis_router)
# BEL-378 / BEL-416: new-product-calculations（其余 shop-calculation /
# pricing-snapshots 已 BLF-582 原生化收口进 agent 原生域，端点模块已删除）。
external_router.include_router(new_product_calculations_router)
