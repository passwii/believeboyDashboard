"""Agent SKU Info 主数据域测试（BLF-579 S2；spec §7）。

覆盖：
* W1 upsert：新建 inserted / 同键重放 updated（不产生新行）；confirm 预览
  is_new/previous；source_file 落 ``agent:<agent_id>``；非法 source →
  SKU_INFO_INVALID_SOURCE（先于 confirm 签发）。
* W1 校验：缺 sku/asin → VALIDATION_FAILED；负成本 → VALIDATION_FAILED；
  非法 country → VALIDATION_FAILED；项目不存在 → 404。
* W2 局部更新：只传 fob_unit_cost → asin/country/is_active 不被重置
  （§9 #2 默认值陷阱锁契约）；更新后唯一键冲突 → SKU_INFO_DUPLICATE（409）；
  改身份字段 → VALIDATION_FAILED。
* W3 上/下架：false → is_active=false 且审计 before/after 含变化；同值重放幂等
  （不重复审计）；下架后 R1 默认 is_active=true 不再返回。
* 缓存失效：W1/W2/W3 写后 invalidate_sku_financial_cache 被调用（mock）。
* R1/R2/R3：分页/筛选；is_active 默认 true；record 不存在或跨项目 → 404；
  R3 审计行含 agent_id/idempotency_key；读不落审计（行数不变）。
* scope 门禁：business_scope 不含 sku_info → 403；project 不在白名单 → 403。
* confirm 流：无 X-Confirm-Token → 200 预览壳；重放 body 不一致 →
  CONFIRM_TOKEN_INVALID；过期 → CONFIRM_TOKEN_EXPIRED。
* 路由注册：镜像已排除（_EXCLUDED_EXTERNAL_PATHS 含 sku-info）；native 路由
  兜底路由之前；镜像收口后 /agent/projects/{id}/sku-info 仍 200 且走原生 handler。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.api.agent.errors import AgentApiError, ErrorCode
from app.db.session import SessionLocal
from app.main import app
from app.models.sku_info import SkuRecord
from app.services.audit_log_service import query_operation_audit_log
from app.services.data.sku_info import update_sku_record_by_id

from conftest import shipment_env  # noqa: F401 — fixture reuse


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis，且可直接改 created_at 模拟过期。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    """clear 内存写桶：跨测试隔离（slowapi 状态按进程共享）。"""
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _headers(env, *, token=None, idem=None) -> dict:
    headers = dict(env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return headers


def _upsert_body(**overrides) -> dict:
    body = {
        "sku": "X-NEW-001",
        "asin": "ASIN-X-NEW-001",
        "country": "US",
        "source": "agent_listing_pull",
        "product_name": "New SKU",
        "fob_unit_cost": 15.5,
        "first_leg_cost_rmb": 3.2,
        "package_length_cm": 10,
        "package_width_cm": 8,
        "package_height_cm": 5,
        "weight_kg": 0.5,
        "carton_length_cm": 20,
        "carton_width_cm": 20,
        "carton_height_cm": 20,
        "carton_weight_kg": 5,
        "units_per_carton": 10,
    }
    body.update(overrides)
    return body


def _post_upsert(client, env, body, *, token=None, idem=None):
    return client.post(
        f"/api/v1/agent/projects/{env['project_id']}/sku-info",
        json=body,
        headers=_headers(env, token=token, idem=idem),
    )


def _patch_update(client, env, sku_record_id, body, *, token=None, idem=None):
    return client.patch(
        f"/api/v1/agent/projects/{env['project_id']}/sku-info/{sku_record_id}",
        json=body,
        headers=_headers(env, token=token, idem=idem),
    )


def _post_status(client, env, sku_record_id, body, *, token=None, idem=None):
    return client.post(
        f"/api/v1/agent/projects/{env['project_id']}/sku-info/{sku_record_id}/status",
        json=body,
        headers=_headers(env, token=token, idem=idem),
    )

def _delete_sku(
    client, env, sku_record_id, *, token=None, idem=None, project_id=None
):
    """DELETE /projects/{project_id}/sku-info/{sku_record_id}（confirm 两步）。"""
    pid = project_id if project_id is not None else env["project_id"]
    return client.delete(
        f"/api/v1/agent/projects/{pid}/sku-info/{sku_record_id}",
        headers=_headers(env, token=token, idem=idem),
    )


def _seed_sku(
    project_id: int,
    project_name: str,
    *,
    sku: str,
    asin: str | None = None,
    country: str = "US",
    fob_unit_cost: float = 10.0,
    is_active: bool = True,
    **overrides,
) -> int:
    """直接落一行 SkuRecord（commit），返回 id。"""
    db = SessionLocal()
    try:
        row = SkuRecord(
            project_id=project_id,
            project_name=project_name,
            sku=sku,
            asin=asin or f"ASIN-{sku}",
            country=country,
            fob_unit_cost=fob_unit_cost,
            first_leg_cost_rmb=1,
            package_length_cm=10,
            package_width_cm=10,
            package_height_cm=10,
            weight_kg=0.5,
            carton_length_cm=20,
            carton_width_cm=20,
            carton_height_cm=20,
            carton_weight_kg=5,
            units_per_carton=10,
            currency="USD",
            sort_order=0,
            is_active=is_active,
            **overrides,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return int(row.id)
    finally:
        db.close()


def _count_audit_rows(target_id: int) -> int:
    db = SessionLocal()
    try:
        return len(
            query_operation_audit_log(
                db, target_type="sku_info", target_id=str(target_id)
            )
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# W1 upsert
# ---------------------------------------------------------------------------


class TestW1Upsert:
    def test_preview_then_replay_inserts_and_audits(
        self, client, shipment_env, confirm_memory_store
    ):
        body = _upsert_body()
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post_upsert(client, shipment_env, body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["preview"]["action"] == "sku_info.upsert"
        assert pbody["preview"]["sku"] == "X-NEW-001"
        assert pbody["preview"]["is_new"] is True
        assert pbody["preview"]["previous"] is None

        replay = _post_upsert(
            client, shipment_env, body, token=pbody["confirm_token"], idem=idem
        )
        assert replay.status_code == 200, replay.text
        rbody = replay.json()
        assert rbody["ok"] is True
        assert rbody["data"]["sku"] == "X-NEW-001"
        assert rbody["data"]["fob_unit_cost"] == 15.5
        assert rbody["action"] == "inserted"
        assert rbody["idempotency_key"] == idem

        # source_file 服务端派生 agent:<agent_id>（D4）；不暴露 r2_key/source_file
        db = SessionLocal()
        try:
            row = db.scalars(
                select(SkuRecord).where(SkuRecord.id == rbody["data"]["id"])
            ).one()
            assert row.source_file == f"agent:{shipment_env['agent_id']}"
        finally:
            db.close()
        assert "source_file" not in rbody["data"]
        assert "fnsku_label_r2_key" not in rbody["data"]
        assert "fnsku_label_r2_url" in rbody["data"]

        # 审计行：target_type=sku_info / agent 归因
        rows = query_operation_audit_log(
            SessionLocal(),
            target_type="sku_info",
            target_id=str(rbody["data"]["id"]),
        )
        assert len(rows) == 1
        audit = rows[0]
        assert audit.action == "sku_info.upsert"
        assert audit.agent_id == shipment_env["agent_id"]
        assert audit.idempotency_key == idem
        assert audit.operator is None

    def test_same_key_replay_updates_not_duplicates(
        self, client, shipment_env, confirm_memory_store
    ):
        body1 = _upsert_body(fob_unit_cost=15.5)
        idem1 = f"idem-{uuid.uuid4().hex[:12]}"
        p1 = _post_upsert(client, shipment_env, body1, idem=idem1)
        r1 = _post_upsert(
            client, shipment_env, body1, token=p1.json()["confirm_token"], idem=idem1
        )
        assert r1.status_code == 200
        row_id = r1.json()["data"]["id"]

        # 同键（同 sku/asin/country）二次 upsert → updated，不产生新行
        body2 = _upsert_body(fob_unit_cost=25.0)
        idem2 = f"idem-{uuid.uuid4().hex[:12]}"
        p2 = _post_upsert(client, shipment_env, body2, idem=idem2)
        assert p2.json()["preview"]["is_new"] is False
        assert p2.json()["preview"]["previous"]["fob_unit_cost"] == 15.5
        r2 = _post_upsert(
            client, shipment_env, body2, token=p2.json()["confirm_token"], idem=idem2
        )
        assert r2.status_code == 200
        assert r2.json()["action"] == "updated"
        assert r2.json()["data"]["id"] == row_id
        assert r2.json()["data"]["fob_unit_cost"] == 25.0

        db = SessionLocal()
        try:
            rows = db.scalars(
                select(SkuRecord).where(
                    SkuRecord.project_id == shipment_env["project_id"],
                    SkuRecord.sku == "X-NEW-001",
                )
            ).all()
            assert len(rows) == 1, "同键 upsert 覆盖：不产生新行"
        finally:
            db.close()

    def test_invalid_source_rejected_before_confirm(
        self, client, shipment_env, confirm_memory_store
    ):
        body = _upsert_body()
        body["source"] = "manual"  # agent 通道禁 manual
        resp = _post_upsert(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "SKU_INFO_INVALID_SOURCE"
        assert sorted(err["details"]["allowed"]) == [
            "agent_listing_pull",
            "agent_user_supplied",
            "external_api",
        ]
        assert get_confirm_store()._rows == {}, "业务校验先于 confirm：未签发 token"

    def test_missing_source_rejected(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body()
        del body["source"]
        resp = _post_upsert(client, shipment_env, body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SKU_INFO_INVALID_SOURCE"

    def test_missing_sku_rejected(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body()
        del body["sku"]
        resp = _post_upsert(client, shipment_env, body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_missing_asin_rejected(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body()
        del body["asin"]
        resp = _post_upsert(client, shipment_env, body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_negative_cost_rejected(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body(fob_unit_cost=-1.0)
        resp = _post_upsert(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_invalid_country_rejected(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body(country="XX")
        resp = _post_upsert(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_project_not_found_404(self, client, shipment_env, confirm_memory_store):
        resp = client.post(
            "/api/v1/agent/projects/99999999/sku-info",
            json=_upsert_body(),
            headers=_headers(shipment_env),
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_cache_invalidated_after_upsert(
        self, client, shipment_env, confirm_memory_store, monkeypatch
    ):
        from app.api.v1.endpoints.agent import sku_info as sku_info_module

        calls: list[int] = []

        def _fake(project_id: int):
            calls.append(project_id)

        monkeypatch.setattr(sku_info_module, "invalidate_sku_financial_cache", _fake)
        body = _upsert_body()
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_upsert(client, shipment_env, body, idem=idem)
        r = _post_upsert(
            client, shipment_env, body, token=p.json()["confirm_token"], idem=idem
        )
        assert r.status_code == 200
        assert calls == [shipment_env["project_id"]]


# ---------------------------------------------------------------------------
# W2 局部更新（读-改-写合并）
# ---------------------------------------------------------------------------


class TestW2Update:
    def _run(self, client, env, sku_record_id, body, *, idem=None):
        idem = idem or f"idem-{uuid.uuid4().hex[:12]}"
        p = _patch_update(client, env, sku_record_id, body, idem=idem)
        assert p.status_code == 200, p.text
        r = _patch_update(
            client, env, sku_record_id, body, token=p.json()["confirm_token"], idem=idem
        )
        return r

    def test_partial_update_preserves_identity_fields(
        self, client, shipment_env, confirm_memory_store
    ):
        """锁契约（§9 #2 / §7 #3）：只传 fob_unit_cost 不得重置 asin/country/is_active。"""
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-LOCK",
            fob_unit_cost=10.0,
        )
        resp = self._run(
            client,
            shipment_env,
            sku_id,
            {"source": "agent_listing_pull", "fob_unit_cost": 99.0},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["fob_unit_cost"] == 99.0
        assert data["asin"] == "ASIN-X-LOCK", "asin 不被重置为空串"
        assert data["country"] == "US", "country 不被重置为默认"
        assert data["is_active"] is True, "is_active 不被重置为默认（原本就是 true）"

    def test_partial_update_does_not_reset_is_active_false(
        self, client, shipment_env, confirm_memory_store
    ):
        """下架中的 SKU 只改成本，不得被 SkuRecordUpdate 默认 is_active=True 重新上架。"""
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-OFF",
            fob_unit_cost=10.0,
            is_active=False,
        )
        resp = self._run(
            client,
            shipment_env,
            sku_id,
            {"source": "agent_listing_pull", "fob_unit_cost": 55.0},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["fob_unit_cost"] == 55.0
        assert data["is_active"] is False, "未提供 is_active 不得误上架（§9 #2 陷阱）"

    def test_update_audit_before_after(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-AUDIT",
            fob_unit_cost=10.0,
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        resp = self._run(
            client,
            shipment_env,
            sku_id,
            {"source": "external_api", "fob_unit_cost": 77.0},
            idem=idem,
        )
        assert resp.status_code == 200
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="sku_info", target_id=str(sku_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "sku_info.update"
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
            assert audit.before_json["fob_unit_cost"] == 10.0
            assert audit.after_json["fob_unit_cost"] == 77.0
            assert audit.operator is None
        finally:
            db.close()

    def test_identity_field_change_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-ID",
        )
        # extra=forbid：传身份字段 → VALIDATION_FAILED（W2 禁改身份）
        resp = _patch_update(
            client,
            shipment_env,
            sku_id,
            {"source": "agent_listing_pull", "sku": "X-ID-CHANGED"},
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        assert get_confirm_store()._rows == {}

    def test_duplicate_maps_to_sku_info_duplicate(
        self, client, shipment_env, confirm_memory_store
    ):
        """service 409 → SKU_INFO_DUPLICATE 翻译契约（spec §4 W2 / §7 #3）。"""
        # 两条不同 key 的 SKU；直接把 A 的身份改成 B 的身份会触发服务层 409
        a_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-DUP-A",
        )
        _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-DUP-B",
        )
        db = SessionLocal()
        try:
            from app.api.v1.endpoints.agent.sku_info import _service_errors
            from app.schemas.sku_info import SkuRecordUpdate

            payload = SkuRecordUpdate(sku="X-DUP-B", asin="ASIN-X-DUP-B", country="US")
            with pytest.raises(AgentApiError) as exc_info:
                with _service_errors():
                    update_sku_record_by_id(db, a_id, payload)
            assert exc_info.value.code == ErrorCode.SKU_INFO_DUPLICATE
        finally:
            db.rollback()
            db.close()

    def test_cache_invalidated_after_update(
        self, client, shipment_env, confirm_memory_store, monkeypatch
    ):
        from app.api.v1.endpoints.agent import sku_info as sku_info_module

        calls: list[int] = []
        monkeypatch.setattr(
            sku_info_module,
            "invalidate_sku_financial_cache",
            lambda project_id: calls.append(project_id),
        )
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-CACHE",
        )
        resp = self._run(
            client,
            shipment_env,
            sku_id,
            {"source": "agent_listing_pull", "fob_unit_cost": 66.0},
        )
        assert resp.status_code == 200
        assert calls == [shipment_env["project_id"]]


