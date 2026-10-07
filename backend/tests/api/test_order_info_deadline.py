"""Request-scoped PostgreSQL deadlines for order-info read endpoints."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from app.api.deps import get_read_db_session, protected
from app.api.v1.endpoints import order_info
from app.db.session import SessionLocal
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session


@pytest.fixture
def client(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Use the dedicated test DB while isolating this router from app startup."""
    app = FastAPI()
    app.include_router(order_info.router, prefix="/api/v1")
    app.dependency_overrides[protected] = lambda: None

    def override_read_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_read_db_session] = override_read_db

    # One-second test deadline exercises the real PostgreSQL SQLSTATE 57014
    # path without waiting for the production default of twenty seconds.
    monkeypatch.setattr(
        order_info,
        "get_settings",
        lambda: SimpleNamespace(order_info_statement_timeout_seconds=1),
    )
    return TestClient(app)


def test_order_info_query_deadline_returns_typed_504(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow_overview(db: Session, **kwargs):
        db.execute(text("SELECT pg_sleep(2)"))
        pytest.fail("pg_sleep should be canceled by the order-info deadline")

    monkeypatch.setattr(order_info.order_info_service, "get_overview", slow_overview)
    response = client.get(
        "/api/v1/order-info/overview",
        headers={"X-Is-Admin": "true"},
    )

    assert response.status_code == 504
    assert response.json() == {
        "detail": "查询超时，请收窄筛选条件",
        "code": "QUERY_DEADLINE_EXCEEDED",
    }


def test_concurrent_order_info_deadlines_leave_no_sleep_queries_active(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def slow_overview(db: Session, **kwargs):
        db.execute(text("SELECT pg_sleep(3)"))
        pytest.fail("pg_sleep should be canceled by the order-info deadline")

    monkeypatch.setattr(order_info.order_info_service, "get_overview", slow_overview)

    def make_request(_: int):
        with TestClient(client.app) as concurrent_client:
            return concurrent_client.get(
                "/api/v1/order-info/overview",
                headers={"X-Is-Admin": "true"},
            )

    with ThreadPoolExecutor(max_workers=5) as pool:
        responses = list(pool.map(make_request, range(5)))

    assert [response.status_code for response in responses] == [504] * 5
    with SessionLocal() as db:
        residual = db.execute(
            text(
                """
                SELECT count(*)
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND state = 'active'
                  AND query LIKE 'SELECT pg_sleep(3)%'
                """
            )
        ).scalar_one()
    assert residual == 0


def test_order_info_deadline_does_not_change_other_read_routes(
    client: TestClient,
) -> None:
    app = client.app

    @app.get("/control/slow-read")
    def slow_read(db: Session = Depends(get_read_db_session)) -> dict[str, bool]:
        db.execute(text("SELECT pg_sleep(1.2)"))
        return {"ok": True}

    response = client.get("/control/slow-read")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
