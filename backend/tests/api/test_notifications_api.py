"""通知 API 集成测试。

走 TestClient + 真实 DB（无 TEST_DATABASE_URL 则 skip，继承根 conftest 的 db_session 保护）。
每个测试前清空 notifications 表。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings


def _headers(user_id: str) -> dict[str, str]:
    """protected 依赖需要 X-API-Key；端点用 X-User-Id 识别用户。"""
    return {"X-API-Key": get_settings().api_key, "X-User-Id": user_id}


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_notifications(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("truncate notifications restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def _seed(user_id: int, n: int, read: bool = False) -> None:
    from app.db.session import SessionLocal
    from app.models.notification import Notification

    s = SessionLocal()
    try:
        for i in range(n):
            s.add(Notification(user_id=user_id, type="alert", title=f"n{i}", read=read))
        s.commit()
    finally:
        s.close()


def test_unread_count_requires_user_id(client):
    # 带 API key 过 protected，但缺 X-User-Id → 端点自身返回 401
    res = client.get(
        "/api/v1/notifications/unread-count",
        headers={"X-API-Key": get_settings().api_key},
    )
    assert res.status_code == 401


def test_unread_count(client):
    _seed(7, 3, read=False)
    _seed(7, 2, read=True)
    res = client.get("/api/v1/notifications/unread-count", headers=_headers("7"))
    assert res.status_code == 200
    assert res.json()["count"] == 3


def test_list_paginates_and_filters(client):
    _seed(7, 5)
    res = client.get("/api/v1/notifications?page=1&page_size=2", headers=_headers("7"))
    body = res.json()
    assert res.status_code == 200
    assert body["total"] == 5
    assert len(body["items"]) == 2

    res_read = client.get("/api/v1/notifications?read=true", headers=_headers("7"))
    assert res_read.json()["total"] == 0


def test_mark_read_then_all(client):
    _seed(7, 3)
    listing = client.get("/api/v1/notifications", headers=_headers("7")).json()
    first_id = listing["items"][0]["id"]

    one = client.post(f"/api/v1/notifications/{first_id}/read", headers=_headers("7"))
    assert one.status_code == 200
    assert one.json()["read"] is True

    allres = client.post("/api/v1/notifications/read-all", headers=_headers("7"))
    assert allres.status_code == 200
    assert (
        client.get("/api/v1/notifications/unread-count", headers=_headers("7")).json()[
            "count"
        ]
        == 0
    )


def test_delete_and_isolation(client):
    _seed(7, 1)
    _seed(8, 1)  # 别的用户
    listing = client.get("/api/v1/notifications", headers=_headers("7")).json()
    assert listing["total"] == 1  # 只看到自己的
    nid = listing["items"][0]["id"]

    dele = client.delete(f"/api/v1/notifications/{nid}", headers=_headers("7"))
    assert dele.status_code == 204
    assert (
        client.get("/api/v1/notifications", headers=_headers("7")).json()["total"] == 0
    )
