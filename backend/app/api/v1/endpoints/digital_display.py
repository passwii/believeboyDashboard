"""数字大屏 API 端点"""

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_db_session
from app.core.security import require_api_key
from app.schemas.digital_display import DigitalDisplayResponse
from app.services import digital_display_service

router = APIRouter()


@router.get("/digital-display/{project_id}", response_model=DigitalDisplayResponse)
async def get_digital_display(
    project_id: int,
    country: str = Query(default="US"),
    days: int = Query(default=7, ge=3, le=30),
    db=Depends(get_db_session),
    _=Depends(require_api_key),
) -> DigitalDisplayResponse:
    """
    数字大屏聚合数据接口。

    - 仅需 X-API-Key 认证，无需用户上下文（适合 TV 无登录场景）
    - 返回所有大屏展示模块的数据：销售概览、趋势、库存、发货、退货、广告
    """
    payload = digital_display_service.build_digital_display(
        db=db,
        project_id=project_id,
        country=country,
        days=days,
    )
    return DigitalDisplayResponse(**payload)