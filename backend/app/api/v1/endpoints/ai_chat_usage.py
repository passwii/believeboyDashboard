"""BEL-379 AI chat token 用量统计读端点。

``GET /api/v1/ai/usage/stats?range=7d|30d|90d`` —— 返回当前请求用户
（X-User-Id 注入）在指定区间内的 token 用量统计：

- ``daily``：按日序列（缺失日期补 0 行）
- ``by_model``：按模型汇总
- ``totals``：区间求和
- ``snapshot_freshness``：最近一次 Celery 写入的元信息

读源是 ``ai_chat_token_usage_snapshots`` 物化表（不是 ai_messages 在线聚合），
因此使用 ``get_read_db_session`` 走读副本（与 ai_chat 其它写端点解耦）。

用户隔离：严格按 X-User-Id 过滤；缺失或解析失败 → 200 空结果（与
ai_chat.list_conversations 口径一致：不暴露 404，避免存在性泄漏）。
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, protected
from app.api.v1.endpoints.ai_chat import _get_request_user_id
from app.models.ai_chat import AIChatTokenUsageSnapshot
from app.schemas.ai_chat_usage import (
    ALLOWED_USAGE_RANGES,
    AIChatUsageDailyPoint,
    AIChatUsageModelSummary,
    AIChatUsageSnapshotFreshness,
    AIChatUsageStatsResponse,
    AIChatUsageTotals,
    USAGE_RANGE_DAYS,
    UsageRange,
)

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(protected)])


CST = ZoneInfo("Asia/Shanghai")


@router.get("/usage/stats", response_model=AIChatUsageStatsResponse)
def get_ai_chat_usage_stats(
    range: UsageRange = Query(default="30d", description="7d / 30d / 90d"),
    db: Session = Depends(get_read_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> AIChatUsageStatsResponse:
    """当前用户的 token 用量统计（读 ai_chat_token_usage_snapshots 物化表）。"""
    if range not in ALLOWED_USAGE_RANGES:
        # FastAPI 的 Literal 校验已兜底；此处 defensive
        range = "30d"  # type: ignore[assignment]
    days = USAGE_RANGE_DAYS[range]

    today_cst = datetime.now(CST).date()
    end_date = today_cst
    start_date = end_date - timedelta(days=days - 1)  # 含 end_date 共 days 天

    freshness = _snapshot_freshness(db)
    if user_id is None or freshness.latest_data_date is None:
        # 无归属 / 物化表空：直接返回 0 填充的区间，不打 DB
        return _empty_response(range, start_date, end_date, freshness)

    # 拉区间内当前用户所有快照行
    stmt = (
        select(AIChatTokenUsageSnapshot)
        .where(
            AIChatTokenUsageSnapshot.user_id == user_id,
            AIChatTokenUsageSnapshot.data_date >= start_date,
            AIChatTokenUsageSnapshot.data_date <= end_date,
        )
        .order_by(AIChatTokenUsageSnapshot.data_date.asc())
    )
    rows = list(db.execute(stmt).scalars().all())

    # 按日聚合
    by_date: dict[date, dict[str, int]] = defaultdict(
        lambda: {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "message_count": 0,
        }
    )
    by_model: dict[str, dict[str, int]] = defaultdict(
        lambda: {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "message_count": 0,
        }
    )
    totals = AIChatUsageTotals()
    for r in rows:
        d = by_date[r.data_date]
        d["prompt_tokens"] += r.prompt_tokens
        d["completion_tokens"] += r.completion_tokens
        d["total_tokens"] += r.total_tokens
        d["message_count"] += r.message_count

        m = by_model[r.model]
        m["prompt_tokens"] += r.prompt_tokens
        m["completion_tokens"] += r.completion_tokens
        m["total_tokens"] += r.total_tokens
        m["message_count"] += r.message_count

        totals.prompt_tokens += r.prompt_tokens
        totals.completion_tokens += r.completion_tokens
        totals.total_tokens += r.total_tokens
        totals.message_count += r.message_count
        totals.conversation_count += (
            r.conversation_count
        )  # ∑ 每日 distinct-conv（上界，docstring 已说明）

    # daily：补齐缺失日期为 0 行，前端可拉直时间轴
    daily: list[AIChatUsageDailyPoint] = []
    cursor = start_date
    while cursor <= end_date:
        d = by_date.get(cursor)
        if d:
            daily.append(
                AIChatUsageDailyPoint(
                    date=cursor,
                    prompt_tokens=d["prompt_tokens"],
                    completion_tokens=d["completion_tokens"],
                    total_tokens=d["total_tokens"],
                    message_count=d["message_count"],
                )
            )
        else:
            daily.append(AIChatUsageDailyPoint(date=cursor))
        cursor += timedelta(days=1)

    by_model_list = [
        AIChatUsageModelSummary(model=m, **vals) for m, vals in by_model.items()
    ]
    # 按 total_tokens 降序，前端可默认展示
    by_model_list.sort(key=lambda x: x.total_tokens, reverse=True)

    return AIChatUsageStatsResponse(
        range=range,
        start_date=start_date,
        end_date=end_date,
        totals=totals,
        daily=daily,
        by_model=by_model_list,
        snapshot_freshness=freshness,
    )


def _snapshot_freshness(db: Session) -> AIChatUsageSnapshotFreshness:
    """取全局最近一次快照写入（不按 user 过滤；仅展示元信息）。"""
    stmt = (
        select(AIChatTokenUsageSnapshot.data_date, AIChatTokenUsageSnapshot.computed_at)
        .order_by(AIChatTokenUsageSnapshot.computed_at.desc())
        .limit(1)
    )
    row = db.execute(stmt).first()
    if not row:
        return AIChatUsageSnapshotFreshness()
    return AIChatUsageSnapshotFreshness(
        latest_data_date=row.data_date, latest_computed_at=row.computed_at
    )


def _empty_response(
    range: UsageRange,
    start_date: date,
    end_date: date,
    freshness: AIChatUsageSnapshotFreshness,
) -> AIChatUsageStatsResponse:
    # 补齐全 0 的 daily
    daily: list[AIChatUsageDailyPoint] = []
    cursor = start_date
    while cursor <= end_date:
        daily.append(AIChatUsageDailyPoint(date=cursor))
        cursor += timedelta(days=1)
    return AIChatUsageStatsResponse(
        range=range,
        start_date=start_date,
        end_date=end_date,
        totals=AIChatUsageTotals(),
        daily=daily,
        by_model=[],
        snapshot_freshness=freshness,
    )
