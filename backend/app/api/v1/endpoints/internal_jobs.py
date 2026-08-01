"""Internal admin endpoints for return analysis (BEL-373).

手动触发退货分析物化表刷新（admin only）：
POST /api/v1/internal/jobs/return-analysis-refresh

用于：
- 运营手动补跑（如 ETL 修了之后）
- 验证 Celery beat 调度是否生效
- 紧急修复 stale snapshot（>25h 未刷新）
"""

from __future__ import annotations

import logging
from datetime import date as date_cls
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.celery_tasks.return_analysis_refresh import _refresh_one_day
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/jobs", tags=["internal-jobs"])


def _require_admin(is_admin: bool = Header(default=False, alias="X-Is-Admin")) -> bool:
    """Admin gate: 只允许管理员触发内部任务."""
    if not is_admin:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


class ReturnAnalysisRefreshRequest(BaseModel):
    """手动触发退货分析物化表刷新请求."""

    target_date: Optional[str] = Field(
        default=None,
        description="ISO date (YYYY-MM-DD)。None = 跑昨天。",
    )
    backfill_days: int = Field(
        default=1,
        ge=1,
        le=90,
        description="回填天数 (含 target_date)，范围 1~90。默认 1 = 只跑 target_date。",
    )


class ReturnAnalysisRefreshResponse(BaseModel):
    """手动触发响应."""

    target_date: str
    backfill_days: int
    rows_written: int
    projects: int
    note: str = "snapshot 已被覆盖，endpoint 25h 内会读到最新"


@router.post(
    "/return-analysis-refresh",
    response_model=ReturnAnalysisRefreshResponse,
    dependencies=[Depends(_require_admin)],
)
def trigger_return_analysis_refresh(
    request: ReturnAnalysisRefreshRequest,
) -> ReturnAnalysisRefreshResponse:
    """手动刷新退货分析物化表.

    默认只跑 target_date（或昨天）；backfill_days > 1 时连同前 N-1 天一起重跑。
    所有日期一次性 commit，便于回填场景。
    """
    if request.target_date:
        end_date = date_cls.fromisoformat(request.target_date)
    else:
        end_date = date_cls.today() - timedelta(days=1)

    start_date = end_date - timedelta(days=request.backfill_days - 1)

    db = SessionLocal()
    try:
        total_rows = 0
        max_projects = 0
        current = start_date
        while current <= end_date:
            result = _refresh_one_day(db, target_date=current)
            total_rows += result["rows_written"]
            max_projects = max(max_projects, result["projects"])
            current += timedelta(days=1)
        # 每个 _refresh_one_day 已经 commit；这里不再重复 commit
    finally:
        db.close()

    logger.info(
        "手动触发 return-analysis-refresh: range=%s..%s rows=%d projects=%d",
        start_date.isoformat(),
        end_date.isoformat(),
        total_rows,
        max_projects,
    )

    return ReturnAnalysisRefreshResponse(
        target_date=end_date.isoformat(),
        backfill_days=request.backfill_days,
        rows_written=total_rows,
        projects=max_projects,
    )
