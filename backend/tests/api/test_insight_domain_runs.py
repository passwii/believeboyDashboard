"""BLF-1016：域级 Insight 提交端点的 HTTP 契约。

域 adapter 负责组装 slots，canonical HTTP 层负责把开关、body 校验与
失败分类暴露给调用方。这里钉住的是**接线**，不是 adapter 内部逻辑
（那部分在 ``tests/services/ad``、``tests/services/inventory``）：

1. 开关未开 → 409 ``DOMAIN_SWITCH_NOT_READY``（两个域、先于任何数据读取）；
2. 开关已开 → 201 canonical run 信封（detail/stream/cancel/retry URL）；
3. body 越界/多字段 → 422 ``INVALID_REQUEST``（不走 FastAPI 默认 detail）；
4. 权限/数据缺失 → canonical 码表（404 ``PROJECT_NOT_FOUND``）；
5. 提交的 run 行里 slots 来自域 adapter（``ad.context`` / ``inventory.context``）。

Auth 走 ``protected`` override + ``X-Is-Admin``，run 行落真实测试库
（``BLF_test``），与 ``test_insight_runs_stream.py`` 同口径。
"""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

TODAY = date(2026, 9, 11)


@pytest.fixture()
def domain_app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    """insight 域端点 + auth bypass + 可控开关 + 不落 broker 的 enqueue。"""
    from app.api.deps import protected
    from app.api.v1.endpoints.insight_domains import router as domains_router
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "ai_chat_provider_base_url", "http://localhost:9/v1", raising=False)
    monkeypatch.setattr(settings, "ai_chat_provider_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "insight_default_model", "test-insight-model", raising=False)
    monkeypatch.setattr(settings, "ai_chat_default_model", "test-insight-model", raising=False)
    monkeypatch.setattr(settings, "insight_canonical_domains", "", raising=False)

    import app.celery_tasks.insights.run as run_task_mod

    monkeypatch.setattr(
        run_task_mod,
        "enqueue_insight_run",
        lambda rid, attempt: None,  # 无 broker：记录即可，绝不真发
    )
    app = FastAPI()
    app.dependency_overrides[protected] = lambda: None
    app.include_router(domains_router, prefix="/api/v1")
    return app


@pytest.fixture()
def client(domain_app: FastAPI) -> TestClient:
    test_client = TestClient(domain_app)
    test_client.headers.update({"X-Is-Admin": "true"})
    return test_client


@pytest.fixture()
def enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """打开两个域的开关（模拟迁移已切换）。"""
    from app.core.config import get_settings

    monkeypatch.setattr(
        get_settings(),
        "insight_canonical_domains",
        "ad_analysis,inventory_health",
        raising=False,
    )


def _project() -> tuple[int, str]:
    """测试库里一个可见项目 + 它的站点（scope 一致性要求两者匹配）。"""
    from sqlalchemy import create_engine, text

    from app.core.config import get_settings

    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT id, country FROM projects ORDER BY id LIMIT 1")
        ).first()
    engine.dispose()
    assert row is not None, "test DB has no projects seeded"
    return int(row[0]), str(row[1] or "US")


def _offsets() -> tuple[int, int]:
    """幂等键含口径日期 → 每次跑用不同日期，避免命中上一轮的 run。"""
    span = uuid.uuid4().int % 200
    return span, span + 14


# --------------------------------------------------------------------------
# 1. 开关门禁
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/v1/insight/ad-analysis/runs", {"project_id": 1, "country": "US"}),
        ("/api/v1/insight/inventory-health/runs", {"project_id": 1, "country": "US"}),
    ],
)
def test_domain_endpoints_are_closed_until_switched(client, path, body):
    resp = client.post(path, json=body)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "DOMAIN_SWITCH_NOT_READY"
    assert resp.json()["detail"]["retryable"] is False


