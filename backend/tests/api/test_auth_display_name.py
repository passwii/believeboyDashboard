"""``/auth/login`` 与 ``/auth/me`` 的显示名字段（BLF-1441）。

口径：全局人物显示名唯一来源是 ``user_accounts.full_name``。登录 / me 响应必须
把它带给前端（会话 → ``X-Operator`` 请求头 → 各类 created_by 快照），同时
``name``（登录名）保持不变、不参与展示。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _login(client: TestClient, email: str, password: str) -> dict:
    resp = client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _headers(settings, user_id: str, email: str) -> dict:
    return {
        "X-API-Key": settings.api_key,
        "X-User-Id": user_id,
        "X-User-Email": email,
    }


def test_login_returns_full_name(client, settings, test_operator):
    """登录响应带 full_name，且 name 仍是登录名（旧字段语义不变）。"""
    body = _login(
        client, settings.test_operator_email, settings.test_operator_password
    )

    assert body["full_name"] == test_operator["full_name"]
    assert body["name"] == test_operator["name"]


def test_me_returns_full_name(client, settings, test_operator):
    resp = client.get(
        "/api/v1/auth/me",
        headers=_headers(settings, str(test_operator["id"]), test_operator["email"]),
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["full_name"] == test_operator["full_name"]
    assert body["name"] == test_operator["name"]


def test_full_name_is_null_when_account_has_no_chinese_name(
    client, settings, db_session
):
    """full_name 为空 → 返回 null，**不**回落成登录名（前端展示「未命名」）。"""
    email = f"blf1441-noname-{uuid.uuid4().hex[:8]}@example.invalid"
    user_id = db_session.execute(
        text(
            """
            insert into public.user_accounts
                (name, email, password_hash, full_name, is_active)
            values ('NoChineseName', :email, :h, null, true)
            returning id::text
            """
        ),
        {"email": email, "h": "x" * 24},
    ).scalar_one()
    db_session.commit()
    try:
        resp = client.get(
            "/api/v1/auth/me", headers=_headers(settings, user_id, email)
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["full_name"] is None
        assert body["name"] == "NoChineseName"
    finally:
        db_session.execute(
            text("delete from public.user_accounts where email = :email"),
            {"email": email},
        )
        db_session.commit()
