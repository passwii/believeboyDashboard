"""P6a 价值评分端点集成测试（PATCH /customers/{id}/value-scores）。"""

import json

import pytest
from sqlalchemy import text

from app.db.session import SessionLocal


def _mk(client, admin_headers, name="P6A"):
    return client.post(
        "/api/v1/crm/customers",
        json={"name": name},
        headers=admin_headers,
    ).json()["id"]


def test_full_set_recomputes_and_audits(client, admin_headers):
    cid = _mk(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/customers/{cid}/value-scores",
        json={
            "score_scale": "A",
            "score_pay": "A",
            "score_fit": "A",
            "score_coop": "A",
        },
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rating"] == "A" and body["score_scale"] == "A"
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": cid, "action": "update"},
        headers=admin_headers,
    ).json()
    assert logs["total"] == 1
    assert "价值评分" in logs["items"][0]["summary"]
    assert "综合A" in logs["items"][0]["summary"]


def test_partial_keeps_rating_and_audits_unrated(client, admin_headers):
    cid = _mk(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale": "A", "score_pay": "B"},
        headers=admin_headers,
    )
    # 仅 2 维 → rating 保持默认 "C" 不动（设计 spec §3.2）
    assert r.status_code == 200 and r.json()["rating"] == "C"
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": cid, "action": "update"},
        headers=admin_headers,
    ).json()
    assert logs["total"] == 1
    assert (
        "待完善" in logs["items"][0]["summary"] or "未" in logs["items"][0]["summary"]
    )


def test_invalid_grade_422(client, admin_headers):
    cid = _mk(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/customers/{cid}/value-scores",
        json={"score_scale": "E"},
        headers=admin_headers,
    )
    # Pydantic Literal["A","B","C","D"] 先拦截 → 422
    assert r.status_code == 422


def test_audit_failure_rolls_back_business(client, admin_headers, monkeypatch):
    from app.services.crm import audit_service

    cid = _mk(client, admin_headers)

    def _boom(*a, **k):
        raise RuntimeError("audit boom")

    monkeypatch.setattr(audit_service, "record_log", _boom)
    with pytest.raises(RuntimeError, match="audit boom"):
        client.patch(
            f"/api/v1/crm/customers/{cid}/value-scores",
            json={
                "score_scale": "A",
                "score_pay": "A",
                "score_fit": "A",
                "score_coop": "A",
            },
            headers=admin_headers,
        )
    s = SessionLocal()
    try:
        n = s.execute(
            text("select count(*) from crm_customers where score_scale='A' and id=:i"),
            {"i": cid},
        ).scalar_one()
    finally:
        s.close()
    assert n == 0


def test_404_when_customer_missing(client, admin_headers):
    r = client.patch(
        "/api/v1/crm/customers/999999/value-scores",
        json={"score_scale": "A"},
        headers=admin_headers,
    )
    assert r.status_code == 404


# ── Task 6：列表返回 score + filter 白名单 ──────────────────────────────────


def test_list_customers_includes_scores(client, admin_headers):
    cid = _mk(client, admin_headers)
    client.patch(
        f"/api/v1/crm/customers/{cid}/value-scores",
        json={
            "score_scale": "A",
            "score_pay": "B",
            "score_fit": "C",
            "score_coop": "D",
        },
        headers=admin_headers,
    )
    body = client.get("/api/v1/crm/customers", headers=admin_headers).json()
    item = next(i for i in body["items"] if i["id"] == cid)
    assert item["score_scale"] == "A"
    assert item["score_pay"] == "B"
    assert item["score_fit"] == "C"
    assert item["score_coop"] == "D"
    # A B C D → (4+3+2+1)/4 = 2.5 → B
    assert item["rating"] == "B"


def test_filter_by_rating(client, admin_headers):
    cid = _mk(client, admin_headers)
    client.patch(
        f"/api/v1/crm/customers/{cid}/value-scores",
        json={
            "score_scale": "A",
            "score_pay": "A",
            "score_fit": "A",
            "score_coop": "A",
        },
        headers=admin_headers,
    )
    r = client.get(
        "/api/v1/crm/customers",
        params={"filters": json.dumps([{"field": "rating", "op": "eq", "value": "A"}])},
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert cid in [i["id"] for i in r.json()["items"]]


def test_filter_by_score_pay(client, admin_headers):
    cid = _mk(client, admin_headers)
    client.patch(
        f"/api/v1/crm/customers/{cid}/value-scores",
        json={
            "score_scale": "A",
            "score_pay": "A",
            "score_fit": "A",
            "score_coop": "A",
        },
        headers=admin_headers,
    )
    r = client.get(
        "/api/v1/crm/customers",
        params={
            "filters": json.dumps([{"field": "score_pay", "op": "eq", "value": "A"}])
        },
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert cid in [i["id"] for i in r.json()["items"]]