# ---------------------------------------------------------------------------
# W3 上/下架
# ---------------------------------------------------------------------------


class TestW3Status:
    def test_deactivate_and_audit(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-STATUS",
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            idem=idem,
        )
        assert p.status_code == 200, p.text
        pb = p.json()
        assert pb["preview"]["action"] == "sku_info.status.transition"
        assert pb["preview"]["from_active"] is True
        assert pb["preview"]["to_active"] is False
        assert "退出补货" in pb["preview"]["note"]

        r = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            token=pb["confirm_token"],
            idem=idem,
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_active"] is False

        # 审计 before/after 含 is_active 变化
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="sku_info", target_id=str(sku_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "sku_info.status.transition"
            assert audit.before_json["is_active"] is True
            assert audit.after_json["is_active"] is False
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
        finally:
            db.close()

    def test_same_value_replay_idempotent(
        self, client, shipment_env, confirm_memory_store
    ):
        """同值重放幂等：目标值与当前一致 → 返回当前态，不重复审计。"""
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-IDEM",
            is_active=False,
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            idem=idem,
        )
        assert p.status_code == 200, p.text
        r = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            token=p.json()["confirm_token"],
            idem=idem,
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["is_active"] is False
        assert _count_audit_rows(sku_id) == 0, "同值切换幂等：不落审计"

    def test_deactivated_excluded_from_default_list(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-DROP",
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            idem=idem,
        )
        r = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            token=p.json()["confirm_token"],
            idem=idem,
        )
        assert r.status_code == 200

        # R1 默认 is_active=true 不再返回；显式 =false 可查
        resp_default = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info?sku=X-DROP",
            headers=shipment_env["headers"],
        )
        assert resp_default.status_code == 200, resp_default.text
        assert resp_default.json()["data"]["items"] == []

        resp_inactive = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info?sku=X-DROP&is_active=false",
            headers=shipment_env["headers"],
        )
        assert resp_inactive.status_code == 200
        items = resp_inactive.json()["data"]["items"]
        assert len(items) == 1
        assert items[0]["is_active"] is False

    def test_reactivate(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-REON",
            is_active=False,
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": True, "source": "external_api"},
            idem=idem,
        )
        r = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": True, "source": "external_api"},
            token=p.json()["confirm_token"],
            idem=idem,
        )
        assert r.status_code == 200
        assert r.json()["data"]["is_active"] is True

    def test_cache_invalidated_after_status(
        self, client, shipment_env, confirm_memory_store, monkeypatch
    ):
        from app.api.v1.endpoints.agent import sku_info as sku_info_module

        calls: list[int] = []
        monkeypatch.setattr(
            sku_info_module,
            "invalidate_sku_financial_cache",
            lambda project_id: calls.append(project_id),
        )
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-CSTATUS",
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            idem=idem,
        )
        r = _post_status(
            client,
            shipment_env,
            sku_id,
            {"is_active": False, "source": "agent_listing_pull"},
            token=p.json()["confirm_token"],
            idem=idem,
        )
        assert r.status_code == 200
        assert calls == [shipment_env["project_id"]]

    def test_missing_record_404(self, client, shipment_env, confirm_memory_store):
        resp = _post_status(
            client,
            shipment_env,
            999999,
            {"is_active": False, "source": "agent_listing_pull"},
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


# ---------------------------------------------------------------------------
# 读路由
# ---------------------------------------------------------------------------


class TestRead:
    def test_list_defaults_is_active_true(self, client, shipment_env):
        """R1 is_active 默认 true：只返回上架 SKU。"""
        _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-ON",
            is_active=True,
        )
        _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-OFF-LIST",
            is_active=False,
        )
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        skus = {item["sku"] for item in body["data"]["items"]}
        assert "X-ON" in skus
        assert "X-OFF-LIST" not in skus, "默认 is_active=true 排除下架"

    def test_list_filters_and_pagination(self, client, shipment_env):
        for i in range(5):
            _seed_sku(
                shipment_env["project_id"],
                shipment_env["project_name"],
                sku=f"X-PG-{i}",
                country="US",
            )
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info?sku=X-PG&page=1&page_size=2&include_total=true",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()["data"]
        assert len(body["items"]) == 2
        assert body["page"] == 1
        assert body["page_size"] == 2
        assert body["total"] >= 5
        assert body["has_next"] is True

    def test_detail_full_fields(self, client, shipment_env):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-DETAIL",
            sku_factory_info={"material": "ABS"},
        )
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["sku"] == "X-DETAIL"
        assert data["sku_factory_info"] == {"material": "ABS"}
        assert data["marketplace_url"] is not None
        assert "created_at" in data and "updated_at" in data
        assert "source_file" not in data
        assert "fnsku_label_r2_key" not in data

    def test_detail_missing_404(self, client, shipment_env):
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/999999",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_detail_cross_project_404(self, client, shipment_env, make_api_key):
        """另一项目的 SKU 对本项目 404（直取语义 + project 归属校验）。"""
        other = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-OTHER",
        )
        # 新建一个项目，用 scoped key 访问
        suffix = uuid.uuid4().hex[:8]
        from app.models import Project

        db = SessionLocal()
        try:
            proj = Project(
                project_name=f"agent-sku-other-{suffix}",
                project_operator="pytest",
                sort_order=0,
                is_active=True,
            )
            db.add(proj)
            db.commit()
            db.refresh(proj)
            other_project_id = int(proj.id)
        finally:
            db.close()
        key = make_api_key(agent_id="other-proj", project_scope=str(other_project_id))
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "other-proj",
        }
        resp = client.get(
            f"/api/v1/agent/projects/{other_project_id}/sku-info/{other}",
            headers=headers,
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

        db = SessionLocal()
        try:
            obj = db.get(Project, other_project_id)
            if obj is not None:
                db.delete(obj)
            db.commit()
        finally:
            db.close()

    def test_audit_endpoint_returns_agent_attribution(
        self, client, shipment_env, confirm_memory_store
    ):
        """R3 审计：W1 写后审计行含 agent_id / idempotency_key。"""
        body = _upsert_body(sku="X-R3AUDIT", asin="ASIN-X-R3AUDIT")
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_upsert(client, shipment_env, body, idem=idem)
        r = _post_upsert(
            client, shipment_env, body, token=p.json()["confirm_token"], idem=idem
        )
        assert r.status_code == 200
        sku_id = r.json()["data"]["id"]

        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}/audit",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        assert len(items) == 1
        assert items[0]["action"] == "sku_info.upsert"
        assert items[0]["agent_id"] == shipment_env["agent_id"]
        assert items[0]["idempotency_key"] == idem
        assert items[0]["operator"] is None

    def test_read_does_not_audit(self, client, shipment_env):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-NOAUDIT",
        )
        before = _count_audit_rows(sku_id)
        for url in (
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info",
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}",
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}/audit",
        ):
            resp = client.get(url, headers=shipment_env["headers"])
            assert resp.status_code == 200
        assert _count_audit_rows(sku_id) == before, "读路由不落审计"


