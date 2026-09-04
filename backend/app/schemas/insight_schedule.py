"""Insight Schedule Pydantic Schemas"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


# -------------------------------------------------------------------------------------------------
# Cron 表达式快捷预设
# -------------------------------------------------------------------------------------------------

CRON_PRESETS = [
    {"label": "每天 06:00", "value": "0 6 * * *"},
    {"label": "每天 07:00", "value": "0 7 * * *"},
    {"label": "每天 08:00", "value": "0 8 * * *"},
    {"label": "每周一 07:00", "value": "0 7 * * 1"},
    {"label": "每周一 08:00", "value": "0 8 * * 1"},
    {"label": "每月1号 07:00", "value": "0 7 1 * *"},
    {"label": "每月1号 08:00", "value": "0 8 1 * *"},
]

DATE_RANGE_STRATEGIES = [
    {"value": "yesterday", "label": "昨日（单日）"},
    {"value": "last_7d", "label": "近 7 天"},
    {"value": "last_30d", "label": "近 30 天"},
    {"value": "prev_month", "label": "上月整月"},
    {"value": "current_month", "label": "当月至今"},
    {"value": "last_week", "label": "上周（周一至周日）"},
]


# -------------------------------------------------------------------------------------------------
# 请求模型
# -------------------------------------------------------------------------------------------------

class InsightScheduleCreate(BaseModel):
    """创建定时任务的请求体"""

    project_id: int = Field(..., description="关联项目 ID")
    country: Literal["US", "DE", "UK"] = Field(default="US", description="目标站点")
    insight_type: Literal["daily", "weekly", "monthly", "custom"] = Field(
        default="daily", description="洞察类型"
    )
    cron_expression: str = Field(
        ...,
        description="标准 5 字段 cron 表达式：分 时 日 月 周",
    )
    date_range_strategy: Literal[
        "yesterday", "last_7d", "last_30d", "prev_month", "current_month", "last_week"
    ] = Field(default="yesterday", description="数据日期范围策略")
    model: Optional[str] = Field(default=None, description="可选的 LLM 模型覆盖")

    @field_validator("cron_expression")
    @classmethod
    def validate_cron(cls, v: str) -> str:
        """校验 cron 表达式格式（5 字段）"""
        parts = v.strip().split()
        if len(parts) != 5:
            raise ValueError("Cron 表达式必须是 5 个字段：分 时 日 月 周")
        return v.strip()


class InsightScheduleUpdate(BaseModel):
    """更新定时任务的请求体"""

    country: Optional[Literal["US", "DE", "UK"]] = Field(default=None)
    insight_type: Optional[Literal["daily", "weekly", "monthly", "custom"]] = Field(
        default=None
    )
    cron_expression: Optional[str] = Field(default=None)
    date_range_strategy: Optional[
        Literal[
            "yesterday", "last_7d", "last_30d", "prev_month", "current_month", "last_week"
        ]
    ] = Field(default=None)
    model: Optional[str] = Field(default=None)
    is_active: Optional[bool] = Field(default=None)


# -------------------------------------------------------------------------------------------------
# 响应模型
# -------------------------------------------------------------------------------------------------

class InsightScheduleItem(BaseModel):
    """定时任务响应模型"""

    id: int
    project_id: int
    project_name: str  # 来自关联项目
    country: str
    insight_type: str
    cron_expression: str
    date_range_strategy: str
    model: Optional[str]
    is_active: bool
    run_count: int
    failure_count: int
    last_run_at: Optional[datetime]
    last_insight_id: Optional[int]
    last_error: Optional[str]
    next_run_at: Optional[datetime]
    created_by: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class InsightScheduleListResponse(BaseModel):
    """定时任务列表响应"""

    items: list[InsightScheduleItem]
    total: int


class InsightScheduleToggleResponse(BaseModel):
    """切换启用状态响应"""

    id: int
    is_active: bool
    message: str


class InsightScheduleRunNowResponse(BaseModel):
    """立即执行响应"""

    id: int
    insight_id: int
    status: str
    message: str


class InsightScheduleDeleteResponse(BaseModel):
    """删除响应"""

    deleted: bool
    id: int