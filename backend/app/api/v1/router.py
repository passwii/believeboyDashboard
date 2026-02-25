from fastapi import APIRouter

from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.jobs import router as jobs_router
from app.api.v1.endpoints.product_costs import router as product_costs_router
from app.api.v1.endpoints.projects import router as projects_router
from app.api.v1.endpoints.system_management import router as system_management_router
from app.api.v1.endpoints.uploads import router as uploads_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(projects_router)
api_router.include_router(product_costs_router)
api_router.include_router(uploads_router)
api_router.include_router(jobs_router)
api_router.include_router(system_management_router)
