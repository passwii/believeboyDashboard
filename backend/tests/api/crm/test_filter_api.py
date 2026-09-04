"""高级筛选端点集成测试（P4）：筛选生效 + 非法字段/运算符 400。

鉴权复用根 conftest 的 admin_headers（含 X-API-Key + X-User-Id UUID）。
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import text


@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_follows, crm_contacts, crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def test_filter_customers_by_status(client, admin_headers):
    client.post(
        "/api/v1/crm/customers",
        json={"name": "C1", "status": "active"},
        headers=admin_headers,
    )
    client.post(
        "/api/v1/crm/customers",
        json={"name": "C2", "status": "lost"},
        headers=admin_headers,
    )
    filters = json.dumps([{"field": "status", "op": "eq", "value": "lost"}])
    body = client.get(
        "/api/v1/crm/customers", params={"filters": filters}, headers=admin_headers
    ).json()
    assert body["total"] == 1 and body["items"][0]["name"] == "C2"


def test_filter_customers_by_rating_in(client, admin_headers):
    client.post(
        "/api/v1/crm/customers",
        json={"name": "C1", "rating": "A"},
        headers=admin_headers,
    )
    client.post(
        "/api/v1/crm/customers",
        json={"name": "C2", "rating": "C"},
        headers=admin_headers,
    )
    filters = json.dumps([{"field": "rating", "op": "in", "value": ["A", "B"]}])
    body = client.get(
        "/api/v1/crm/customers", params={"filters": filters}, headers=admin_headers
    ).json()
    assert body["total"] == 1 and body["items"][0]["name"] == "C1"


def test_filter_illegal_field_returns_400(client, admin_headers):
    filters = json.dumps([{"field": "evil_field", "op": "eq", "value": "x"}])
    resp = client.get(
        "/api/v1/crm/customers", params={"filters": filters}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_filter_illegal_op_returns_400(client, admin_headers):
    filters = json.dumps([{"field": "status", "op": "like_evil", "value": "x"}])
    resp = client.get(
        "/api/v1/crm/customers", params={"filters": filters}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_filter_non_array_json_returns_400(client, admin_headers):
    """合法 JSON 但非数组（dict）→ 400（否则 apply_filters 迭代 dict 键 → 500）。"""
    filters = json.dumps({"field": "status", "op": "eq", "value": "active"})
    resp = client.get(
        "/api/v1/crm/customers", params={"filters": filters}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_filter_malformed_json_returns_400(client, admin_headers):
    resp = client.get(
        "/api/v1/crm/customers", params={"filters": "not-json["}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_filter_malformed_between_value_returns_400(client, admin_headers):
    """between 的 value 非 [lo,hi]（如 None）会触发 TypeError，端点须转 400 而非 500。"""
    filters = json.dumps([{"field": "employeeCount", "op": "between", "value": None}])
    resp = client.get(
        "/api/v1/crm/customers", params={"filters": filters}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_filter_leads_by_intent(client, admin_headers):
    client.post(
        "/api/v1/crm/leads",
        json={"name": "L1", "intent": "high"},
        headers=admin_headers,
    )
    client.post(
        "/api/v1/crm/leads", json={"name": "L2", "intent": "low"}, headers=admin_headers
    )
    filters = json.dumps([{"field": "intent", "op": "eq", "value": "high"}])
    body = client.get(
        "/api/v1/crm/leads", params={"filters": filters}, headers=admin_headers
    ).json()
    assert body["total"] == 1 and body["items"][0]["name"] == "L1"
