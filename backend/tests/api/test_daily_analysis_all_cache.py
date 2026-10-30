"""BLF-1038：``/api/v1/daily-analysis/all`` 快照缓存（SWR）行为测试。

覆盖：
1. 命中：第二次请求不再重算聚合，且响应体与首次逐字节一致；
2. 缓存体合当前响应 schema（``model_validate_json`` 通过）；
3. stale-while-revalidate：数据变更后先返回旧快照，随后（后台刷新完成）返回新数据；
4. 失效语义：``invalidate_daily_analysis_cache`` 只标记 epoch、不删快照；
5. cache key 幂等：项目顺序无关；country/日期/schema 指纹/include_detail 变化 → 不同 key；
   重复 project id 去重 + 稳定排序后才进聚合（复审回归）；
6. 冷启动单飞：未抢到锁的调用方等待先到者回填；等待超时才自行计算（且不覆盖缓存）；
7. ``include_detail=false``（BLF-1045）：只把顶层与 ``project_breakdown[*]`` 的
   ``detail_rows`` 清空为空列表（**键保留**、字段集合与默认形状一致），且两种响应
   形状互不串体（各自的缓存 key）。

全程用内存版 Redis 客户端补丁，不依赖本地 Redis，也不污染真实 key。
"""

from __future__ import annotations

import copy
import fnmatch
import json
import threading
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
    serialize_all_projects_response,
    strip_all_projects_detail,
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


def _url(env, *, day: date | None = None, include_detail: bool | None = None) -> str:
    day_text = (day or env["day"]).isoformat()
    url = (
        "/api/v1/daily-analysis/all"
        f"?project_ids={env['project_id']}&country=US"
        f"&start_date={day_text}&end_date={day_text}"
    )
    if include_detail is not None:
        url += f"&include_detail={'true' if include_detail else 'false'}"
    return url


