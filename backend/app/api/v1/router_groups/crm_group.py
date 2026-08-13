"""CRM 懒分组（BLF-657）：crm。"""

from fastapi import APIRouter

from app.api.v1.endpoints.crm import router as crm_router

router = APIRouter()
router.include_router(crm_router)
