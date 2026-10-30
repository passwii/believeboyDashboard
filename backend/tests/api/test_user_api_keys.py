"""BLF-711 用户专属 API Key（C2 方案）测试。

覆盖：
* 登录返回 api_key（blf_ 前缀、非空）；DB 只存 hash 不存明文；
* 业务路由带用户 key 放行（200）；主 key 仍可用；缺失 401 / 无效 403；
  Bearer / query 兜底路径同样放行；
* 登录轮换：第二次登录返回不同 key，旧 key 立即 403；
* 吊销后 403；再次登录自愈（拿到新 key 恢复 200）；
* 管理员端点：list（无明文）/ revoke（幂等 + 审计）/ rotate（返回明文一次）/
  非管理员 403 / 未知用户 404。

BLF-1059 一账号多把 key（按设备槽 ``client_id`` 分区）额外覆盖：
* 两个不同槽各登录一次 → 先登录那把**仍然有效**（核心验收；拆分前必然 403）；
* 同一槽二次登录 → 只轮换该槽，其它槽不受影响；
* 不带 ``X-Client-Id`` 落 ``default`` 槽，同槽二次登录才互顶（= 拆分前的 Web 行为）；
* 非法槽标识 → 400（不静默降级）：含首尾/内部空白、制表符、超长、非法字符一律拒，
  **不做** ``strip``——``" mac-install-a "`` 不得别名到 ``mac-install-a`` 槽；
* 撤销/轮换粒度：按 user = 全部设备，按 ``(user, client)`` = 只动那一台；
* 每账号 ``MAX_ACTIVE_KEYS_PER_USER`` 个有效槽上限：超限回收最旧一把，不清空全部；
* 改密码 → 该账号全部设备 key 失效，改密码者重登拿到可用新 key。

说明：
* 登录限流（IP 10 次/15min，内存 fallback）——autouse fixture 每次测试前
  清空 login_ip/login_email_fail 桶，避免多个登录用例互相吃配额；
* 直接通过 service 造 key（``_seed_key``）可绕过登录，节省配额；
* 端点写操作直接 commit 到测试库（对齐 test_internal_api_keys_lifecycle），
  用例自行清理 user_api_keys 行。
"""

from __future__ import annotations

import secrets
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.services import user_api_key_service

pytestmark = pytest.mark.audit_table_isolation


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


def _login(
    client: TestClient,
    settings,
    email: str,
    password: str,
    client_id: str | None = None,
) -> dict:
    """登录并返回响应体。``client_id`` 非 None 时带 ``X-Client-Id`` 头。

    缺省不带该头 —— 与网页端代理、拆分前发布的桌面端构建一致，落 ``default`` 槽。
    """
    headers = {"X-Client-Id": client_id} if client_id is not None else None
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _seed_key(user_id: str, client_id: str | None = None) -> tuple[int, str]:
    """直接走 service 造 key（绕过登录），返回 (key_id, plaintext)。

    ``client_id=None`` → ``default`` 槽（与 ``ensure_user_api_key`` 缺省一致）。
    """
    db = SessionLocal()
    try:
        row, plaintext = user_api_key_service.ensure_user_api_key(db, user_id, client_id)
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


def _health_status(client: TestClient, api_key: str) -> int:
    """带该 key 请求受保护路由的状态码（200 = 有效；403 = 已吊销）。"""
    return client.get("/api/v1/health", headers={"X-API-Key": api_key}).status_code


def _slot_rows(user_id: str) -> dict[str, dict]:
    """该用户各槽的行（槽内至多一把），以 ``client_id`` 为键。

    槽数、吊销态、key_prefix 的单一事实来源 —— 比直接数行更能表达
    「一账号多槽、槽内一把」的语义。
    """
    db = SessionLocal()
    try:
        rows = (
            db.execute(
                text(
                    "select id, client_id, key_prefix, revoked_at "
                    "from user_api_keys where user_id = CAST(:uid AS uuid) "
                    "order by client_id"
                ),
                {"uid": user_id},
            )
            .mappings()
            .all()
        )
        return {row["client_id"]: dict(row) for row in rows}
    finally:
        db.close()


