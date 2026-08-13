"""AI Chat token 用量每日聚合快照（BEL-379 统计层）。

每日 03:15 CST 跑前一日（CST）：
- 从 ``ai_messages`` JOIN ``ai_conversations`` 按 (user_id, model) 聚合 token
  与 message/conversation 数
- UPSERT 到 ``ai_chat_token_usage_snapshots``（唯一键 (user_id, data_date, model)）

设计要点（对齐 return_analysis_refresh 屋风）：
- 队列：default（短任务，每日一次）
- 失败：max_retries=3, retry_backoff=True, retry_backoff_max=300s
- 双方言 UPSERT：PG 用 ``ON CONFLICT``，SQLite 用 ``OR REPLACE``（测试 in-memory）
- data_date 语义：CST(Asia/Shanghai) 日期，与 Celery beat timezone 一致
  （crontab 在 Asia/Shanghai 下 → 03:15 CST，data_date = 昨日 CST）
- ``target_date`` 参数允许重跑指定日期（idempotent upsert + data_version 自增）
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from celery import shared_task
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.services.infra.cache_decorator import mark_committed

logger = logging.getLogger(__name__)

# 与 celery_app.conf.timezone 保持一致；显式标注避免依赖隐式全局
CST = ZoneInfo("Asia/Shanghai")


@shared_task(
    name="ai_chat_token_usage.refresh_daily",
    bind=True,
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=300,
    acks_late=True,
)
def refresh_ai_chat_token_usage(
    self, target_date: str | date | None = None
) -> dict[str, Any]:
    """每日刷新 AI chat token 用量聚合快照.

    Args:
        target_date: ISO date string (YYYY-MM-DD) 或 date 对象.
                     None = 跑昨日（CST 语义）.

    Returns:
        dict with rows_written / users / target_date
    """
    if isinstance(target_date, str):
        run_date = date.fromisoformat(target_date)
    elif isinstance(target_date, date):
        run_date = target_date
    else:
        # 昨日 CST：与 Celery beat timezone 对齐，避开 host 时区漂移
        run_date = (datetime.now(CST) - timedelta(days=1)).date()

    db = SessionLocal()
    try:
        result = _refresh_one_day(db, target_date=run_date)
        mark_committed()  # BLF-669: _refresh_one_day 内部已 commit，协议标记
        logger.info(
            "ai_chat_token_usage.refresh_daily 完成：date=%s rows=%d users=%d",
            run_date.isoformat(),
            result["rows_written"],
            result["users"],
        )
        return result
    except Exception as exc:
        logger.exception(
            "ai_chat_token_usage.refresh_daily 失败：date=%s", run_date.isoformat()
        )
        raise self.retry(exc=exc)
    finally:
        db.close()


def _refresh_one_day(db: Session, *, target_date: date) -> dict[str, Any]:
    """对单个 CST 日期刷新 (user_id, model) 聚合.

    流程：
    1. 计算当日 CST 区间 [00:00, 次日 00:00)
    2. 查 ai_messages（join ai_conversations 取 user_id）按 (user_id, model) 聚合
    3. UPSERT 到 ai_chat_token_usage_snapshots
    """
    from app.models.ai_chat import AIMessage, AIConversation, AIChatTokenUsageSnapshot
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    # 1) CST 区间边界
    start_cst = datetime.combine(target_date, time.min, tzinfo=CST)
    end_cst = start_cst + timedelta(days=1)
    # 写库为 naive timestamptz 时，PG/psycopg 会按 UTC 解释，统一转 UTC
    # （ai_messages.created_at 是 timezone=True，UTC 存；filter 走带 tz 的 aware 即可）
    start_utc = start_cst.astimezone(timezone.utc)
    end_utc = end_cst.astimezone(timezone.utc)

    # 2) GROUP BY (user_id, model)
    stmt = (
        select(
            AIConversation.user_id.label("user_id"),
            AIMessage.model.label("model"),
            func.coalesce(func.sum(AIMessage.prompt_tokens), 0).label("prompt_tokens"),
            func.coalesce(func.sum(AIMessage.completion_tokens), 0).label(
                "completion_tokens"
            ),
            func.coalesce(func.sum(AIMessage.total_tokens), 0).label("total_tokens"),
            func.count(AIMessage.id).label("message_count"),
            func.count(func.distinct(AIMessage.conversation_id)).label(
                "conversation_count"
            ),
        )
        .select_from(AIMessage)
        .join(AIConversation, AIConversation.id == AIMessage.conversation_id)
        .where(
            AIConversation.user_id.is_not(None),
            AIMessage.created_at >= start_utc,
            AIMessage.created_at < end_utc,
            AIMessage.role == "assistant",  # 只聚合 assistant（计费口径）
        )
        .group_by(AIConversation.user_id, AIMessage.model)
    )

    aggregates = list(db.execute(stmt).all())
    if not aggregates:
        return {
            "rows_written": 0,
            "users": 0,
            "target_date": target_date.isoformat(),
        }

    rows = [
        {
            "user_id": a.user_id,
            "data_date": target_date,
            "model": a.model,
            "prompt_tokens": int(a.prompt_tokens),
            "completion_tokens": int(a.completion_tokens),
            "total_tokens": int(a.total_tokens),
            "message_count": int(a.message_count),
            "conversation_count": int(a.conversation_count),
            "data_version": 1,
            "computed_at": datetime.now(timezone.utc),
        }
        for a in aggregates
    ]

    # 3) UPSERT（双方言）
    bind = db.get_bind()
    dialect_name = bind.dialect.name if bind else "postgresql"
    insert_stmt = pg_insert(AIChatTokenUsageSnapshot).values(rows)
    update_set = {
        "prompt_tokens": insert_stmt.excluded.prompt_tokens,
        "completion_tokens": insert_stmt.excluded.completion_tokens,
        "total_tokens": insert_stmt.excluded.total_tokens,
        "message_count": insert_stmt.excluded.message_count,
        "conversation_count": insert_stmt.excluded.conversation_count,
        "data_version": AIChatTokenUsageSnapshot.data_version + 1,
        "computed_at": insert_stmt.excluded.computed_at,
    }
    if dialect_name == "postgresql":
        upsert = insert_stmt.on_conflict_do_update(
            constraint="uq_ai_chat_token_usage_user_date_model",
            set_=update_set,
        )
    else:
        upsert = sqlite_insert(AIChatTokenUsageSnapshot).values(rows)
        upsert = upsert.on_conflict_do_update(
            index_elements=["user_id", "data_date", "model"],
            set_=update_set,
        )

    db.execute(upsert)
    db.commit()
    mark_committed()  # BLF-669: commit 后必须 mark

    unique_users = {r["user_id"] for r in rows}
    return {
        "rows_written": len(rows),
        "users": len(unique_users),
        "target_date": target_date.isoformat(),
    }
