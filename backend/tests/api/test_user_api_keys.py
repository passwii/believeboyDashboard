"""BLF-711 用户专属 API Key（C2 方案）测试。

覆盖：
* 登录返回 api_key（blf_ 前缀、非空）；DB 只存 hash 不存明文；
* 业务路由带用户 key 放行（200）；主 key 仍可用；缺失 401 / 无效 403；
  Bearer / query 兜底路径同样放行；
* 登录轮换：第二次登录返回不同 key，旧 key 立即 403；
* 吊销后 403；再次登录自愈（拿到新 key 恢复 200）；
* 管理员端点：list（无明文）/ revoke（幂等 + 审计）/ rotate（返回明文一次）/
  非管理员 403 / 未知用户 404。

说明：
* 登录限流（IP 10 次/15min，内存 fallback）——autouse fixture 每次测试前
  清空 login_ip/login_email_fail 桶，避免多个登录用例互相吃配额；
* 直接通过 service 造 key（``_seed_key``）可绕过登录，节省配额；
* 端点写操作直接 commit 到测试库（对齐 test_internal_api_keys_lifecycle），
  用例自行清理 user_api_keys 行。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.services import user_api_key_service


@pytest.fixture(autouse=True)
def _clear_login_rate_limits(settings) -> None:
    """清空登录限流桶（Redis 与内存 fallback 双清），避免用例互吃配额。

    登录限流：IP 10 次/15min + 邮箱 5 次/30min。本文件多个用例都走
    ``/auth/login``，且 Redis 桶跨测试进程持久（本机 Redis 可能已启动），
    不清理会随时间累积出 429 抖动。
    """
    from app.services import rate_limit_service as rl

    emails = [settings.test_operator_email, settings.test_businessdev_email]
    # Redis 桶（clear_key 只在 Redis 可用时删除键）
    rl.clear_key("login_ip", "testclient")
    for email in emails:
        rl.clear_key("login_email_fail", email.strip().lower())
    # 内存 fallback 桶（Redis 未启动时生效）
    with rl._MEMORY_LOCK:
        rl._IN_MEMORY.pop("login_ip:testclient", None)
        for email in emails:
            rl._IN_MEMORY.pop(f"login_email_fail:{email.strip().lower()}", None)
    yield


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


# ─────────────────────────── 工具函数 ─────────────────────────────────────────


def _login(client: TestClient, settings, email: str, password: str) -> dict:
    resp = client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _seed_key(user_id: str) -> tuple[int, str]:
    """直接走 service 造 key（绕过登录），返回 (key_id, plaintext)。"""
    db = SessionLocal()
    try:
        row, plaintext = user_api_key_service.ensure_user_api_key(db, user_id)
        db.commit()
        return row.id, plaintext
    finally:
        db.close()


def _revoke_key(user_id: str) -> None:
    db = SessionLocal()
    try:
        user_api_key_service.revoke_user_key(db, user_id)
        db.commit()
    finally:
        db.close()


def _cleanup_user_keys(user_id: str) -> None:
    db = SessionLocal()
    try:
        db.execute(
            text("DELETE FROM user_api_keys WHERE user_id = CAST(:uid AS uuid)"),
            {"uid": user_id},
        )
        db.commit()
    finally:
        db.close()


def _audit_action(key_id: int, action: str) -> dict | None:
    db = SessionLocal()
    try:
        row = (
            db.execute(
                text(
                    "select operator, action, target_type, target_id "
                    "from operation_audit_logs "
                    "where target_id = CAST(:id AS varchar) and action = :action "
                    "order by id desc limit 1"
                ),
                {"id": str(key_id), "action": action},
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None
    finally:
        db.close()


# ─────────────────────────── 登录下发 / 鉴权矩阵 ─────────────────────────────


class TestLoginIssuesKey:
    def test_login_returns_api_key(self, client, settings, test_operator):
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            assert body["api_key"], "登录响应必须携带 api_key"
            assert body["api_key"].startswith("blf_")
            assert len(body["api_key"]) > 30
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_db_stores_hash_not_plaintext(self, client, settings, test_operator):
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            plaintext = body["api_key"]
            db = SessionLocal()
            try:
                row = (
                    db.execute(
                        text(
                            "select key_hash, key_prefix, revoked_at "
                            "from user_api_keys where user_id = CAST(:uid AS uuid)"
                        ),
                        {"uid": test_operator["id"]},
                    )
                    .mappings()
                    .first()
                )
            finally:
                db.close()
            assert row is not None
            assert row["key_hash"] != plaintext  # 只存 hash
            assert row["key_hash"] == user_api_key_service.hash_key(plaintext)
            assert row["key_prefix"] == plaintext[:12]
            assert row["revoked_at"] is None
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_user_key_authorizes_protected_route(self, client, settings, test_operator):
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            resp = client.get("/api/v1/health", headers={"X-API-Key": body["api_key"]})
            assert resp.status_code == 200, resp.text
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_user_key_via_bearer_and_query(self, client, settings, test_operator):
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            resp = client.get(
                "/api/v1/health", headers={"Authorization": f"Bearer {body['api_key']}"}
            )
            assert resp.status_code == 200, resp.text
            resp = client.get(f"/api/v1/health?api_key={body['api_key']}")
            assert resp.status_code == 200, resp.text
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_master_key_still_works(self, client, settings):
        resp = client.get("/api/v1/health", headers={"X-API-Key": settings.api_key})
        assert resp.status_code == 200, resp.text

    def test_missing_key_returns_401(self, client):
        resp = client.get("/api/v1/health")
        assert resp.status_code == 401

    def test_invalid_key_returns_403(self, client):
        resp = client.get(
            "/api/v1/health", headers={"X-API-Key": "definitely-not-a-key"}
        )
        assert resp.status_code == 403

    def test_revoked_key_returns_403(self, client, settings, test_operator):
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            _revoke_key(test_operator["id"])
            resp = client.get("/api/v1/health", headers={"X-API-Key": body["api_key"]})
            assert resp.status_code == 403
        finally:
            _cleanup_user_keys(test_operator["id"])


# ─────────────────────────── 轮换 / 自愈 ─────────────────────────────────────


class TestLoginRotation:
    def test_login_rotates_key(self, client, settings, test_operator):
        first = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        second = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            assert first["api_key"] != second["api_key"]
            # 旧 key 立即失效，新 key 可用
            resp = client.get("/api/v1/health", headers={"X-API-Key": first["api_key"]})
            assert resp.status_code == 403
            resp = client.get(
                "/api/v1/health", headers={"X-API-Key": second["api_key"]}
            )
            assert resp.status_code == 200
            # 每用户至多一行（user_id unique）
            db = SessionLocal()
            try:
                count = db.execute(
                    text(
                        "select count(*) from user_api_keys "
                        "where user_id = CAST(:uid AS uuid)"
                    ),
                    {"uid": test_operator["id"]},
                ).scalar_one()
            finally:
                db.close()
            assert count == 1
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_login_after_revoke_self_heals(self, client, settings, test_operator):
        first = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            _revoke_key(test_operator["id"])
            resp = client.get("/api/v1/health", headers={"X-API-Key": first["api_key"]})
            assert resp.status_code == 403
            # 再次登录自动补发新 key
            second = _login(
                client,
                settings,
                settings.test_operator_email,
                settings.test_operator_password,
            )
            assert second["api_key"] != first["api_key"]
            resp = client.get(
                "/api/v1/health", headers={"X-API-Key": second["api_key"]}
            )
            assert resp.status_code == 200
        finally:
            _cleanup_user_keys(test_operator["id"])


# ─────────────────────────── 管理员端点 ──────────────────────────────────────


class TestAdminEndpoints:
    def test_list_user_api_keys(self, client, admin_headers, test_operator):
        key_id, plaintext = _seed_key(test_operator["id"])
        try:
            resp = client.get("/api/v1/internal/user-api-keys", headers=admin_headers)
            assert resp.status_code == 200, resp.text
            items = resp.json()
            mine = [i for i in items if i["user_id"] == test_operator["id"]]
            assert mine, "列表应包含该用户的 key"
            assert mine[0]["key_prefix"] == plaintext[:12]
            assert "plaintext_key" not in mine[0]  # 列表永不返回明文
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_list_requires_admin(self, client, operator_headers):
        resp = client.get("/api/v1/internal/user-api-keys", headers=operator_headers)
        assert resp.status_code == 403

    def test_revoke_endpoint(self, client, admin_headers, test_operator):
        key_id, plaintext = _seed_key(test_operator["id"])
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == {"user_id": test_operator["id"], "revoked": True}
            # 旧 key 立即 403
            resp = client.get("/api/v1/health", headers={"X-API-Key": plaintext})
            assert resp.status_code == 403
            # 审计行
            audit = _audit_action(key_id, "user_api_key.revoke")
            assert audit is not None
            assert audit["target_type"] == "user_api_key"
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_revoke_unknown_user_returns_404(self, client, admin_headers):
        resp = client.post(
            f"/api/v1/internal/user-api-keys/{uuid.uuid4()}/revoke",
            headers=admin_headers,
        )
        assert resp.status_code == 404

    def test_revoke_requires_admin(self, client, operator_headers, test_operator):
        resp = client.post(
            f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
            headers=operator_headers,
        )
        assert resp.status_code == 403

    def test_rotate_endpoint(self, client, admin_headers, test_operator):
        key_id, old_plaintext = _seed_key(test_operator["id"])
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/rotate",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["plaintext_key"].startswith("blf_")
            assert body["plaintext_key"] != old_plaintext
            # 旧 key 失效、新 key 可用
            resp = client.get("/api/v1/health", headers={"X-API-Key": old_plaintext})
            assert resp.status_code == 403
            resp = client.get(
                "/api/v1/health", headers={"X-API-Key": body["plaintext_key"]}
            )
            assert resp.status_code == 200
            # 审计行
            audit = _audit_action(key_id, "user_api_key.rotate")
            assert audit is not None
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_rotate_unknown_user_returns_404(self, client, admin_headers):
        resp = client.post(
            f"/api/v1/internal/user-api-keys/{uuid.uuid4()}/rotate",
            headers=admin_headers,
        )
        assert resp.status_code == 404
