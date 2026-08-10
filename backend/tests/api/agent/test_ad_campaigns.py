"""Agent 广告投放活动域原生路由测试（BLF-580 原生化样板）。

ad_campaigns 是「原生化模板」第一个域：从 external 镜像复用 → agent 原生
实现（external/ad_campaigns.py 端点模块已删除）。本文件同时是后续 9 个
ad 域（budgets/targets/placements/...）+ 其它域的**照抄模板**，覆盖：

1. **parity**：agent 通道响应 == service 直调结果（aggregate + raw +
   单数 alias），对齐 test_mirror_agent_channel_group_by_parity 的
   service 直调比对模式——同一服务函数、同一参数，响应 model_dump 全等。
2. **鉴权/壳**：401 未鉴权 / 404 项目不存在 / 403 project_scope 越界 /
   403 business_scope 不含 ad_analysis 域。
3. **路由面/镜像排除**：3 条原生路由注册；external_mirror 无 ad-campaigns
   镜像路径；_EXCLUDED_EXTERNAL_PATHS 含 3 条路径（防双挂）；external
   端点模块已删除。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import AdUploadCampaignRow, AdUploadFile, Project


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
    report_type: str = "ad_campaign_report",
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
        upload_file_id=f"test-campaign-{project_id}-{country}-{report_date.isoformat()}",
        upload_file_path=f"/tmp/test-campaign-{project_id}-{report_date.isoformat()}.csv",
        stored_filename=f"test-campaign-{project_id}-{report_date.isoformat()}.csv",
        logical_filename=f"test-campaign-{project_id}-{report_date.isoformat()}.csv",
        file_extension=".csv",
        matched_columns=[],
        warnings=[],
        recognition_payload={},
    )
    db.add(f)
    db.flush()
    return f


def _seed_campaign_row(
    db,
    *,
    source_file_id: int,
    row_no: int,
    report_date: date,
    campaign_name: str,
    impressions: int,
    clicks: int,
    spend: float,
    sales_7d: float,
    orders_7d: int,
    status: str = "ENABLED",
    budget: float = 10.0,
):
    db.add(
        AdUploadCampaignRow(
            source_file_id=source_file_id,
            source_row_no=row_no,
            report_start_date=report_date,
            report_end_date=report_date,
            campaign_name=campaign_name,
            status=status,
            budget=budget,
            impressions=impressions,
            clicks=clicks,
            spend=spend,
            sales_7d=sales_7d,
            orders_7d=orders_7d,
            ctr=0,
            cpc=0,
            acos=0,
            roas=0,
            country="US",
            currency="USD",
            raw_row={},
        )
    )


@pytest.fixture
def campaigns_env(make_api_key):
    """临时项目 + 全放行 key + 2 个 campaign 的 US 原始行，测试后清理。

    种子：campaign-A（2 行，跨 2 天）→ aggregate 按 campaign_name 聚合；
    campaign-B（1 行）。窗口锚定 today-1（与 agent 路由 T-1 一致）。
    """
    agent_id = f"blf580-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf580-{suffix}"
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
        _seed_campaign_row(
            db,
            source_file_id=f1.id,
            row_no=1,
            report_date=day1,
            campaign_name="Campaign-A",
            impressions=100,
            clicks=10,
            spend=5.0,
            sales_7d=20.0,
            orders_7d=2,
        )
        _seed_campaign_row(
            db,
            source_file_id=f2.id,
            row_no=2,
            report_date=day2,
            campaign_name="Campaign-A",
            impressions=200,
            clicks=20,
            spend=10.0,
            sales_7d=30.0,
            orders_7d=3,
        )
        _seed_campaign_row(
            db,
            source_file_id=f2.id,
            row_no=3,
            report_date=day2,
            campaign_name="Campaign-B",
            impressions=300,
            clicks=30,
            spend=15.0,
            sales_7d=10.0,
            orders_7d=1,
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
            db.execute(
                delete(AdUploadCampaignRow).where(
                    AdUploadCampaignRow.source_file_id.in_(file_ids)
                )
            )
        db.execute(delete(AdUploadFile).where(AdUploadFile.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调（aggregate + raw + alias）
# ---------------------------------------------------------------------------


def _period_info(qs: str):
    """与 agent 路由一致的 period 解析：period=7d + today 锚定 T-1。"""
    from app.api.v1.endpoints.external._period import parse_period_v2

    kwargs = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
    return parse_period_v2(
        kwargs.get("period", "7d"),
        kwargs.get("start_date"),
        kwargs.get("end_date"),
        today=date.today() - timedelta(days=1),
    )


def test_aggregate_parity_agent_channel_vs_service(client, campaigns_env):
    """aggregate：agent 通道 data == service 直调（aggregate_campaigns +
    build_aggregate_summary + AdCampaignAggregateResponse model_dump）。"""
    from app.schemas.external.aggregate import AdCampaignAggregateResponse
    from app.services.external import aggregator, projects_query

    pid = campaigns_env["project_id"]
    country = campaigns_env["country"]
    qs = f"period=7d&country={country}"

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/ad-campaigns?{qs}",
        headers=campaigns_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    period_info = _period_info(qs)
    db = SessionLocal()
    try:
        assert projects_query.project_exists(db, pid)
        rows = aggregator.aggregate_campaigns(
            db,
            project_id=pid,
            country=country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
        )
        expected = AdCampaignAggregateResponse(
            project_id=pid,
            period=period_info,
            country=country,
            data=[type(rows[0]).model_validate(r) for r in rows] if rows else [],
            summary=aggregator.build_aggregate_summary(rows),
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected, "agent 通道与 service 直调结果不一致"
    assert agent_data["summary"]["total_rows"] == 2
    names = {r["campaign_name"] for r in agent_data["data"]}
    assert names == {"Campaign-A", "Campaign-B"}


def test_raw_parity_agent_channel_vs_service(client, campaigns_env):
    """raw：agent 通道 data == service 直调（query_campaign_raw + RawResponse）。"""
    from app.schemas.external.ad_raw import AdCampaignRawRow
    from app.schemas.external.aggregate import RawResponse, RawSummary
    from app.services.external import ad_rows_query, projects_query

    pid = campaigns_env["project_id"]
    country = campaigns_env["country"]
    qs = f"period=7d&country={country}&order_by=report_end_date&order_dir=desc"

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/ad-campaigns-raw?{qs}",
        headers=campaigns_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    period_info = _period_info(qs)
    db = SessionLocal()
    try:
        assert projects_query.project_exists(db, pid)
        from app.models import AdUploadCampaignRow as _Row
        from app.api.v1.endpoints.external._whitelist import parse_order_by

        order_column, direction = parse_order_by("report_end_date", "desc", model=_Row)
        rows = ad_rows_query.query_campaign_raw(
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
        expected = RawResponse[AdCampaignRawRow](
            project_id=pid,
            period=period_info,
            country=country,
            data=[AdCampaignRawRow.model_validate(r) for r in rows],
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


def test_raw_alias_parity(client, campaigns_env):
    """单数 alias ``ad-campaign-raw`` 与复数 ``ad-campaigns-raw`` 同响应。"""
    pid = campaigns_env["project_id"]
    qs = f"period=7d&country={campaigns_env['country']}"

    plural = client.get(
        f"/api/v1/agent/projects/{pid}/ad-campaigns-raw?{qs}",
        headers=campaigns_env["headers"],
    )
    alias = client.get(
        f"/api/v1/agent/projects/{pid}/ad-campaign-raw?{qs}",
        headers=campaigns_env["headers"],
    )
    assert plural.status_code == 200 and alias.status_code == 200
    assert plural.json()["data"] == alias.json()["data"]


# ---------------------------------------------------------------------------
# 2. 鉴权 / 壳：401 / 404 / 403 project_scope / 403 business_scope
# ---------------------------------------------------------------------------


def test_401_without_credentials(client, campaigns_env):
    resp = client.get(
        f"/api/v1/agent/projects/{campaigns_env['project_id']}/ad-campaigns"
        f"?period=7d&country={campaigns_env['country']}",
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


def test_404_project_not_found(client, campaigns_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/ad-campaigns"
        f"?period=7d&country={campaigns_env['country']}",
        headers=campaigns_env["headers"],
    )
    assert resp.status_code == 404
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_403_project_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="scoped-blf580", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/ad-campaigns?period=7d&country=US",
        headers=_headers(key, "scoped-blf580"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_403_business_scope_missing_ad_analysis(client, campaigns_env, make_api_key):
    """business_scope 不含 ad_analysis（既有的 ad 域 scope 约定）→ 403。"""
    key = make_api_key(
        agent_id="biz-scoped-blf580",
        project_scope="*",
        business_scope="shipments",
    )
    resp = client.get(
        f"/api/v1/agent/projects/{campaigns_env['project_id']}/ad-campaigns"
        f"?period=7d&country={campaigns_env['country']}",
        headers=_headers(key, "biz-scoped-blf580"),
    )
    assert resp.status_code == 403
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_400_validation_shell(client, campaigns_env):
    resp = client.get(
        f"/api/v1/agent/projects/{campaigns_env['project_id']}/ad-campaigns"
        "?period=bogus&country=US",
        headers=campaigns_env["headers"],
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# 3. 路由面 / 镜像排除（模板断言：无双挂 + external 模块已删）
# ---------------------------------------------------------------------------


def test_native_routes_registered_and_mirror_excluded():
    """3 条原生路由注册；external_mirror 无 ad-campaigns 镜像路径；
    _EXCLUDED_EXTERNAL_PATHS 含 3 条（防双挂）；external 端点模块已删。"""
    from app.api.v1.endpoints.agent.ad_campaigns import ad_campaigns_router
    from app.api.v1.endpoints.agent.external_mirror import (
        _EXCLUDED_EXTERNAL_PATHS,
        external_mirror_router,
    )

    native_paths = {r.path for r in ad_campaigns_router.routes}
    assert "/projects/{project_id}/ad-campaigns" in native_paths
    assert "/projects/{project_id}/ad-campaigns-raw" in native_paths
    assert "/projects/{project_id}/ad-campaign-raw" in native_paths

    mirror_paths = {r.path for r in external_mirror_router.routes}
    for rel in (
        "/projects/{project_id}/ad-campaigns",
        "/projects/{project_id}/ad-campaigns-raw",
        "/projects/{project_id}/ad-campaign-raw",
    ):
        assert rel not in mirror_paths, f"镜像仍含 {rel}（双挂）"

    for ext in (
        "/external/projects/{project_id}/ad-campaigns",
        "/external/projects/{project_id}/ad-campaigns-raw",
        "/external/projects/{project_id}/ad-campaign-raw",
    ):
        assert ext in _EXCLUDED_EXTERNAL_PATHS, f"排除集缺 {ext}"


def test_external_module_deleted():
    """external/ad_campaigns.py 端点模块已删除：import 应失败。"""
    import pytest as _pytest

    with _pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.ad_campaigns  # noqa: F401


def test_business_scope_key_is_ad_analysis():
    """模板契约：ad 域挂 business_scope("ad_analysis")（既有约定），
    agent/__init__.py 接线处生效。"""
    from app.api.v1.endpoints.agent import agent_router

    # 路由级依赖无法直接读取闭包 domain，验证方式：ad_analysis 是
    # frontend agent-domains.ts 注册表的既有 code（后端侧无注册表，
    # 依赖字符串在 require_business_scope 调用点）。此处保证原生路由
    # 确实挂在 agent_router 之下（非被兜底吞掉）。
    ad_campaign_routes = [
        r
        for r in agent_router.routes
        if getattr(r, "path", "") == "/agent/projects/{project_id}/ad-campaigns"
    ]
    assert len(ad_campaign_routes) == 1
