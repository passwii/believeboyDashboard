from fastapi import APIRouter

from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.jobs import router as jobs_router
from app.api.v1.endpoints.monthly_reports import router as monthly_reports_router
from app.api.v1.endpoints.vat_invoices import router as vat_invoices_router
from app.api.v1.endpoints.daily_analysis import router as daily_analysis_router
from app.api.v1.endpoints.product_analysis import router as product_analysis_router
from app.api.v1.endpoints.product_analysis_reports import (
    router as product_analysis_reports_router,
)
from app.api.v1.endpoints.presence import router as presence_router
from app.api.v1.endpoints.sku_info import router as sku_info_router
from app.api.v1.endpoints.pricing_calculation import (
    router as pricing_calculation_router,
)
from app.api.v1.endpoints.new_product_calculations import (
    router as new_product_calculations_router,
)
from app.api.v1.endpoints.pricing_calculation_snapshots import (
    router as pricing_calculation_snapshots_router,
)
from app.api.v1.endpoints.shop_calculation import router as shop_calculation_router
from app.api.v1.endpoints.projects import router as projects_router
from app.api.v1.endpoints.ai_chat import router as ai_chat_router
from app.api.v1.endpoints.ai_chat_v2 import router as ai_chat_v2_router
from app.api.v1.endpoints.ai_file_upload import router as ai_file_upload_router
from app.api.v1.endpoints.ai_chat_usage import router as ai_chat_usage_router
from app.api.v1.endpoints.ai_insight import router as ai_insight_router
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.exchange_rates import router as exchange_rates_router
from app.api.v1.endpoints.order_info import router as order_info_router
from app.api.v1.endpoints.inventory_replenishment import (
    router as inventory_replenishment_router,
)
from app.api.v1.endpoints.inventory_replenishment_snapshots import (
    router as inventory_replenishment_snapshots_router,
)
from app.api.v1.endpoints.inventory_ledger import router as inventory_ledger_router
from app.api.v1.endpoints.shipment_schedules import router as shipment_schedules_router
from app.api.v1.endpoints.system_management import router as system_management_router
from app.api.v1.endpoints.uploads import router as uploads_router
from app.api.v1.endpoints.ad_upload import router as ad_upload_router
from app.api.v1.endpoints.ad_analysis import router as ad_analysis_router
from app.api.v1.endpoints.users import router as users_router
from app.api.v1.endpoints.profile import router as profile_router
from app.api.v1.endpoints.category_research import router as category_research_router
from app.api.v1.endpoints.return_analysis import router as return_analysis_router
from app.api.v1.endpoints.project_goals import router as project_goals_router
from app.api.v1.endpoints.digital_employees import router as digital_employees_router
from app.api.v1.endpoints.digital_office import router as digital_office_router
from app.api.v1.endpoints.rpa_reports import router as rpa_reports_router
from app.api.v1.endpoints.report_reconciliation import (
    router as report_reconciliation_router,
)
from app.api.v1.endpoints.digital_display import router as digital_display_router
from app.api.v1.endpoints.alerts import router as alerts_router
from app.api.v1.endpoints.scheduled_reports import router as scheduled_reports_router
from app.api.v1.endpoints.notification_settings import (
    router as notification_settings_router,
)
from app.api.v1.endpoints.platform_revenues import router as platform_revenues_router
from app.api.v1.endpoints.inspections import router as inspections_router
from app.api.v1.endpoints.page_render import router as page_render_router
from app.api.v1.endpoints.external_retired import external_retired_router
from app.api.v1.endpoints.agent import agent_router
from app.api.v1.endpoints.crm import router as crm_router
from app.api.v1.endpoints.notifications import router as notifications_router
from app.api.v1.endpoints.internal_jobs import router as internal_jobs_router
from app.api.v1.endpoints.internal.api_keys import router as internal_api_keys_router
from app.api.v1.endpoints.internal.ad_data import router as internal_ad_data_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(exchange_rates_router)
api_router.include_router(order_info_router)
api_router.include_router(projects_router)
api_router.include_router(sku_info_router)
api_router.include_router(pricing_calculation_router)
api_router.include_router(new_product_calculations_router)
api_router.include_router(pricing_calculation_snapshots_router)
api_router.include_router(shop_calculation_router)
api_router.include_router(inventory_replenishment_router)
api_router.include_router(inventory_replenishment_snapshots_router)
api_router.include_router(
    inventory_ledger_router, prefix="/inventory-ledger", tags=["inventory-ledger"]
)
api_router.include_router(shipment_schedules_router)
api_router.include_router(ai_chat_router)
api_router.include_router(ai_chat_v2_router)
api_router.include_router(ai_file_upload_router)
api_router.include_router(ai_chat_usage_router)
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
api_router.include_router(profile_router)
api_router.include_router(presence_router)
api_router.include_router(return_analysis_router)
api_router.include_router(project_goals_router)
api_router.include_router(rpa_reports_router)
api_router.include_router(digital_employees_router)
api_router.include_router(digital_office_router)
api_router.include_router(report_reconciliation_router)
api_router.include_router(digital_display_router)
api_router.include_router(alerts_router)
api_router.include_router(scheduled_reports_router)
api_router.include_router(notification_settings_router)
api_router.include_router(platform_revenues_router)
api_router.include_router(inspections_router)
api_router.include_router(page_render_router)
# BLF-459 V3：/external/* 已彻底下线（老消费者全部切到 /agent/*）。
# 保留一个 410 Gone 兜底路由，给仍打旧路径的调用方明确信号（见
# app/api/v1/endpoints/external_retired.py），而不是裸 404。
api_router.include_router(external_retired_router)
api_router.include_router(agent_router)
api_router.include_router(vat_invoices_router)
api_router.include_router(crm_router)
api_router.include_router(notifications_router)
api_router.include_router(internal_jobs_router)
api_router.include_router(internal_api_keys_router)
# BLF-459 V3：/external/* 下线后浏览器 ad-data 页的内部读路由。
api_router.include_router(internal_ad_data_router)
