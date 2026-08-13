"""报表域懒分组（BLF-657）：daily / monthly / product_analysis / reconciliation / revenues / vat。"""

from fastapi import APIRouter

from app.api.v1.endpoints.daily_analysis import router as daily_analysis_router
from app.api.v1.endpoints.monthly_reports import router as monthly_reports_router
from app.api.v1.endpoints.platform_revenues import router as platform_revenues_router
from app.api.v1.endpoints.product_analysis import router as product_analysis_router
from app.api.v1.endpoints.product_analysis_reports import (
    router as product_analysis_reports_router,
)
from app.api.v1.endpoints.report_reconciliation import (
    router as report_reconciliation_router,
)
from app.api.v1.endpoints.vat_invoices import router as vat_invoices_router

router = APIRouter()
router.include_router(daily_analysis_router)
router.include_router(monthly_reports_router)
router.include_router(product_analysis_reports_router)
router.include_router(product_analysis_router)
router.include_router(report_reconciliation_router)
router.include_router(platform_revenues_router)
router.include_router(vat_invoices_router)
