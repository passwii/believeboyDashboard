"""类目/归因分析域懒分组（BLF-657）：category_research / presence / return_analysis / project_goals。"""

from fastapi import APIRouter

from app.api.v1.endpoints.category_research import router as category_research_router
from app.api.v1.endpoints.presence import router as presence_router
from app.api.v1.endpoints.project_goals import router as project_goals_router
from app.api.v1.endpoints.return_analysis import router as return_analysis_router

router = APIRouter()
router.include_router(category_research_router)
router.include_router(presence_router)
router.include_router(return_analysis_router)
router.include_router(project_goals_router)
