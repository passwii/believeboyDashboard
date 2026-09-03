"""Agent 平台巡检写侧域路由测试（BLF-944；spec §10 测试清单）。

覆盖（对齐 spec §10 清单 8 类）：
1. R0 模板：health 1 / service 3 / shipping 4 / compliance 10，阈值/枚举齐全；
   模板常量提取后内部 ``GET /inspections/template`` 回归一致。
2. W1 保存：周期不存在 404；项目不在凭据范围 403 AGENT_PROJECT_OUT_OF_SCOPE；
   upsert 幂等（重复 PUT 更新同一条不新建）；**显式字段合并**（只传 health_data
   不重置 compliance_data / status_summary）；非法 account_health_rating 枚举 400
   VALIDATION_FAILED。
3. W2 提交：无草稿 404；confirm 两步（预览 → 带 X-Confirm-Token 重放）；
   重放请求体不一致 → 400 CONFIRM_TOKEN_INVALID；提交后 status=submitted +
   submitted_by=agent_id + submitted_at 非空；响应带 warnings（阈值命中时）。
4. W3 截图上传：文件类型 / 大小超限 400；该 (period, project) 无草稿 404；
   项目不在 scope 403；上传后 R2 对象 + 缩略图 + DB 行；响应**不含 presigned
   URL / r2_key**；sort_order 递增。
5. W4 截图删除：confirm 两步；删除后 R2 原图 + 缩略图 + DB 行均删除；不存在 404。
6. 壳与错误码：未鉴权 401 壳；限流 429；业务错误统一壳。
7. 路由注册：platform-inspection 在兜底路由之前注册（不被吞成 404）；
   KNOWN_BUSINESS_DOMAINS 含 platform_inspection。
8. 回归：内部 /api/v1/inspections/* 9 端点行为不变；account-health 5 条读路由
   不受影响。
"""

from __future__ import annotations

import io
import uuid
from contextlib import ExitStack
from datetime import date, datetime, timedelta, timezone
from unittest.mock import PropertyMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import delete, func, select

from app.api.agent.confirm import InMemoryConfirmStore, get_confirm_store, set_confirm_store
from app.api.agent.scope import KNOWN_BUSINESS_DOMAINS
from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.inspection import (
    InspectionPeriod,
    InspectionReport,
    InspectionScreenshot,
)
from app.services.audit_log_service import query_operation_audit_log

_TZ_CN = timezone(timedelta(hours=8))

#: 有效的 100x100 红色 PNG（upload_screenshot 走 PIL 压缩，必须是真实图片）。
_RED_PNG = io.BytesIO()
Image.new("RGB", (100, 100), color="red").save(_RED_PNG, format="PNG")
RED_PNG = _RED_PNG.getvalue()


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


@pytest.fixture
def confirm_memory_store():
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


def _seed(
    *,
    projects: tuple[str, ...] = ("A", "B"),
    country_map: dict[str, str] | None = None,
):
    """建项目 + 周期；返回 id 字典。inspection 表在 teardown 清理。

    ``country_map={name: "DE"}`` 覆盖 Project.country（默认 US）。
    """
    suffix = uuid.uuid4().hex[:8]
    agent_id = f"pi-agent-{suffix}"

    db = SessionLocal()
    try:
        db.execute(delete(InspectionScreenshot))
        db.execute(delete(InspectionReport))
        db.execute(delete(InspectionPeriod))

        pids: dict[str, int] = {}
        for name in projects:
            kw = {**({"country": country_map[name]} if country_map and name in country_map else {})}
            p = Project(
                project_name=f"agent-pi-{name}-{suffix}",
                project_operator=None,
                assistant_operator=None,
                sort_order=len(pids),
                is_active=True,
                **kw,
            )
            db.add(p)
            db.flush()
            pids[name] = p.id

        today = _cn_today()
        cur_monday = _week_start(today)
        future_deadline = datetime.now(_TZ_CN) + timedelta(days=1)
        cur = InspectionPeriod(
            week_start=cur_monday,
            week_end=cur_monday + timedelta(days=6),
            deadline=future_deadline,
        )
        db.add(cur)
        db.flush()
        db.commit()
        period_id = cur.id
    finally:
        db.close()

    return {
        "agent_id": agent_id,
        "suffix": suffix,
        "pids": pids,
        "period_id": period_id,
    }


