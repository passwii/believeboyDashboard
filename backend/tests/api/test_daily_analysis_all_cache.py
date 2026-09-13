"""BLF-1038：``/api/v1/daily-analysis/all`` 快照缓存（SWR）行为测试。

覆盖：
1. 命中：第二次请求不再重算聚合，且响应体与首次逐字节一致；
2. 缓存体合当前响应 schema（``model_validate_json`` 通过）；
3. stale-while-revalidate：数据变更后先返回旧快照，随后（后台刷新完成）返回新数据；
4. 失效语义：``invalidate_daily_analysis_cache`` 只标记 epoch、不删快照；
5. cache key 幂等：项目顺序无关；country/日期/schema 指纹变化 → 不同 key；
   重复 project id 去重 + 稳定排序后才进聚合（复审回归）；
6. 冷启动单飞：未抢到锁的调用方等待先到者回填；等待超时才自行计算（且不覆盖缓存）。

全程用内存版 Redis 客户端补丁，不依赖本地 Redis，也不污染真实 key。
"""

from __future__ import annotations

import fnmatch
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.api.v1.endpoints import daily_analysis as endpoint_mod
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project
from app.schemas.daily_analysis import (
    ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT,
    DailyAnalysisAllProjectsResponse,
)
from app.services import infra as redis_service
from app.services.infra import cache as cache_mod


class _FakeRedis:
    """最小内存版 Redis（仅覆盖本路径用到的命令；忽略 TTL）。"""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def get(self, key: str):
        return self.store.get(key)

    def setex(self, key: str, ttl: int, value: str) -> None:
        self.store[key] = value

    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def delete(self, *keys: str) -> int:
        removed = 0
        for key in keys:
            if key in self.store:
                del self.store[key]
                removed += 1
        return removed

    def scan(self, cursor: int, match: str | None = None, count: int | None = None):
        keys = [k for k in self.store if fnmatch.fnmatch(k, match or "*")]
        return 0, keys


@pytest.fixture
def fake_redis(monkeypatch) -> _FakeRedis:
    client = _FakeRedis()
    monkeypatch.setattr(cache_mod, "get_redis_client", lambda: client)
    return client


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(*, is_admin: bool = True) -> dict[str, str]:
    return {
        "X-API-Key": get_settings().api_key,
        "X-Is-Admin": "true" if is_admin else "false",
    }


def _seed_sku_row(
    db, *, project_id: int, source_file_id: int, day: date, sale: str
) -> None:
    db.add(
        AnalysisSalesOrderRow(
            project_id=project_id,
            country="US",
            source_file_id=source_file_id,
            source_row_no=1,
            amazon_order_id=f"BLF1038-{uuid.uuid4().hex[:8]}",
            purchase_at_utc=datetime.now(UTC),
            purchase_at_pt=datetime.now(UTC),
            purchase_date_pt=day,
            order_status="Shipped",
            sku=f"SKU-1038-{uuid.uuid4().hex[:4]}",
            asin="B000001038",
            quantity=1,
            item_price=Decimal(sale),
            shipping_price=Decimal("0.00"),
            item_tax=Decimal("0.00"),
            shipping_tax=Decimal("0.00"),
            currency="USD",
            is_counted_sales=True,
            raw_row={"product_name": "BLF-1038"},
        )
    )


@pytest.fixture
def env():
    """单项目 + 一行销售数据（显式 project_ids 请求 → cache key 确定）。"""
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(UTC).date() - timedelta(days=11)
    db = SessionLocal()
    try:
        project = Project(
            project_name=f"blf1038-{suffix}",
            project_operator=f"blf1038-op-{suffix}",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        pid = project.id

        sf = AnalysisSourceFile(
            project_id=pid,
            country="US",
            report_type="sales_report",
            upload_file_id=f"blf1038_{suffix}",
            upload_file_path="reports/blf1038.csv",
            original_filename="blf1038.csv",
            stored_filename="blf1038.csv",
            logical_filename="blf1038.csv",
            storage_key="blf1038.csv",
            period_start_date=day,
            period_end_date=day,
            is_current=True,
            ingestion_status="success",
            created_by="pytest",
        )
        db.add(sf)
        db.flush()
        _seed_sku_row(db, project_id=pid, source_file_id=sf.id, day=day, sale="10.00")
        db.commit()
    finally:
        db.close()

    yield {"project_id": pid, "day": day}

    db = SessionLocal()
    try:
        db.execute(
            delete(AnalysisSalesOrderRow).where(AnalysisSalesOrderRow.project_id == pid)
        )
        db.execute(
            delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == pid)
        )
        row = db.get(Project, pid)
        if row is not None:
            db.delete(row)
        db.commit()
    finally:
        db.close()


def _url(env, *, day: date | None = None) -> str:
    day_text = (day or env["day"]).isoformat()
    return (
        "/api/v1/daily-analysis/all"
        f"?project_ids={env['project_id']}&country=US"
        f"&start_date={day_text}&end_date={day_text}"
    )


