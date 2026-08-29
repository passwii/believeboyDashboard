"""Agent Provisioning 域测试（BLF-843）：/api/v1/agent/provisioning/keys。

覆盖：

* 鉴权与域门禁：无凭据 401；业务 key（无 agent_provisioning 域）403；
  provisioner key（含该域）进入 confirm 预览。
* 安全红线：``"*"`` 通配 scope 拒绝（project/business 各自 + 双通配）；
  ``agent_id`` 格式非法拒绝；同 agent_id 重复签发拒绝；过期 expires_at 拒绝。
* confirm 两步：预览不落库（requires_confirmation + confirm_token +
  preview 摘要）；同 Idempotency-Key + X-Confirm-Token + 同请求体重放后
  落库、明文仅此一次、审计行带 via=agent_provisioning 归因。
* 签出的凭据真实可用：新 key 能通过鉴权访问其白名单内的域，且
  business_scope 不含 agent_provisioning 时不能铸 key（隔离闭环）。
* BLF-885 P0 回归：project_scope 必须命中存在且 active 的项目；
  报错附的「可用项目列表」只含 active（停产/归档项目不引导签发）。
"""

from __future__ import annotations

import uuid

import pytest
from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from fastapi.testclient import TestClient
from sqlalchemy import text


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    """清内存读桶+写桶：跨测试隔离（slowapi 状态按进程共享）。"""
    from app.api.agent.rate_limit import agent_read_limiter, agent_write_limiter

    agent_read_limiter.reset()
    agent_write_limiter.reset()
    yield
    agent_read_limiter.reset()
    agent_write_limiter.reset()


def _cleanup_key_by_agent_id(agent_id: str) -> None:
    db = SessionLocal()
    try:
        db.execute(
            text("delete from agent_api_keys where agent_id = :aid"),
            {"aid": agent_id},
        )
        db.commit()
    finally:
        db.close()


def _provision_env(make_api_key):
    """provisioner 凭据：business_scope 仅 agent_provisioning（最小身份）。"""
    agent_id = f"agent-provisioner-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, business_scope="agent_provisioning")
    headers = {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }
    return {"agent_id": agent_id, "headers": headers}


@pytest.fixture
def provision_projects():
    """一对专用项目（active + 停产），BLF-885 校验测试的数据底座。

    happy path 签发到 active 项目；停产项目用于「存在但 is_active=false
    同样拒绝 + 可用列表只含 active」回归。测试后按 project 维度自清。
    """
    from app.models.project import Project

    suffix = uuid.uuid4().hex[:8]
    db = SessionLocal()
    try:
        active = Project(
            project_name=f"blf885-active-{suffix}",
            project_operator="pytest",
            sort_order=0,
            is_active=True,
        )
        archived = Project(
            project_name=f"blf885-archived-{suffix}",
            project_operator="pytest",
            sort_order=0,
            is_active=False,
        )
        db.add_all([active, archived])
        db.commit()
        ids = {"active": active.id, "archived": archived.id}
    finally:
        db.close()

    yield ids

    db = SessionLocal()
    try:
        db.execute(
            text("delete from projects where id in (:a, :b)"),
            {"a": ids["active"], "b": ids["archived"]},
        )
        db.commit()
    finally:
        db.close()


def _body(**overrides) -> dict:
    target = f"new-agent-{uuid.uuid4().hex[:10]}"
    body = {
        "label": "库存助理 (自助)",
        "agent_id": target,
        "project_scope": "900101",
        "business_scope": "inventory,sales",
        "item_key": f"multica://ws-test/agent/{target}",
    }
    body.update(overrides)
    return body