def _latest_audit_after(action: str, user_id: str) -> dict:
    """最近一条该 action + 该 user 的审计 ``after_json``（测试库可能并行写入，按 user 收窄）。"""
    db = SessionLocal()
    try:
        row = (
            db.execute(
                text(
                    "select after_json from operation_audit_logs "
                    "where action = :action and after_json->>'user_id' = :uid "
                    "order by id desc limit 1"
                ),
                {"action": action, "uid": str(user_id)},
            )
            .mappings()
            .first()
        )
        return dict(row["after_json"] or {}) if row else {}
    finally:
        db.close()


def _new_test_password() -> str:
    """改密码用例的临时新密码 —— 每次运行现生成。

    不写固定字面量：与种子账号的原始密码无关，且用完立即用
    ``_restore_password_state`` 还原，不会在共享的 BLF_test 上留下痕迹。
    """
    return f"Blf{secrets.token_hex(8)}!9"


def _password_state(user_id: str) -> tuple[str, object]:
    """改密码用例前后恢复用：(password_hash, password_changed_at)。

    测试账号是 BLF_test 里的**持久种子行**，改完必须原样还原，否则同一
    DB 上的其它用例（以及其它 worktree 的测试）都会因为密码变了而登录不上。
    """
    db = SessionLocal()
    try:
        row = (
            db.execute(
                text(
                    "select password_hash, password_changed_at "
                    "from public.user_accounts where id::text = :uid"
                ),
                {"uid": str(user_id)},
            )
            .mappings()
            .one()
        )
        return str(row["password_hash"]), row["password_changed_at"]
    finally:
        db.close()