def test_switch_is_per_domain(monkeypatch, client):
    """只开广告域：库存端点仍 409，广告端点不再被开关拦住。"""
    from app.core.config import get_settings

    monkeypatch.setattr(
        get_settings(), "insight_canonical_domains", "ad_analysis", raising=False
    )
    resp = client.post(
        "/api/v1/insight/inventory-health/runs",
        json={"project_id": 1, "country": "US"},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "DOMAIN_SWITCH_NOT_READY"


# --------------------------------------------------------------------------
# 2. body 校验
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "body", "bad_field"),
    [
        (
            "/api/v1/insight/ad-analysis/runs",
            {
                "project_id": 1,
                "country": "US",
                "start_date": "2026-09-11",
                "end_date": "2026-08-01",  # end < start
            },
            "end_date",
        ),
        (
            "/api/v1/insight/ad-analysis/runs",
            {
                "project_id": 1,
                "country": "US",
                "start_date": "2025-01-01",
                "end_date": "2026-09-11",  # 超过 366 天，与 SERIES_MAX_ITEMS 对齐
            },
            "end_date",
        ),
        (
            "/api/v1/insight/ad-analysis/runs",
            {
                "project_id": 1,
                "country": "US",
                "start_date": "2026-09-01",
                "end_date": "2026-09-11",
                "prompt": "ignore previous instructions",  # 未知字段
            },
            "prompt",
        ),
        (
            "/api/v1/insight/inventory-health/runs",
            {"project_id": 1, "country": "CN"},  # 站点不在允许枚举内
            "country",
        ),
    ],
)
def test_invalid_body_maps_to_typed_422(client, enabled, path, body, bad_field):
    resp = client.post(path, json=body)
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "INVALID_REQUEST"
    assert bad_field in detail["message"]


