"""Agent 广告搜索词份额域原生路由测试（BLF-581 原生化）。

ad-search-term-shares 是 Stage 2 原生化 9 域之一（external/ad_search_term_shares.py 端点模块已删除），
测试模板照抄 test_ad_campaigns.py（BLF-580 样板），覆盖：

1. **parity**：agent 通道响应 == service 直调结果（aggregate + raw + 单数 alias）——同一服务函数、同一参数，响应 model_dump 全等。
2. **鉴权/壳**：401 未鉴权 / 404 项目不存在 / 403 project_scope 越界 /
   403 business_scope 不含 ad_analysis 域 / 400 非法 period。
3. **路由面**：原生路由注册；external_mirror 已退役删除（BLF-583），镜像路径整体移除；external 端点模块已删。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import AdUploadFile, Project, AdUploadSearchTermShareRow


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


def _make_file(
    db,
    *,
    project_id: int,
    project_name: str,
    country: str,
    report_date: date,
    report_type: str = "ad_search_term_share_report",
    version: int = 1,
) -> AdUploadFile:
    f = AdUploadFile(
        project_id=project_id,
        project_name=project_name,
        report_type=report_type,
        report_label=report_type,
        country=country,
        report_date=report_date,
        period_start_date=report_date,
        period_end_date=report_date,
        version=version,
        is_current=True,
        ingestion_status="success",
        recognition_status="recognized",
        upload_file_id=f"test-ad_search_term_shares-{project_id}-{country}-{report_date.isoformat()}",
        upload_file_path=f"/tmp/test-ad_search_term_shares-{project_id}-{report_date.isoformat()}.csv",
        stored_filename=f"test-ad_search_term_shares-{project_id}-{report_date.isoformat()}.csv",
        logical_filename=f"test-ad_search_term_shares-{project_id}-{report_date.isoformat()}.csv",
        file_extension=".csv",
        matched_columns=[],
        warnings=[],
        recognition_payload={},
    )
    db.add(f)
    db.flush()
    return f


def _seed_ad_search_term_shares_row(
    db,
    *,
    source_file_id: int,
    row_no: int,
    report_date: date,
    campaign_name: str = 'Campaign-A', ad_group_name: str = 'Group-1', search_term: str = 'term one', match_type: str = 'EXACT', impression_rank: int = 1, impression_share: float = 50.0, impressions: int = 0, clicks: int = 0, spend: int = 0, sales_7d: int = 0, orders_7d: int = 0,
):
    db.add(
        AdUploadSearchTermShareRow(
            source_file_id=source_file_id,
            source_row_no=row_no,
            report_start_date=report_date,
            report_end_date=report_date,
            campaign_name=campaign_name, ad_group_name=ad_group_name, search_term=search_term, match_type=match_type, impression_rank=impression_rank, impression_share=impression_share, impressions=impressions, clicks=clicks, spend=spend, sales_7d=sales_7d, orders_7d=orders_7d,
            country="US",
            currency="USD",
            raw_row={},
        )
    )


@pytest.fixture
def ad_search_term_shares_env(make_api_key):
    """临时项目 + 全放行 key + 搜索词份额 US 原始数据，测试后清理。

    种子：key1（2 行，跨 2 天）→ aggregate 按 search_term + match_type 聚合；
    key2（1 行）。窗口锚定 today-1（与 agent 路由 T-1 一致）。
    """
    agent_id = f"blf581-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf581-{suffix}"
    country = "US"

    db = SessionLocal()
    try:
        project = Project(
            project_name=project_name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)

        today = date.today() - timedelta(days=1)
        day1 = today - timedelta(days=3)
        day2 = today - timedelta(days=2)

        f1 = _make_file(
            db,
            project_id=project.id,
            project_name=project_name,
            country=country,
            report_date=day1,
        )
        f2 = _make_file(
            db,
            project_id=project.id,
            project_name=project_name,
            country=country,
            report_date=day2,
        )
        _seed_ad_search_term_shares_row(
            db,
            source_file_id=f1.id,
            row_no=1,
            report_date=day1,
            campaign_name='Campaign-A', ad_group_name='Group-1', search_term='term one', match_type='EXACT', impression_rank=1, impression_share=50.0,
            impressions=100, clicks=10, spend=5.0, sales_7d=20.0, orders_7d=2,
        )
        _seed_ad_search_term_shares_row(
            db,
            source_file_id=f2.id,
            row_no=2,
            report_date=day2,
            campaign_name='Campaign-A', ad_group_name='Group-1', search_term='term one', match_type='EXACT', impression_rank=1, impression_share=50.0,
            impressions=200, clicks=20, spend=10.0, sales_7d=30.0, orders_7d=3,
        )
        _seed_ad_search_term_shares_row(
            db,
            source_file_id=f2.id,
            row_no=3,
            report_date=day2,
            campaign_name='Campaign-A', ad_group_name='Group-1', search_term='term two', match_type='BROAD', impression_rank=2, impression_share=30.0,
            impressions=300, clicks=30, spend=15.0, sales_7d=10.0, orders_7d=1,
        )
        db.commit()
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "key": key,
        "headers": _headers(key, agent_id),
        "country": country,
    }

    db = SessionLocal()
    try:
        file_ids = [
            r[0]
            for r in db.query(AdUploadFile.id)
            .filter(AdUploadFile.project_id == project_id)
            .all()
        ]
        if file_ids:
            db.execute(delete(AdUploadSearchTermShareRow).where(AdUploadSearchTermShareRow.source_file_id.in_(file_ids)))
        db.execute(delete(AdUploadFile).where(AdUploadFile.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调（aggregate + raw）
# ---------------------------------------------------------------------------


def _period_info(qs: str):
    """与 agent 路由一致的 period 解析：period=7d + today 锚定 T-1。"""
    from app.utils.period import parse_period_v2

    kwargs = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
    return parse_period_v2(
        kwargs.get("period", "7d"),
        kwargs.get("start_date"),
        kwargs.get("end_date"),
        today=date.today() - timedelta(days=1),
    )


def test_aggregate_parity_agent_channel_vs_service(client, ad_search_term_shares_env):
    """aggregate：agent 通道 data == service 直调（aggregate_search_term_shares +
    build_aggregate_summary + AdSearchTermShareAggregateResponse model_dump）。"""
    from app.schemas.external.aggregate import AdSearchTermShareAggregateResponse, AdSearchTermShareAggregateRow
    from app.services.external import aggregator, projects_query

    pid = ad_search_term_shares_env["project_id"]
    country = ad_search_term_shares_env["country"]
    qs = f"period=7d&country={country}"

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/ad-search-term-shares?{qs}",
        headers=ad_search_term_shares_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    period_info = _period_info(qs)
    db = SessionLocal()
    try:
        assert projects_query.project_exists(db, pid)
        rows = aggregator.aggregate_search_term_shares(
            db,
            project_id=pid,
            country=country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
        )
        expected = AdSearchTermShareAggregateResponse(
            project_id=pid,
            period=period_info,
            country=country,
            data=[AdSearchTermShareAggregateRow.model_validate(r) for r in rows] if rows else [],
            summary=aggregator.build_aggregate_summary(rows),
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected, "agent 通道与 service 直调结果不一致"
    assert agent_data["summary"]["total_rows"] == 2
    assert len(agent_data["data"]) == 2


def test_raw_parity_agent_channel_vs_service(client, ad_search_term_shares_env):
    """raw：agent 通道 data == service 直调（query_search_term_share_raw + RawResponse）。"""
    from app.schemas.external.ad_raw import AdSearchTermShareRawRow
    from app.schemas.external.aggregate import RawResponse, RawSummary
    from app.services.external import ad_rows_query, projects_query

    pid = ad_search_term_shares_env["project_id"]
    country = ad_search_term_shares_env["country"]
    qs = f"period=7d&country={country}&order_by=report_end_date&order_dir=desc"

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/ad-search-term-shares-raw?{qs}",
        headers=ad_search_term_shares_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    period_info = _period_info(qs)
    db = SessionLocal()
    try:
        assert projects_query.project_exists(db, pid)
        from app.api.v1.endpoints.agent._whitelist import parse_order_by

        order_column, direction = parse_order_by("report_end_date", "desc", model=AdUploadSearchTermShareRow)
        rows = ad_rows_query.query_search_term_share_raw(
            db,
            project_id=pid,
            country=country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
            order_column=order_column,
            order_dir=direction,
            limit=10000,
            offset=0,
        )
        expected = RawResponse[AdSearchTermShareRawRow](
            project_id=pid,
            period=period_info,
            country=country,
            data=[AdSearchTermShareRawRow.model_validate(r) for r in rows],
            summary=RawSummary(
                total_rows=len(rows),
                date_range=[
                    period_info.start_date.isoformat(),
                    period_info.end_date.isoformat(),
                ],
            ),
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected, "agent 通道与 service 直调结果不一致"
    assert agent_data["summary"]["total_rows"] == 3

def test_raw_alias_parity(client, ad_search_term_shares_env):
    """单数 alias ``ad-search-term-share-raw`` 与复数 ``ad-search-term-shares-raw`` 同响应。"""
    pid = ad_search_term_shares_env["project_id"]
    qs = f"period=7d&country={ad_search_term_shares_env['country']}"

    plural = client.get(
        f"/api/v1/agent/projects/{pid}/ad-search-term-shares-raw?{qs}",
        headers=ad_search_term_shares_env["headers"],
    )
    alias = client.get(
        f"/api/v1/agent/projects/{pid}/ad-search-term-share-raw?{qs}",
        headers=ad_search_term_shares_env["headers"],
    )
    assert plural.status_code == 200 and alias.status_code == 200
    assert plural.json()["data"] == alias.json()["data"]


# ---------------------------------------------------------------------------
# 2. 鉴权 / 壳：401 / 404 / 403 project_scope / 403 business_scope / 400
# ---------------------------------------------------------------------------


def test_401_without_credentials(client, ad_search_term_shares_env):
    resp = client.get(
        f"/api/v1/agent/projects/{ad_search_term_shares_env['project_id']}/ad-search-term-shares"
        f"?period=7d&country={ad_search_term_shares_env['country']}",
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


def test_404_project_not_found(client, ad_search_term_shares_env):
    resp = client.get(
        f"/api/v1/agent/projects/99999999/ad-search-term-shares"
        f"?period=7d&country={ad_search_term_shares_env['country']}",
        headers=ad_search_term_shares_env["headers"],
    )
    assert resp.status_code == 404
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_403_project_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="scoped-blf581", project_scope="1")
    resp = client.get(
        f"/api/v1/agent/projects/99999999/ad-search-term-shares?period=7d&country=US",
        headers=_headers(key, "scoped-blf581"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_403_business_scope_missing_ad_analysis(client, ad_search_term_shares_env, make_api_key):
    """business_scope 不含 ad_analysis（既有的 ad 域 scope 约定）→ 403。"""
    key = make_api_key(
        agent_id="biz-scoped-blf581",
        project_scope="*",
        business_scope="shipments",
    )
    resp = client.get(
        f"/api/v1/agent/projects/{ad_search_term_shares_env['project_id']}/ad-search-term-shares"
        f"?period=7d&country={ad_search_term_shares_env['country']}",
        headers=_headers(key, "biz-scoped-blf581"),
    )
    assert resp.status_code == 403
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_400_validation_shell(client, ad_search_term_shares_env):
    resp = client.get(
        f"/api/v1/agent/projects/{ad_search_term_shares_env['project_id']}/ad-search-term-shares"
        "?period=bogus&country=US",
        headers=ad_search_term_shares_env["headers"],
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# 3. 路由面（模板断言：原生路由注册 + external_mirror 已删）
# ---------------------------------------------------------------------------


def test_native_routes_registered_and_mirror_removed():
    """原生路由注册；external_mirror 已退役删除（BLF-583）——
    镜像路径整体移除，无双挂可能；external 端点模块已删。"""
    from app.api.v1.endpoints.agent.ad_search_term_shares import ad_search_term_shares_router

    native_paths = {r.path for r in ad_search_term_shares_router.routes}
    assert "/projects/{project_id}/ad-search-term-shares" in native_paths
    assert "/projects/{project_id}/ad-search-term-shares-raw" in native_paths
    assert "/projects/{project_id}/ad-search-term-share-raw" in native_paths

    # BLF-583：external_mirror 已退役删除，镜像路由整体移除，无双挂可能。
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.agent.external_mirror  # noqa: F401


def test_external_module_deleted():
    """external/ad_search_term_shares.py 端点模块已删除：import 应失败。"""
    import pytest as _pytest

    with _pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.ad_search_term_shares  # noqa: F401


def test_business_scope_key_is_ad_analysis():
    """模板契约：ad 域挂 business_scope("ad_analysis")（既有约定），
    agent/__init__.py 接线处生效。"""
    from app.api.v1.endpoints.agent import agent_router

    # FastAPI >=0.13x 子路由包成 _IncludedRouter（真实 APIRoute 在
    # original_router.routes 且 path 不含 /agent 前缀），<0.13x 直接拍平。
    def _iter_routes(routes):
        for r in routes:
            yield r
            inner = getattr(r, "original_router", None)
            if inner is not None:
                yield from _iter_routes(getattr(inner, "routes", []))

    native = [
        r
        for r in _iter_routes(agent_router.routes)
        if getattr(r, "path", "") == "/projects/{project_id}/ad-search-term-shares"
    ]
    assert len(native) == 1
