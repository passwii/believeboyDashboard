"""BLF-1262 Stage 2 SQL count regression tests for order-info read APIs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.core.config import get_settings
from app.db.session import engine


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _admin_headers() -> dict[str, str]:
    return {
        "X-API-Key": get_settings().api_key,
        "X-Is-Admin": "true",
        "X-Operator": "pytest-admin",
    }


def test_list_pagination_uses_two_order_row_queries_and_matches_overview(
    client: TestClient,
) -> None:
    counts: list[int] = []
    current_count = 0

    def _count_order_row_sql(conn, cursor, statement, parameters, context, executemany):
        nonlocal current_count
        if "analysis_sales_order_rows" in statement.lower():
            current_count += 1

    event.listen(engine, "before_cursor_execute", _count_order_row_sql)
    try:
        list_response = client.get(
            "/api/v1/order-info/list?page=2",
            headers=_admin_headers(),
        )
        assert list_response.status_code == 200, list_response.text[:400]
        counts.append(current_count)
        current_count = 0

        overview_response = client.get(
            "/api/v1/order-info/overview?page=1",
            headers=_admin_headers(),
        )
        assert overview_response.status_code == 200, overview_response.text[:400]
        counts.append(current_count)
    finally:
        event.remove(engine, "before_cursor_execute", _count_order_row_sql)

    list_data = list_response.json()
    overview_data = overview_response.json()
    assert counts == [2, 3], f"expected list=2 and overview=3 order-row queries, got {counts}"
    assert list_data["total"] == overview_data["total"]
    assert overview_data["total"] == overview_data["stats"]["total_orders"]