def _restore_password_state(user_id: str, state: tuple[str, object]) -> None:
    db = SessionLocal()
    try:
        db.execute(
            text(
                "update public.user_accounts "
                "set password_hash = :hash, password_changed_at = :changed_at "
                "where id::text = :uid"
            ),
            {"hash": state[0], "changed_at": state[1], "uid": str(user_id)},
        )
        db.commit()
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
        _cleanup_user_keys(test_operator["id"])
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
        _cleanup_user_keys(test_operator["id"])
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
            # 同一槽（两次都无 X-Client-Id → default）重登复用同一行，不新增行
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
        _cleanup_user_keys(test_operator["id"])
        key_id, plaintext = _seed_key(test_operator["id"])
        try:
            resp = client.get("/api/v1/internal/user-api-keys", headers=admin_headers)
            assert resp.status_code == 200, resp.text
            items = resp.json()
            # 按 key_prefix 精确定位本次造的那把（不假设用户只有一行）
            mine = [
                i
                for i in items
                if i["user_id"] == test_operator["id"]
                and i["key_prefix"] == plaintext[:12]
            ]
            assert mine, "列表应包含该用户刚签发的 key"
            assert mine[0]["id"] == key_id
            # BLF-1059：不提 X-Client-Id 的登录落 default 槽，管理面要能看出是哪台设备
            assert mine[0]["client_id"] == "default"
            assert "plaintext_key" not in mine[0]  # 列表永不返回明文
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_list_requires_admin(self, client, operator_headers):
        resp = client.get("/api/v1/internal/user-api-keys", headers=operator_headers)
        assert resp.status_code == 403

    def test_revoke_endpoint(self, client, admin_headers, test_operator):
        _cleanup_user_keys(test_operator["id"])
        key_id, plaintext = _seed_key(test_operator["id"])
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["user_id"] == test_operator["id"]
            assert body["revoked"] is True
            # 不传 client_id = 「该账号全部设备」选择器，回显 None 表示不限定槽
            assert body["client_id"] is None
            assert body["revoked_count"] == 1
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
        _cleanup_user_keys(test_operator["id"])
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

    def test_rotate_by_client_id_only_touches_that_slot(
        self, client, admin_headers, test_operator
    ):
        """设计 6：rotate 支持可选 client_id —— 给定则只轮换那一台。"""
        _cleanup_user_keys(test_operator["id"])
        _, web_key = _seed_key(test_operator["id"])
        _, mac_key = _seed_key(test_operator["id"], "mac-install-a")
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/rotate",
                params={"client_id": "mac-install-a"},
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["client_id"] == "mac-install-a"
            assert body["plaintext_key"] != mac_key
            # 该槽旧 key 失效、新 key 可用；default 槽完全不受影响
            assert _health_status(client, mac_key) == 403
            assert _health_status(client, body["plaintext_key"]) == 200
            assert _health_status(client, web_key) == 200
            # 审计 after 带 client_id
            after = _latest_audit_after("user_api_key.rotate", test_operator["id"])
            assert after["client_id"] == "mac-install-a"
            assert after["requested_client_id"] == "mac-install-a"
            assert after["user_id"] == test_operator["id"]
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_rotate_unknown_client_id_returns_404(
        self, client, admin_headers, test_operator
    ):
        _cleanup_user_keys(test_operator["id"])
        _seed_key(test_operator["id"])
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/rotate",
                params={"client_id": "ghost-install"},
                headers=admin_headers,
            )
            assert resp.status_code == 404
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_whitespace_client_id_is_rejected_not_trimmed(
        self, client, admin_headers, test_operator
    ):
        """管理面选择器不做 ``strip``：``" mac-install-a "`` 必须 400，且不动任何槽。

        回归（Tia review）：服务层原先先 ``strip()``，于是 ``" mac-install-a "`` 被
        静默归一成合法槽 ``mac-install-a`` —— 非法标识**别名**到一台合法设备，
        管理员以为吊销了别的设备，实际动的是这一台。首尾空白 / 内部空白 / 制表符
        三种形态都走 400（查询参数不经 HTTP 层 OWS 裁剪，能真实覆盖）。
        """
        _cleanup_user_keys(test_operator["id"])
        _, mac_key = _seed_key(test_operator["id"], "mac-install-a")
        try:
            for bad in (
                " mac-install-a ",
                "\tmac-install-a",
                "mac-install-a\t",
                "mac install a",
                "mac\tinstall",
            ):
                resp = client.post(
                    f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                    params={"client_id": bad},
                    headers=admin_headers,
                )
                assert resp.status_code == 400, (
                    f"{bad!r} 应被拒绝，实际 {resp.status_code}"
                )
            rows = _slot_rows(test_operator["id"])
            assert set(rows) == {"mac-install-a"}, "非法选择器不得改动/新建任何槽"
            assert rows["mac-install-a"]["revoked_at"] is None
            assert _health_status(client, mac_key) == 200
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_empty_client_id_query_means_all_devices(
        self, client, admin_headers, test_operator
    ):
        """``?client_id=``（空串）= 没给选择器 → 全部设备，不窄化成 ``default`` 槽。

        本端点的缺省语义就是「该账号全部设备」；把空串当 ``default`` 槽反而是
        静默窄化（想重置全部设备、结果只动了网页端那一把，比全量更难发现）。
        """
        _cleanup_user_keys(test_operator["id"])
        _, web_key = _seed_key(test_operator["id"])
        _, mac_key = _seed_key(test_operator["id"], "mac-install-a")
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                params={"client_id": ""},
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["client_id"] is None
            assert body["revoked_count"] == 2
            assert _health_status(client, web_key) == 403
            assert _health_status(client, mac_key) == 403
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_list_returns_client_id_and_sorts_by_user_then_client(
        self, client, admin_headers, test_operator
    ):
        """设计 6：list 透出 client_id，并按 (user_id, client_id) 排序。"""
        _cleanup_user_keys(test_operator["id"])
        _seed_key(test_operator["id"], "zzz-install")
        _seed_key(test_operator["id"], "aaa-install")
        try:
            resp = client.get("/api/v1/internal/user-api-keys", headers=admin_headers)
            assert resp.status_code == 200, resp.text
            items = resp.json()
            mine = [i for i in items if i["user_id"] == test_operator["id"]]
            assert [i["client_id"] for i in mine] == ["aaa-install", "zzz-install"]
            assert all("plaintext_key" not in i for i in mine)
        finally:
            _cleanup_user_keys(test_operator["id"])


