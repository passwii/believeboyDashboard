"""客诉中心 Dashboard API 契约测试（BLF-1004）。"""

from __future__ import annotations

from datetime import date
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.api.v1.endpoints.complaints import router as complaints_router
from app.main import app
from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck
from app.models.project import Project

pytestmark = pytest.mark.usefixtures("db_session")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def dashboard_env(db_session):
    """Create one isolated project/run with sortable complaint snapshots."""
    project = Project(
        project_name=f"blf1004-{uuid.uuid4().hex[:10]}",
        project_operator="pytest",
        assistant_operator=None,
        sort_order=0,
        is_active=True,
        country="US",
    )
    db_session.add(project)
    db_session.flush()

    run = ComplaintRun(
        run_date=date(2026, 9, 9),
        trigger="autopilot",
        shops_total=1,
        shops_checked=1,
        shops_failed=[],
        summary={"total_needs_reply": 3},
        agent_id="blf1004-test-agent",
    )
    db_session.add(run)
    db_session.flush()
    db_session.add(
        ShopCheck(
            run_id=run.id,
            project_id=project.id,
            country="US",
            check_status="ok",
            metrics={"needs_reply": 3},
        )
    )

    first = Complaint(
        run_id=run.id,
        project_id=project.id,
        country="US",
        buyer_name="Buyer One",
        first_message_date=date(2026, 9, 2),
        message_date=date(2026, 9, 2),
        subject="Order complaint",
        message_body="The product arrived damaged.",
        triage={
            "category": "with_order",
            "has_order": True,
            "summary_zh": "买家反馈商品损坏",
        },
        category="with_order",
        has_order=True,
        order_info={
            "order_id": "111-1111111-1111111",
            "asin": "B0FIRST",
            "product_title": "First product",
            "qty": 1,
            "purchased_at": "2026-08-01T00:00:00+00:00",
            "shipped_at": "2026-08-02T00:00:00+00:00",
            "delivered_at": "2026-08-05T00:00:00+00:00",
        },
        sla={
            "reply_deadline": "2026-09-10T00:00:00+00:00",
            "expires_soon": False,
        },
        status="pending",
        status_history=[
            {
                "from": None,
                "to": "pending",
                "at": "2026-09-09T01:00:00+00:00",
                "by": "agent:blf1004",
            }
        ],
        message_count=1,
        messages=[],
    )
    second = Complaint(
        run_id=run.id,
        project_id=project.id,
        country="US",
        buyer_name="Buyer Two",
        first_message_date=date(2026, 9, 4),
        message_date=date(2026, 9, 4),
        subject="Shipping question",
        message_body="Where is my package?",
        triage={
            "category": "no_order_info",
            "has_order": False,
            "summary_zh": "买家询问物流",
        },
        category="no_order_info",
        has_order=False,
        order_info=None,
        sla={
            "reply_deadline": "2026-09-08T00:00:00+00:00",
            "expires_soon": True,
        },
        status="pending",
        status_history=[
            {
                "from": None,
                "to": "pending",
                "at": "2026-09-09T01:01:00+00:00",
                "by": "agent:blf1004",
            }
        ],
        message_count=1,
        messages=[],
    )
    spam = Complaint(
        run_id=run.id,
        project_id=project.id,
        country="US",
        buyer_name="Spam Buyer",
        first_message_date=date(2026, 9, 3),
        message_date=date(2026, 9, 3),
        subject="Buy cheap shoes now",
        message_body="Unrelated promotion.",
        triage={
            "category": "spam",
            "has_order": False,
            "summary_zh": "无关推广信息，已标记垃圾",
        },
        category="spam",
        has_order=False,
        order_info=None,
        sla=None,
        status="pending",
        status_history=[
            {
                "from": None,
                "to": "pending",
                "at": "2026-09-09T01:02:00+00:00",
                "by": "agent:blf1004",
            }
        ],
        message_count=1,
        messages=[],
    )
    db_session.add_all([first, second, spam])
    db_session.commit()

    try:
        yield {
            "project": project,
            "run": run,
            "first": first,
            "second": second,
            "spam": spam,
        }
    finally:
        db_session.execute(delete(Complaint).where(Complaint.project_id == project.id))
        db_session.execute(delete(ShopCheck).where(ShopCheck.project_id == project.id))
        db_session.execute(delete(ComplaintRun).where(ComplaintRun.id == run.id))
        db_session.execute(delete(Project).where(Project.id == project.id))
        db_session.commit()


def test_dashboard_routes_use_single_complaints_prefix_and_keep_overview(
    client: TestClient, dashboard_env, operator_headers
) -> None:
    from fastapi.routing import APIRoute

    route_paths = {
        route.path for route in complaints_router.routes if isinstance(route, APIRoute)
    }
    assert "/complaints" in route_paths
    assert "/complaints/{complaint_id}" in route_paths
    assert "/complaints/complaints" not in route_paths
    assert "/api/v1/complaints/complaints" not in {
        route.path for route in app.routes if isinstance(route, APIRoute)
    }

    overview = client.get(
        "/api/v1/complaints/overview?date=2026-09-09",
        headers=operator_headers,
    )
    assert overview.status_code == 200, overview.text
    assert overview.json()["date"] == "2026-09-09"


