from __future__ import annotations

from pydantic import BaseModel, Field


class ProjectGoalItem(BaseModel):
    """单条目标记录"""
    id: int
    project_id: int
    country: str
    goal_type: str  # 'monthly' | 'annual'
    metric_type: str  # 'sales_amount' | ... 未来扩展
    period_year: int
    period_month: int | None  # 1-12, only for monthly goals
    target_amount: float
    currency: str  # 'USD' | 'EUR' | 'GBP'
    created_at: str
    updated_at: str


class ProjectGoalCreate(BaseModel):
    """创建目标请求"""
    project_id: int
    country: str = 'US'
    goal_type: str = 'monthly'
    metric_type: str = 'sales_amount'  # 未来可扩展其他维度
    period_year: int = Field(..., ge=2020, le=2100)
    period_month: int | None = Field(None, ge=1, le=12)
    target_amount: float = Field(..., ge=0)


class ProjectGoalUpdate(BaseModel):
    """更新目标请求"""
    target_amount: float = Field(..., ge=0)


class MonthlyProgressItem(BaseModel):
    """月度完成进度项"""
    year: int
    month: int  # 1-12
    month_label: str  # "2026年1月"
    target_amount: float
    achieved_amount: float
    completion_rate: float  # 0.0 - 1.0+
    days_in_month: int
    today_day: int  # 截止今天的日期
    daily_target: float  # 每日目标 (target / days_in_month)
    cumulative_daily_target: float  # 截止今天的累计目标
    completion_vs_daily: float  # 实际完成 vs 累计目标 (0.0 - 1.0+)
    completion_vs_monthly: float  # 实际完成 vs 月度目标 (0.0 - 1.0+)
    currency: str  # 'USD' | 'EUR' | 'GBP'


class AnnualProgressItem(BaseModel):
    """年度完成进度项"""
    year: int
    target_amount: float
    achieved_amount: float
    completion_rate: float  # 0.0 - 1.0+
    currency: str


class ProjectGoalProgressResponse(BaseModel):
    """目标进度响应"""
    project_id: int
    country: str
    year: int
    currency: str  # 'USD' | 'EUR' | 'GBP'
    monthly_progress: list[MonthlyProgressItem]
    annual_progress: AnnualProgressItem | None


class ProjectGoalListResponse(BaseModel):
    """目标列表响应"""
    goals: list[ProjectGoalItem]
    total: int