# ─────────────── 多设备槽（BLF-1059：一账号多把 key，按设备分区） ──────────────


class TestMultiClientSlots:
    """验收 1/2/3：槽间互不顶掉、槽内轮换、缺省落 default。"""

    def test_two_clients_do_not_evict_each_other(
        self, client, settings, test_operator
    ):
        """验收 1（核心）：两个不同 client_id 各登录一次，先登录那把**仍然有效**。

        拆分前 user_id 唯一 → 第二次登录覆写同一行，第一个调用方的 key 立刻 403。
        这是本 stage 要修的核心体验硬伤。
        """
        _cleanup_user_keys(test_operator["id"])
        web = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        desktop = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
            client_id="mac-install-a",
        )
        try:
            assert web["api_key"] != desktop["api_key"]
            assert _health_status(client, web["api_key"]) == 200, (
                "网页端 key 不应被桌面端登录顶掉"
            )
            assert _health_status(client, desktop["api_key"]) == 200
            rows = _slot_rows(test_operator["id"])
            assert set(rows) == {"default", "mac-install-a"}
            assert all(r["revoked_at"] is None for r in rows.values())
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_same_client_relogin_rotates_only_that_slot(
        self, client, settings, test_operator
    ):
        """验收 2：同一 client_id 二次登录 → 该设备旧 key 立即失效，其它槽不受影响。"""
        _cleanup_user_keys(test_operator["id"])
        mac_first = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
            client_id="mac-install-a",
        )
        web = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        mac_second = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
            client_id="mac-install-a",
        )
        try:
            assert mac_first["api_key"] != mac_second["api_key"]
            assert _health_status(client, mac_first["api_key"]) == 403
            assert _health_status(client, mac_second["api_key"]) == 200
            assert _health_status(client, web["api_key"]) == 200, (
                "同槽轮换不应动到 default 槽"
            )
            rows = _slot_rows(test_operator["id"])
            # 同槽重登复用同一行（行数不随登录次数增长）
            assert set(rows) == {"default", "mac-install-a"}
            assert len(rows) == 2
            assert all(r["revoked_at"] is None for r in rows.values())
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_missing_client_id_stays_in_default_slot(
        self, client, settings, test_operator
    ):
        """验收 3：不带设备标识 → 落 default 槽，同槽二次登录才互顶（= 今天的 Web 行为）。"""
        _cleanup_user_keys(test_operator["id"])
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
            assert _health_status(client, first["api_key"]) == 403
            assert _health_status(client, second["api_key"]) == 200
            rows = _slot_rows(test_operator["id"])
            assert set(rows) == {"default"}, "不带标识的调用方只占 default 一个槽"
            assert rows["default"]["revoked_at"] is None
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_invalid_client_id_is_rejected(self, client, settings, test_operator):
        """非法槽标识 → 400，且不落任何行。

        不静默降级为 ``default``：发错标识的设备若与网页端共用一把 key，会回到
        「互相顶掉」且极难排查。

        空白一律非法（``strip`` 已移除）：``"   "`` 不再被当成"空标识"落 ``default``，
        因为它是**含空白**的值；只有真正的空串（``X-Client-Id:`` 无值）走兼容规则，
        见 ``test_blank_client_id_falls_back_to_default``。
        """
        _cleanup_user_keys(test_operator["id"])
        try:
            for bad in (
                "bad id",
                "x" * 65,
                "semi;colon",
                "with/slash",
                "tab\tsep",
                " pad-in-id ",
                "\tlead-tab",
                "trail-tab\t",
                "   ",
            ):
                resp = client.post(
                    "/api/v1/auth/login",
                    json={
                        "email": settings.test_operator_email,
                        "password": settings.test_operator_password,
                    },
                    headers={"X-Client-Id": bad},
                )
                assert resp.status_code == 400, (
                    f"{bad!r} 应被拒绝，实际 {resp.status_code}"
                )
            assert _slot_rows(test_operator["id"]) == {}, "非法标识不应落任何槽"
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_blank_client_id_falls_back_to_default(self, client, settings, test_operator):
        """空串标识（``X-Client-Id:`` 无值）→ ``default`` 槽（等价于不带该头）。

        兼容规则只给真正的空值：全空白（``"   "``）是含空白的非法值，走 400 —— 见
        ``test_invalid_client_id_is_rejected``。
        """
        _cleanup_user_keys(test_operator["id"])
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
            client_id="",
        )
        try:
            assert _health_status(client, body["api_key"]) == 200
            assert set(_slot_rows(test_operator["id"])) == {"default"}
        finally:
            _cleanup_user_keys(test_operator["id"])