# ---------------------------------------------------------------------------
# scope 门禁
# ---------------------------------------------------------------------------


class TestScopeGate:
    def test_business_scope_without_sku_info_403(
        self, client, shipment_env, make_api_key
    ):
        key = make_api_key(agent_id="no-sku-info", business_scope="shop_calculations")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "no-sku-info",
        }
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

        # 写路由同样被 business_scope 拦截
        resp_write = client.post(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info",
            json=_upsert_body(),
            headers={**headers, "Idempotency-Key": f"idem-{uuid.uuid4().hex[:12]}"},
        )
        assert resp_write.status_code == 403
        assert resp_write.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_project_out_of_scope_403(self, client, shipment_env, make_api_key):
        key = make_api_key(agent_id="out-proj", project_scope="900001")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "out-proj",
        }
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


# ---------------------------------------------------------------------------
# confirm 流通用契约
# ---------------------------------------------------------------------------


class TestConfirmFlow:
    def test_replay_body_change_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        body = _upsert_body(fob_unit_cost=15.5)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_upsert(client, shipment_env, body, idem=idem)
        token = p.json()["confirm_token"]
        changed = _upsert_body(fob_unit_cost=99.0)
        r = _post_upsert(client, shipment_env, changed, token=token, idem=idem)
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_confirm_token_expired(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body()
        p = _post_upsert(client, shipment_env, body)
        token = p.json()["confirm_token"]
        confirm_memory_store._rows[token]["record"].created_at -= 400
        r = _post_upsert(client, shipment_env, body, token=token)
        assert r.status_code == 409
        assert r.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"

    def test_replay_single_use(self, client, shipment_env, confirm_memory_store):
        body = _upsert_body()
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        p = _post_upsert(client, shipment_env, body, idem=idem)
        token = p.json()["confirm_token"]
        first = _post_upsert(client, shipment_env, body, token=token, idem=idem)
        assert first.status_code == 200
        second = _post_upsert(client, shipment_env, body, token=token, idem=idem)
        assert second.status_code == 400
        assert second.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"


# ---------------------------------------------------------------------------
# 路由注册 & 镜像收口
# ---------------------------------------------------------------------------


class TestRouteRegistration:
    def test_mirror_removed(self):
        """BLF-583：external_mirror 已退役删除，import 应失败。"""
        with pytest.raises(ModuleNotFoundError):
            import app.api.v1.endpoints.agent.external_mirror  # noqa: F401

    def test_agent_sku_info_still_200_native_handler(self, client, shipment_env):
        """镜像收口后 /agent/projects/{id}/sku-info 仍 200 且走原生 handler。"""
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        # 原生 R1 响应形状：data.items/page/page_size/has_next（非镜像 ExternalSkuInfoResponse）
        assert "items" in body["data"]
        assert "page" in body["data"]
        assert "has_next" in body["data"]

    def test_single_get_route_for_sku_info(self):
        """路由数量不重复：agent 侧 /projects/{project_id}/sku-info 只有原生一条 GET。"""
        from app.api.v1.endpoints.agent import agent_router
        from app.api.v1.endpoints.agent.sku_info import sku_info_router

        # FastAPI >=0.13x 子路由包成 _IncludedRouter（真实 APIRoute 在
        # original_router.routes 且 path 不含 /agent 前缀），<0.13x 直接拍平。
        def _iter_routes(routes):
            for r in routes:
                yield r
                inner = getattr(r, "original_router", None)
                if inner is not None:
                    yield from _iter_routes(getattr(inner, "routes", []))

        native_paths = [
            r.path for r in _iter_routes(agent_router.routes) if hasattr(r, "path")
        ]
        assert "/projects/{project_id}/sku-info" in native_paths

        # 原生模块内恰好一条（不含兜底）
        sku_paths = [r.path for r in sku_info_router.routes]
        assert "/projects/{project_id}/sku-info" in sku_paths


# ---------------------------------------------------------------------------
# W4 FNSKU 标签 PDF 上传（multipart confirm；BLF-628，spec §4 W4 / §7 #11）
# ---------------------------------------------------------------------------


class TestW4UploadFnskuLabel:
    """W4 上传：multipart confirm 两步 + R2 写入 + 行更新 + 审计归因。

    R2 全程 mock（``upload_bytes_to_r2`` / ``delete_file_from_r2``）——
    本类不依赖真实 R2。文件校验（source 枚举 / PDF 后缀 / 非空 / ≤20MB /
    跨项目 404）在 confirm 签发之前短路。
    """

    PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF"

    def _upload(
        self,
        client,
        env,
        sku_record_id,
        *,
        source="agent_listing_pull",
        filename="label.pdf",
        content=None,
        idem=None,
        token=None,
        data_extra=None,
    ):
        headers = dict(env["headers"])
        headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
        if token:
            headers["X-Confirm-Token"] = token
        data = {"source": source}
        if data_extra:
            data.update(data_extra)
        return client.post(
            f"/api/v1/agent/projects/{env['project_id']}/sku-info/"
            f"{sku_record_id}/fnsku-label",
            files={
                "file": (
                    filename,
                    content if content is not None else self.PDF,
                    "application/pdf",
                )
            },
            data=data,
            headers=headers,
        )

    def _patch_r2(self, return_url="https://cdn.example.com/label.pdf"):
        """mock R2 上传/删除；返回 (ExitStack, upload_mock, delete_mock)。"""
        from contextlib import ExitStack
        from unittest.mock import PropertyMock, patch

        from app.core.config import get_settings

        def _upload(
            settings,
            data,
            filename,
            project_slug,
            file_type,
            content_type="application/octet-stream",
        ):
            return {
                "key": f"{project_slug}/{file_type}/{filename}",
                "url": return_url,
                "bucket": "test-bucket",
                "size": len(data),
            }

        settings = get_settings()
        stack = ExitStack()
        up = stack.enter_context(
            patch(
                "app.services.r2_service.upload_bytes_to_r2",
                side_effect=_upload,
            )
        )
        dele = stack.enter_context(
            patch("app.services.r2_service.delete_file_from_r2", return_value=True)
        )
        stack.enter_context(
            patch.object(
                type(settings),
                "r2_enabled",
                new_callable=PropertyMock,
                return_value=True,
            )
        )
        return stack, up, dele

    def test_preview_then_replay_uploads_audits_and_reads_back(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4A"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = self._upload(client, shipment_env, sku_id, idem=idem)
            assert preview.status_code == 200, preview.text
            pbody = preview.json()
            assert pbody["ok"] is False
            assert pbody["requires_confirmation"] is True
            assert pbody["confirm_token"].startswith("cf_")
            assert pbody["preview"]["action"] == "sku_info.upload_fnsku_label"
            assert pbody["preview"]["sku_record_id"] == sku_id
            assert pbody["preview"]["sku"] == "X-W4A"
            assert pbody["preview"]["filename"] == "label.pdf"
            assert pbody["preview"]["file_size"] == len(self.PDF)
            assert pbody["preview"]["replace_old"] is False
            assert pbody["preview"]["source"] == "agent_listing_pull"

            # 重放：TestClient 每次 files= 生成新 boundary，内容一致即通过
            replay = self._upload(
                client, shipment_env, sku_id, token=pbody["confirm_token"], idem=idem
            )
            assert replay.status_code == 200, replay.text
            rbody = replay.json()
            assert rbody["ok"] is True
            assert rbody["data"]["sku_record_id"] == sku_id
            assert (
                rbody["data"]["fnsku_label_r2_url"]
                == "https://cdn.example.com/label.pdf"
            )
            assert rbody["data"]["file_size"] == len(self.PDF)
            assert rbody["data"]["filename"].endswith("_X-W4A.pdf")
            assert rbody["idempotency_key"] == idem

            up.assert_called_once()
            dele.assert_not_called()  # 无旧 key

        # 行已更新（R2 写回）
        db = SessionLocal()
        try:
            row = db.get(SkuRecord, sku_id)
            assert (
                row.fnsku_label_r2_key
                == f"{shipment_env['project_name']}/fnsku-labels/"
                + rbody["data"]["filename"]
            )
            assert row.fnsku_label_r2_url == "https://cdn.example.com/label.pdf"
        finally:
            db.close()

        # 审计归因
        db = SessionLocal()
        try:
            audit = query_operation_audit_log(
                db, target_type="sku_info", target_id=str(sku_id)
            )
        finally:
            db.close()
        assert len(audit) == 1
        row = audit[0]
        assert row.action == "sku_info.upload_fnsku_label"
        assert row.agent_id == shipment_env["agent_id"]
        assert row.idempotency_key == idem
        assert row.operator is None
        assert row.after_json["sku"] == "X-W4A"
        assert "fnsku_label_r2_key" in row.after_json
        assert row.after_json["file_size"] == len(self.PDF)

        # R1/R2 读回可见新 url
        read = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}",
            headers=shipment_env["headers"],
        )
        assert read.status_code == 200
        assert (
            read.json()["data"]["fnsku_label_r2_url"]
            == "https://cdn.example.com/label.pdf"
        )

    def test_replace_existing_label_deletes_old_key(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-W4B",
            fnsku_label_r2_key="old/project/fnsku-labels/old.pdf",
            fnsku_label_r2_url="https://cdn.example.com/old.pdf",
        )
        stack, up, dele = self._patch_r2()
        with stack:
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = self._upload(client, shipment_env, sku_id, idem=idem)
            assert preview.status_code == 200, preview.text
            assert preview.json()["preview"]["replace_old"] is True

            replay = self._upload(
                client,
                shipment_env,
                sku_id,
                token=preview.json()["confirm_token"],
                idem=idem,
            )
            assert replay.status_code == 200, replay.text
            dele.assert_called_once()
            assert dele.call_args.args[1] == "old/project/fnsku-labels/old.pdf"
            up.assert_called_once()

    def test_missing_source_rejected_before_token(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4C"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(
                client, shipment_env, sku_id, data_extra={"source": None}
            )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SKU_INFO_INVALID_SOURCE"
        up.assert_not_called()

    def test_invalid_source_rejected(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4D"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(client, shipment_env, sku_id, source="manual")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SKU_INFO_INVALID_SOURCE"

    def test_non_pdf_rejected(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4E"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(client, shipment_env, sku_id, filename="label.txt")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        up.assert_not_called()

    def test_empty_file_rejected(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4F"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(client, shipment_env, sku_id, content=b"")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_oversize_file_rejected(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4G"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(
                client, shipment_env, sku_id, content=b"x" * (20 * 1024 * 1024 + 1)
            )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        up.assert_not_called()

    def test_missing_file_rejected(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4H"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = client.post(
                f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}/fnsku-label",
                data={"source": "agent_listing_pull"},
                headers=_headers(shipment_env),
            )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_cross_project_record_404(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4I"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(client, shipment_env, sku_id + 999999, idem="idem-x")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        up.assert_not_called()

    def test_replay_content_changed_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4J"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = self._upload(client, shipment_env, sku_id, idem=idem)
            replay = self._upload(
                client,
                shipment_env,
                sku_id,
                content=b"%PDF-1.4 tampered",
                token=preview.json()["confirm_token"],
                idem=idem,
            )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        up.assert_not_called()

    def test_replay_source_changed_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4K"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = self._upload(client, shipment_env, sku_id, idem=idem)
            replay = self._upload(
                client,
                shipment_env,
                sku_id,
                source="external_api",
                token=preview.json()["confirm_token"],
                idem=idem,
            )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        up.assert_not_called()

    def test_replay_idempotency_changed_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4L"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            preview = self._upload(client, shipment_env, sku_id, idem="idem-a")
            replay = self._upload(
                client,
                shipment_env,
                sku_id,
                token=preview.json()["confirm_token"],
                idem="idem-b",
            )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        up.assert_not_called()

    def test_confirm_token_expired(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4M"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = self._upload(client, shipment_env, sku_id, idem=idem)
            token = preview.json()["confirm_token"]
            confirm_memory_store._rows[token]["record"].created_at -= 400
            replay = self._upload(client, shipment_env, sku_id, token=token, idem=idem)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"
        up.assert_not_called()

    def test_invalid_idempotency_header_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4N"
        )
        stack, up, dele = self._patch_r2()
        with stack:
            resp = self._upload(client, shipment_env, sku_id, idem="x" * 65)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        up.assert_not_called()

    def test_r2_disabled_returns_internal_error(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-W4O"
        )
        from unittest.mock import PropertyMock, patch

        from app.core.config import get_settings

        settings = get_settings()
        with (
            patch("app.services.r2_service.upload_bytes_to_r2") as up,
            patch.object(
                type(settings),
                "r2_enabled",
                new_callable=PropertyMock,
                return_value=False,
            ),
        ):
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = self._upload(client, shipment_env, sku_id, idem=idem)
            replay = self._upload(
                client,
                shipment_env,
                sku_id,
                token=preview.json()["confirm_token"],
                idem=idem,
            )
        assert replay.status_code == 500
        assert replay.json()["error"]["code"] == "INTERNAL_ERROR"
        up.assert_not_called()


# ---------------------------------------------------------------------------
# W5 删除（confirm 两步；不可逆硬删除）
# ---------------------------------------------------------------------------


class TestDeleteSkuRecord:
    """W5 删除：confirm 两步 + 硬删除 + 审计归因 + 缓存失效。

    对齐内部删除语义：不存在/跨项目 → agent shell 404（不泄漏存在性）；
    预览不落库；删除后 R2 详情 404；审计 before 记录删除前快照。
    """

    def _run(self, client, env, sku_record_id, *, idem=None):
        idem = idem or f"idem-{uuid.uuid4().hex[:12]}"
        p = _delete_sku(client, env, sku_record_id, idem=idem)
        assert p.status_code == 200, p.text
        r = _delete_sku(
            client, env, sku_record_id, token=p.json()["confirm_token"], idem=idem
        )
        return r

    def test_preview_then_replay_deletes_and_audits(
        self, client, shipment_env, confirm_memory_store
    ):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-DEL",
            fob_unit_cost=12.5,
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        # 第一次：预览壳（HTTP 200 + ok:false + requires_confirmation，不落库）
        preview = _delete_sku(client, shipment_env, sku_id, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["preview"]["action"] == "sku_info.delete"
        assert pbody["preview"]["sku_record_id"] == sku_id
        assert pbody["preview"]["sku"] == "X-DEL"
        assert pbody["preview"]["country"] == "US"
        assert "永久删除" in pbody["preview"]["note"]

        # 预览不落库：R2 详情仍在
        detail = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}",
            headers=shipment_env["headers"],
        )
        assert detail.status_code == 200, detail.text

        # 第二次：重放删除
        replay = _delete_sku(
            client, shipment_env, sku_id, token=pbody["confirm_token"], idem=idem
        )
        assert replay.status_code == 200, replay.text
        rbody = replay.json()
        assert rbody["ok"] is True
        assert rbody["data"] == {"deleted": True, "sku_record_id": sku_id}
        assert rbody["idempotency_key"] == idem

        # 已删：R2 详情 404、R1 列表不含该记录
        detail = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}",
            headers=shipment_env["headers"],
        )
        assert detail.status_code == 404
        listing = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info"
            "?is_active=false&page_size=500",
            headers=shipment_env["headers"],
        )
        assert listing.status_code == 200
        assert sku_id not in {item["id"] for item in listing.json()["data"]["items"]}

        db = SessionLocal()
        try:
            assert db.get(SkuRecord, sku_id) is None, "硬删除：行已不存在"
        finally:
            db.close()

        # 审计行：agent 归因 + before 快照
        rows = query_operation_audit_log(
            SessionLocal(),
            target_type="sku_info",
            target_id=str(sku_id),
        )
        assert len(rows) == 1
        audit = rows[0]
        assert audit.action == "sku_info.delete"
        assert audit.agent_id == shipment_env["agent_id"]
        assert audit.idempotency_key == idem
        assert audit.operator is None
        assert audit.before_json["sku"] == "X-DEL"
        assert audit.before_json["fob_unit_cost"] == 12.5
        assert audit.after_json is None

    def test_unknown_record_404_no_token_issued(
        self, client, shipment_env, confirm_memory_store
    ):
        resp = _delete_sku(client, shipment_env, 999999)
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        assert get_confirm_store()._rows == {}, "校验先于 confirm：未签发 token"

    def test_cross_project_404(self, client, shipment_env, make_api_key):
        """另一项目的 SKU 对本项目 404（不泄漏存在性）。"""
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-XP",
        )
        resp = _delete_sku(client, shipment_env, sku_id, project_id=99999999)
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

        db = SessionLocal()
        try:
            assert db.get(SkuRecord, sku_id) is not None, "跨项目 404：未误删"
        finally:
            db.close()

    def test_invalid_token_replay(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-INV",
        )
        resp = _delete_sku(client, shipment_env, sku_id, token="cf_bogus")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

        db = SessionLocal()
        try:
            assert db.get(SkuRecord, sku_id) is not None, "无效 token：未删除"
        finally:
            db.close()

    def test_expired_token_replay(self, client, shipment_env, confirm_memory_store):
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-EXP",
        )
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _delete_sku(client, shipment_env, sku_id, idem=idem)
        token = preview.json()["confirm_token"]

        # 模拟逻辑过期（TTL 300s）：直接回拨 created_at
        confirm_memory_store._rows[token]["record"].created_at -= 301

        replay = _delete_sku(client, shipment_env, sku_id, token=token, idem=idem)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"

        db = SessionLocal()
        try:
            assert db.get(SkuRecord, sku_id) is not None, "过期 token：未删除"
        finally:
            db.close()

    def test_cache_invalidated_after_delete(
        self, client, shipment_env, confirm_memory_store, monkeypatch
    ):
        from app.api.v1.endpoints.agent import sku_info as sku_info_module

        calls: list[int] = []

        def _fake(project_id: int):
            calls.append(project_id)

        monkeypatch.setattr(sku_info_module, "invalidate_sku_financial_cache", _fake)
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-CDEL",
        )
        resp = self._run(client, shipment_env, sku_id)
        assert resp.status_code == 200
        assert calls == [shipment_env["project_id"]]

    def test_business_scope_without_sku_info_403(
        self, client, shipment_env, make_api_key
    ):
        key = make_api_key(agent_id="no-del", business_scope="shop_calculations")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "no-del",
        }
        sku_id = _seed_sku(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-SCOPEDEL",
        )
        resp = client.delete(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{sku_id}",
            headers={**headers, "Idempotency-Key": f"idem-{uuid.uuid4().hex[:12]}"},
        )
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
