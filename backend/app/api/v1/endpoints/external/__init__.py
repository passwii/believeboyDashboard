"""External API namespace — ``/api/v1/external/*``.

P0 contract (no auth, no rate limiting, network isolation handled at the
gateway layer). See ``docs/deployment/external-api-network-isolation.md``
and ``backend/docs/external-api.md`` for the full design.

Endpoint layout:

  GET  /external/projects

  # Aggregated row endpoints (default; do NOT include ``raw_row`` JSON).
  GET  /external/projects/{id}/ad-campaigns
  GET  /external/projects/{id}/ad-search-terms
  GET  /external/projects/{id}/ad-budgets
  GET  /external/projects/{id}/ad-targets
  GET  /external/projects/{id}/ad-placements
  GET  /external/projects/{id}/ad-promoted-products
  GET  /external/projects/{id}/ad-time-trends
  GET  /external/projects/{id}/ad-search-term-shares
  GET  /external/projects/{id}/ad-invalid-traffic
  GET  /external/projects/{id}/ad-purchased-products

  # Master-data endpoints (no period / aggregation).
  GET  /external/projects/{id}/sku-info

  # Inventory & replenishment analysis.
  GET  /external/projects/{id}/replenishment-analysis
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints.external.ad_budgets import router as ad_budgets_router
from app.api.v1.endpoints.external.ad_campaigns import router as ad_campaigns_router
from app.api.v1.endpoints.external.ad_invalid_traffic import (
    router as ad_invalid_traffic_router,
)
from app.api.v1.endpoints.external.ad_placements import router as ad_placements_router
from app.api.v1.endpoints.external.ad_promoted_products import (
    router as ad_promoted_products_router,
)
from app.api.v1.endpoints.external.ad_purchased_products import (
    router as ad_purchased_products_router,
)
from app.api.v1.endpoints.external.ad_search_term_shares import (
    router as ad_search_term_shares_router,
)
from app.api.v1.endpoints.external.ad_search_terms import (
    router as ad_search_terms_router,
)
from app.api.v1.endpoints.external.ad_targets import router as ad_targets_router
from app.api.v1.endpoints.external.ad_time_trends import router as ad_time_trends_router
from app.api.v1.endpoints.external.business_summary import (
    router as business_summary_router,
)
from app.api.v1.endpoints.external.orders_summary import router as orders_summary_router
from app.api.v1.endpoints.external.projects import router as projects_router
from app.api.v1.endpoints.external.replenishment_analysis import (
    router as replenishment_analysis_router,
)
from app.api.v1.endpoints.external.sku_info import router as sku_info_router


# P0 intentionally has no `dependencies=[Depends(protected)]` — authentication
# and rate limiting are deferred to P1. Network-level isolation must be
# enforced at the gateway (see docs/deployment/external-api-network-isolation.md).
external_router = APIRouter(prefix="/external", tags=["external"])

external_router.include_router(projects_router)
external_router.include_router(ad_campaigns_router)
external_router.include_router(ad_search_terms_router)
external_router.include_router(ad_budgets_router)
external_router.include_router(ad_targets_router)
external_router.include_router(ad_placements_router)
external_router.include_router(ad_promoted_products_router)
external_router.include_router(ad_time_trends_router)
external_router.include_router(ad_search_term_shares_router)
external_router.include_router(ad_invalid_traffic_router)
external_router.include_router(ad_purchased_products_router)
external_router.include_router(orders_summary_router)
external_router.include_router(business_summary_router)
external_router.include_router(replenishment_analysis_router)
external_router.include_router(sku_info_router)