class TestRevokeGranularity:
    """验收 4：按 user = 全部设备；按 (user, client) = 只失效那一台。"""

    def _seed_three_devices(self, user_id: str) -> dict[str, str]:
        return {
            "default": _seed_key(user_id)[1],
            "mac-install-a": _seed_key(user_id, "mac-install-a")[1],
            "win-install-b": _seed_key(user_id, "win-install-b")[1],
        }

    def test_revoke_without_client_id_kills_all_devices(
        self, client, admin_headers, test_operator
    ):
        _cleanup_user_keys(test_operator["id"])
        keys = self._seed_three_devices(test_operator["id"])
        try:
            assert all(_health_status(client, k) == 200 for k in keys.values())
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["revoked"] is True
            assert body["client_id"] is None, "不传 client_id = 不限定槽（全部设备）"
            assert body["revoked_count"] == 3
            for slot, key in keys.items():
                assert _health_status(client, key) == 403, f"{slot} 槽应已失效"
            after = _latest_audit_after("user_api_key.revoke", test_operator["id"])
            assert after["client_id"] is None
            assert after["revoked_count"] == 3
            assert len(after["changed_key_ids"]) == 3
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_revoke_by_client_id_kills_only_that_slot(
        self, client, admin_headers, test_operator
    ):
        _cleanup_user_keys(test_operator["id"])
        keys = self._seed_three_devices(test_operator["id"])
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                params={"client_id": "mac-install-a"},
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["client_id"] == "mac-install-a"
            assert body["revoked_count"] == 1
            assert _health_status(client, keys["mac-install-a"]) == 403
            assert _health_status(client, keys["default"]) == 200
            assert _health_status(client, keys["win-install-b"]) == 200
            after = _latest_audit_after("user_api_key.revoke", test_operator["id"])
            assert after["client_id"] == "mac-install-a"
            assert after["revoked_count"] == 1
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_revoke_unknown_slot_returns_404(
        self, client, admin_headers, test_operator
    ):
        _cleanup_user_keys(test_operator["id"])
        _seed_key(test_operator["id"], "mac-install-a")
        try:
            resp = client.post(
                f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke",
                params={"client_id": "ghost-install"},
                headers=admin_headers,
            )
            assert resp.status_code == 404
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_revoke_all_is_idempotent(
        self, client, admin_headers, test_operator
    ):
        """幂等：重放不刷时间、``revoked_count`` 归零，但仍是 200（有行就 200）。"""
        _cleanup_user_keys(test_operator["id"])
        _seed_key(test_operator["id"])
        try:
            url = f"/api/v1/internal/user-api-keys/{test_operator['id']}/revoke"
            first = client.post(url, headers=admin_headers)
            assert first.status_code == 200
            assert first.json()["revoked_count"] == 1
            second = client.post(url, headers=admin_headers)
            assert second.status_code == 200
            assert second.json()["revoked_count"] == 0
        finally:
            _cleanup_user_keys(test_operator["id"])


