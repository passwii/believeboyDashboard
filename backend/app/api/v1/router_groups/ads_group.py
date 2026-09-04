"""广告域懒分组（BLF-657）：ad_upload / ad_analysis / rpa_reports。"""

from fastapi import APIRouter

from app.api.v1.endpoints.ad_analysis import router as ad_analysis_router
from app.api.v1.endpoints.ad_upload import router as ad_upload_router
from app.api.v1.endpoints.rpa_reports import router as rpa_reports_router

router = APIRouter()
router.include_router(ad_upload_router)
router.include_router(ad_analysis_router)
router.include_router(rpa_reports_router)
