"""[BEL-81.B] AI Chat 联网搜索时间范围透传测试。

覆盖：
1. `build_stream_sources` 在未传 time_range / query 时，事件体里不写入这两个字段（兼容旧客户端）。
2. 传入 time_range='week' / query='xxx' 时，事件体能正确序列化这两个字段。
3. `detect_time_range_from_query` 对中英文时间词的归一。
4. `append_message` 接受 `search_time_range` 入参，并落到 `AIMessage.search_time_range`。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.ai_chat import AIConversation, AIMessage
from app.services.ai import chat as chat_service
from app.services.ai.search import detect_time_range_from_query
from app.services.ai.stream_utils import build_stream_sources


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _seed_conversation(db: Session) -> AIConversation:
    conv = AIConversation(
        user_id=1,
        title="t",
        created_at=datetime(2026, 6, 14, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 14, tzinfo=timezone.utc),
    )
    db.add(conv)
    db.flush()
    return conv


# ── build_stream_sources 时间范围透传 ─────────────────────────────────────


def test_build_stream_sources_without_time_range_omits_field() -> None:
    """旧调用方式（仅 sources）应不写 time_range / query 字段。"""
    raw = build_stream_sources([{"title": "x", "url": "https://x"}])
    payload = json.loads(raw.decode("utf-8").rstrip("\n"))
    assert payload["type"] == "sources"
    assert payload["sources"] == [{"title": "x", "url": "https://x"}]
    assert "time_range" not in payload
    assert "query" not in payload


def test_build_stream_sources_with_time_range_and_query() -> None:
    raw = build_stream_sources(
        [{"title": "x", "url": "https://x"}],
        time_range="week",
        query="近 7 天 BTC 价格",
    )
    payload = json.loads(raw.decode("utf-8").rstrip("\n"))
    assert payload["type"] == "sources"
    assert payload["time_range"] == "week"
    assert payload["query"] == "近 7 天 BTC 价格"


def test_build_stream_sources_empty_time_range_omits_field() -> None:
    """time_range 为空字符串视为缺省，不写入事件体。"""
    raw = build_stream_sources(
        [{"title": "x", "url": "https://x"}], time_range="", query="q"
    )
    payload = json.loads(raw.decode("utf-8").rstrip("\n"))
    assert "time_range" not in payload
    # query 非空仍写入
    assert payload["query"] == "q"


# ── detect_time_range_from_query 基础覆盖 ─────────────────────────────────


def test_detect_time_range_day_zh() -> None:
    assert detect_time_range_from_query("昨天 BTC 价格") == "day"


def test_detect_time_range_day_with_today_keyword() -> None:
    assert detect_time_range_from_query("今天 BTC 价格") == "day"


def test_detect_time_range_week_zh() -> None:
    assert detect_time_range_from_query("本周 BTC 价格") == "week"


def test_detect_time_range_week_with_compact_recent_phrase() -> None:
    assert detect_time_range_from_query("近 7 天 BTC 价格") == "week"


def test_detect_time_range_month_default() -> None:
    """无明确时间词的查询默认 month。"""
    assert detect_time_range_from_query("BTC 是什么") == "month"


def test_detect_time_range_month_with_recent_keyword() -> None:
    assert detect_time_range_from_query("最近 BTC 价格") == "month"


def test_detect_time_range_year_zh() -> None:
    assert detect_time_range_from_query("今年的政策变化") == "year"


# ── append_message search_time_range 入参 ────────────────────────────────


def test_append_message_persists_search_time_range(db: Session) -> None:
    conv = _seed_conversation(db)
    row = chat_service.append_message(
        db,
        conv.id,
        "assistant",
        "answer",
        search_sources=[{"title": "x", "url": "https://x"}],
        search_time_range="week",
    )
    db.flush()
    assert row.search_time_range == "week"
    assert json.loads(row.search_sources) == [{"title": "x", "url": "https://x"}]


def test_append_message_default_search_time_range_is_none(db: Session) -> None:
    """不传 time_range 时落库为 None。"""
    conv = _seed_conversation(db)
    row = chat_service.append_message(db, conv.id, "assistant", "answer")
    db.flush()
    assert row.search_time_range is None
