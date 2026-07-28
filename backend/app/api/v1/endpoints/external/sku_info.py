"""External SKU info endpoint — ``GET /external/projects/{id}/sku-info``.

Master-data list (no period / aggregation). Follows the same contract as
``projects.py``: no auth at P0, network isolation at the gateway layer.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.models.sku_info import SkuRecord
from app.schemas.external.sku_info import ExternalSkuInfoItem, ExternalSkuInfoResponse
from app.services.external import projects_query

router = APIRouter()


@router.get(
    "/projects/{project_id}/sku-info",
    response_model=ExternalSkuInfoResponse,
)
def get_external_sku_info(
    project_id: int = Path(..., ge=1),
    country: str = Query(default=""),
    is_active: bool = Query(default=True),
    sku: str = Query(default=""),
    limit: int = Query(default=500, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
    include_total: bool = Query(default=False),
    db: Session = Depends(get_read_db_session),
) -> ExternalSkuInfoResponse:
    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    stmt = select(SkuRecord).where(SkuRecord.project_id == project_id)

    if country:
        normalized = country.strip().upper()
        if len(normalized) != 2:
            raise HTTPException(
                status_code=400, detail="country must be a 2-letter code"
            )
        stmt = stmt.where(SkuRecord.country == normalized)

    stmt = stmt.where(SkuRecord.is_active.is_(is_active))

    if sku:
        stmt = stmt.where(SkuRecord.sku.ilike(f"%{sku}%"))

    # Count (optional)
    total: int | None = None
    if include_total:
        count_stmt = select(func.count()).select_from(stmt.subquery())
        total = db.execute(count_stmt).scalar_one()

    # Paginate
    rows = (
        db.execute(
            stmt.order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc())
            .offset(offset)
            .limit(limit + 1)
        )
        .scalars()
        .all()
    )

    has_next = len(rows) > limit
    rows = rows[:limit]

    data = [
        ExternalSkuInfoItem(
            sku=r.sku,
            asin=r.asin,
            fnsku=r.fnsku,
            product_name=r.product_name,
            fob_unit_cost=float(r.fob_unit_cost),
            first_leg_cost_rmb=float(r.first_leg_cost_rmb),
            currency=r.currency,
            country=r.country,
            package_length_cm=float(r.package_length_cm),
            package_width_cm=float(r.package_width_cm),
            package_height_cm=float(r.package_height_cm),
            weight_kg=float(r.weight_kg),
            carton_length_cm=float(r.carton_length_cm),
            carton_width_cm=float(r.carton_width_cm),
            carton_height_cm=float(r.carton_height_cm),
            carton_weight_kg=float(r.carton_weight_kg),
            units_per_carton=r.units_per_carton,
            is_active=r.is_active,
            product_image_url=r.product_image_r2_url,
        )
        for r in rows
    ]

    return ExternalSkuInfoResponse(
        project_id=project_id,
        country=country.strip().upper() if country else "",
        data=data,
        total=total,
        has_next=has_next,
    )