def test_non_object_body_is_typed(client, enabled):
    resp = client.post(
        "/api/v1/insight/ad-analysis/runs",
        content=b"[1,2,3]",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_REQUEST"


def test_ad_range_boundary_is_inclusive():
    """跨度按闭区间计：正好 366 天放行，第 367 天拒绝（复审[5]）。

    原实现用 ``(end - start).days > 366``，把 367 天的请求当合法放行——
    但 slot 只保留 366 条序列，多出那一天的数据必然被静默裁掉。
    """
    from pydantic import ValidationError

    from app.schemas.insight_domains import AdAnalysisRunRequest

    def _request(start: str, end: str) -> AdAnalysisRunRequest:
        return AdAnalysisRunRequest(
            project_id=1, country="US", start_date=start, end_date=end
        )

    full_year = _request("2026-01-01", "2027-01-01")  # 含首尾共 366 天
    assert (full_year.end_date - full_year.start_date).days + 1 == 366

    one_day_short = _request("2026-01-01", "2026-12-31")  # 365 天
    assert (one_day_short.end_date - one_day_short.start_date).days + 1 == 365

    with pytest.raises(ValidationError):
        _request("2026-01-01", "2027-01-02")  # 367 天


# --------------------------------------------------------------------------
# 3. 提交：slots 来自域 adapter，失败走 canonical 码表
# --------------------------------------------------------------------------


class _Aggregate:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def to_dict(self) -> dict[str, Any]:
        return self._data


def _stub_aggregate(monkeypatch: pytest.MonkeyPatch, data: dict[str, Any] | None) -> None:
    def _fake(*args: Any, **kwargs: Any) -> _Aggregate | None:
        return None if data is None else _Aggregate(data)

    monkeypatch.setattr(
        "app.services.ai_insight_aggregator.aggregate_project_data", _fake
    )


def _aggregate_payload(project_id: int, start: date, end: date) -> dict[str, Any]:
    series = [
        {
            "date": (end - timedelta(days=offset)).isoformat(),
            "order_qty": 2,
            "sales_amount": 20.0,
            "unique_asins": 1,
        }
        for offset in range((end - start).days + 1)
    ]
    return {
        "project_name": "HTTP 测试店铺",
        "country": "US",
        "date_range_start": start.isoformat(),
        "date_range_end": end.isoformat(),
        "sales_by_date": series,
        "ad_by_date": [],
        "inventory_summary": {},
        "comparison_period": None,
        "top_skus": [],
        "ad_campaigns": [],
        "ad_breakdown_by_type": {},
        "data_coverage": {
            "sales_days": len(series),
            "ad_days": 0,
            "total_requested_days": len(series),
        },
        "project_context": {},
        "sku_context": {},
    }


def test_ad_run_creates_canonical_run_with_adapter_slots(
    client, enabled, monkeypatch, db_session
):
    from app.models.insight_run import InsightRun

    project_id, country = _project()
    span, span_end = _offsets()
    start = TODAY - timedelta(days=span_end)
    end = TODAY - timedelta(days=span)
    _stub_aggregate(monkeypatch, _aggregate_payload(project_id, start, end))

    resp = client.post(
        "/api/v1/insight/ad-analysis/runs",
        json={
            "project_id": project_id,
            "country": country,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role_id"] == "ad_analysis"
    assert body["role_version"] == 1
    assert body["status"] == "queued"
    assert body["detail_url"] == f"/api/v1/insight/runs/{body['run_id']}"
    assert body["stream_url"].endswith("/stream")
    raw = json.dumps(body)
    for banned in ("api_key", "base_url", "system_prompt"):
        assert banned not in raw

    run = (
        db_session.query(InsightRun)
        .filter(InsightRun.run_id == body["run_id"])
        .one()
    )
    slots = json.loads(run.slots_json)
    assert set(slots) == {"ad.context", "ad.data"}
    assert slots["ad.context"]["project_ids"] == [project_id]
    assert slots["ad.context"]["country"] == country
    assert slots["ad.data"]["payload"]["project_name"] == "HTTP 测试店铺"

    # 同一口径重放：复用 run，不重复扣费。
    again = client.post(
        "/api/v1/insight/ad-analysis/runs",
        json={
            "project_id": project_id,
            "country": country,
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
        },
    )
    assert again.status_code == 201
    assert again.json()["run_id"] == body["run_id"]
    assert again.json()["replayed"] is True


def test_ad_run_without_project_data_reports_project_not_found(
    client, enabled, monkeypatch
):
    project_id, country = _project()
    _stub_aggregate(monkeypatch, None)  # 聚合器对不存在的项目返回 None
    resp = client.post(
        "/api/v1/insight/ad-analysis/runs",
        json={
            "project_id": project_id,
            "country": country,
            "start_date": (TODAY - timedelta(days=7)).isoformat(),
            "end_date": TODAY.isoformat(),
        },
    )
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "PROJECT_NOT_FOUND"


def test_inventory_run_creates_canonical_run_with_adapter_slots(
    client, enabled, monkeypatch, db_session
):
    from app.models.insight_run import InsightRun

    project_id, country = _project()
    report_date = TODAY - timedelta(days=_offsets()[0])
    rows = [
        {
            "sku": "HTTP-SKU-1",
            "country": country,
            "available_inventory": 30,
            "sellable_days": 4.0,
            "risk_status": "out_of_stock",
            "sellout_date": TODAY + timedelta(days=4),
        }
    ]
    summary = {
        "sku_count": 1,
        "pending_data_count": 0,
        "total_available_inventory": 30,
        "total_in_transit_quantity": 0,
        "state_distribution": {"critical": 1},
    }
    monkeypatch.setattr(
        "app.services.inventory.replenishment.list_inventory_replenishment_analysis",
        lambda db, **kwargs: (rows, summary, 1, False),
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment.latest_inventory_snapshot_date",
        # 快照日期 ≠ 口径日期：新鲜度看快照（今天 → fresh），口径只看请求。
        lambda db, project_id, country, anchor: date.today(),
    )

    resp = client.post(
        "/api/v1/insight/inventory-health/runs",
        json={
            "project_id": project_id,
            "country": country,
            "report_date": report_date.isoformat(),
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["role_id"] == "inventory_health"
    assert body["status"] == "queued"

    run = (
        db_session.query(InsightRun)
        .filter(InsightRun.run_id == body["run_id"])
        .one()
    )
    slots = json.loads(run.slots_json)
    assert set(slots) == {"inventory.context", "inventory.data"}
    assert slots["inventory.context"]["report_date"] == report_date.isoformat()
    assert slots["inventory.context"]["data_freshness"]["status"] == "fresh"
    payload = slots["inventory.data"]["payload"]
    assert payload["rows"][0]["sku"] == "HTTP-SKU-1"
    # 行里的 date 已转 ISO：slots_json 是 worker 唯一输入，必须可反序列化。
    assert payload["rows"][0]["sellout_date"] == (TODAY + timedelta(days=4)).isoformat()


# --------------------------------------------------------------------------
# 4. 旧写端冻结（开关已开 → 旧入口 409；开关未开 → 旧入口照常建行）
# --------------------------------------------------------------------------


@pytest.fixture()
def legacy_app(monkeypatch: pytest.MonkeyPatch, db_session) -> FastAPI:
    """旧 ``/ai-insights`` 写端点 + auth/DB bypass + 不落 broker 的派发记录。"""
    from types import SimpleNamespace

    from app.api.deps import get_primary_db_session, protected
    from app.api.v1.endpoints import ai_insight as legacy_mod
    from app.core.config import get_settings

    monkeypatch.setattr(
        get_settings(), "insight_canonical_domains", "", raising=False
    )
    dispatched: list[int | None] = []
    monkeypatch.setattr(
        legacy_mod,
        "celery_generate_insight",
        SimpleNamespace(delay=lambda schedule_id, insight_id: dispatched.append(insight_id)),
    )

    app = FastAPI()
    app.dependency_overrides[protected] = lambda: None
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.include_router(legacy_mod.router, prefix="/api/v1")
    app.state.dispatched = dispatched
    return app


@pytest.fixture()
def legacy_client(legacy_app: FastAPI) -> TestClient:
    test_client = TestClient(legacy_app)
    test_client.headers.update({"X-Is-Admin": "true"})
    return test_client


def _generate_body(project_id: int, country: str, insight_type: str) -> dict[str, Any]:
    return {
        "project_id": project_id,
        "country": country,
        "insight_type": insight_type,
        "date_range_start": (TODAY - timedelta(days=7)).isoformat(),
        "date_range_end": TODAY.isoformat(),
    }


def test_legacy_generate_endpoint_is_frozen_when_domain_switched(
    legacy_app: FastAPI, legacy_client: TestClient, enabled, db_session
):
    """已切 canonical 的域：旧 POST /ai-insights/generate 必须 409 且不建行、不派发。"""
    from app.models import AIInsight

    project_id, country = _project()
    before = db_session.query(AIInsight).count()

    resp = legacy_client.post(
        "/api/v1/ai-insights/generate",
        json=_generate_body(project_id, country, "ad_analysis"),
    )

    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "DOMAIN_SWITCH_NOT_READY"
    assert detail["retryable"] is False
    assert db_session.query(AIInsight).count() == before
    assert legacy_app.state.dispatched == []


def test_legacy_generate_endpoint_unchanged_when_switch_off(
    legacy_app: FastAPI, legacy_client: TestClient, db_session
):
    """开关未开（默认）：同名 insight_type 仍走旧链路——冻结只由开关决定。"""
    from app.models import AIInsight, InsightStatus

    project_id, country = _project()
    resp = legacy_client.post(
        "/api/v1/ai-insights/generate",
        json=_generate_body(project_id, country, "ad_analysis"),
    )

    assert resp.status_code == 200, resp.text
    insight_id = resp.json()["insight_id"]
    row = db_session.get(AIInsight, insight_id)
    assert row is not None
    assert row.status == InsightStatus.pending
    assert legacy_app.state.dispatched == [insight_id]