def _teardown(suffix: str, pids: dict[str, int]) -> None:
    db = SessionLocal()
    try:
        db.execute(delete(InspectionScreenshot))
        db.execute(delete(InspectionReport))
        db.execute(delete(InspectionPeriod))
        for pid in pids.values():
            obj = db.get(Project, pid)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()


def _count_reports() -> int:
    db = SessionLocal()
    try:
        return db.execute(select(func.count()).select_from(InspectionReport)).scalar_one()
    finally:
        db.close()


def _make_headers(make_api_key, agent_id: str, *, business_scope="platform_inspection", project_scope="*", **kw) -> dict:
    key = make_api_key(
        agent_id=agent_id, business_scope=business_scope, project_scope=project_scope, **kw
    )
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }


def _w1_body(**overrides) -> dict:
    body = {
        "health_data": {
            "account_health_rating": "Good",
            "negative_feedback": 2,
            "late_shipment_rate": 1.5,
        },
        "compliance_data": {"ip_infringement": 1},
        "status_summary": "本周账户状况良好，无异常",
    }
    body.update(overrides)
    return body


def _patch_r2():
    """mock R2 上传/删除；返回 ExitStack。

    ``inspection_service`` 在模块顶层 ``from app.services.r2_service import
    (upload_bytes_to_r2, delete_file_from_r2)`` 把函数绑进自己命名空间——必须
    patch ``app.services.inspection_service.*`` 才能拦截（对齐 test_sku_info W4
    的写法，只是后者函数内局部 import，路径不同）。
    """
    from app.core.config import get_settings

    settings = get_settings()

    def _upload(settings, data, filename, project_slug, file_type, content_type="image/jpeg"):
        return {
            "key": f"{project_slug}/{file_type}/{filename}",
            "url": "https://cdn.example.com/inspection.png",
            "bucket": "test-bucket",
            "size": len(data),
        }

    stack = ExitStack()
    stack.enter_context(
        patch("app.services.inspection_service.upload_bytes_to_r2", side_effect=_upload)
    )
    stack.enter_context(
        patch("app.services.inspection_service.delete_file_from_r2", return_value=True)
    )
    # get_report 对已有截图会调 generate_presigned_url（R2 客户端）；测试环境
    # 无 R2 端点 → 必须 mock，否则 boto3 因空 endpoint_url 抛 ValueError。
    stack.enter_context(
        patch(
            "app.services.inspection_service.generate_presigned_url",
            return_value="https://cdn.example.com/shot.png",
        )
    )
    stack.enter_context(
        patch.object(
            type(settings), "r2_enabled", new_callable=PropertyMock, return_value=True
        )
    )
    return stack


def _w2_url(env, project_id):
    return (
        f"/api/v1/agent/platform-inspection/periods/{env['period_id']}"
        f"/projects/{project_id}"
    )


def _w3_url(env, project_id):
    return _w2_url(env, project_id) + "/screenshots"


def _w4_url(screenshot_id):
    return f"/api/v1/agent/platform-inspection/screenshots/{screenshot_id}"


# ============================================================
# 1. R0 模板 + 常量提取回归
# ============================================================