def _key(
    env, *, schema_fingerprint: str = ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT
) -> str:
    return redis_service.make_daily_analysis_all_cache_key(
        project_ids=[env["project_id"]],
        country="US",
        start_date=env["day"].isoformat(),
        end_date=env["day"].isoformat(),
        sku=None,
        schema_fingerprint=schema_fingerprint,
    )


def _total_sales(body: dict) -> float:
    return float(body["summary_rows"][0]["sales_amount"])


def test_second_request_served_from_cache(client, fake_redis, env, monkeypatch):
    """命中路径：不再重算聚合，响应体与首次逐字节一致且合 schema。"""
    calls: list[int] = []
    original = endpoint_mod.build_daily_analysis_all_projects

    def _spy(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(endpoint_mod, "build_daily_analysis_all_projects", _spy)

    first = client.get(_url(env), headers=_headers())
    assert first.status_code == 200, first.text
    assert len(calls) == 1

    second = client.get(_url(env), headers=_headers())
    assert second.status_code == 200, second.text
    assert len(calls) == 1, "第二次请求应命中缓存，不应再跑聚合"
    assert second.content == first.content
    assert second.headers["content-type"] == "application/json"

    # 缓存体必须能被当前响应模型解析（schema 指纹机制的前提）
    parsed = DailyAnalysisAllProjectsResponse.model_validate_json(second.content)
    assert _total_sales(parsed.model_dump()) == pytest.approx(10.0)


def test_duplicate_project_ids_normalized_before_aggregation(
    client, fake_redis, env, monkeypatch
):
    """回归（复审）：项目 id 必须先去重 + 稳定排序，再进聚合 / key / 后台刷新。

    此前缓存 key 对 id 去重、聚合却按原始 ids 循环：`project_ids=1,1` 与
    `project_ids=1` 共用同一个 key，命中时返回**双倍**累计结果。
    """
    pid_a = env["project_id"]
    suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    try:
        other = Project(
            project_name=f"blf1038-dup-{suffix}",
            project_operator=f"blf1038-dup-op-{suffix}",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(other)
        db.commit()
        db.refresh(other)
        pid_b = int(other.id)
    finally:
        db.close()

    seen: list[list[int]] = []
    original = endpoint_mod.build_daily_analysis_all_projects

    def _spy(session, *, project_ids, **kwargs):
        seen.append(list(project_ids))
        return original(session, project_ids=project_ids, **kwargs)

    monkeypatch.setattr(endpoint_mod, "build_daily_analysis_all_projects", _spy)

    try:
        day_text = env["day"].isoformat()
        url = (
            "/api/v1/daily-analysis/all"
            f"?project_ids={pid_b},{pid_a},{pid_b}&country=US"
            f"&start_date={day_text}&end_date={day_text}"
        )
        first = client.get(url, headers=_headers())
        assert first.status_code == 200, first.text
        assert seen == [sorted([pid_a, pid_b])], "聚合只应看到去重且稳定排序后的 id"
        assert _total_sales(first.json()) == pytest.approx(10.0), "重复 id 不得双倍累计"

        # key / 后台刷新共用同一份规范化列表 → 快照落在规范化 id 的 key 上
        normalized_key = redis_service.make_daily_analysis_all_cache_key(
            project_ids=[pid_b, pid_a, pid_b],
            country="US",
            start_date=day_text,
            end_date=day_text,
            sku=None,
            schema_fingerprint=ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT,
        )
        assert (
            redis_service.load_daily_analysis_all_snapshot(normalized_key) is not None
        )

        # 重复请求命中同一 key：不再重算，且响应体逐字节一致
        second = client.get(url, headers=_headers())
        assert second.status_code == 200, second.text
        assert len(seen) == 1, "第二次请求应命中缓存，不再跑聚合"
        assert second.content == first.content
    finally:
        db = SessionLocal()
        try:
            db.execute(delete(Project).where(Project.id == pid_b))
            db.commit()
        finally:
            db.close()


def test_data_change_serves_stale_then_refreshes(client, fake_redis, env, monkeypatch):
    """stale-while-revalidate：写后先给旧快照，后台刷新后转为新数据。"""
    first = client.get(_url(env), headers=_headers())
    assert first.status_code == 200, first.text
    assert _total_sales(first.json()) == pytest.approx(10.0)

    # 追加一行销售数据 + 走真实的写路径失效（只推进 epoch，不删快照）
    db = SessionLocal()
    try:
        source_file_id = db.execute(
            select(AnalysisSourceFile.id).where(
                AnalysisSourceFile.project_id == env["project_id"]
            )
        ).scalar_one()
        _seed_sku_row(
            db,
            project_id=env["project_id"],
            source_file_id=source_file_id,
            day=env["day"],
            sale="5.00",
        )
        db.commit()
    finally:
        db.close()
    deleted = redis_service.invalidate_daily_analysis_cache(env["project_id"])
    assert deleted == 0  # 单项目缓存 key 不存在，聚合快照不按 project 前缀删
    assert redis_service.load_daily_analysis_all_snapshot(_key(env)) is not None

    # 第一次：返回旧快照（10.00）+ 触发后台刷新
    stale = client.get(_url(env), headers=_headers())
    assert stale.status_code == 200, stale.text
    assert stale.content == first.content, "过期但仍可用时先返回旧快照"

    # 等后台刷新落盘（TestClient 会执行 BackgroundTasks；这里做兼容等待）
    deadline = time.monotonic() + 5.0
    refreshed = None
    while time.monotonic() < deadline:
        snapshot = redis_service.load_daily_analysis_all_snapshot(_key(env))
        if snapshot is not None and redis_service.is_daily_analysis_all_snapshot_fresh(
            snapshot[1]
        ):
            refreshed = snapshot
            break
        time.sleep(0.05)
    assert refreshed is not None, "后台刷新应在超时前回填新快照"

    third = client.get(_url(env), headers=_headers())
    assert third.status_code == 200, third.text
    assert _total_sales(third.json()) == pytest.approx(15.0)
    assert third.content != first.content


def test_invalidate_marks_stale_only(client, fake_redis, env):
    """失效只推进 data-epoch：快照仍在，但被判定为过期（下个请求后台刷新）。"""
    assert client.get(_url(env), headers=_headers()).status_code == 200

    key = _key(env)
    before = redis_service.load_daily_analysis_all_snapshot(key)
    assert before is not None
    assert redis_service.is_daily_analysis_all_snapshot_fresh(before[1]) is True

    redis_service.invalidate_daily_analysis_cache(env["project_id"])

    after = redis_service.load_daily_analysis_all_snapshot(key)
    assert after is not None, "聚合快照不应被删除（删除会导致下一次请求同步重算）"
    assert redis_service.is_daily_analysis_all_snapshot_fresh(after[1]) is False


def test_cache_key_order_and_field_sensitivity():
    """key 幂等：项目 id 顺序无关；country / 日期 / schema 指纹变化 → 不同 key。"""

    def _key_for(
        project_ids: list[int],
        *,
        country: str = "US",
        start_date: str = "2026-03-01",
        end_date: str = "2026-03-10",
        schema_fingerprint: str = "abc12345",
    ) -> str:
        return redis_service.make_daily_analysis_all_cache_key(
            project_ids=project_ids,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=None,
            schema_fingerprint=schema_fingerprint,
        )

    key_a = _key_for([3, 1, 2])
    key_b = _key_for([2, 3, 1])
    key_c = _key_for([1, 2])
    assert key_a == key_b
    assert key_a != key_c

    for variant in (
        {"country": "DE"},
        {"start_date": "2026-02-01"},
        {"end_date": "2026-03-31"},
        {"schema_fingerprint": "def67890"},
    ):
        assert _key_for([1, 2, 3], **variant) != key_a


def test_cold_start_single_flight_waits_for_winner(fake_redis):
    """冷启动：未抢到锁的调用方等待先到者回填，不重复计算。"""
    key = "bb:test:daily-all:snapshot:single-flight"
    computed: list[bytes] = []

    def _winner_compute() -> bytes:
        computed.append(b"winner")
        # 模拟"先到者"在持锁期间回填快照
        redis_service.store_daily_analysis_all_snapshot(key, b"winner-payload")
        return b"winner-payload"

    assert redis_service.try_acquire_daily_analysis_all_lock(key) is True
    body = redis_service.load_or_compute_daily_analysis_all_body(key, _winner_compute)
    assert body == (b"winner-payload", False)
    assert len(computed) == 1
    redis_service.release_daily_analysis_all_lock(key)

    # 另一个 key：锁被占用且先到者始终没回填 → 等待超时后自行计算，不覆盖缓存
    other_key = "bb:test:daily-all:snapshot:single-flight-2"
    assert redis_service.try_acquire_daily_analysis_all_lock(other_key) is True
    body_after = redis_service.load_or_compute_daily_analysis_all_body(
        other_key, lambda: b"fallback"
    )
    assert body_after == (b"fallback", False)
    redis_service.release_daily_analysis_all_lock(other_key)


def test_cold_start_wait_timeout_falls_back_to_compute(fake_redis, monkeypatch, env):
    """等待超时分支：仍返回正确数据，但不覆盖缓存（避免盖掉先到者的结果）。"""
    key = _key(env)
    monkeypatch.setattr(
        cache_mod,
        "wait_daily_analysis_all_snapshot",
        lambda *args, **kwargs: None,
    )
    assert redis_service.try_acquire_daily_analysis_all_lock(key) is True
    body, needs_refresh = redis_service.load_or_compute_daily_analysis_all_body(
        key, lambda: b"fallback-body"
    )
    assert body == b"fallback-body"
    assert needs_refresh is False
    assert redis_service.load_daily_analysis_all_snapshot(key) is None
