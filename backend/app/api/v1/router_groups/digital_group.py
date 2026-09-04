"""数字员工/办公/大屏懒分组（BLF-657）：digital_employees / digital_office / digital_display。"""

from fastapi import APIRouter

from app.api.v1.endpoints.digital_display import router as digital_display_router
from app.api.v1.endpoints.digital_employees import router as digital_employees_router
from app.api.v1.endpoints.digital_office import router as digital_office_router

router = APIRouter()
router.include_router(digital_employees_router)
router.include_router(digital_office_router)
router.include_router(digital_display_router)