class TestR0Template:
    def test_template_shape(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            resp = client.get("/api/v1/agent/platform-inspection/template", headers=headers)
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert len(data["health_fields"]) == 1
            assert data["health_fields"][0]["key"] == "account_health_rating"
            assert data["health_fields"][0]["type"] == "select"
            assert data["health_fields"][0]["options"] == ["Healthy", "Good", "At Risk", "Critical"]
            assert len(data["service_performance_fields"]) == 3
            assert len(data["shipping_performance_fields"]) == 4
            assert len(data["compliance_fields"]) == 10
            # 阈值/枚举齐全
            assert data["shipping_performance_fields"][0]["threshold_warning"] == 2.0
            assert data["shipping_performance_fields"][0]["threshold_critical"] == 4.0
            assert data["compliance_fields"][0]["threshold_warning"] == 1
            assert data["compliance_fields"][0]["threshold_critical"] == 3
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_template_matches_internal_regression(self, client, make_api_key, admin_headers):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            agent_resp = client.get("/api/v1/agent/platform-inspection/template", headers=headers)
            internal_resp = client.get("/api/v1/inspections/template", headers=admin_headers)
            assert agent_resp.status_code == 200
            assert internal_resp.status_code == 200
            agent = agent_resp.json()["data"]
            internal = internal_resp.json()
            assert agent == internal
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 鉴权 / scope 门禁（spec §10 #6/#7）
# ============================================================


class TestAuthShell:
    def test_no_credentials_401_shell(self, client):
        resp = client.get("/api/v1/agent/platform-inspection/template")
        assert resp.status_code == 401, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_AUTH_FAILED"

    def test_domain_out_of_scope_403(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"], business_scope="shipments")
            resp = client.get("/api/v1/agent/platform-inspection/template", headers=headers)
            assert resp.status_code == 403, resp.text
            assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_known_business_domains_contains_domain(self):
        assert "platform_inspection" in KNOWN_BUSINESS_DOMAINS


class TestRateLimitWrite:
    def test_breach_returns_429_shell(self, client, settings, make_api_key):
        env = _seed()
        try:
            original = settings.agent_api_write_rate_limit
            settings.agent_api_write_rate_limit = "5/minute"
            headers = _make_headers(make_api_key, env["agent_id"])
            body = {"health_data": {"account_health_rating": "Good"}}
            statuses = [
                client.put(_w2_url(env, env["pids"]["A"]), json=body, headers=headers).status_code
                for _ in range(8)
            ]
            assert statuses.count(200) == 5
            assert statuses.count(429) == 3
            blocked = client.put(_w2_url(env, env["pids"]["A"]), json=body, headers=headers)
            assert blocked.status_code == 429
            assert blocked.json()["error"]["code"] == "AGENT_RATE_LIMIT_EXCEEDED"
        finally:
            settings.agent_api_write_rate_limit = original
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 2. W1 保存 / 更新草稿（spec §10 #2）
# ============================================================


class TestW1Save:
    def test_upsert_create_then_idempotent_update(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            url = _w2_url(env, env["pids"]["A"])

            r1 = client.put(url, json=_w1_body(), headers=headers)
            assert r1.status_code == 200, r1.text
            d1 = r1.json()["data"]
            assert d1["status"] == "draft"
            assert d1["health_data"]["account_health_rating"] == "Good"
            assert d1["health_data"]["negative_feedback"] == 2
            assert d1["compliance_data"]["ip_infringement"] == 1
            assert d1["status_summary"] == "本周账户状况良好，无异常"
            assert d1["screenshot_count"] == 0
            # 无 presigned URL / screenshots 列表
            assert "screenshots" not in d1
            assert "r2_key" not in d1

            # 幂等：重复 PUT 更新同一条不新建
            assert _count_reports() == 1
            r2 = client.put(url, json=_w1_body(health_data={"account_health_rating": "At Risk"}), headers=headers)
            assert r2.status_code == 200, r2.text
            d2 = r2.json()["data"]
            assert d2["report_id"] == d1["report_id"]
            assert _count_reports() == 1
            assert d2["health_data"]["account_health_rating"] == "At Risk"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_explicit_field_merge_keeps_unspecified(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            url = _w2_url(env, env["pids"]["A"])

            client.put(url, json=_w1_body(), headers=headers)
            # 只传 health_data 的一部分 → compliance_data / status_summary 保持
            r = client.put(
                url,
                json={"health_data": {"negative_feedback": 5}},
                headers=headers,
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["health_data"]["negative_feedback"] == 5
            assert d["health_data"]["account_health_rating"] == "Good"  # 保持
            assert d["compliance_data"]["ip_infringement"] == 1  # 保持
            assert d["status_summary"] == "本周账户状况良好，无异常"  # 保持
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_missing_block_keeps_current(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            url = _w2_url(env, env["pids"]["A"])
            client.put(url, json=_w1_body(), headers=headers)
            # 只传 status_summary，health/compliance 整块缺失 → 保持现状
            r = client.put(url, json={"status_summary": "仅改摘要"}, headers=headers)
            d = r.json()["data"]
            assert d["status_summary"] == "仅改摘要"
            assert d["health_data"]["account_health_rating"] == "Good"
            assert d["compliance_data"]["ip_infringement"] == 1
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_invalid_rating_enum_400(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            resp = client.put(
                _w2_url(env, env["pids"]["A"]),
                json={"health_data": {"account_health_rating": "Superb"}},
                headers=headers,
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_period_not_found_404(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            resp = client.put(
                f"/api/v1/agent/platform-inspection/periods/999999/projects/{env['pids']['A']}",
                json=_w1_body(),
                headers=headers,
            )
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_project_out_of_scope_403(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], project_scope=str(env["pids"]["A"])
            )
            resp = client.put(
                _w2_url(env, env["pids"]["B"]),
                json=_w1_body(),
                headers=headers,
            )
            assert resp.status_code == 403, resp.text
            assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_audit_written_with_agent_attribution(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            headers["Idempotency-Key"] = idem
            r = client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            assert r.status_code == 200
            db = SessionLocal()
            try:
                report = db.execute(
                    select(InspectionReport).where(
                        InspectionReport.project_id == env["pids"]["A"]
                    )
                ).scalar_one()
                audit = query_operation_audit_log(
                    db, target_type="inspection_report", target_id=str(report.id)
                )
            finally:
                db.close()
            assert len(audit) == 1
            row = audit[0]
            assert row.action == "platform_inspection.save"
            assert row.agent_id == env["agent_id"]
            assert row.operator is None
            assert row.idempotency_key == idem
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 3. W2 提交（confirm 两步；spec §10 #3）
# ============================================================


class TestW2Submit:
    def test_confirm_two_step_and_submitted_state(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            # 先建草稿
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            url = _w2_url(env, env["pids"]["A"]) + "/submit"
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem

            # 第一步：预览
            preview = client.post(url, json={}, headers=h)
            assert preview.status_code == 200, preview.text
            pbody = preview.json()
            assert pbody["ok"] is False
            assert pbody["requires_confirmation"] is True
            assert pbody["confirm_token"].startswith("cf_")
            assert pbody["preview"]["action"] == "platform_inspection.submit"
            assert pbody["preview"]["project_id"] == env["pids"]["A"]
            assert pbody["preview"]["from_status"] == "draft"
            assert pbody["preview"]["to_status"] == "submitted"
            assert pbody["preview"]["compliance_total"] == 1
            assert pbody["preview"]["screenshot_count"] == 0

            # 第二步：重放
            h2 = dict(headers)
            h2["Idempotency-Key"] = idem
            h2["X-Confirm-Token"] = pbody["confirm_token"]
            replay = client.post(url, json={}, headers=h2)
            assert replay.status_code == 200, replay.text
            rbody = replay.json()
            assert rbody["ok"] is True
            data = rbody["data"]
            assert data["status"] == "submitted"
            assert data["submitted_by"] == env["agent_id"]
            assert data["submitted_at"] is not None
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_replay_body_mismatch_invalid(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            url = _w2_url(env, env["pids"]["A"]) + "/submit"
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem
            preview = client.post(url, json={}, headers=h)
            token = preview.json()["confirm_token"]

            # 重放时带 body（与 preview 的 {} 不一致）→ INVALID
            h2 = dict(headers)
            h2["Idempotency-Key"] = idem
            h2["X-Confirm-Token"] = token
            replay = client.post(url, json={"dirty": 1}, headers=h2)
            assert replay.status_code == 400, replay.text
            assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_no_draft_404(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            url = _w2_url(env, env["pids"]["A"]) + "/submit"
            resp = client.post(url, json={}, headers=headers)
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_warnings_returned_on_threshold_hit(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            # negative_feedback=5 ≥ crit 3 → 触发告警
            client.put(
                _w2_url(env, env["pids"]["A"]),
                json={"health_data": {"negative_feedback": 5}},
                headers=headers,
            )
            url = _w2_url(env, env["pids"]["A"]) + "/submit"
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem
            preview = client.post(url, json={}, headers=h)
            token = preview.json()["confirm_token"]
            h2 = dict(headers)
            h2["Idempotency-Key"] = idem
            h2["X-Confirm-Token"] = token
            replay = client.post(url, json={}, headers=h2)
            assert replay.status_code == 200, replay.text
            warnings = replay.json()["data"]["warnings"]
            assert any(
                "inspection_negative_feedback" in w.get("metric", "")
                for w in warnings
            ), f"no negative_feedback warning in {warnings}"
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 4. W3 截图上传（multipart；不 confirm；spec §10 #4）
# ============================================================


class TestW3Upload:

    def test_upload_no_confirm_and_no_presigned_url(self, client, make_api_key):
        env = _seed()
        stack = _patch_r2()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem
            with stack:
                resp = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("shot.png", RED_PNG, "image/png")},
                    headers=h,
                )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["ok"] is True
            data = body["data"]
            assert data["screenshot_id"] is not None
            assert data["filename"] == "shot.png"
            assert data["content_type"] == "image/jpeg"  # 压缩转 JPEG
            # D6：不含 presigned URL / r2_key
            assert "url" not in data
            assert "r2_key" not in data
            assert "thumbnail_url" not in data
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_upload_requires_draft_first_404(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            resp = client.post(
                _w3_url(env, env["pids"]["A"]),
                files={"file": ("shot.png", RED_PNG, "image/png")},
                headers=headers,
            )
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_upload_invalid_type_400(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            resp = client.post(
                _w3_url(env, env["pids"]["A"]),
                files={"file": ("x.txt", b"hello", "text/plain")},
                headers=headers,
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_upload_sort_order_increments(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            with _patch_r2():
                r1 = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("a.png", RED_PNG, "image/png")},
                    headers=headers,
                )
            with _patch_r2():
                r2 = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("b.png", RED_PNG, "image/png")},
                    headers=headers,
                )
            assert r1.status_code == 200, r1.text
            assert r2.status_code == 200, r2.text
            assert r1.json()["data"]["sort_order"] == 0
            assert r2.json()["data"]["sort_order"] == 1
            # DB 行存在
            db = SessionLocal()
            try:
                rows = db.execute(
                    select(InspectionScreenshot).join(InspectionReport)
                ).scalars().all()
            finally:
                db.close()
            assert len(rows) == 2
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_project_out_of_scope_403(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], project_scope=str(env["pids"]["A"])
            )
            resp = client.post(
                _w3_url(env, env["pids"]["B"]),
                files={"file": ("shot.png", RED_PNG, "image/png")},
                headers=headers,
            )
            assert resp.status_code == 403, resp.text
            assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 5. W4 截图删除（confirm 两步；spec §10 #5）
# ============================================================


class TestW4Delete:

    def test_delete_two_step_and_db_row_removed(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        stack1 = _patch_r2()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            with stack1:
                up = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("shot.png", RED_PNG, "image/png")},
                    headers=headers,
                )
            sid = up.json()["data"]["screenshot_id"]
            url = _w4_url(sid)
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem

            preview = client.delete(url, headers=h)
            assert preview.status_code == 200, preview.text
            pbody = preview.json()
            assert pbody["ok"] is False
            assert pbody["requires_confirmation"] is True
            assert pbody["preview"]["action"] == "platform_inspection.delete_screenshot"
            assert pbody["preview"]["screenshot_id"] == sid
            assert pbody["preview"]["project_id"] == env["pids"]["A"]
            assert "delete_scope" in pbody["preview"]

            h2 = dict(headers)
            h2["Idempotency-Key"] = idem
            h2["X-Confirm-Token"] = pbody["confirm_token"]
            stack2 = _patch_r2()
            with stack2:
                replay = client.delete(url, headers=h2)
            assert replay.status_code == 200, replay.text
            rbody = replay.json()
            assert rbody["ok"] is True
            assert rbody["data"]["deleted"] is True
            assert rbody["data"]["screenshot_id"] == sid

            # DB 行已删除
            db = SessionLocal()
            try:
                row = db.get(InspectionScreenshot, sid)
            finally:
                db.close()
            assert row is None
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_delete_not_found_404(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            resp = client.delete(_w4_url(999999), headers=headers)
            assert resp.status_code == 404, resp.text
            assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_delete_project_out_of_scope_403(self, client, make_api_key, confirm_memory_store):
        env = _seed()
        stack = _patch_r2()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            with stack:
                up = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("shot.png", RED_PNG, "image/png")},
                    headers=headers,
                )
            sid = up.json()["data"]["screenshot_id"]
            # 该凭据只放行 B，截图归属 A → 403
            headers_b = _make_headers(
                make_api_key, env["agent_id"] + "-b", project_scope=str(env["pids"]["B"])
            )
            resp = client.delete(_w4_url(sid), headers=headers_b)
            assert resp.status_code == 403, resp.text
            assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 6. country 维度（BLF-958）：写侧防错校验 + 响应回传
# ============================================================


class TestCountryDimension:
    """巡检无国家列（数据按 (period, project)）；站点国家 = Project.country。

    W1/W2 body 可选 ``country``：提供时与目标项目国家一致才放行（不一致 →
    400 ``VALIDATION_FAILED``，防错填站点）；缺省不校验（向后兼容）。
    W1/W2/W3/W4 响应与确认预览回传 ``country``（归一化码）。
    R0 ``?country=`` 仅做归一化校验（模板为全局共享常量）。
    """

    def test_r0_valid_and_invalid_country_param(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            ok = client.get(
                "/api/v1/agent/platform-inspection/template?country=DE",
                headers=headers,
            )
            assert ok.status_code == 200, ok.text
            # 模板内容与内部一致（回归锁定：全局共享常量）
            bad = client.get(
                "/api/v1/agent/platform-inspection/template?country=XX",
                headers=headers,
            )
            assert bad.status_code == 400, bad.text
            assert bad.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w1_response_echoes_project_country_default(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            r = client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            assert r.status_code == 200, r.text
            # 未传 country → 默认项目国家 US 回传
            assert r.json()["data"]["country"] == "US"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w1_country_match_accepts_normalized(self, client, make_api_key):
        env = _seed(country_map={"A": "DE"})
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            # 小写别名归一化后与项目国家一致 → 200
            r = client.put(
                _w2_url(env, env["pids"]["A"]),
                json=_w1_body(country="de"),
                headers=headers,
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["country"] == "DE"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w1_country_mismatch_400(self, client, make_api_key):
        env = _seed(country_map={"A": "DE"})
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            r = client.put(
                _w2_url(env, env["pids"]["A"]),
                json=_w1_body(country="US"),
                headers=headers,
            )
            assert r.status_code == 400, r.text
            body = r.json()
            assert body["error"]["code"] == "VALIDATION_FAILED"
            assert "DE" in body["error"]["human_message"]
            # 校验失败不落库
            assert _count_reports() == 0
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w1_invalid_country_400(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            r = client.put(
                _w2_url(env, env["pids"]["A"]),
                json=_w1_body(country="XX"),
                headers=headers,
            )
            assert r.status_code == 400, r.text
            assert r.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w1_project_not_found_404(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            r = client.put(
                f"/api/v1/agent/platform-inspection/periods/{env['period_id']}/projects/999999",
                json=_w1_body(),
                headers=headers,
            )
            assert r.status_code == 404, r.text
            assert r.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w2_preview_echoes_country_and_mismatch_400(self, client, make_api_key, confirm_memory_store):
        env = _seed(country_map={"A": "DE"})
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            url = _w2_url(env, env["pids"]["A"]) + "/submit"

            # 预览带 country（项目国家 DE）
            preview = client.post(url, json={"country": "DE"}, headers=headers)
            assert preview.status_code == 200, preview.text
            assert preview.json()["preview"]["country"] == "DE"

            # 声明 country=US 与项目 DE 不匹配 → confirm 前 400，不签 token
            bad = client.post(url, json={"country": "US"}, headers=headers)
            assert bad.status_code == 400, bad.text
            assert bad.json()["error"]["code"] == "VALIDATION_FAILED"
            assert "confirm_token" not in bad.json()
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w2_submit_response_echoes_country(self, client, make_api_key, confirm_memory_store):
        env = _seed(country_map={"A": "DE"})
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            url = _w2_url(env, env["pids"]["A"]) + "/submit"
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem
            preview = client.post(url, json={"country": "DE"}, headers=h)
            token = preview.json()["confirm_token"]
            h2 = dict(headers)
            h2["Idempotency-Key"] = idem
            h2["X-Confirm-Token"] = token
            replay = client.post(url, json={"country": "DE"}, headers=h2)
            assert replay.status_code == 200, replay.text
            assert replay.json()["data"]["country"] == "DE"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w3_response_echoes_country(self, client, make_api_key):
        env = _seed(country_map={"A": "DE"})
        stack = _patch_r2()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            with stack:
                r = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("shot.png", RED_PNG, "image/png")},
                    headers=headers,
                )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["country"] == "DE"
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_w4_preview_and_response_echo_country(self, client, make_api_key, confirm_memory_store):
        env = _seed(country_map={"A": "DE"})
        stack1 = _patch_r2()
        try:
            headers = _make_headers(make_api_key, env["agent_id"])
            client.put(_w2_url(env, env["pids"]["A"]), json=_w1_body(), headers=headers)
            with stack1:
                up = client.post(
                    _w3_url(env, env["pids"]["A"]),
                    files={"file": ("shot.png", RED_PNG, "image/png")},
                    headers=headers,
                )
            sid = up.json()["data"]["screenshot_id"]
            url = _w4_url(sid)
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            h = dict(headers)
            h["Idempotency-Key"] = idem

            preview = client.delete(url, headers=h)
            assert preview.status_code == 200, preview.text
            assert preview.json()["preview"]["country"] == "DE"

            h2 = dict(headers)
            h2["Idempotency-Key"] = idem
            h2["X-Confirm-Token"] = preview.json()["confirm_token"]
            with _patch_r2():
                replay = client.delete(url, headers=h2)
            assert replay.status_code == 200, replay.text
            assert replay.json()["data"]["country"] == "DE"
        finally:
            _teardown(env["suffix"], env["pids"])


# ============================================================
# 7. 路由注册（spec §10 #7）：兜底路由之前
# ============================================================
# 7. 路由注册（spec §10 #7）：兜底路由之前
# ============================================================


class TestRouteRegistration:
    def test_platform_inspection_routes_registered_before_fallback(self):
        from app.api.v1.endpoints.agent import agent_router

        def _iter_routes(routes):
            for r in routes:
                yield r
                inner = getattr(r, "original_router", None)
                if inner is not None:
                    yield from _iter_routes(getattr(inner, "routes", []))

        paths = [r.path for r in _iter_routes(agent_router.routes) if hasattr(r, "path")]
        pi_paths = [
            "/platform-inspection/template",
            "/platform-inspection/periods/{period_id}/projects/{project_id}",
            "/platform-inspection/periods/{period_id}/projects/{project_id}/submit",
            "/platform-inspection/periods/{period_id}/projects/{project_id}/screenshots",
            "/platform-inspection/screenshots/{screenshot_id}",
        ]
        for p in pi_paths:
            assert p in paths, f"missing route {p}"
        # 兜底必须是最后一个
        assert paths[-1] == "/agent/{path:path}"


# ============================================================
# 8. 回归：内部 inspections 端点行为不变；account-health 读路由不受影响
# ============================================================


class TestRegression:
    def test_internal_inspections_template_unchanged(self, client, admin_headers):
        env = _seed()
        try:
            resp = client.get("/api/v1/inspections/template", headers=admin_headers)
            assert resp.status_code == 200, resp.text
            tpl = resp.json()
            assert tpl["health_fields"][0]["key"] == "account_health_rating"
            assert len(tpl["compliance_fields"]) == 10
            assert len(tpl["service_performance_fields"]) == 3
            assert len(tpl["shipping_performance_fields"]) == 4
        finally:
            _teardown(env["suffix"], env["pids"])

    def test_account_health_read_routes_untouched(self, client, make_api_key):
        env = _seed()
        try:
            headers = _make_headers(
                make_api_key, env["agent_id"], business_scope="account_health"
            )
            # account-health R1 周期列表仍 200
            resp = client.get("/api/v1/agent/account-health/periods", headers=headers)
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["total"] == 1
            # account-health R3 概览仍 200（读域不受本写域影响）
            resp3 = client.get(
                f"/api/v1/agent/account-health/periods/{env['period_id']}/overview",
                headers=headers,
            )
            assert resp3.status_code == 200, resp3.text
        finally:
            _teardown(env["suffix"], env["pids"])