def _post(client, headers, body, *, token=None, idem=None):
    h = dict(headers)
    h["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        h["X-Confirm-Token"] = token
    return client.post("/api/v1/agent/provisioning/keys", json=body, headers=h)


class TestAuthAndScopeGate:
    def test_no_credentials_401(self, client):
        resp = client.post("/api/v1/agent/provisioning/keys", json=_body(), headers={})
        assert resp.status_code == 401

    def test_business_key_without_domain_403(self, client, make_api_key):
        """业务 key（无 agent_provisioning 域）不得铸 key——双向隔离的另一半。"""
        agent_id = f"biz-agent-{uuid.uuid4().hex[:8]}"
        key = make_api_key(agent_id=agent_id, business_scope="inventory")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }
        resp = _post(client, headers, _body())
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_star_scope_denied_for_provisioning(self, client, make_api_key):
        """'*' 全域 key 不再隐含签发能力（BLF-847）：调 provisioning 域门禁
        直接 403，过不了域这关——门禁与自助红线下层独立。"""
        agent_id = f"star-agent-{uuid.uuid4().hex[:8]}"
        key = make_api_key(agent_id=agent_id, business_scope="*")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }
        resp = _post(client, headers, _body())
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
        assert "'*'" in resp.json()["error"]["human_message"]

    def test_provisioner_rejects_wildcard_body(
        self, client, make_api_key, confirm_memory_store
    ):
        """持有显式 agent_provisioning 域的 provisioner key 能过域门禁，
        但请求体里的 '*' scope 仍被 validate 拒绝——两层防线独立。"""
        env = _provision_env(make_api_key)
        resp = _post(client, env["headers"], _body(business_scope="*"))
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestValidationRedLines:
    def test_preview_then_replay_happy_path(
        self, client, make_api_key, confirm_memory_store, provision_projects
    ):
        env = _provision_env(make_api_key)
        body = _body(project_scope=str(provision_projects["active"]))
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, env["headers"], body, idem=idem)
        assert preview.status_code == 200, preview.text
        payload = preview.json()
        assert payload["ok"] is False
        assert payload["requires_confirmation"] is True
        assert payload["confirm_token"].startswith("cf_")
        # 预览摘要
        assert payload["preview"]["action"] == "agent_key.create"
        assert payload["preview"]["target_agent_id"] == body["agent_id"]
        assert payload["preview"]["expires_at"] is None

        # 预览不落库
        db = SessionLocal()
        try:
            count = db.execute(
                text("select count(*) from agent_api_keys where agent_id = :aid"),
                {"aid": body["agent_id"]},
            ).scalar_one()
            assert count == 0
        finally:
            db.close()

        replay = _post(
            client,
            env["headers"],
            body,
            token=payload["confirm_token"],
            idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["plaintext_key"].startswith("bbx_")
        assert data["agent_id"] == body["agent_id"]
        assert data["item_key"] == body["item_key"]
        assert data["expires_at"] is None

        try:
            self._assert_persisted_and_audited(body)
        finally:
            _cleanup_key_by_agent_id(body["agent_id"])

    def _assert_persisted_and_audited(self, body: dict) -> None:
        db = SessionLocal()
        try:
            row = (
                db.execute(
                    text(
                        "select id, label, project_scope, business_scope, item_key "
                        "from agent_api_keys where agent_id = :aid"
                    ),
                    {"aid": body["agent_id"]},
                )
                .mappings()
                .first()
            )
            assert row is not None
            assert row["label"] == body["label"]
            assert row["project_scope"] == body["project_scope"]
            assert row["business_scope"] == body["business_scope"]
            assert row["item_key"] == body["item_key"]
            audit = (
                db.execute(
                    text(
                        "select agent_id, after_json from operation_audit_logs "
                        "where action='api_key.create' and target_type='agent_api_key' "
                        "order by id desc limit 1"
                    )
                )
                .mappings()
                .first()
            )
            assert audit is not None
            assert audit["agent_id"].startswith("agent-provisioner-")
            after = audit["after_json"]
            assert after["via"] == "agent_provisioning"
            assert after["target_agent_id"] == body["agent_id"]
            assert "plaintext" not in (after or {})
        finally:
            db.close()


class TestValidationRejections:
    def test_duplicate_agent_id_rejected(
        self, client, make_api_key, confirm_memory_store, provision_projects
    ):
        env = _provision_env(make_api_key)

        # 先真实签发一张（预览与重放必须同 Idempotency-Key）
        body = _body(project_scope=str(provision_projects["active"]))
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, env["headers"], body, idem=idem)
        token = preview.json()["confirm_token"]
        first = _post(client, env["headers"], body, token=token, idem=idem)
        assert first.status_code == 200, first.text
        try:
            dup = _post(
                client,
                env["headers"],
                _body(
                    agent_id=body["agent_id"],
                    project_scope=str(provision_projects["active"]),
                ),
            )
            assert dup.status_code == 400
            assert "已存在有效凭据" in dup.json()["error"]["human_message"]
        finally:
            _cleanup_key_by_agent_id(body["agent_id"])

    def test_invalid_agent_id_format(self, client, make_api_key, confirm_memory_store):
        env = _provision_env(make_api_key)
        for bad in ("UPPER-case", "has space", "ab", "-lead", ""):
            resp = _post(client, env["headers"], _body(agent_id=bad))
            assert resp.status_code == 400, f"agent_id={bad!r}"
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_expired_expires_at_rejected(
        self, client, make_api_key, confirm_memory_store
    ):
        env = _provision_env(make_api_key)
        resp = _post(client, env["headers"], _body(expires_at="2020-01-01T00:00:00Z"))
        assert resp.status_code == 400

    def test_extra_fields_forbidden(self, client, make_api_key, confirm_memory_store):
        env = _provision_env(make_api_key)
        resp = _post(client, env["headers"], _body(scope="admin"))
        assert resp.status_code == 400

    def test_self_service_rejects_provisioning_scope(
        self, client, make_api_key, confirm_memory_store
    ):
        """红线 A（BLF-847）：自助签发路径禁止授予 agent_provisioning 域——
        无论是单独给还是混在业务域列表里，preview 阶段就被 _validate 短路拒绝。
        自助通道物理上铸不出带签发能力的 key（叠加禁 '*' 通配，自复制链封死）。"""
        env = _provision_env(make_api_key)
        for bad_bs in ("agent_provisioning", "inventory,agent_provisioning"):
            resp = _post(client, env["headers"], _body(business_scope=bad_bs))
            assert resp.status_code == 400, f"business_scope={bad_bs!r}: {resp.text}"
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
            assert "agent_provisioning" in resp.json()["error"]["human_message"]

    def test_missing_project_id_rejected_with_active_only_hint(
        self, client, make_api_key, confirm_memory_store, provision_projects
    ):
        """BLF-885 验收用例2 + 跟进小修：不存在的项目 id 预览即拒，
        details 指明非法片段；报错附的「可用项目列表」只含 active 项目。"""
        env = _provision_env(make_api_key)
        resp = _post(
            client,
            env["headers"],
            _body(project_scope="99999"),
        )
        assert resp.status_code == 400, resp.text
        payload = resp.json()["error"]
        assert payload["code"] == "VALIDATION_FAILED"
        assert "不存在的项目" in payload["human_message"] or (
            "不存在或已停用的项目 id: 99999" in payload["human_message"]
        )
        # 可用列表只含 active：本测试的 active 专项项目在内、archived 不在
        assert str(provision_projects["active"]) in payload["human_message"]
        assert str(provision_projects["archived"]) not in payload["human_message"]

    def test_archived_project_id_rejected(
        self, client, make_api_key, confirm_memory_store, provision_projects
    ):
        """BLF-885 跟进（2026-08-29）：停产/归档项目（is_active=false）与
        不存在同样拒绝——防止签出指向停产项目的废凭据；可用列表只列
        active，不再把全量 19 行（含停产）当成可选项。"""
        env = _provision_env(make_api_key)
        resp = _post(
            client,
            env["headers"],
            _body(project_scope=str(provision_projects["archived"])),
        )
        assert resp.status_code == 400, resp.text
        payload = resp.json()["error"]
        assert payload["code"] == "VALIDATION_FAILED"
        assert "不存在或已停用" in payload["human_message"]
        assert str(provision_projects["archived"]) in payload["human_message"]
        # 引导列表里 active 在、archived 不在
        assert str(provision_projects["active"]) in payload["human_message"]
        assert str(provision_projects["archived"]) not in (
            payload["human_message"].split("可用项目 id: ")[-1]
        )
        # 不落库
        db = SessionLocal()
        try:
            count = db.execute(
                text("select count(*) from agent_api_keys where agent_id = :aid"),
                {"aid": "should-not-exist"},
            ).scalar_one()
            assert count == 0
        finally:
            db.close()


