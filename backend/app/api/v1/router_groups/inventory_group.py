"""库存域懒分组（BLF-657）：inventory_replenishment / snapshots / ledger / shipment_schedules。"""

from fastapi import APIRouter

from app.api.v1.endpoints.inventory_ledger import router as inventory_ledger_router
from app.api.v1.endpoints.inventory_replenishment import (
    router as inventory_replenishment_router,
)
from app.api.v1.endpoints.inventory_replenishment_snapshots import (
    router as inventory_replenishment_snapshots_router,
)
from app.api.v1.endpoints.shipment_schedules import router as shipment_schedules_router

router = APIRouter()
router.include_router(inventory_replenishment_router)
router.include_router(inventory_replenishment_snapshots_router)
router.include_router(
    inventory_ledger_router, prefix="/inventory-ledger", tags=["inventory-ledger"]
)
router.include_router(shipment_schedules_router)
