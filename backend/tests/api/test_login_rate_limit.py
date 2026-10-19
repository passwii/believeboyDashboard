"""BLF-1381 登录限流：只统计**失败**尝试，且重置密码 / 删除重建清掉残留桶。

背景（用户报障）：「管理员重置密码后，该用户无法再 login」。复现路径是
重置动作本身没坏，坏的是登录限流：

1. ``/auth/login`` 把**每次**尝试（含成功）都写进两个桶 —— 于是用户用旧密码
   试错 5 次（重置前后的正常动作）就把 ``login_email_fail`` 打满，随后的
   **正确新密码**照样 429，窗口 30 分钟；
2. ``clear_key`` 只清 Redis，Redis 掉线时内存兜底桶永不清零；
3. 被拒绝的请求也继续 ``zadd``，重试自己把锁往后推（自续期锁死）；
4. 删除后重建同邮箱账号，新账号继承旧账号的失败计数（"旧密码/旧账号残留"
   的真实形态 —— 表现为"登不进去"，而不是"旧密码还能用"）。

本文件锁住修复后的口径：成功登录零消耗；失败才计数；重置密码 / 删除 / 新建
清掉该邮箱的失败桶；被拒绝的请求不再延长窗口。
"""

from __future__ import annotations

import threading
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.services import rate_limit_service as rl

TEST_IP = "testclient"
EMAIL_PREFIX = "blf1381-"


# ─────────────────────────── 桶清理 / 建号工具 ────────────────────────────────


def _wipe_buckets() -> None:
    """清空 Redis + 内存两套桶（登录限流跨用例残留会让断言随机 429）。"""
    client = rl._redis_client()
    if client is not None:
        try:
            settings = __import__(
                "app.core.config", fromlist=["get_settings"]
            ).get_settings()
            for key in client.scan_iter(f"{settings.redis_key_prefix}:ratelimit:*"):
                client.delete(key)
        except Exception:
            pass
    with rl._MEMORY_LOCK:
        rl._IN_MEMORY.clear()


