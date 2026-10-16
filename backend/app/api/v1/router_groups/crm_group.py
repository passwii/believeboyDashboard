"""CRM 懒分组（BLF-657）：crm + crm-proposals。"""

from fastapi import APIRouter

from app.api.v1.endpoints.crm import router as crm_router
from app.api.v1.endpoints.crm_proposals import router as crm_proposals_router

router = APIRouter()
router.include_router(crm_router)
router.include_router(crm_proposals_router)
