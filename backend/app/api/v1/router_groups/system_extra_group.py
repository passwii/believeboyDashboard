"""系统杂项懒分组（BLF-657）：notification_settings / inspections。"""

from fastapi import APIRouter

from app.api.v1.endpoints.inspections import router as inspections_router
from app.api.v1.endpoints.notification_settings import (
    router as notification_settings_router,
)

router = APIRouter()
router.include_router(notification_settings_router)
router.include_router(inspections_router)