@pytest.fixture(autouse=True)
def _clean_rate_limit_state():
    _wipe_buckets()
    yield
    _wipe_buckets()
    _purge_users()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _make_user(
    client: TestClient, settings, password: str, email: str | None = None
) -> str:
    """通过管理端点建号（顺带走一遍 create 路径的桶清理），返回邮箱。"""
    email = email or f"{EMAIL_PREFIX}{uuid.uuid4().hex[:10]}@example.com"
    resp = client.post(
        "/api/v1/system-management/users",
        headers={"X-API-Key": settings.api_key, "X-Is-Admin": "true"},
        json={"name": "blf1381 probe", "email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    return email


def _purge_users() -> None:
    db = SessionLocal()
    try:
        db.execute(
            text("delete from public.user_accounts where email like :prefix"),
            {"prefix": f"{EMAIL_PREFIX}%"},
        )
        db.commit()
    finally:
        db.close()


def _user_id(email: str) -> str:
    db = SessionLocal()
    try:
        return str(
            db.execute(
                text(
                    "select id::text from public.user_accounts where lower(email)=lower(:e)"
                ),
                {"e": email},
            ).scalar_one()
        )
    finally:
        db.close()


def _login(client: TestClient, email: str, password: str, ip: str | None = None):
    headers = {"X-Forwarded-For": ip} if ip else None
    return client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
        headers=headers,
    )


def _admin_reset(client: TestClient, settings, email: str, new_password: str):
    return client.patch(
        f"/api/v1/system-management/users/{_user_id(email)}",
        headers={"X-API-Key": settings.api_key, "X-Is-Admin": "true"},
        json={"password": new_password},
    )


# ─────────────────────────────── 用例 ────────────────────────────────────────


def test_successful_logins_do_not_consume_any_quota(client, settings):
    """连续 12 次**正确**密码登录全部成功：成功不占额度（上限 10/15min）。"""
    email = _make_user(client, settings, "GoodPass1234")
    statuses = [_login(client, email, "GoodPass1234").status_code for _ in range(12)]
    assert statuses == [200] * 12, statuses


def test_failed_attempts_are_limited(client, settings):
    """失败第 6 次起被挡（上限 5/30min）——失败仍然要计数，别把爆破口放开。"""
    email = _make_user(client, settings, "GoodPass1234")
    statuses = [_login(client, email, "WrongPass000").status_code for _ in range(6)]
    assert statuses[:5] == [401] * 5, statuses
    assert statuses[5] == 429, statuses


def test_admin_reset_unlocks_email_quota(client, settings):
    """BLF-1381 核心：用旧密码试错打满后，管理员重置密码 → 新密码立刻可登录。

    修复前：重置动作不碰限流桶，新密码照样 429，用户只能干等 30 分钟
    —— 这正是「重置密码后无法 login」的现场。
    """
    email = _make_user(client, settings, "OldPass1234")
    for _ in range(5):
        assert _login(client, email, "OldPass1234-wrong").status_code == 401
    assert _login(client, email, "OldPass1234").status_code == 429  # 窗口确实满了

    assert _admin_reset(client, settings, email, "NewPass5678").status_code == 200

    assert _login(client, email, "OldPass1234").status_code == 401
    assert _login(client, email, "NewPass5678").status_code == 200


def test_delete_and_recreate_same_email_has_no_stale_quota(client, settings):
    """删除 + 同邮箱重建：新账号不继承旧账号的失败计数与旧密码。"""
    email = _make_user(client, settings, "FirstPass123")
    for _ in range(5):
        assert _login(client, email, "FirstPass123-wrong").status_code == 401

    resp = client.delete(
        f"/api/v1/system-management/users/{_user_id(email)}",
        headers={"X-API-Key": settings.api_key, "X-Is-Admin": "true"},
    )
    assert resp.status_code == 204

    assert _make_user(client, settings, "SecondPass123", email=email) == email

    assert _login(client, email, "FirstPass123").status_code == 401  # 旧密码不残留
    assert _login(client, email, "SecondPass123").status_code == 200  # 新号立即可用


def test_create_user_ignores_stale_quota_for_that_email(client, settings):
    """新建账号同样清掉该邮箱的失败桶（历史残留不该连坐新号）。"""
    email = f"{EMAIL_PREFIX}{uuid.uuid4().hex[:10]}@example.com"
    for _ in range(5):
        assert _login(client, email, "whatever123").status_code == 401
    assert _login(client, email, "whatever123").status_code == 429

    assert _make_user(client, settings, "FreshPass123", email=email) == email
    assert _login(client, email, "FreshPass123").status_code == 200


def test_clear_key_also_clears_memory_fallback(monkeypatch):
    """Redis 不可用时桶落在内存兜底里，``clear_key`` 也必须能清掉它。

    修复前 ``clear_key`` 只 delete Redis key，内存桶要等窗口自然过期 ——
    Redis 一抖动，重置密码后的用户就要白等 30 分钟。
    """
    monkeypatch.setattr(rl, "_redis_client", lambda: None)
    rl.clear_key("login_email_fail", "mem@example.com")
    for _ in range(5):
        rl.record_attempt("login_email_fail", "mem@example.com", 1800)
    assert rl.peek_limit("login_email_fail", "mem@example.com", 5, 1800)[1] > 0

    rl.clear_key("login_email_fail", "mem@example.com")
    assert rl.peek_limit("login_email_fail", "mem@example.com", 5, 1800)[1] == 0


def test_blocked_request_does_not_extend_window(monkeypatch):
    """被拒绝的请求不再写桶：否则每次重试都把锁往后推，永远锁不出来。"""
    monkeypatch.setattr(rl, "_redis_client", lambda: None)
    rl.clear_key("login_ip", "1.2.3.4")
    for _ in range(2):
        rl.record_attempt("login_ip", "1.2.3.4", 60)

    before = rl.peek_limit("login_ip", "1.2.3.4", 2, 60)
    assert before[1] > 0  # 已超限
    # 调用方在被挡时**不**记失败；这里断言只读检查不会改计数
    after = rl.peek_limit("login_ip", "1.2.3.4", 2, 60)
    assert after[0] == before[0]


def test_reserve_attempt_denies_past_limit_without_counting(monkeypatch):
    """预占到上限后继续预占一律被拒，且被拒的预占不留在桶里。"""
    monkeypatch.setattr(rl, "_redis_client", lambda: None)
    rl.clear_key("login_email_fail", "cap@example.com")

    results = [
        rl.reserve_attempt("login_email_fail", "cap@example.com", 5, 1800)
        for _ in range(7)
    ]
    assert [ok for ok, _, _ in results] == [True] * 5 + [False] * 2
    assert all(retry > 0 for ok, retry, _ in results if not ok)
    # 被拒的两次没有写进桶：计数停在 5
    assert rl.peek_limit("login_email_fail", "cap@example.com", 5, 1800)[0] == 5


def test_release_attempt_restores_quota(monkeypatch):
    """登录成功预占后再回滚：额度回到原值，连登 12 次也不会被自己的成功锁住。"""
    monkeypatch.setattr(rl, "_redis_client", lambda: None)
    rl.clear_key("login_ip", "9.9.9.9")

    for _ in range(12):
        ok, _, token = rl.reserve_attempt("login_ip", "9.9.9.9", 10, 900)
        assert ok, "成功路径应该回滚预占，第 11 次不该被挡"
        rl.release_attempt("login_ip", "9.9.9.9", token, 900)

    assert rl.peek_limit("login_ip", "9.9.9.9", 10, 900)[0] == 0


def test_concurrent_reservations_cannot_exceed_limit(monkeypatch):
    """BLF-1381 / Codex P1：并发批次不能突破上限。

    修复前的写法是「先 peek_limit 判定、密码错才 record_attempt」，两个动
    作之间不是原子的：同一邮箱的 N 个并行请求能全部看到「桶没满」、全部
    跑完密码校验，之后才一起记账 —— 攻击者因此可以在任何计数生效前并行
    提交任意多组密码。现在把「检查 + 记账」压进 reserve_attempt 的临界区。
    """
    monkeypatch.setattr(rl, "_redis_client", lambda: None)
    rl.clear_key("login_email_fail", "race@example.com")

    allowed: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        ok, _, _ = rl.reserve_attempt("login_email_fail", "race@example.com", 5, 1800)
        with lock:
            allowed.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(1 for ok in allowed if ok) == 5, allowed
    assert rl.peek_limit("login_email_fail", "race@example.com", 5, 1800)[0] == 5
