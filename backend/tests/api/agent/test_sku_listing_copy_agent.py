"""Agent SKU Info 产品文案读写契约回归（BLF-1080 / BLF-1083）。

覆盖：
* W1 upsert / W2 局部更新读写文案字段组；
* W2 只改显式提供字段（默认值陷阱契约）；
* W6 批量文案写入（BLF-1083）：多条成功 / 跨项目与未知 id 404 /
  confirm 预览壳 / source 溯源校验 / business_scope 门禁 / 逐条审计。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.operation_audit_log import OperationAuditLog
from app.models.sku_info import SkuRecord

LISTING_FIELDS = (
    "listing_title",
    "listing_bullet_1",
    "listing_bullet_2",
    "listing_bullet_3",
    "listing_bullet_4",
    "listing_bullet_5",
    "listing_description",
    "listing_selling_points",
)


def _headers(env: dict, *, token: str | None = None, idem: str | None = None) -> dict:
    headers = dict(env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return headers


def _seed_sku(env: dict, **listing_fields: str | None) -> int:
    db = SessionLocal()
    try:
        row = SkuRecord(
            project_id=env["project_id"],
            project_name=env["project_name"],
            sku=f"AGENT-LISTING-{uuid.uuid4().hex[:10]}",
            asin=f"ASIN-{uuid.uuid4().hex[:10]}",
            country="US",
            fob_unit_cost=10,
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
            is_active=True,
            **listing_fields,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return int(row.id)
    finally:
        db.close()


def _upsert(
    client: TestClient,
    env: dict,
    body: dict,
    *,
    token: str | None = None,
    idem: str | None = None,
):
    return client.post(
        f"/api/v1/agent/projects/{env['project_id']}/sku-info",
        json=body,
        headers=_headers(env, token=token, idem=idem),
    )


def _patch(
    client: TestClient,
    env: dict,
    sku_id: int,
    body: dict,
    *,
    token: str | None = None,
    idem: str | None = None,
):
    return client.patch(
        f"/api/v1/agent/projects/{env['project_id']}/sku-info/{sku_id}",
        json=body,
        headers=_headers(env, token=token, idem=idem),
    )


def _base_body(**overrides) -> dict:
    body = {
        "sku": f"AGENT-LISTING-{uuid.uuid4().hex[:10]}",
        "asin": f"ASIN-{uuid.uuid4().hex[:10]}",
        "country": "US",
        "source": "agent_listing_pull",
    }
    body.update(overrides)
    return body


def test_agent_w1_reads_and_writes_all_listing_copy_fields(shipment_env):
    client = TestClient(app)
    idem = f"idem-{uuid.uuid4().hex[:12]}"
    body = _base_body(
        listing_title="Agent 标题",
        listing_bullet_1="第一点",
        listing_bullet_2="第二点",
        listing_bullet_3="第三点",
        listing_bullet_4="第四点",
        listing_bullet_5="第五点",
        listing_description="Agent 描述",
        listing_selling_points="卖点提炼",
    )
    set_confirm_store(InMemoryConfirmStore())
    try:
        preview = _upsert(client, shipment_env, body, idem=idem)
        assert preview.status_code == 200, preview.text
        replay = _upsert(
            client,
            shipment_env,
            body,
            token=preview.json()["confirm_token"],
            idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert {field: data[field] for field in LISTING_FIELDS} == {
            field: body[field] for field in LISTING_FIELDS
        }
        assert data["listing_copy_updated_at"] is not None
        assert data["listing_copy_updated_by"] == shipment_env["agent_id"]

        listed = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info"
            f"?sku={body['sku']}",
            headers=shipment_env["headers"],
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()["data"]["items"][0]["listing_description"] == "Agent 描述"

        detail = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/sku-info/{data['id']}",
            headers=shipment_env["headers"],
        )
        assert detail.status_code == 200, detail.text
        assert detail.json()["data"]["listing_selling_points"] == "卖点提炼"
    finally:
        set_confirm_store(None)


def test_agent_w2_updates_and_clears_listing_copy_without_touching_others(
    shipment_env,
):
    client = TestClient(app)
    sku_id = _seed_sku(
        shipment_env,
        listing_title="旧标题",
        listing_bullet_1="旧第一点",
        listing_bullet_2="保留第二点",
    )
    idem = f"idem-{uuid.uuid4().hex[:12]}"
    body = {
        "source": "agent_user_supplied",
        "listing_title": "新标题",
        "listing_bullet_1": None,
    }
    set_confirm_store(InMemoryConfirmStore())
    try:
        preview = _patch(client, shipment_env, sku_id, body, idem=idem)
        assert preview.status_code == 200, preview.text
        replay = _patch(
            client,
            shipment_env,
            sku_id,
            body,
            token=preview.json()["confirm_token"],
            idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["listing_title"] == "新标题"
        assert data["listing_bullet_1"] is None
        assert data["listing_bullet_2"] == "保留第二点"
        assert data["listing_copy_updated_at"] is not None
        assert data["listing_copy_updated_by"] == shipment_env["agent_id"]
    finally:
        set_confirm_store(None)


def test_agent_listing_schema_rejects_server_trace_fields():
    from app.schemas.agent_sku_info import AgentSkuRecordUpdateRequest

    try:
        AgentSkuRecordUpdateRequest.model_validate(
            {"source": "agent_listing_pull", "listing_copy_updated_by": "forged"}
        )
    except ValueError:
        return
    raise AssertionError("Agent W2 must reject server-managed trace fields")


# ---------------------------------------------------------------------------
# W6 批量文案写入（BLF-1083）
# ---------------------------------------------------------------------------

BATCH_ACTION = "sku_info.listing_copy.batch"


def _batch(
    client: TestClient,
    env: dict,
    body: dict,
    *,
    token: str | None = None,
    idem: str | None = None,
    project_id: int | None = None,
):
    return client.post(
        f"/api/v1/agent/projects/{project_id or env['project_id']}"
        "/sku-info/listing-copy/batch",
        json=body,
        headers=_headers(env, token=token, idem=idem),
    )


def _batch_body(items: list[dict], source: str = "agent_listing_pull") -> dict:
    return {"items": items, "source": source}


def _batch_audit_rows(sku_record_id: int) -> list[OperationAuditLog]:
    db = SessionLocal()
    try:
        return list(
            db.execute(
                select(OperationAuditLog).where(
                    OperationAuditLog.action == BATCH_ACTION,
                    OperationAuditLog.target_id == str(sku_record_id),
                )
            )
            .scalars()
            .all()
        )
    finally:
        db.close()


def _confirmed_batch(
    client: TestClient, env: dict, body: dict
) -> tuple[int, dict]:
    """预览 → 带 token 重放，返回 (HTTP 状态码, 响应体)。"""
    idem = f"idem-{uuid.uuid4().hex[:12]}"
    preview = _batch(client, env, body, idem=idem)
    if preview.status_code != 200:
        return preview.status_code, preview.json()
    replay = _batch(
        client, env, body, token=preview.json()["confirm_token"], idem=idem
    )
    return replay.status_code, replay.json()


@pytest.fixture
def other_project_sku():
    """另一项目的 SKU 行（跨项目 404 断言用），测后清理。"""
    db = SessionLocal()
    try:
        project = Project(
            project_name=f"agent-listing-other-{uuid.uuid4().hex[:8]}",
            project_operator="pytest",
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        row = SkuRecord(
            project_id=project.id,
            project_name=project.project_name,
            sku=f"AGENT-LISTING-OTHER-{uuid.uuid4().hex[:8]}",
            asin=f"ASIN-{uuid.uuid4().hex[:10]}",
            country="US",
            fob_unit_cost=10,
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
            is_active=True,
            listing_title="他项目标题",
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        payload = {"project_id": int(project.id), "sku_record_id": int(row.id)}
    finally:
        db.close()

    yield payload

    db = SessionLocal()
    try:
        db.execute(delete(SkuRecord).where(SkuRecord.id == payload["sku_record_id"]))
        obj = db.get(Project, payload["project_id"])
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


def test_agent_w6_batch_writes_multiple_records(shipment_env):
    """本项目多条 → 全成功，溯源落 agent_id，逐条审计可查。"""
    client = TestClient(app)
    first = _seed_sku(shipment_env)
    second = _seed_sku(shipment_env)
    body = _batch_body(
        [
            {
                "sku_record_id": first,
                "listing_title": "批量标题 A",
                "listing_bullet_1": "批量要点 A",
            },
            {"sku_record_id": second, "listing_title": "批量标题 B"},
        ]
    )

    set_confirm_store(InMemoryConfirmStore())
    try:
        status, payload = _confirmed_batch(client, shipment_env, body)
    finally:
        set_confirm_store(None)

    assert status == 200, payload
    data = payload["data"]
    assert data["updated"] == 2
    assert data["unchanged"] == 0
    assert sorted(data["updated_ids"]) == sorted([first, second])
    assert len(data["items"]) == 2
    for item in data["items"]:
        assert item["listing_copy_updated_by"] == shipment_env["agent_id"]
        assert item["listing_copy_updated_at"] is not None

    db = SessionLocal()
    try:
        first_row = db.get(SkuRecord, first)
        second_row = db.get(SkuRecord, second)
        assert first_row is not None, "批量写完的行必须存在"
        assert second_row is not None, "批量写完的行必须存在"
        assert first_row.listing_title == "批量标题 A"
        assert first_row.listing_bullet_1 == "批量要点 A"
        assert second_row.listing_title == "批量标题 B"
    finally:
        db.close()

    for record_id, expected_title in ((first, "批量标题 A"), (second, "批量标题 B")):
        rows = _batch_audit_rows(record_id)
        assert len(rows) == 1, f"record {record_id} 应有 1 条批量写审计"
        assert rows[0].agent_id == shipment_env["agent_id"]
        assert rows[0].operator is None
        assert rows[0].result == "success"
        after = rows[0].after_json
        assert isinstance(after, dict)
        assert after["listing_title"] == expected_title


def test_agent_w6_batch_only_writes_provided_fields(shipment_env):
    """只传 listing_title → bullets 保持原值；显式 null 清空；同值 → unchanged。"""
    client = TestClient(app)
    sku_id = _seed_sku(
        shipment_env,
        listing_title="旧标题",
        listing_bullet_1="保留要点 1",
        listing_bullet_2="保留要点 2",
    )

    set_confirm_store(InMemoryConfirmStore())
    try:
        status, payload = _confirmed_batch(
            client,
            shipment_env,
            _batch_body([{"sku_record_id": sku_id, "listing_title": "新标题"}]),
        )
        assert status == 200, payload
        item = payload["data"]["items"][0]
        assert item["listing_title"] == "新标题"
        assert item["listing_bullet_1"] == "保留要点 1"
        assert item["listing_bullet_2"] == "保留要点 2"

        # 显式 null → 清空该字段，未提及的仍保留
        status, payload = _confirmed_batch(
            client,
            shipment_env,
            _batch_body([{"sku_record_id": sku_id, "listing_bullet_1": None}]),
        )
        assert status == 200, payload
        item = payload["data"]["items"][0]
        assert item["listing_bullet_1"] is None
        assert item["listing_bullet_2"] == "保留要点 2"
        assert item["listing_title"] == "新标题"

        # 写入同值 → unchanged，不重复审计
        before_audit = len(_batch_audit_rows(sku_id))
        status, payload = _confirmed_batch(
            client,
            shipment_env,
            _batch_body([{"sku_record_id": sku_id, "listing_title": "新标题"}]),
        )
        assert status == 200, payload
        assert payload["data"]["updated"] == 0
        assert payload["data"]["unchanged"] == 1
        assert payload["data"]["updated_ids"] == []
        assert len(_batch_audit_rows(sku_id)) == before_audit
    finally:
        set_confirm_store(None)


def test_agent_w6_batch_cross_project_id_404(shipment_env, other_project_sku):
    """混入他项目 id → 整批 404，自己的行也不被改动。"""
    client = TestClient(app)
    own = _seed_sku(shipment_env)
    body = _batch_body(
        [
            {"sku_record_id": own, "listing_title": "自己的"},
            {
                "sku_record_id": other_project_sku["sku_record_id"],
                "listing_title": "他项目的",
            },
        ]
    )

    set_confirm_store(InMemoryConfirmStore())
    try:
        resp = _batch(client, shipment_env, body)
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
    finally:
        set_confirm_store(None)

    db = SessionLocal()
    try:
        own_row = db.get(SkuRecord, own)
        other_row = db.get(SkuRecord, other_project_sku["sku_record_id"])
        assert own_row is not None, "本项目行必须存在"
        assert other_row is not None, "他项目行必须存在"
        assert own_row.listing_title is None, "整批拒绝，不得部分写入"
        assert own_row.listing_copy_updated_at is None
        assert other_row.listing_title == "他项目标题"
    finally:
        db.close()


def test_agent_w6_batch_unknown_id_404(shipment_env):
    """不存在的 sku_record_id → 404（而不是静默 skipped）。"""
    client = TestClient(app)
    set_confirm_store(InMemoryConfirmStore())
    try:
        resp = _batch(
            client,
            shipment_env,
            _batch_body([{"sku_record_id": 99_999_999, "listing_title": "x"}]),
        )
    finally:
        set_confirm_store(None)
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_agent_w6_batch_preview_requires_confirmation(shipment_env):
    """无 X-Confirm-Token → 预览壳（不落库），含逐条字段级 diff。"""
    client = TestClient(app)
    sku_id = _seed_sku(shipment_env, listing_title="预览前标题")

    set_confirm_store(InMemoryConfirmStore())
    try:
        resp = _batch(
            client,
            shipment_env,
            _batch_body([{"sku_record_id": sku_id, "listing_title": "预览后标题"}]),
        )
    finally:
        set_confirm_store(None)

    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["ok"] is False
    assert payload["requires_confirmation"] is True
    assert payload["confirm_token"]
    preview = payload["preview"]
    assert preview["action"] == BATCH_ACTION
    assert preview["item_count"] == 1
    assert preview["source"] == "agent_listing_pull"
    changed = preview["items"][0]["changed"]["listing_title"]
    assert changed == {"from": "预览前标题", "to": "预览后标题"}

    db = SessionLocal()
    try:
        row = db.get(SkuRecord, sku_id)
        assert row is not None, "预览不得删行"
        assert row.listing_title == "预览前标题", "预览不得落库"
    finally:
        db.close()


def test_agent_w6_batch_rejects_manual_source(shipment_env):
    """source 必填且禁 manual（D4）→ SKU_INFO_INVALID_SOURCE。"""
    client = TestClient(app)
    sku_id = _seed_sku(shipment_env)

    set_confirm_store(InMemoryConfirmStore())
    try:
        manual = _batch(
            client,
            shipment_env,
            _batch_body([{"sku_record_id": sku_id, "listing_title": "x"}], "manual"),
        )
        missing = _batch(
            client,
            shipment_env,
            {"items": [{"sku_record_id": sku_id, "listing_title": "x"}]},
        )
    finally:
        set_confirm_store(None)

    for resp in (manual, missing):
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "SKU_INFO_INVALID_SOURCE"


def test_agent_w6_batch_rejects_identity_and_trace_fields(shipment_env):
    """item 只接 sku_record_id + 文案字段；身份字段 / 溯源列 / 多余键 → 400。"""
    client = TestClient(app)
    sku_id = _seed_sku(shipment_env)

    set_confirm_store(InMemoryConfirmStore())
    try:
        for item in (
            {"sku_record_id": sku_id, "listing_copy_updated_by": "伪造"},
            {"sku_record_id": sku_id, "sku": "改身份"},
            {"sku_record_id": sku_id, "listing_title": "x", "unknown": 1},
        ):
            resp = _batch(client, shipment_env, _batch_body([item]))
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

        # 空 items → 400（min_length=1）
        empty = _batch(client, shipment_env, {"items": [], "source": "agent_listing_pull"})
        assert empty.status_code == 400, empty.text
        assert empty.json()["error"]["code"] == "VALIDATION_FAILED"
    finally:
        set_confirm_store(None)


def test_agent_w6_batch_business_scope_gate(shipment_env, make_api_key):
    """business_scope 不含 sku_info → 403（与同域其它路由一致）。"""
    client = TestClient(app)
    key = make_api_key(agent_id="no-sku-info-w6", business_scope="shop_calculations")
    resp = client.post(
        f"/api/v1/agent/projects/{shipment_env['project_id']}"
        "/sku-info/listing-copy/batch",
        json=_batch_body([{"sku_record_id": 1, "listing_title": "x"}]),
        headers={
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "no-sku-info-w6",
            "Idempotency-Key": f"idem-{uuid.uuid4().hex[:12]}",
        },
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
