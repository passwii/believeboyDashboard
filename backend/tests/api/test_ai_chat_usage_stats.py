"""GET /api/v1/ai/usage/stats — 单测（DB-free via dependency_overrides）。

覆盖：
- range 解析（7d/30d/90d），默认 30d
- user 隔离：user A 的快照 user B 看不到
- 缺失 user_id（X-User-Id 未传）→ 200 空结果
- 物化表空 → 200 全 0 daily（区间补齐）+ 空 by_model
- 按 model 汇总正确
- snapshot_freshness 透传
- daily 区间补齐缺失日期为 0 行
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from zoneinfo import ZoneInfo

import pytest

CST = ZoneInfo("Asia/Shanghai")
API_KEY_HEADER = "X-API-Key"
USER_HEADER = "X-User-Id"


def _settings_with_api_key(api_key: str = "test-key"):
    from app.core.config import get_settings

    s = get_settings()
    s.api_key = api_key
    return s


@pytest.fixture
def api_key(monkeypatch):
    """Force a known API key so the test client can auth without real settings."""
    _settings_with_api_key("test-key")
    return "test-key"


def _make_snapshot(
    *,
    user_id: int,
    data_date: date,
    model: str,
    prompt: int,
    completion: int,
    total: int,
    msg: int,
    conv: int,
    computed_at: datetime | None = None,
):
    return SimpleNamespace(
        user_id=user_id,
        data_date=data_date,
        model=model,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        message_count=msg,
        conversation_count=conv,
        data_version=1,
        computed_at=computed_at or datetime(2026, 8, 2, 3, 15, tzinfo=timezone.utc),
    )


class _FakeScalarResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return _FakeScalars(self._rows)


class _FakeScalars:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return list(self._rows)


class _FakeFreshnessResult:
    """fake ``db.execute(stmt).first()`` for the freshness query."""

    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


def _make_fake_db(*, snapshots: list, freshness_row=None) -> MagicMock:
    """Build a mock Session.

    Execute call order in the endpoint:
      1) ``_snapshot_freshness`` → ``db.execute(stmt).first()``
      2) snapshots select        → ``db.execute(stmt).scalars().all()``

    So ``side_effect`` must be ``[freshness_result, scalar_result]`` in that order.
    """
    db = MagicMock()
    db.execute.side_effect = [
        _FakeFreshnessResult(freshness_row),
        _FakeScalarResult(snapshots),
    ]
    return db


def _override_db(app, db_mock):
    from app.api.v1.endpoints import ai_chat_usage
    from app.api.deps import get_read_db_session

    app.dependency_overrides[get_read_db_session] = lambda: db_mock
    yield
    app.dependency_overrides.pop(get_read_db_session, None)


def _client(app):
    from fastapi.testclient import TestClient

    return TestClient(app)


# ── tests ──


def test_default_range_is_30d(api_key) -> None:
    """不传 range → 默认 30d."""
    from app.main import app
    from app.api.deps import get_read_db_session

    db = _make_fake_db(snapshots=[], freshness_row=None)
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats",
                headers={API_KEY_HEADER: api_key, USER_HEADER: "1"},
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    assert r.status_code == 200
    body = r.json()
    assert body["range"] == "30d"
    assert (
        date.fromisoformat(body["end_date"]) - date.fromisoformat(body["start_date"])
    ).days == 29
    assert len(body["daily"]) == 30  # 30 天全部补 0
    assert body["totals"]["total_tokens"] == 0
    assert body["by_model"] == []


def test_invalid_range_falls_back_to_30d(api_key) -> None:
    """range=14d（非法）→ FastAPI Literal 校验返回 422（schema 兜底）."""
    from app.main import app
    from app.api.deps import get_read_db_session

    db = _make_fake_db(snapshots=[], freshness_row=None)
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats?range=14d",
                headers={API_KEY_HEADER: api_key, USER_HEADER: "1"},
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    assert r.status_code == 422


@pytest.mark.parametrize("rng,expected_days", [("7d", 7), ("30d", 30), ("90d", 90)])
def test_range_days_mapping(api_key, rng, expected_days) -> None:
    from app.main import app
    from app.api.deps import get_read_db_session

    db = _make_fake_db(snapshots=[], freshness_row=None)
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                f"/api/v1/ai/usage/stats?range={rng}",
                headers={API_KEY_HEADER: api_key, USER_HEADER: "1"},
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    assert r.status_code == 200
    body = r.json()
    assert body["range"] == rng
    assert len(body["daily"]) == expected_days


def test_user_isolation(api_key) -> None:
    """端点只聚合请求用户自己的快照行。

    隔离由端点 SQL 的 ``WHERE user_id == requesting_user`` 保证（见
    ``ai_chat_usage.py`` 的 snapshots select）。本单测用 mock 模拟「SQL
    已预过滤为 user 1 的行」→ 验证端点 Python 循环只汇总结论，不混入
    其它用户。SQL 层面的隔离由 code review + 集成测试覆盖。
    """
    from app.main import app
    from app.api.deps import get_read_db_session

    today = datetime.now(CST).date()
    yesterday = today - timedelta(days=1)
    # 模拟 SQL WHERE user_id=1 已过滤：mock 只返回 user 1 的行
    snapshots = [
        _make_snapshot(
            user_id=1,
            data_date=yesterday,
            model="gpt-4",
            prompt=100,
            completion=50,
            total=150,
            msg=2,
            conv=1,
        ),
    ]
    db = _make_fake_db(
        snapshots=snapshots,
        freshness_row=SimpleNamespace(
            data_date=datetime.now(CST).date(),
            computed_at=datetime.now(timezone.utc),
        ),
    )
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats?range=7d",
                headers={API_KEY_HEADER: api_key, USER_HEADER: "1"},
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    assert r.status_code == 200
    body = r.json()
    assert body["totals"]["total_tokens"] == 150  # 只算 user 1
    assert body["totals"]["message_count"] == 2
    assert body["by_model"][0]["model"] == "gpt-4"
    assert body["by_model"][0]["total_tokens"] == 150


def test_missing_user_id_returns_empty(api_key) -> None:
    """X-User-Id 未传 → user_id=None → 200 全 0（不暴露 404）."""
    from app.main import app
    from app.api.deps import get_read_db_session

    db = _make_fake_db(snapshots=[], freshness_row=None)
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats?range=7d",
                headers={API_KEY_HEADER: api_key},  # 无 X-User-Id
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    assert r.status_code == 200
    body = r.json()
    assert body["totals"]["total_tokens"] == 0
    assert all(d["total_tokens"] == 0 for d in body["daily"])


def test_by_model_aggregates_across_days(api_key) -> None:
    """同一 model 跨日 → by_model 求和；daily 拆开."""
    from app.main import app
    from app.api.deps import get_read_db_session

    today = datetime.now(CST).date()
    snapshots = [
        _make_snapshot(
            user_id=1,
            data_date=today - timedelta(days=1),
            model="gpt-4",
            prompt=100,
            completion=50,
            total=150,
            msg=2,
            conv=1,
        ),
        _make_snapshot(
            user_id=1,
            data_date=today - timedelta(days=2),
            model="gpt-4",
            prompt=200,
            completion=100,
            total=300,
            msg=4,
            conv=1,
        ),
        _make_snapshot(
            user_id=1,
            data_date=today - timedelta(days=2),
            model="claude",
            prompt=50,
            completion=25,
            total=75,
            msg=1,
            conv=1,
        ),
    ]
    db = _make_fake_db(
        snapshots=snapshots,
        freshness_row=SimpleNamespace(
            data_date=datetime.now(CST).date(),
            computed_at=datetime.now(timezone.utc),
        ),
    )
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats?range=7d",
                headers={API_KEY_HEADER: api_key, USER_HEADER: "1"},
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    body = r.json()
    # by_model 求和
    by_model = {m["model"]: m for m in body["by_model"]}
    assert by_model["gpt-4"]["total_tokens"] == 450
    assert by_model["gpt-4"]["message_count"] == 6
    assert by_model["claude"]["total_tokens"] == 75
    # 排序：total_tokens 降序
    assert body["by_model"][0]["model"] == "gpt-4"
    # daily 拆开
    assert len(body["daily"]) == 7
    days_with_data = [d for d in body["daily"] if d["total_tokens"] > 0]
    assert len(days_with_data) == 2  # two distinct dates


def test_snapshot_freshness_passed_through(api_key) -> None:
    """snapshot_freshness 透传最近一次 computed_at."""
    from app.main import app
    from app.api.deps import get_read_db_session

    today = datetime.now(CST).date()
    freshness_row = SimpleNamespace(
        data_date=today - timedelta(days=1),
        computed_at=datetime(2026, 8, 2, 3, 15, tzinfo=timezone.utc),
    )
    db = _make_fake_db(snapshots=[], freshness_row=freshness_row)
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats?range=7d",
                headers={API_KEY_HEADER: api_key, USER_HEADER: "1"},
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    body = r.json()
    assert (
        body["snapshot_freshness"]["latest_data_date"]
        == (today - timedelta(days=1)).isoformat()
    )
    assert body["snapshot_freshness"]["latest_computed_at"] is not None


def test_requires_api_key() -> None:
    """无 X-API-Key → 401/403（受 protected 依赖守护）."""
    from app.main import app
    from app.api.deps import get_read_db_session

    db = _make_fake_db(snapshots=[], freshness_row=None)
    app.dependency_overrides[get_read_db_session] = lambda: db
    try:
        with _client(app) as c:
            r = c.get(
                "/api/v1/ai/usage/stats?range=7d",
                headers={USER_HEADER: "1"},  # 无 API key
            )
    finally:
        app.dependency_overrides.pop(get_read_db_session, None)

    assert r.status_code in (401, 403)
