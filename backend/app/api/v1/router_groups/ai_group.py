"""AI 域懒分组（BLF-657）：ai_chat / ai_chat_v2 / ai_file_upload / ai_chat_usage / ai_insight。"""

from fastapi import APIRouter

from app.api.v1.endpoints.ai_chat import router as ai_chat_router
from app.api.v1.endpoints.ai_chat_v2 import router as ai_chat_v2_router
from app.api.v1.endpoints.ai_chat_usage import router as ai_chat_usage_router
from app.api.v1.endpoints.ai_file_upload import router as ai_file_upload_router
from app.api.v1.endpoints.ai_insight import router as ai_insight_router

router = APIRouter()
router.include_router(ai_chat_router)
router.include_router(ai_chat_v2_router)
router.include_router(ai_file_upload_router)
router.include_router(ai_chat_usage_router)
router.include_router(ai_insight_router)
