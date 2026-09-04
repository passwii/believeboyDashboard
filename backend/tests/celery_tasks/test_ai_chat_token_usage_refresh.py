"""CELERY task refresh_ai_chat_token_usage — 单测。

覆盖（不依赖 DB，mirror tests/celery_tasks/test_return_analysis_refresh.py 屋风）:
- target_date 默认走昨日（CST 语义）
- target_date 显式传值
- 错误抛异常由 Celery 重试
- task name / max_retries / retry_backoff 配置
- _refresh_one_day：当日无 assistant 消息 → 0 行 + 不 commit
- _refresh_one_day：有 assistant 消息 → 按 (user_id, model) 聚合，UPSERT 调用一次
- 双方言 UPSERT 分支覆盖（PG / sqlite）由 dialect.name 决定
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from unittest.mock import MagicMock, patch
from zoneinfo import ZoneInfo

import pytest

CST = ZoneInfo("Asia/Shanghai")


# ── task body：target_date 解析 + 错误传播 + 配置 ──


def test_refresh_default_target_is_yesterday_cst() -> None:
    """不传 target_date → 跑昨日（CST 语义，与 Celery beat timezone 一致）."""
    from app.celery_tasks.ai_chat_token_usage_refresh import refresh_ai_chat_token_usage

    captured: dict = {}

    def fake_refresh(db, target_date):
        captured["target_date"] = target_date
        return {"rows_written": 0, "users": 0, "target_date": target_date.isoformat()}

    with patch(
        "app.celery_tasks.ai_chat_token_usage_refresh._refresh_one_day",
        side_effect=fake_refresh,
    ):
        result = refresh_ai_chat_token_usage.run(target_date=None)

    expected = (datetime.now(CST) - timedelta(days=1)).date()
    assert captured["target_date"] == expected
    assert result["rows_written"] == 0


def test_refresh_explicit_target_date_string_and_date() -> None:
    """target_date 支持 ISO string 和 date 对象."""
    from app.celery_tasks.ai_chat_token_usage_refresh import refresh_ai_chat_token_usage

    captured: dict = {}

    def fake_refresh(db, target_date):
        captured["target_date"] = target_date
        return {"rows_written": 3, "users": 1, "target_date": target_date.isoformat()}

    with patch(
        "app.celery_tasks.ai_chat_token_usage_refresh._refresh_one_day",
        side_effect=fake_refresh,
    ):
        r1 = refresh_ai_chat_token_usage.run(target_date="2026-08-01")
        r2 = refresh_ai_chat_token_usage.run(target_date=date(2026, 8, 1))

    assert captured["target_date"] == date(2026, 8, 1)
    assert r1["rows_written"] == 3
    assert r2["rows_written"] == 3


def test_refresh_propagates_db_error_for_retry() -> None:
    """DB 异常向上抛（让 Celery retry）."""
    from app.celery_tasks.ai_chat_token_usage_refresh import refresh_ai_chat_token_usage

    def fake_refresh_boom(db, target_date):
        raise RuntimeError("db connection lost")

    with patch(
        "app.celery_tasks.ai_chat_token_usage_refresh._refresh_one_day",
        side_effect=fake_refresh_boom,
    ):
        with pytest.raises(RuntimeError, match="db connection lost"):
            refresh_ai_chat_token_usage.run(target_date=date(2026, 8, 1))


def test_task_registered_with_correct_name() -> None:
    from app.celery_tasks.ai_chat_token_usage_refresh import refresh_ai_chat_token_usage

    assert refresh_ai_chat_token_usage.name == "ai_chat_token_usage.refresh_daily"


def test_task_has_retry_config() -> None:
    """max_retries=3 + retry_backoff=True + retry_backoff_max=300 — 对齐 226/373 屋风."""
    from app.celery_tasks.ai_chat_token_usage_refresh import refresh_ai_chat_token_usage

    assert refresh_ai_chat_token_usage.max_retries == 3
    assert refresh_ai_chat_token_usage.retry_backoff is True
    assert refresh_ai_chat_token_usage.retry_backoff_max == 300
    assert refresh_ai_chat_token_usage.acks_late is True


# ── _refresh_one_day：DB-free mock，覆盖空数据 / 写聚合 / 双方言 ──


def _make_aggregate_row(
    *, user_id: int, model: str, p: int, c: int, t: int, msg: int, conv: int
):
    return MagicMock(
        user_id=user_id,
        model=model,
        prompt_tokens=p,
        completion_tokens=c,
        total_tokens=t,
        message_count=msg,
        conversation_count=conv,
    )


def test_refresh_one_day_skips_when_no_messages() -> None:
    """当日无任何 assistant 消息 → 0 行 + 不 commit."""
    from app.celery_tasks.ai_chat_token_usage_refresh import _refresh_one_day

    db = MagicMock()
    # GROUP BY query: db.execute(stmt).all() → []
    db.execute.return_value.all.return_value = []

    result = _refresh_one_day(db, target_date=date(2026, 8, 1))

    assert result == {
        "rows_written": 0,
        "users": 0,
        "target_date": "2026-08-01",
    }
    db.commit.assert_not_called()
    db.execute.assert_called_once()  # 只跑了 SELECT


def test_refresh_one_day_writes_upsert_per_user_model_sqlite() -> None:
    """有 assistant 消息 → 一次 db.execute 走 sqlite UPSERT，commit 一次."""
    from app.celery_tasks.ai_chat_token_usage_refresh import _refresh_one_day

    db = MagicMock()
    db.execute.return_value.all.return_value = [
        _make_aggregate_row(
            user_id=1, model="gpt-4", p=100, c=50, t=150, msg=2, conv=1
        ),
        _make_aggregate_row(user_id=1, model="gpt-3.5", p=10, c=5, t=15, msg=1, conv=1),
        _make_aggregate_row(
            user_id=2, model="gpt-4", p=200, c=100, t=300, msg=3, conv=2
        ),
    ]
    db.get_bind.return_value.dialect.name = "sqlite"

    result = _refresh_one_day(db, target_date=date(2026, 8, 1))

    assert result["rows_written"] == 3
    assert result["users"] == 2
    db.commit.assert_called_once()
    # SELECT + INSERT-UPSERT 两次 execute
    assert db.execute.call_count == 2


def test_refresh_one_day_uses_pg_upsert_on_postgres() -> None:
    """dialect=postgresql 时走 pg_insert + on_conflict_do_update 分支."""
    from app.celery_tasks.ai_chat_token_usage_refresh import _refresh_one_day

    db = MagicMock()
    db.execute.return_value.all.return_value = [
        _make_aggregate_row(user_id=1, model="gpt-4", p=10, c=5, t=15, msg=1, conv=1),
    ]
    db.get_bind.return_value.dialect.name = "postgresql"

    result = _refresh_one_day(db, target_date=date(2026, 8, 1))

    assert result["rows_written"] == 1
    db.commit.assert_called_once()


def test_refresh_one_day_idempotent_upsert_data_version() -> None:
    """重跑同一天 UPSERT → 行为幂等（rows 数量不变，data_version 递增由 SQL 处理）.

    单元测试只验证 Python 侧：两次调用都得到相同 rows_written / users。
    data_version 的 +1 由 SQL 表达式保证，由集成测试 / 生产验证。
    """
    from app.celery_tasks.ai_chat_token_usage_refresh import _refresh_one_day

    db = MagicMock()
    db.execute.return_value.all.return_value = [
        _make_aggregate_row(user_id=1, model="gpt-4", p=10, c=5, t=15, msg=1, conv=1),
    ]
    db.get_bind.return_value.dialect.name = "postgresql"

    r1 = _refresh_one_day(db, target_date=date(2026, 8, 1))
    db.execute.reset_mock()
    r2 = _refresh_one_day(db, target_date=date(2026, 8, 1))

    assert r1["rows_written"] == r2["rows_written"] == 1
    assert r1["users"] == r2["users"] == 1