def _key(
    env,
    *,
    schema_fingerprint: str = ALL_PROJECTS_RESPONSE_SCHEMA_FINGERPRINT,
    include_detail: bool = True,
) -> str:
    return redis_service.make_daily_analysis_all_cache_key(
        project_ids=[env["project_id"]],
        country="US",
        start_date=env["day"].isoformat(),
        end_date=env["day"].isoformat(),
        sku=None,
        schema_fingerprint=schema_fingerprint,
        include_detail=include_detail,
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
    """key 幂等：项目 id 顺序无关；country / 日期 / schema 指纹 / include_detail → 不同 key。"""

    def _key_for(
        project_ids: list[int],
        *,
        country: str = "US",
        start_date: str = "2026-03-01",
        end_date: str = "2026-03-10",
        schema_fingerprint: str = "abc12345",
        include_detail: bool = True,
    ) -> str:
        return redis_service.make_daily_analysis_all_cache_key(
            project_ids=project_ids,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=None,
            schema_fingerprint=schema_fingerprint,
            include_detail=include_detail,
        )

    key_a = _key_for([3, 1, 2])
    key_b = _key_for([2, 3, 1])
    key_c = _key_for([1, 2])
    assert key_a == key_b
    assert key_a != key_c

    assert _key_for([1, 2, 3], country="DE") != key_a
    assert _key_for([1, 2, 3], start_date="2026-02-01") != key_a
    assert _key_for([1, 2, 3], end_date="2026-03-31") != key_a
    assert _key_for([1, 2, 3], schema_fingerprint="def67890") != key_a

    # include_detail 也在 key 里（BLF-1038：两种响应形状不得共用快照）
    assert _key_for([1, 2, 3], include_detail=False) != key_a


def test_cold_start_single_flight_waits_for_winner(fake_redis):
    """冷启动：未抢到锁的调用方等待先到者回填，不重复计算。"""
    key = "bb:test:daily-all:snapshot:single-flight"
    computed: list[bytes] = []

    def _winner_compute() -> bytes:
        computed.append(b"winner")
        return b"winner-payload"

    assert redis_service.try_acquire_daily_analysis_all_lock(key) is True
    # 模拟持锁的“先到者”并发回填；调用方应等到快照后直接复用。
    winner = threading.Timer(
        0.05,
        redis_service.store_daily_analysis_all_snapshot,
        args=(key, b"winner-payload"),
    )
    winner.start()
    try:
        body = redis_service.load_or_compute_daily_analysis_all_body(
            key, _winner_compute
        )
    finally:
        winner.join()
        redis_service.release_daily_analysis_all_lock(key)

    assert body == (b"winner-payload", False)
    assert computed == []


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


# ── include_detail（BLF-1045：summary-only 形状 + 缓存 key 隔离）────────


def _summary_payload() -> dict[str, object]:
    """构造一份带 Decimal 的完整聚合 payload（直接喂序列化器，不跑 DB）。"""
    summary_row = {
        "date": "2026-03-01",
        "order_qty": 2,
        "pending_order_qty": 1,
        "sales_amount": Decimal("12.345"),
        "impressions": 10,
        "clicks": 2,
        "cpc": Decimal("0.5"),
        "ad_spend": Decimal("1.25"),
        "ad_orders": 1,
        "available_qty": 7,
        "page_views": 5,
        "units_ordered": 2,
        "sessions": 4,
        "ordered_sales_amount": Decimal("11.00"),
        "conversion_rate": Decimal("0.4"),
    }
    detail_row = {
        "date": "2026-03-01",
        "sku": "SKU-1038",
        "asin": None,
        "order_qty": 2,
        "pending_order_qty": 1,
        "sales_amount": Decimal("12.345"),
        "impressions": 10,
        "clicks": 2,
        "cpc": Decimal("0.5"),
        "ad_spend": Decimal("1.25"),
        "ad_orders": 1,
        "available_qty": 7,
        "in_transit_qty": 3,
        "page_views": 5,
        "units_ordered": 2,
        "sessions": 4,
        "ordered_sales_amount": Decimal("11.00"),
        "conversion_rate": Decimal("0.4"),
    }
    return {
        "summary_rows": [summary_row],
        "detail_rows": [detail_row],
        "available_dates": {"sales_report": ["2026-03-01"]},
        "project_breakdown": {
            1: {
                "project_name": "P1",
                "summary_rows": [summary_row],
                "detail_rows": [detail_row],
            }
        },
    }


def test_serialize_include_detail_false_keeps_field_set():
    """``include_detail=false`` == 完整响应体把两处 ``detail_rows`` 置空（其余逐字节一致）。

    键**不消失**（前端生成类型 ``api.d.ts`` 里 ``detail_rows`` 是必填字段），且裁剪
    分支不能跳过 Pydantic 强转（Decimal → float），否则缓存体里会冒出与完整口径
    不一致的类型。
    """
    payload = _summary_payload()

    full = json.loads(serialize_all_projects_response(payload))
    pruned = json.loads(serialize_all_projects_response(payload, include_detail=False))

    assert pruned["detail_rows"] == []
    assert pruned["project_breakdown"]["1"]["detail_rows"] == []

    expected = copy.deepcopy(full)
    expected["detail_rows"] = []
    for entry in expected["project_breakdown"].values():
        entry["detail_rows"] = []
    assert pruned == expected

    # 逐层键集合一致（前端必填字段的契约不破）
    assert set(pruned) == set(full)
    assert set(pruned["project_breakdown"]["1"]) == set(full["project_breakdown"]["1"])

    assert isinstance(pruned["summary_rows"][0]["sales_amount"], float)
    assert isinstance(pruned["summary_rows"][0]["cpc"], float)

    # 默认口径（含明细）仍是完整形状，且合响应模型
    DailyAnalysisAllProjectsResponse.model_validate(full)
    assert full["detail_rows"][0]["sku"] == "SKU-1038"


def test_include_detail_false_blanks_detail_keeps_summary(client, fake_redis, env):
    """端点行为：``include_detail=false`` 只清空明细，字段集合 / 摘要 / 可用日期 / 项目名不变。"""
    full = client.get(_url(env), headers=_headers())
    assert full.status_code == 200, full.text
    full_body = full.json()
    assert full_body["detail_rows"], "默认仍返回完整明细（运营日报页真消费）"

    pruned = client.get(_url(env, include_detail=False), headers=_headers())
    assert pruned.status_code == 200, pruned.text
    assert pruned.headers["content-type"] == "application/json"
    body = pruned.json()

    # 键不消失（前端必填字段）——只置空
    assert body["detail_rows"] == []
    assert set(body) == set(full_body)
    assert body["summary_rows"] == full_body["summary_rows"]
    assert body["available_dates"] == full_body["available_dates"]
    assert set(body["project_breakdown"]) == set(full_body["project_breakdown"])
    for project_id, entry in body["project_breakdown"].items():
        full_entry = full_body["project_breakdown"][project_id]
        assert set(entry) == set(full_entry)
        assert entry["detail_rows"] == [], "嵌套明细也要清空"
        assert entry["project_name"] == full_entry["project_name"]
        assert entry["summary_rows"] == full_entry["summary_rows"]

    # 明细是响应体体积的主要来源 → 清空后体明显更小
    assert len(pruned.content) < len(full.content)


@pytest.mark.parametrize("first_detail", [True, False])
def test_include_detail_shapes_do_not_share_snapshot(
    client, fake_redis, env, monkeypatch, first_detail
):
    """回归（P0）：两种响应形状各一个缓存 key，不得串体（先后顺序无关）。

    否则先到的 ``include_detail=false`` 请求会把 summary-only 字节写进完整形状
    共用的 key，随后同一 project 集 + 同一日期区间的运营日报页请求命中它
    （``daily-analysis-client.tsx`` 真读 ``payload.detail_rows``）→ 明细表整体塌掉；
    反过来说完整形状的 3.6MB 字节被首页命中 → 载荷精简失效。
    """
    calls: list[int] = []
    original = endpoint_mod.build_daily_analysis_all_projects

    def _spy(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(endpoint_mod, "build_daily_analysis_all_projects", _spy)

    first = client.get(_url(env, include_detail=first_detail), headers=_headers())
    assert first.status_code == 200, first.text
    assert len(calls) == 1

    # 同项目集 / 同日期区间，只差 include_detail → 必须另算一份，不得命中对方快照
    second = client.get(_url(env, include_detail=not first_detail), headers=_headers())
    assert second.status_code == 200, second.text
    assert len(calls) == 2, "两种形状应各自一份快照"

    for wanted_detail, response in ((first_detail, first), (not first_detail, second)):
        payload = response.json()
        assert payload["summary_rows"], "两种形状都必须保留 summary_rows"
        if wanted_detail:
            assert payload["detail_rows"], "include_detail=true 必须带逐 SKU 明细"
            assert all(
                entry["detail_rows"]
                for entry in payload["project_breakdown"].values()
            ), "project_breakdown 的明细不得被裁"
        else:
            assert payload["detail_rows"] == []
            assert all(
                entry["detail_rows"] == []
                for entry in payload["project_breakdown"].values()
            )

    # 各自再请求一次 → 各自命中自己的快照（形状不再错位）
    for detail, response in ((first_detail, first), (not first_detail, second)):
        assert (
            client.get(_url(env, include_detail=detail), headers=_headers()).content
            == response.content
        )
    assert len(calls) == 2, "两种形状都命中各自快照，不应重算"

    key_summary = _key(env, include_detail=False)
    key_full = _key(env, include_detail=True)
    assert key_summary != key_full
    assert redis_service.load_daily_analysis_all_snapshot(key_summary) is not None
    assert redis_service.load_daily_analysis_all_snapshot(key_full) is not None


def test_include_detail_false_background_refresh_keeps_summary_shape(
    client, fake_redis, env
):
    """后台刷新（SWR）必须沿用请求的 include_detail —— 否则过期后摘要请求会被
    刷成完整体（体积回到 5.6MB），或反过来把完整形状刷成摘要体。"""
    first = client.get(_url(env, include_detail=False), headers=_headers())
    assert first.status_code == 200, first.text
    assert first.json()["detail_rows"] == []

    # 推进 data-epoch → 快照过期，下一次请求先给旧快照并触发后台刷新
    cache_mod.mark_daily_analysis_all_data_changed()
    stale = client.get(_url(env, include_detail=False), headers=_headers())
    assert stale.status_code == 200, stale.text
    assert stale.content == first.content

    deadline = time.monotonic() + 5.0
    refreshed = None
    while time.monotonic() < deadline:
        snapshot = redis_service.load_daily_analysis_all_snapshot(
            _key(env, include_detail=False)
        )
        if snapshot is not None and redis_service.is_daily_analysis_all_snapshot_fresh(
            snapshot[1]
        ):
            refreshed = snapshot
            break
        time.sleep(0.05)
    assert refreshed is not None, "后台刷新应在超时前回填新快照"
    refreshed_body = json.loads(refreshed[0])
    assert refreshed_body["detail_rows"] == [], "刷新后的体仍是摘要形状"
    assert refreshed_body["summary_rows"], "刷新后仍保留 summary_rows"

    # 完整形状的快照不受摘要形状刷新影响
    full = client.get(_url(env), headers=_headers())
    assert full.json()["detail_rows"]


def test_include_detail_default_equals_explicit_true(client, fake_redis, env):
    """缺省（不传）与显式 ``true`` 逐字节一致；``false`` 是另一个体（且更小）。

    中间清空内存 Redis，确保比较的是两条**冷路径**产物，而不是同一快照被命中。
    """
    explicit = client.get(_url(env, include_detail=True), headers=_headers())
    assert explicit.status_code == 200, explicit.text

    fake_redis.store.clear()
    default = client.get(_url(env), headers=_headers())
    assert default.status_code == 200, default.text
    assert default.content == explicit.content, "缺省必须等价于显式 true（逐字节）"

    fake_redis.store.clear()
    summary_only = client.get(_url(env, include_detail=False), headers=_headers())
    assert summary_only.status_code == 200, summary_only.text
    assert summary_only.content != explicit.content
    assert len(summary_only.content) < len(explicit.content), "清空明细后体应更小"
    # 默认 true 的调用方（运营日报页）拿到的仍是带明细的完整体
    assert summary_only.json()["detail_rows"] == []
    assert explicit.json()["detail_rows"]


def test_strip_all_projects_detail_keeps_shape_without_mutating_input():
    """裁剪函数单元测试：清空明细、保留其它字段、不改原 payload。"""
    block = {
        "project_name": "p1",
        "summary_rows": [{"date": "2026-03-01", "sales_amount": 10.0}],
        "detail_rows": [{"sku": "SKU-1", "sales_amount": 10.0}],
    }
    payload: dict[str, object] = {
        "summary_rows": [{"date": "2026-03-01"}],
        "detail_rows": [{"sku": "SKU-1"}],
        "available_dates": {"sales_report": ["2026-03-01"]},
        "project_breakdown": {7: block},
    }

    stripped = strip_all_projects_detail(payload)

    assert stripped["detail_rows"] == []
    assert set(stripped) == set(payload)
    assert stripped["summary_rows"] == payload["summary_rows"]
    assert stripped["available_dates"] == payload["available_dates"]
    stripped_breakdown = stripped["project_breakdown"]
    assert isinstance(stripped_breakdown, dict)
    stripped_block = stripped_breakdown[7]
    assert stripped_block["detail_rows"] == []
    assert set(stripped_block) == set(block)
    assert stripped_block["project_name"] == "p1"
    assert stripped_block["summary_rows"] == block["summary_rows"]
    # 输入不被就地修改（调用方可能复用同一 payload）
    assert payload["detail_rows"] == [{"sku": "SKU-1"}]
    assert block["detail_rows"] == [{"sku": "SKU-1", "sales_amount": 10.0}]
