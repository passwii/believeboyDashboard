from fastapi import APIRouter

from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.jobs import router as jobs_router
from app.api.v1.endpoints.monthly_reports import router as monthly_reports_router
from app.api.v1.endpoints.daily_analysis import router as daily_analysis_router
from app.api.v1.endpoints.product_analysis import router as product_analysis_router
from app.api.v1.endpoints.product_analysis_reports import router as product_analysis_reports_router
from app.api.v1.endpoints.presence import router as presence_router
from app.api.v1.endpoints.sku_info import router as sku_info_router
from app.api.v1.endpoints.pricing_calculation import router as pricing_calculation_router
from app.api.v1.endpoints.store_sku_pricing_snapshots import router as store_sku_pricing_snapshots_router
from app.api.v1.endpoints.shop_calculation import router as shop_calculation_router
from app.api.v1.endpoints.projects import router as projects_router
from app.api.v1.endpoints.ai_chat import router as ai_chat_router
from app.api.v1.endpoints.ai_file_upload import router as ai_file_upload_router
from app.api.v1.endpoints.ai_insight import router as ai_insight_router
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.exchange_rates import router as exchange_rates_router
from app.api.v1.endpoints.inventory_replenishment import router as inventory_replenishment_router
from app.api.v1.endpoints.inventory_replenishment_snapshots import router as inventory_replenishment_snapshots_router
from app.api.v1.endpoints.shipment_schedules import router as shipment_schedules_router
from app.api.v1.endpoints.system_management import router as system_management_router
from app.api.v1.endpoints.uploads import router as uploads_router
from app.api.v1.endpoints.ad_upload import router as ad_upload_router
from app.api.v1.endpoints.ad_analysis import router as ad_analysis_router
from app.api.v1.endpoints.users import router as users_router
from app.api.v1.endpoints.category_research import router as category_research_router
from app.api.v1.endpoints.return_analysis import router as return_analysis_router
from app.api.v1.endpoints.project_goals import router as project_goals_router
from app.api.v1.endpoints.digital_employees import router as digital_employees_router
from app.api.v1.endpoints.rpa_reports import router as rpa_reports_router
from app.api.v1.endpoints.report_reconciliation import router as report_reconciliation_router
from app.api.v1.endpoints.digital_display import router as digital_display_router
from app.api.v1.endpoints.dashboard_overview import router as dashboard_overview_router
from app.api.v1.endpoints.alerts import router as alerts_router
from app.api.v1.endpoints.scheduled_reports import router as scheduled_reports_router
from app.api.v1.endpoints.notification_settings import router as notification_settings_router
from app.api.v1.endpoints.platform_revenues import router as platform_revenues_router
from app.api.v1.endpoints.backups import router as backups_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(exchange_rates_router)
api_router.include_router(projects_router)
api_router.include_router(sku_info_router)
api_router.include_router(pricing_calculation_router)
api_router.include_router(store_sku_pricing_snapshots_router)
api_router.include_router(shop_calculation_router)
api_router.include_router(inventory_replenishment_router)
api_router.include_router(inventory_replenishment_snapshots_router)
api_router.include_router(shipment_schedules_router)
api_router.include_router(ai_chat_router)
api_router.include_router(ai_file_upload_router)
api_router.include_router(ai_insight_router)
api_router.include_router(uploads_router)
api_router.include_router(ad_upload_router)
api_router.include_router(ad_analysis_router)
api_router.include_router(jobs_router)
api_router.include_router(daily_analysis_router)
api_router.include_router(monthly_reports_router)
api_router.include_router(product_analysis_reports_router)
api_router.include_router(product_analysis_router)
api_router.include_router(category_research_router)
api_router.include_router(system_management_router)
api_router.include_router(users_router)
api_router.include_router(presence_router)
api_router.include_router(return_analysis_router)
api_router.include_router(project_goals_router)
api_router.include_router(rpa_reports_router)
api_router.include_router(digital_employees_router)
api_router.include_router(report_reconciliation_router)
api_router.include_router(digital_display_router)
api_router.include_router(dashboard_overview_router)
api_router.include_router(alerts_router)
api_router.include_router(scheduled_reports_router)
api_router.include_router(notification_settings_router)
api_router.include_router(platform_revenues_router)
api_router.include_router(backups_router)
