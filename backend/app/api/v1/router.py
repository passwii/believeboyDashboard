from fastapi import APIRouter

from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.jobs import router as jobs_router
from app.api.v1.endpoints.monthly_reports import router as monthly_reports_router
from app.api.v1.endpoints.daily_reports import router as daily_reports_router
from app.api.v1.endpoints.product_analysis import router as product_analysis_router
from app.api.v1.endpoints.product_analysis_reports import router as product_analysis_reports_router
from app.api.v1.endpoints.product_costs import router as product_costs_router
from app.api.v1.endpoints.pricing_calculation import router as pricing_calculation_router
from app.api.v1.endpoints.projects import router as projects_router
from app.api.v1.endpoints.ai_chat import router as ai_chat_router
from app.api.v1.endpoints.auth import router as auth_router
from app.api.v1.endpoints.exchange_rates import router as exchange_rates_router
from app.api.v1.endpoints.inventory_replenishment import router as inventory_replenishment_router
from app.api.v1.endpoints.shipment_schedules import router as shipment_schedules_router
from app.api.v1.endpoints.system_management import router as system_management_router
from app.api.v1.endpoints.uploads import router as uploads_router
from app.api.v1.endpoints.users import router as users_router
from app.api.v1.endpoints.category_research import router as category_research_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(exchange_rates_router)
api_router.include_router(projects_router)
api_router.include_router(product_costs_router)
api_router.include_router(pricing_calculation_router)
api_router.include_router(inventory_replenishment_router)
api_router.include_router(shipment_schedules_router)
api_router.include_router(ai_chat_router)
api_router.include_router(uploads_router)
api_router.include_router(jobs_router)
api_router.include_router(daily_reports_router)
api_router.include_router(monthly_reports_router)
api_router.include_router(product_analysis_reports_router)
api_router.include_router(product_analysis_router)
api_router.include_router(category_research_router)
api_router.include_router(system_management_router)
api_router.include_router(users_router)
