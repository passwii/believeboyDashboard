"""Agent SKU Info 产品文案读写契约回归（BLF-1080）。"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
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