class TestSlotLimit:
    """验收 5：每账号有效槽上限，超限回收最旧一把且不清空全部。"""

    def test_documented_default_limit_is_five(self):
        assert user_api_key_service.MAX_ACTIVE_KEYS_PER_USER == 5

    def test_extra_slot_evicts_oldest_without_clearing_all(
        self, client, test_operator
    ):
        limit = user_api_key_service.MAX_ACTIVE_KEYS_PER_USER
        _cleanup_user_keys(test_operator["id"])
        seeded: list[tuple[str, str]] = []
        for i in range(1, limit + 1):
            _, plaintext = _seed_key(test_operator["id"], f"slot-{i}")
            seeded.append((f"slot-{i}", plaintext))
        try:
            rows = _slot_rows(test_operator["id"])
            assert len(rows) == limit
            assert all(r["revoked_at"] is None for r in rows.values())

            # 第 limit+1 个槽 → 回收最旧一把（slot-1），不拒绝登录、不清空全部
            _, newest = _seed_key(test_operator["id"], f"slot-{limit + 1}")
            rows = _slot_rows(test_operator["id"])
            assert len(rows) == limit + 1, "回收写 revoked_at 而非删行，保留审计轨迹"
            active = {c for c, r in rows.items() if r["revoked_at"] is None}
            assert active == {f"slot-{i}" for i in range(2, limit + 2)}
            assert rows["slot-1"]["revoked_at"] is not None
            assert 0 < len(active) < len(rows), "绝不能把该账号全部 key 清空"

            # 被回收那把真的不可用；最新那把可用；其它槽不受影响
            assert _health_status(client, seeded[0][1]) == 403
            assert _health_status(client, newest) == 200
            assert _health_status(client, seeded[1][1]) == 200
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_limit_counts_only_active_keys(self, test_operator):
        """已吊销的槽不占额度：吊销 slot-1 后再开一个新槽不应回收 slot-2。"""
        limit = user_api_key_service.MAX_ACTIVE_KEYS_PER_USER
        _cleanup_user_keys(test_operator["id"])
        for i in range(1, limit + 1):
            _seed_key(test_operator["id"], f"slot-{i}")
        db = SessionLocal()
        try:
            user_api_key_service.revoke_user_key(db, test_operator["id"], "slot-1")
            db.commit()
        finally:
            db.close()
        try:
            _, newest = _seed_key(test_operator["id"], f"slot-{limit + 1}")
            active = {
                c: r
                for c, r in _slot_rows(test_operator["id"]).items()
                if r["revoked_at"] is None
            }
            assert set(active) == {f"slot-{i}" for i in range(2, limit + 2)}
            assert newest[:12] == active[f"slot-{limit + 1}"]["key_prefix"]
        finally:
            _cleanup_user_keys(test_operator["id"])


