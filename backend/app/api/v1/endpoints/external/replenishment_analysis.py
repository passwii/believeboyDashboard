"""External replenishment-analysis endpoint — ``GET /external/projects/{id}/replenishment-analysis``.

Combines FBA inventory snapshot (available qty + age buckets) with computed
DMS (7/14/30/3 day weighted), sellable days, replenishment timelines, and
risk classification — one response per SKU.

Intended use: external BI tools / multi-agent orchestration that need a
unified inventory-health + replenishment signal without re-computing DMS.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.schemas.inventory_replenishment import (
    InventoryReplenishmentListItem,
    InventoryReplenishmentListResponse,
    InventoryReplenishmentSummary,
)
from app.services.external import projects_query
from app.services.inventory.replenishment import list_inventory_replenishment_analysis


router = APIRouter()


@router.get(
    "/projects/{project_id}/replenishment-analysis",
    response_model=InventoryReplenishmentListResponse,
    summary="Replenishment analysis with age-bucket breakdown and DMS",
    description=(
        "Per-SKU inventory-health + replenishment analysis. Each item includes:\n"
        "  - **Stock**: available_inventory, in_transit_quantity, age buckets\n"
        "  - **Sales velocity**: DMS at 30/14/7/3 days, weighted DMS\n"
        "  - **Sell-through**: sellable_days, sellout_date (with/without transit)\n"
        "  - **Replenishment**: production_lead_days, shipping_days,"
        " estimated_replenishment_quantity\n"
        "  - **Risk**: risk_status (断货风险 / 健康库存 / 滞销 / 待补数据)\n"
        "  - **Age bucket**: age_0_90_qty … age_365_plus_qty, recommended_action"
    ),
)
def get_external_replenishment_analysis(
    project_id: int = Path(..., ge=1, description="Project ID"),
    country: str = Query(default="US", description="ISO-2 country code"),
    keyword: str | None = Query(
        default=None,
        description="Filter by SKU or ASIN (substring match, case-insensitive)",
    ),
    risk_status: str | None = Query(
        default=None,
        description=(
            "Filter by risk status: 断货风险 | 短期断货 | 长期断货"
            " | 健康库存 | 滞销 | 严重滞销 | 待补数据"
        ),
    ),
    in_transit_only: bool = Query(
        default=False,
        description="Only SKUs with in-transit quantity > 0",
    ),
    report_date: date | None = Query(
        default=None,
        description=(
            "Business date for historical snapshot (YYYY-MM-DD). "
            "When provided, uses the latest inventory snapshot on or before "
            "this date and anchors DMS/sellout calculations to it. "
            "Default: today."
        ),
    ),
    page: int = Query(default=1, ge=1, description="Page number (1-based)"),
    page_size: int = Query(
        default=50,
        ge=1,
        le=200,
        description="Items per page (max 200)",
    ),
    db: Session = Depends(get_read_db_session),
) -> InventoryReplenishmentListResponse:
    if not projects_query.project_exists(db, project_id):
        raise HTTPException(
            status_code=404,
            detail=f"project {project_id} not found",
        )

    rows, summary, total, has_next = list_inventory_replenishment_analysis(
        db,
        project_id=project_id,
        country=country,
        keyword=keyword,
        risk_status=risk_status,
        in_transit_only=in_transit_only,
        report_date=report_date,
        page=page,
        page_size=page_size,
    )

    return InventoryReplenishmentListResponse(
        items=[InventoryReplenishmentListItem(**row) for row in rows],
        summary=InventoryReplenishmentSummary(**summary),
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )
