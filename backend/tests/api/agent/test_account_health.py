"""Agent 店铺合规健康域读路由测试（BLF-550；spec §8 测试清单）。

覆盖（对齐 spec §8 清单）：
1. R2 纯读锁契约：无周期 → 404；有周期 → 返回当前周期；**不产生新行**
   （断言 inspection_periods 行数不变）——内部 get_or_create_current_period
   有建行副作用，Agent 通道必须纯读。
2. R3：period 不存在 404；items 按 project_scope 过滤；空值 null 非 0；
   compliance_total 口径与内部 overview 一致。
3. R4：无报告 404；include_summary 默认不带 / =true 带；项目不在凭据范围 404。
4. R5：分页；order_by 白名单非法值 400 VALIDATION_FAILED；按 period /
   project 筛选；scope 过滤；排序方向正确。
5. 壳与错误码：未鉴权 401 壳；限流 429；所有错误均走统一错误壳。
6. 路由注册：account-health 路由在兜底路由之前注册（不被吞成 404）。
7. regression：内部 /api/v1/inspections/* 端点行为不变（R2 新增纯读函数
   不改 get_or_create_current_period——内部 current 仍会建行，Agent 不会）。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select

from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.inspection import InspectionPeriod, InspectionReport

_TZ_CN = timezone(timedelta(hours=8))

# 拍平事实行（§7.1）健康 8 + 合规 10 字段名。
_HEALTH_KEYS = (
    "account_health_rating",
    "negative_feedback",
    "a2z_claims",
    "chargeback_claims",
    "late_shipment_rate",
    "pre_fulfillment_cancel_rate",
    "valid_tracking_rate",
    "on_time_delivery_rate",
)
_COMPLIANCE_KEYS = (
    "ip_infringement",
    "ip_complaints",
    "product_authenticity_complaints",
    "product_condition_complaints",
    "food_product_safety",
    "listing_policy_violations",
    "restricted_product_violations",
    "review_policy_violations",
    "other_policy_violations",
    "regulatory_compliance",
)


def _cn_today() -> date:
    return datetime.now(_TZ_CN).date()


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def settings():
    from app.core.config import get_settings

    return get_settings()


def _seed(
    *,
    projects: list[str] = ("A", "B", "C"),
    with_current_period: bool = True,
    country_map: dict[str, str] | None = None,
):
    """建项目 + 周期 + 报告；返回 id 字典。报告/周期/项目在 teardown 清理。"""
    suffix = uuid.uuid4().hex[:8]
    agent_id = f"ah-agent-{suffix}"

    db = SessionLocal()
    try:
        # 测试库预置了生产巡检数据（11 周档）——先清空 inspection 两表，
        # 保证 fixture 周期 week_start 唯一约束可插入、用例确定性不依赖存量。
        db.execute(delete(InspectionReport))
        db.execute(delete(InspectionPeriod))

        pids: dict[str, int] = {}
        for name in projects:
            p = Project(
                project_name=f"agent-ah-{name}-{suffix}",
                project_operator=None,
                assistant_operator=None,
                sort_order=len(pids),
                is_active=True,
                **({"country": country_map[name]} if country_map and name in country_map else {}),
            )
            db.add(p)
            db.flush()
            pids[name] = p.id

        today = _cn_today()
        cur_monday = _week_start(today)
        past_monday = cur_monday - timedelta(days=7)
        # deadline 放未来 → past_deadline=False → get_overview 不触发
        # mark_overdue_reports（保持测试纯读、不污染共享测试库）。
        future_deadline = datetime.now(_TZ_CN) + timedelta(days=1)

        period_ids: dict[str, int] = {}
        if with_current_period:
            cur = InspectionPeriod(
                week_start=cur_monday,
                week_end=cur_monday + timedelta(days=6),
                deadline=future_deadline,
            )
            db.add(cur)
            db.flush()
            period_ids["cur"] = cur.id
        past = InspectionPeriod(
            week_start=past_monday,
            week_end=past_monday + timedelta(days=6),
            deadline=future_deadline,
        )
        db.add(past)
        db.flush()
        period_ids["past"] = past.id

        now = datetime.now(_TZ_CN)
        if with_current_period:
            db.add_all(
                [
                    InspectionReport(
                        period_id=period_ids["cur"],
                        project_id=pids["A"],
                        status="submitted",
                        health_data={
                            "account_health_rating": "Good",
                            "negative_feedback": 2,
                            "a2z_claims": 1,
                            "chargeback_claims": 0,
                            "late_shipment_rate": 1.5,
                            "pre_fulfillment_cancel_rate": 0.5,
                            "valid_tracking_rate": 98.0,
                            "on_time_delivery_rate": 97.5,
                        },
                        compliance_data={"ip_infringement": 1},
                        status_summary="当前健康",
                        submitted_by="pytest",
                        submitted_at=now,
                    ),
                    InspectionReport(
                        period_id=period_ids["cur"],
                        project_id=pids["B"],
                        status="submitted",
                        # 部分空值：negative_feedback 等未填 → null 非 0。
                        health_data={
                            "account_health_rating": "At Risk",
                            "late_shipment_rate": 3.0,
                        },
                        compliance_data={},
                        submitted_by="pytest",
                        submitted_at=now,
                    ),
                ]
            )
        db.add(
            InspectionReport(
                period_id=period_ids["past"],
                project_id=pids["A"],
                status="submitted",
                health_data={"account_health_rating": "At Risk"},
                compliance_data={"ip_infringement": 2, "ip_complaints": 1},
                submitted_by="pytest",
                submitted_at=now,
            )
        )
        db.commit()
    finally:
        db.close()

    return {
        "agent_id": agent_id,
        "suffix": suffix,
        "pids": pids,
        "period_ids": period_ids,
    }


def _teardown(suffix: str, pids: dict[str, int]) -> None:
    """清理：inspection 表为本测试文件专属（全库无其它用例碰这两个表），
    整体清空 + 删本项目，保证内部 regression 测试建出的周期也不残留。"""
    db = SessionLocal()
    try:
        db.execute(delete(InspectionReport))
        db.execute(delete(InspectionPeriod))
        for pid in pids.values():
            obj = db.get(Project, pid)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()


def _count_periods() -> int:
    db = SessionLocal()
    try:
        return db.execute(
            select(func.count()).select_from(InspectionPeriod)
        ).scalar_one()
    finally:
        db.close()


def _make_headers(make_api_key, agent_id: str, **kw) -> dict:
    key = make_api_key(agent_id=agent_id, **kw)
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }


# ============================================================
# R2 纯读锁契约（spec §8 #1）
# ============================================================


class TestR2PureReadLock:
    def test_has_current_period_returns_it_and_no_new_row(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope="*",
            )
            before = _count_periods()

            resp = client.get(
                "/api/v1/agent/account-health/periods/current", headers=headers
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["period_id"] == env["period_ids"]["cur"]
            assert data["week_start"] == _week_start(_cn_today()).isoformat()
            assert "submitted_count" not in data

            # 纯读锁：行数不变（内部 get_or_create_current_period 会 INSERT）。
            assert _count_periods() == before
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_no_current_period_404_and_no_new_row(self, client, make_api_key):
        env = _seed(with_current_period=False)
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope="*",
            )
            before = _count_periods()
            assert before == 1  # 只有 past 周期，无当前周期

            resp = client.get(
                "/api/v1/agent/account-health/periods/current", headers=headers
            )
            assert resp.status_code == 404, resp.text
            body = resp.json()
            assert body["ok"] is False
            assert body["error"]["code"] == "RESOURCE_NOT_FOUND"

            # 纯读锁：404 也不建行。
            assert _count_periods() == before
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 鉴权 / 域 scope 门禁（spec §8 #5/#6）
# ============================================================


class TestAuthShell:
    def test_no_credentials_401_shell(self, client):
        resp = client.get("/api/v1/agent/account-health/periods")
        assert resp.status_code == 401, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_AUTH_FAILED"

    def test_wrong_credentials_401_shell(self, client):
        resp = client.get(
            "/api/v1/agent/account-health/periods",
            headers={"Authorization": "Bearer bbx_deadbeef", "X-Agent-Id": "x"},
        )
        assert resp.status_code == 401, resp.text
        assert resp.json()["error"]["reason"] == "token_invalid"


class TestBusinessScopeGate:
    def test_domain_out_of_scope_403(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="shipments"
            )
            resp = client.get("/api/v1/agent/account-health/periods", headers=headers)
            assert resp.status_code == 403, resp.text
            body = resp.json()
            assert body["ok"] is False
            assert body["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_domain_in_scope_allows(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get("/api/v1/agent/account-health/periods", headers=headers)
            assert resp.status_code == 200, resp.text
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# R1 周期列表（spec §7.2：可附 submitted_count）
# ============================================================


class TestR1Periods:
    def test_list_shape_and_submitted_count(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get("/api/v1/agent/account-health/periods", headers=headers)
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["total"] == 2
            by_id = {i["period_id"]: i for i in data["items"]}
            # cur：A/B 两条 submitted → submitted_count=2；past：A 一条 → 1。
            assert by_id[env["period_ids"]["cur"]]["submitted_count"] == 2
            assert by_id[env["period_ids"]["past"]]["submitted_count"] == 1
            for item in data["items"]:
                for field in (
                    "period_id",
                    "week_start",
                    "week_end",
                    "deadline",
                    "submitted_count",
                ):
                    assert field in item, f"missing field {field}"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_pagination(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get(
                "/api/v1/agent/account-health/periods?limit=1&offset=1",
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["total"] == 2
            assert len(data["items"]) == 1
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# R3 周期概览（spec §8 #2）
# ============================================================


class TestR3Overview:
    def test_period_not_found_404(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get(
                "/api/v1/agent/account-health/periods/999999/overview",
                headers=headers,
            )
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_items_filtered_by_project_scope(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            # scope = A,B → items 只有 A/B；C 被列表过滤（不抛 403）。
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope=f"{env['pids']['A']},{env['pids']['B']}",
            )
            resp = client.get(
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}/overview",
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            pids = {i["project_id"] for i in data["items"]}
            assert pids == {env["pids"]["A"], env["pids"]["B"]}
            assert data["total_projects"] == 2
            assert data["submitted_count"] == 2
            assert data["overdue_count"] == 0

            # scope = A → 只剩 A。
            headers_a = _make_headers(
                make_api_key,
                env["agent_id"] + "-a",
                business_scope="account_health",
                project_scope=str(env["pids"]["A"]),
            )
            resp_a = client.get(
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}/overview",
                headers=headers_a,
            )
            assert resp_a.status_code == 200, resp_a.text
            data_a = resp_a.json()["data"]
            assert {i["project_id"] for i in data_a["items"]} == {env["pids"]["A"]}
            assert data_a["total_projects"] == 1
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_null_values_not_zero(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope=f"{env['pids']['A']},{env['pids']['B']}",
            )
            resp = client.get(
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}/overview",
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            items = {i["project_id"]: i for i in resp.json()["data"]["items"]}
            # B：negative_feedback 未填 → null（非 0）；compliance 空 dict → null。
            b = items[env["pids"]["B"]]
            assert b["negative_feedback"] is None
            assert b["compliance_total"] is None
            for key in _COMPLIANCE_KEYS:
                assert b[key] is None, f"{key} 应为 null 而非 0"
            # A：ip_infringement=1 → compliance_total=1；negative_feedback=2。
            a = items[env["pids"]["A"]]
            assert a["negative_feedback"] == 2
            assert a["compliance_total"] == 1
            # 不暴露 raw JSON / presigned URL / status_summary。
            assert "health_data" not in a
            assert "compliance_data" not in a
            assert "status_summary" not in a
            assert "screenshots" not in a
            assert a["screenshot_count"] == 0
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_compliance_total_matches_internal_overview(
        self, client, make_api_key, admin_headers
    ):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope=f"{env['pids']['A']},{env['pids']['B']}",
            )
            agent_resp = client.get(
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}/overview",
                headers=headers,
            )
            internal_resp = client.get(
                f"/api/v1/inspections/periods/{env['period_ids']['cur']}/overview",
                headers=admin_headers,
            )
            assert agent_resp.status_code == 200, agent_resp.text
            assert internal_resp.status_code == 200, internal_resp.text
            agent_by_pid = {
                i["project_id"]: i for i in agent_resp.json()["data"]["items"]
            }
            internal_by_pid = {
                i["project_id"]: i for i in internal_resp.json()["items"]
            }
            for pid, agent_item in agent_by_pid.items():
                internal_item = internal_by_pid.get(pid)
                assert internal_item is not None, f"internal 缺项目 {pid}"
                assert (
                    agent_item["compliance_total"] == internal_item["compliance_total"]
                ), f"compliance_total 口径不一致 pid={pid}"
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# R4 单店报告明细（spec §8 #3）
# ============================================================


class TestR4ProjectReport:
    def test_report_detail_and_no_status_summary_by_default(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            url = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                f"/projects/{env['pids']['A']}"
            )
            resp = client.get(url, headers=headers)
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["project_id"] == env["pids"]["A"]
            assert data["account_health_rating"] == "Good"
            assert data["compliance_total"] == 1
            assert "status_summary" not in data  # 默认不带
            assert data["screenshot_count"] == 0
            assert "health_data" not in data
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_include_summary_true_returns_status_summary(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            url = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                f"/projects/{env['pids']['A']}?include_summary=true"
            )
            resp = client.get(url, headers=headers)
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["status_summary"] == "当前健康"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_no_report_404(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            # past 周期没有 B 的报告 → 404。
            url = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['past']}"
                f"/projects/{env['pids']['B']}"
            )
            resp = client.get(url, headers=headers)
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_project_out_of_scope_404(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope=str(env["pids"]["A"]),
            )
            url = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                f"/projects/{env['pids']['B']}"
            )
            resp = client.get(url, headers=headers)
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_period_not_found_404(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get(
                f"/api/v1/agent/account-health/periods/999999/projects/{env['pids']['A']}",
                headers=headers,
            )
            assert resp.status_code == 404, resp.text
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# R5 历史趋势（spec §8 #4）
# ============================================================


class TestR5History:
    def test_list_shape_and_pagination(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get("/api/v1/agent/account-health/history", headers=headers)
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            # cur×A + cur×B + past×A = 3 行；默认 week_start desc。
            assert data["total"] == 3
            assert len(data["items"]) == 3
            item = data["items"][0]
            for field in (
                "period_id",
                "week_start",
                "week_end",
                "project_id",
                "project_name",
                "status",
                "account_health_rating",
                "compliance_total",
                "submitted_at",
                "screenshot_count",
            ):
                assert field in item, f"missing field {field}"

            resp2 = client.get(
                "/api/v1/agent/account-health/history?limit=2&offset=1",
                headers=headers,
            )
            assert resp2.status_code == 200, resp2.text
            data2 = resp2.json()["data"]
            assert data2["total"] == 3
            assert len(data2["items"]) == 2
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_order_by_whitelist_invalid_400(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get(
                "/api/v1/agent/account-health/history?order_by=evil_column",
                headers=headers,
            )
            assert resp.status_code == 400, resp.text
            body = resp.json()
            assert body["ok"] is False
            assert body["error"]["code"] == "VALIDATION_FAILED"

            resp_dir = client.get(
                "/api/v1/agent/account-health/history?order_dir=sideways",
                headers=headers,
            )
            assert resp_dir.status_code == 400, resp_dir.text
            assert resp_dir.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_order_by_compliance_total_desc(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get(
                "/api/v1/agent/account-health/history"
                "?order_by=compliance_total&order_dir=desc",
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            items = resp.json()["data"]["items"]
            totals = [i["compliance_total"] for i in items]
            # past×A=3, cur×A=1, cur×B=None（输出保留 null，排序时 None 当 0 排最后）。
            assert totals == [3, 1, None]
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_period_and_project_filter(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            resp = client.get(
                f"/api/v1/agent/account-health/history?period_id={env['period_ids']['cur']}",
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert data["total"] == 2
            assert {i["project_id"] for i in data["items"]} == {
                env["pids"]["A"],
                env["pids"]["B"],
            }

            resp_p = client.get(
                f"/api/v1/agent/account-health/history?project_id={env['pids']['A']}",
                headers=headers,
            )
            assert resp_p.status_code == 200, resp_p.text
            assert resp_p.json()["data"]["total"] == 2
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_scope_filter(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope=str(env["pids"]["A"]),
            )
            resp = client.get("/api/v1/agent/account-health/history", headers=headers)
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert {i["project_id"] for i in data["items"]} == {env["pids"]["A"]}
            assert data["total"] == 2  # cur×A + past×A
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 限流 429（spec §8 #5）
# ============================================================


class TestRateLimitShell:
    def test_breach_returns_429_shell(self, client, settings, make_api_key):
        env = _seed(with_current_period=True)
        original = settings.agent_api_read_rate_limit
        try:
            settings.agent_api_read_rate_limit = "5/minute"
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            statuses = [
                client.get(
                    "/api/v1/agent/account-health/periods", headers=headers
                ).status_code
                for _ in range(8)
            ]
            assert statuses.count(200) == 5
            assert statuses.count(429) == 3
            blocked = client.get(
                "/api/v1/agent/account-health/periods", headers=headers
            )
            assert blocked.status_code == 429
            body = blocked.json()
            assert body["ok"] is False
            assert body["error"]["code"] == "AGENT_RATE_LIMIT_EXCEEDED"
            assert blocked.headers.get("Retry-After")
        finally:
            settings.agent_api_read_rate_limit = original
            _teardown(env["suffix"], env["pids"])


# ============================================================
# regression：内部 /api/v1/inspections/* 行为不变（spec §8 #7）
# ============================================================


class TestInternalRegression:
    def test_internal_current_still_creates_period(self, client, admin_headers):
        """内部 /inspections/periods/current 仍会建行（get_or_create_current_period
        未改动）；R2 纯读锁测试已证明 Agent 通道不建行。"""
        env = _seed(with_current_period=False)
        try:
            # 清理后确保无当前周期。
            before = _count_periods()
            assert before == 1  # 只有 past 周期

            resp = client.get(
                "/api/v1/inspections/periods/current", headers=admin_headers
            )
            assert resp.status_code == 200, resp.text
            # 内部端点有建行副作用 → 行数 +1。
            assert _count_periods() == before + 1
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_internal_list_and_template_unchanged(self, client, admin_headers):
        env = _seed(with_current_period=True)
        try:
            resp = client.get("/api/v1/inspections/template", headers=admin_headers)
            assert resp.status_code == 200, resp.text
            tpl = resp.json()
            assert tpl["health_fields"][0]["key"] == "account_health_rating"
            assert len(tpl["compliance_fields"]) == 10

            resp_p = client.get("/api/v1/inspections/periods", headers=admin_headers)
            assert resp_p.status_code == 200, resp_p.text
            periods = resp_p.json()["items"]
            assert any(p["id"] == env["period_ids"]["cur"] for p in periods)
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_internal_overview_unchanged(self, client, admin_headers):
        env = _seed(with_current_period=True)
        try:
            resp = client.get(
                f"/api/v1/inspections/periods/{env['period_ids']['cur']}/overview",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["period"]["id"] == env["period_ids"]["cur"]
            by_pid = {i["project_id"]: i for i in body["items"]}
            assert by_pid[env["pids"]["A"]]["compliance_total"] == 1
            assert by_pid[env["pids"]["B"]]["compliance_total"] is None
            assert "health_data" not in by_pid[env["pids"]["A"]]
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# country 维度（BLF-956）：全部 5 条路由 ?country= 过滤
# ============================================================


class TestCountryDimension:
    """巡检无国家列（数据按 (period, project)）；国家 = Project.country。

    seed 默认 A/B/C 均 US；country_map={"B": "DE"} 时 B 变德国站——
    cur 周期 A(submitted)+B(submitted)，past 周期 A(submitted)，C 无报告
    （overview 里以 pending 出现）。
    """

    def _headers(self, make_api_key, agent_id: str) -> dict:
        return _make_headers(
            make_api_key, agent_id, business_scope="account_health"
        )

    # ── R1 周期列表：submitted_count 按国家过滤 ────────────────────
    def test_r1_submitted_count_filtered_by_country(self, client, make_api_key):
        env = _seed(with_current_period=True, country_map={"B": "DE"})
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            resp = client.get(
                "/api/v1/agent/account-health/periods?country=DE", headers=headers
            )
            assert resp.status_code == 200, resp.text
            by_id = {i["period_id"]: i for i in resp.json()["data"]["items"]}
            # cur：只有 B(DE) submitted → 1；past：A(US) → 0。
            assert by_id[env["period_ids"]["cur"]]["submitted_count"] == 1
            assert by_id[env["period_ids"]["past"]]["submitted_count"] == 0

            # 多站点聚合：country=US,DE → cur=2 / past=1。
            resp2 = client.get(
                "/api/v1/agent/account-health/periods?country=US,DE",
                headers=headers,
            )
            assert resp2.status_code == 200, resp2.text
            by_id2 = {i["period_id"]: i for i in resp2.json()["data"]["items"]}
            assert by_id2[env["period_ids"]["cur"]]["submitted_count"] == 2
            assert by_id2[env["period_ids"]["past"]]["submitted_count"] == 1
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_r1_invalid_country_400(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            resp = client.get(
                "/api/v1/agent/account-health/periods?country=XX", headers=headers
            )
            assert resp.status_code == 400, resp.text
            body = resp.json()
            assert body["ok"] is False
            assert body["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    # ── R2 当前周期：country 仅归一化校验（周期全局共享） ───────────
    def test_r2_accepts_valid_country_and_rejects_invalid(
        self, client, make_api_key
    ):
        env = _seed(with_current_period=True)
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            ok = client.get(
                "/api/v1/agent/account-health/periods/current?country=US",
                headers=headers,
            )
            assert ok.status_code == 200, ok.text
            assert ok.json()["data"]["period_id"] == env["period_ids"]["cur"]

            bad = client.get(
                "/api/v1/agent/account-health/periods/current?country=XX",
                headers=headers,
            )
            assert bad.status_code == 400, bad.text
            assert bad.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_r3_overview_filtered_by_country(self, client, make_api_key):
        env = _seed(with_current_period=True, country_map={"B": "DE"})
        try:
            headers = _make_headers(
                make_api_key,
                env["agent_id"],
                business_scope="account_health",
                project_scope=",".join(str(p) for p in env["pids"].values()),
            )
            url = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                "/overview"
            )
            # 只看 DE → 只有 B。
            resp_de = client.get(url + "?country=DE", headers=headers)
            assert resp_de.status_code == 200, resp_de.text
            data_de = resp_de.json()["data"]
            assert {i["project_id"] for i in data_de["items"]} == {env["pids"]["B"]}
            assert data_de["total_projects"] == 1
            assert data_de["submitted_count"] == 1
            # 行响应回传 normalized country。
            assert data_de["items"][0]["country"] == "DE"

            # 只看 US → A(submitted) + C(pending，无报告)。
            resp_us = client.get(url + "?country=US", headers=headers)
            assert resp_us.status_code == 200, resp_us.text
            data_us = resp_us.json()["data"]
            assert {i["project_id"] for i in data_us["items"]} == {
                env["pids"]["A"],
                env["pids"]["C"],
            }
            assert data_us["submitted_count"] == 1
            by_pid = {i["project_id"]: i for i in data_us["items"]}
            assert by_pid[env["pids"]["A"]]["country"] == "US"
            assert by_pid[env["pids"]["C"]]["country"] == "US"

            # 多站点 US,DE → 三店齐全。
            resp_both = client.get(url + "?country=US,DE", headers=headers)
            assert resp_both.status_code == 200, resp_both.text
            assert {i["project_id"] for i in resp_both.json()["data"]["items"]} == {
                env["pids"]["A"],
                env["pids"]["B"],
                env["pids"]["C"],
            }
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_r3_invalid_country_400(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            resp = client.get(
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                "/overview?country=XX",
                headers=headers,
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    # ── R4 单店明细：country 校验项目国家，不匹配 → 404 ────────────
    def test_r4_country_mismatch_404_match_200(self, client, make_api_key):
        env = _seed(with_current_period=True, country_map={"B": "DE"})
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            # A 是美国站：country=US → 200；country=DE → 404。
            url_a = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                f"/projects/{env['pids']['A']}"
            )
            ok = client.get(url_a + "?country=US", headers=headers)
            assert ok.status_code == 200, ok.text
            assert ok.json()["data"]["country"] == "US"

            mismatch = client.get(url_a + "?country=DE", headers=headers)
            assert mismatch.status_code == 404, mismatch.text
            assert mismatch.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

            # B 是德国站：country=DE → 200。
            url_b = (
                f"/api/v1/agent/account-health/periods/{env['period_ids']['cur']}"
                f"/projects/{env['pids']['B']}"
            )
            ok_b = client.get(url_b + "?country=DE", headers=headers)
            assert ok_b.status_code == 200, ok_b.text
            assert ok_b.json()["data"]["country"] == "DE"
        finally:
            _teardown(env["suffix"], env["pids"])

    # ── R5 历史趋势：行按国家过滤 ──────────────────────────────────
    def test_r5_history_filtered_by_country(self, client, make_api_key):
        env = _seed(with_current_period=True, country_map={"B": "DE"})
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            # 无过滤：cur×A + cur×B + past×A = 3 行。
            all_rows = client.get("/api/v1/agent/account-health/history", headers=headers)
            assert all_rows.status_code == 200, all_rows.text
            assert all_rows.json()["data"]["total"] == 3

            # country=DE → 只有 cur×B。
            de = client.get(
                "/api/v1/agent/account-health/history?country=DE", headers=headers
            )
            assert de.status_code == 200, de.text
            data_de = de.json()["data"]
            assert data_de["total"] == 1
            assert data_de["items"][0]["project_id"] == env["pids"]["B"]
            assert data_de["items"][0]["country"] == "DE"

            # country=US → cur×A + past×A = 2 行。
            us = client.get(
                "/api/v1/agent/account-health/history?country=US", headers=headers
            )
            assert us.status_code == 200, us.text
            data_us = us.json()["data"]
            assert data_us["total"] == 2
            assert {i["project_id"] for i in data_us["items"]} == {env["pids"]["A"]}

            # 多站点 US,DE → 3 行。
            both = client.get(
                "/api/v1/agent/account-health/history?country=US,DE", headers=headers
            )
            assert both.status_code == 200, both.text
            assert both.json()["data"]["total"] == 3
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_r5_invalid_country_400(self, client, make_api_key):
        env = _seed(with_current_period=True)
        try:
            headers = self._headers(make_api_key, env["agent_id"])
            resp = client.get(
                "/api/v1/agent/account-health/history?country=XX", headers=headers
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])