class TestPasswordChangeRevokesKeys:
    """验收 6：改密码 → 该账号全部设备 key 失效；改密码者重登拿到可用新 key。

    落点唯一：``PATCH /system-management/users/{id}``（``password`` 非空时）。
    自助改密码与管理员重置他人密码走的是同一个端点，故两条路径在此各测一遍。
    """

    def _login_three_devices(
        self, client: TestClient, settings, email: str, password: str
    ) -> dict[str, str]:
        return {
            "default": _login(client, settings, email, password)["api_key"],
            "mac-install-a": _login(
                client, settings, email, password, client_id="mac-install-a"
            )["api_key"],
            "win-install-b": _login(
                client, settings, email, password, client_id="win-install-b"
            )["api_key"],
        }

    def test_self_password_change_revokes_all_devices(
        self, client, settings, test_operator, operator_headers
    ):
        _cleanup_user_keys(test_operator["id"])
        keys = self._login_three_devices(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        state = _password_state(test_operator["id"])
        new_password = _new_test_password()
        try:
            assert all(_health_status(client, k) == 200 for k in keys.values())
            resp = client.patch(
                f"/api/v1/system-management/users/{test_operator['id']}",
                json={"password": new_password},
                headers=operator_headers,
            )
            assert resp.status_code == 200, resp.text
            for slot, key in keys.items():
                assert _health_status(client, key) == 403, f"{slot} 槽在改密码后应失效"
            # 改密码者重新登录拿到可用新 key
            relogin = _login(
                client, settings, settings.test_operator_email, new_password
            )
            assert relogin["api_key"] not in keys.values()
            assert _health_status(client, relogin["api_key"]) == 200
        finally:
            _restore_password_state(test_operator["id"], state)
            _cleanup_user_keys(test_operator["id"])

    def test_admin_reset_revokes_all_devices(
        self, client, settings, test_businessdev, admin_headers
    ):
        """管理员重置**他人**密码同样撤销该账号全部设备 key。"""
        _cleanup_user_keys(test_businessdev["id"])
        keys = self._login_three_devices(
            client,
            settings,
            settings.test_businessdev_email,
            settings.test_businessdev_password,
        )
        state = _password_state(test_businessdev["id"])
        new_password = _new_test_password()
        try:
            resp = client.patch(
                f"/api/v1/system-management/users/{test_businessdev['id']}",
                json={"password": new_password},
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            for slot, key in keys.items():
                assert _health_status(client, key) == 403, f"{slot} 槽应被重置撤销"
            relogin = _login(
                client, settings, settings.test_businessdev_email, new_password
            )
            assert _health_status(client, relogin["api_key"]) == 200
        finally:
            _restore_password_state(test_businessdev["id"], state)
            _cleanup_user_keys(test_businessdev["id"])

    def test_other_field_update_does_not_revoke_keys(
        self, client, settings, test_operator, operator_headers
    ):
        """只改名（``password`` 为空）不应吊销任何 key —— 避免顺手把设备都踢下线。"""
        _cleanup_user_keys(test_operator["id"])
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
            client_id="mac-install-a",
        )
        try:
            resp = client.patch(
                f"/api/v1/system-management/users/{test_operator['id']}",
                json={"full_name": test_operator["full_name"]},
                headers=operator_headers,
            )
            assert resp.status_code == 200, resp.text
            assert _health_status(client, body["api_key"]) == 200
            rows = _slot_rows(test_operator["id"])
            assert rows["mac-install-a"]["revoked_at"] is None
        finally:
            _cleanup_user_keys(test_operator["id"])


class TestClientIdStrictValidation:
    """``normalize_client_id`` 的严格校验（服务层单测，不经 HTTP 层）。

    HTTP 层（h11 / starlette）可能裁掉 header 值两侧的 OWS，所以"原始值校验"
    必须有服务层单测兜底：``" foo "`` 这类值即使从 header 进不来，也可能从管理面
    查询参数或未来任何内部调用进来 —— 一旦 ``strip``，就等于让非法标识**别名**到
    一台合法设备的槽（发错标识的客户端会顶掉真正那台的 key，两边都难察觉）。
    """

    def test_none_and_empty_string_use_default_slot(self) -> None:
        assert user_api_key_service.normalize_client_id(None) == "default"
        assert user_api_key_service.normalize_client_id("") == "default"

    @pytest.mark.parametrize(
        "value",
        [
            " foo ",  # 首尾空白（原先被 strip 成合法槽）
            " foo",
            "foo ",
            "\tfoo",
            "foo\t",
            "\t",  # 全空白：含空白的非法值，不再是"空标识"
            "   ",
            "foo bar",  # 内部空白
            "foo\nbar",  # 控制字符
            "foo\r",
            "foo\r\n",
            "foo\u00a0",  # 非 ASCII 空白（strip 会吃掉的形态）
            "semi;colon",
            "with/slash",
            "x" * 65,
        ],
    )
    def test_invalid_values_raise_value_error(self, value: str) -> None:
        with pytest.raises(ValueError):
            user_api_key_service.normalize_client_id(value)

    def test_valid_charset_and_length_boundary(self) -> None:
        """契约内的合法值原样透传（含 64 字符上限边界）。"""
        for ok in ("default", "mac-install-a", "a.b:c_d-1", "x" * 64, "0" * 64):
            assert user_api_key_service.normalize_client_id(ok) == ok

    def test_whitespace_variant_does_not_alias_legal_slot(
        self, client, test_operator
    ):
        """核心回归：非法 ``" mac-install-a "`` 不得动到 ``mac-install-a`` 槽那把 key。"""
        _cleanup_user_keys(test_operator["id"])
        _, mac_key = _seed_key(test_operator["id"], "mac-install-a")
        db = SessionLocal()
        try:
            with pytest.raises(ValueError):
                user_api_key_service.ensure_user_api_key(
                    db, test_operator["id"], " mac-install-a "
                )
            db.rollback()
        finally:
            db.close()
        try:
            rows = _slot_rows(test_operator["id"])
            assert set(rows) == {"mac-install-a"}, "非法标识不得新建槽"
            assert rows["mac-install-a"]["revoked_at"] is None
            assert _health_status(client, mac_key) == 200, "真正那台设备的 key 不受影响"
        finally:
            _cleanup_user_keys(test_operator["id"])

    def test_login_rejects_whitespace_client_id_header(
        self, client, settings, test_operator
    ):
        """登录路径同样严格：``X-Client-Id`` 带首尾空白 / 制表符 / 全空白 → 400。

        校验发生在限流之前，故不会吃登录配额（失败请求也不落任何槽）。
        """
        _cleanup_user_keys(test_operator["id"])
        try:
            for bad in (
                " mac-install-a ",
                "\tmac-install-a",
                "mac-install-a\t",
                "   ",
            ):
                resp = client.post(
                    "/api/v1/auth/login",
                    json={
                        "email": settings.test_operator_email,
                        "password": settings.test_operator_password,
                    },
                    headers={"X-Client-Id": bad},
                )
                assert resp.status_code == 400, (
                    f"{bad!r} 应被拒绝，实际 {resp.status_code}"
                )
            assert _slot_rows(test_operator["id"]) == {}, "非法标识不应落任何槽"
        finally:
            _cleanup_user_keys(test_operator["id"])


class TestAuthErrorSemantics:
    """验收 7：``resolve_user_key`` 语义与拆分前一致。"""

    def test_missing_key_returns_401_with_message(self, client):
        resp = client.get("/api/v1/health")
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing API key"

    def test_invalid_key_returns_403_with_message(self, client):
        resp = client.get("/api/v1/health", headers={"X-API-Key": "blf_not-a-real-key"})
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Invalid API key"

    def test_revoked_key_returns_403_with_message(
        self, client, settings, test_operator
    ):
        _cleanup_user_keys(test_operator["id"])
        body = _login(
            client,
            settings,
            settings.test_operator_email,
            settings.test_operator_password,
        )
        try:
            _revoke_key(test_operator["id"])
            resp = client.get(
                "/api/v1/health", headers={"X-API-Key": body["api_key"]}
            )
            assert resp.status_code == 403
            assert resp.json()["detail"] == "Invalid API key"
        finally:
            _cleanup_user_keys(test_operator["id"])