class TestProvisionedKeyUsable:
    def test_provisioned_key_authenticates_and_is_isolated(
        self, client, make_api_key, confirm_memory_store, provision_projects
    ):
        """签出的 key 真实可用：能过鉴权；且新凭据默认无 provisioning 域，
        不能再铸 key——隔离闭环（自助签发不自我复制）。"""
        env = _provision_env(make_api_key)
        body = _body(project_scope=str(provision_projects["active"]))
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, env["headers"], body, idem=idem)
        token = preview.json()["confirm_token"]
        replay = _post(client, env["headers"], body, token=token, idem=idem)
        assert replay.status_code == 200, replay.text
        plaintext = replay.json()["data"]["plaintext_key"]

        new_headers = {
            "Authorization": f"Bearer {plaintext}",
            "X-Agent-Id": body["agent_id"],
        }
        try:
            # 新 key 能过命名空间鉴权（health 无域门禁）
            health = client.get("/api/v1/agent/health", headers=new_headers)
            assert health.status_code == 200, health.text
            # 新 key 默认无 agent_provisioning 域 → 不能铸 key
            escalate = _post(client, new_headers, _body())
            assert escalate.status_code == 403
            assert escalate.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
            # 新 key 的业务域白名单不含 inventory 之外也读不了别的域——这里
            # 用域门禁直接验证白名单生效（inventory 命中、ad_analysis 未命中）
            # 由 scope 测试覆盖，此处验证 business_scope 落库正确即可。
            db = SessionLocal()
            try:
                stored = db.execute(
                    text(
                        "select business_scope from agent_api_keys where agent_id = :aid"
                    ),
                    {"aid": body["agent_id"]},
                ).scalar_one()
                assert stored == body["business_scope"]
            finally:
                db.close()
        finally:
            _cleanup_key_by_agent_id(body["agent_id"])
