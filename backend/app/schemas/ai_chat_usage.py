"""BEL-379 AI chat token 用量统计响应模型。

``GET /api/v1/ai/usage/stats?range=7d|30d|90d`` 返回的契约。

设计要点（与 ``AIChatTokenUsageSnapshot`` 物化表口径一致）：
- ``daily`` 为快照表逐行透传，``start_date..end_date`` 区间内没有数据的日期
  补 0 行（前端可拉直时间轴）。
- ``by_model`` 为 ``(model)`` 维度按区间聚合，仅做求和（每行已是 per-day，
  区间求和语义明确）。
- ``totals`` 为区间求和：``message_count`` 准确；``conversation_count`` 为
  ∑ 每日 distinct-conv，是真实 distinct conv 数的**上界**（同一 conv 跨多
  日会被多次计入），前端展示文案应避免暗示「不重复会话数」。
- ``snapshot_freshness`` 透传最近一次 ``computed_at``，前端可据此显示
  「数据更新于 ...」，并判断当前区间末尾日期是否已快照。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


UsageRange = Literal["7d", "30d", "90d"]
ALLOWED_USAGE_RANGES: tuple[UsageRange, ...] = ("7d", "30d", "90d")
USAGE_RANGE_DAYS: dict[UsageRange, int] = {"7d": 7, "30d": 30, "90d": 90}


class AIChatUsageDailyPoint(BaseModel):
    date: date
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    message_count: int = 0


class AIChatUsageModelSummary(BaseModel):
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    message_count: int = 0


class AIChatUsageTotals(BaseModel):
    """区间求和。``conversation_count`` 为上界，见模块 docstring。"""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    message_count: int = 0
    conversation_count: int = Field(
        default=0,
        description=(
            "∑ 每日 distinct-conv；单日 = 真实 distinct，跨日为上界。"
            "前端展示时避免暗示「不重复会话数」。"
        ),
    )


class AIChatUsageSnapshotFreshness(BaseModel):
    """最近一次 Celery 写入的元信息，供前端判断数据新鲜度。"""

    latest_data_date: date | None = None
    latest_computed_at: datetime | None = None


class AIChatUsageStatsResponse(BaseModel):
    range: UsageRange
    start_date: date
    end_date: date
    totals: AIChatUsageTotals
    daily: list[AIChatUsageDailyPoint]
    by_model: list[AIChatUsageModelSummary]
    snapshot_freshness: AIChatUsageSnapshotFreshness
