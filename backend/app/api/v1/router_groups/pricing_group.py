"""定价测算域懒分组（BLF-657）：pricing_calculation / new_product / snapshots / shop_calculation。"""

from fastapi import APIRouter

from app.api.v1.endpoints.new_product_calculations import (
    router as new_product_calculations_router,
)
from app.api.v1.endpoints.pricing_calculation import (
    router as pricing_calculation_router,
)
from app.api.v1.endpoints.pricing_calculation_snapshots import (
    router as pricing_calculation_snapshots_router,
)
from app.api.v1.endpoints.shop_calculation import router as shop_calculation_router

router = APIRouter()
router.include_router(pricing_calculation_router)
router.include_router(new_product_calculations_router)
router.include_router(pricing_calculation_snapshots_router)
router.include_router(shop_calculation_router)