def test_dashboard_list_returns_frontend_fields_filters_pagination_and_spam_count(
    client: TestClient, dashboard_env, operator_headers
) -> None:
    response = client.get(
        "/api/v1/complaints?date=2026-09-09&sort=sla_asc&page=1&page_size=2",
        headers=operator_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 3
    assert body["page"] == 1
    assert body["page_size"] == 2
    assert body["spam_count"] == 1
    assert [item["id"] for item in body["items"]] == [
        dashboard_env["second"].id,
        dashboard_env["first"].id,
    ]

    item = body["items"][0]
    assert item["project_name"] == dashboard_env["project"].project_name
    assert item["triage"]["category"] == "no_order_info"
    assert item["order_info"] is None
    assert item["sla"]["reply_deadline"] == "2026-09-08T00:00:00Z"
    assert len(item["status_history"]) == 1

    filtered = client.get(
        "/api/v1/complaints?date=2026-09-09&category=spam&keyword=Spam&country=US",
        headers=operator_headers,
    )
    assert filtered.status_code == 200, filtered.text
    filtered_body = filtered.json()
    assert filtered_body["total"] == 1
    assert filtered_body["items"][0]["category"] == "spam"

    second_page = client.get(
        "/api/v1/complaints?date=2026-09-09&page=2&page_size=2",
        headers=operator_headers,
    )
    assert second_page.status_code == 200, second_page.text
    assert second_page.json()["page"] == 2
    assert len(second_page.json()["items"]) == 1


def test_dashboard_sort_options_are_applied_stably(client: TestClient, dashboard_env, operator_headers) -> None:
    def ids(sort: str) -> list[int]:
        response = client.get(
            f"/api/v1/complaints?date=2026-09-09&sort={sort}&page_size=100",
            headers=operator_headers,
        )
        assert response.status_code == 200, response.text
        return [item["id"] for item in response.json()["items"]]

    assert ids("sla_asc") == [
        dashboard_env["second"].id,
        dashboard_env["first"].id,
        dashboard_env["spam"].id,
    ]
    assert ids("sla_desc") == [
        dashboard_env["first"].id,
        dashboard_env["second"].id,
        dashboard_env["spam"].id,
    ]
    assert ids("date_asc") == [
        dashboard_env["first"].id,
        dashboard_env["spam"].id,
        dashboard_env["second"].id,
    ]
    assert ids("date_desc") == [
        dashboard_env["second"].id,
        dashboard_env["spam"].id,
        dashboard_env["first"].id,
    ]

    invalid = client.get(
        "/api/v1/complaints?date=2026-09-09&sort=unexpected",
        headers=operator_headers,
    )
    assert invalid.status_code == 422


def test_dashboard_detail_patch_status_history_and_404(
    client: TestClient, dashboard_env, operator_headers
) -> None:
    detail = client.get(
        f"/api/v1/complaints/{dashboard_env['first'].id}",
        headers=operator_headers,
    )
    assert detail.status_code == 200, detail.text
    detail_body = detail.json()
    assert detail_body["project_name"] == dashboard_env["project"].project_name
    assert detail_body["message_body"] == "The product arrived damaged."
    assert detail_body["order_info"]["order_id"] == "111-1111111-1111111"
    assert detail_body["triage"]["summary_zh"] == "买家反馈商品损坏"
    assert detail_body["sla"]["expires_soon"] is False
    assert detail_body["status_history"][0]["to"] == "pending"

    patched = client.patch(
        f"/api/v1/complaints/{dashboard_env['first'].id}",
        headers=operator_headers,
        json={"status": "drafted", "handler_note": "已完成草稿"},
    )
    assert patched.status_code == 200, patched.text
    patched_body = patched.json()
    assert patched_body["status"] == "drafted"
    assert patched_body["handler_note"] == "已完成草稿"
    assert patched_body["status_history"][-1]["from"] == "pending"
    assert patched_body["status_history"][-1]["to"] == "drafted"
    assert patched_body["status_history"][-1]["by"]

    backward = client.patch(
        f"/api/v1/complaints/{dashboard_env['first'].id}",
        headers=operator_headers,
        json={"status": "pending"},
    )
    assert backward.status_code == 400

    missing_get = client.get("/api/v1/complaints/999999999", headers=operator_headers)
    assert missing_get.status_code == 404
    missing_patch = client.patch(
        "/api/v1/complaints/999999999",
        headers=operator_headers,
        json={"status": "drafted"},
    )
    assert missing_patch.status_code == 404

def test_dashboard_requires_api_key(client: TestClient) -> None:
    response = client.get("/api/v1/complaints")
    assert response.status_code == 401


