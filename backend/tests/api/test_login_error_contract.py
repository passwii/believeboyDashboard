"""``/auth/login`` 失败响应契约：稳定 ``code`` + 中文 ``message`` + ``request_id``。

背景（BLF-1381 续）：登录页过去只拿得到 HTTP 状态码，401 无法区分「密码错」和
「账号停用」，429 看不到还要等多久，后端 500 更是只能落回一句「后端连接错误」
——用户与支持都没法判断真实原因，这正是「重置密码后登不进去」被误判的成因之一。

本文件锁住失败响应的口径：

* ``detail`` 保持改动前的字符串（旧调用方只读它，不能变）；
* ``code`` 是稳定枚举，前端按它选文案，不做自然语言匹配；
* ``message`` 是可直接展示的中文文案；
* ``request_id`` 与响应头 ``X-Request-Id`` 同一个值，用于回查日志 / 审计；
* 429 额外带 ``retry_after_seconds``（同时保留 ``Retry-After`` 头）；
* 未预期异常回 JSON + ``LOGIN_INTERNAL_ERROR``，不再让前端把 500 当成密码错。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api.v1.endpoints import auth as auth_module
from app.db.session import SessionLocal
from app.main import app
from app.services import rate_limit_service as rl

EMAIL_PREFIX = "blf1381-code-"


# ─────────────────────────── 隔离工具 ─────────────────────────────────────────


def _wipe_buckets() -> None:
    """清空 Redis + 内存两套桶：登录限流跨用例残留会让断言随机 429。"""
    client = rl._redis_client()
    if client is not None:
        try:
            from app.core.config import get_settings

            prefix = get_settings().redis_key_prefix
            for key in client.scan_iter(f"{prefix}:ratelimit:*"):
                client.delete(key)
        except Exception:
            pass
    with rl._MEMORY_LOCK:
        rl._IN_MEMORY.clear()


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


@pytest.fixture(autouse=True)
def _isolated_state():
    _wipe_buckets()
    yield
    _wipe_buckets()
    _purge_users()


@pytest.fixture
def client() -> TestClient:
    """每个用例独立的 IP：IP 桶按客户端 IP 计，共享会互相污染。"""
    return TestClient(app)


@pytest.fixture
def ip() -> dict[str, str]:
    return {
        "X-Forwarded-For": f"10.138.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}"
    }


def _make_user(client: TestClient, settings, password: str) -> str:
    email = f"{EMAIL_PREFIX}{uuid.uuid4().hex[:10]}@example.com"
    resp = client.post(
        "/api/v1/system-management/users",
        headers={"X-API-Key": settings.api_key, "X-Is-Admin": "true"},
        json={"name": "blf1381 contract probe", "email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    return email


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


def _login(client: TestClient, email: str, password: str, headers: dict[str, str]):
    return client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
        headers=headers,
    )


# ─────────────────────────────── 用例 ────────────────────────────────────────


def test_invalid_credentials_returns_stable_code(client, settings, ip):
    """密码错 → 401 + LOGIN_INVALID_CREDENTIALS；``detail`` 保持旧值不变。"""
    email = _make_user(client, settings, "GoodPass1234")

    resp = _login(client, email, "WrongPass000", ip)

    assert resp.status_code == 401, resp.text
    body = resp.json()
    assert body["code"] == "LOGIN_INVALID_CREDENTIALS"
    assert body["detail"] == "Invalid credentials", "旧客户端只读 detail，值不能改"
    assert "邮箱或密码错误" in body["message"]
    assert body["request_id"], "失败响应必须带可回查的 request_id"


def test_unknown_email_shares_invalid_credentials_code(client, settings, ip):
    """账号不存在与密码错共用同一 code / message：登录页不能变成账号枚举接口。"""
    email = _make_user(client, settings, "GoodPass1234")

    wrong_password = _login(client, email, "WrongPass000", ip).json()
    unknown_email = _login(
        client, f"{EMAIL_PREFIX}ghost@example.com", "WrongPass000", ip
    ).json()

    assert unknown_email["code"] == wrong_password["code"]
    assert unknown_email["message"] == wrong_password["message"]
    assert unknown_email["detail"] == wrong_password["detail"]


def test_account_disabled_returns_distinct_code(client, settings, ip):
    """账号停用必须与密码错区分开，否则用户会一直去试密码。"""
    email = _make_user(client, settings, "GoodPass1234")
    assert (
        client.patch(
            f"/api/v1/system-management/users/{_user_id(email)}",
            headers={"X-API-Key": settings.api_key, "X-Is-Admin": "true"},
            json={"is_active": False},
        ).status_code
        == 200
    )

    resp = _login(client, email, "GoodPass1234", ip)

    assert resp.status_code == 401, resp.text
    body = resp.json()
    assert body["code"] == "LOGIN_ACCOUNT_DISABLED"
    assert body["detail"] == "Account disabled"
    assert "停用" in body["message"]


def test_rate_limited_carries_retry_after_seconds(client, settings, ip):
    """429 要能直接做倒计时：body 里的秒数与 ``Retry-After`` 头一致。"""
    email = _make_user(client, settings, "GoodPass1234")
    statuses = [_login(client, email, "WrongPass000", ip).status_code for _ in range(5)]
    assert statuses == [401] * 5, statuses

    resp = _login(client, email, "GoodPass1234", ip)

    assert resp.status_code == 429, resp.text
    body = resp.json()
    assert body["code"] == "LOGIN_RATE_LIMITED"
    assert body["detail"] == "Too many login attempts. Please try again later."
    retry_after = body["retry_after_seconds"]
    assert isinstance(retry_after, int) and retry_after > 0
    assert resp.headers["Retry-After"] == str(retry_after)
    assert resp.headers["X-RateLimit-Retry-After-Sec"] == str(retry_after)
    assert f"{retry_after} 秒后重试" in body["message"]
    # 不写「刚改过密码可直接用新密码重试」：429 可能来自 IP 桶（10 次 / 15 分钟），
    # 而重置密码只清邮箱桶（``clear_login_failures`` 只清 ``login_email_fail``）。
    # 共享出口 IP 的公司里这句话会把刚改完密码的人再骗进同一个 429。
    assert "改过密码" not in body["message"]


def test_invalid_client_id_returns_code(client, settings, ip):
    """``X-Client-Id`` 形态非法 → 400 + LOGIN_INVALID_CLIENT_ID（不落 default 槽）。"""
    email = _make_user(client, settings, "GoodPass1234")

    resp = _login(client, email, "GoodPass1234", {**ip, "X-Client-Id": "bad id"})

    assert resp.status_code == 400, resp.text
    body = resp.json()
    assert body["code"] == "LOGIN_INVALID_CLIENT_ID"
    assert body["detail"] == "Invalid X-Client-Id"
    assert body["message"]


def test_request_id_matches_response_header(client, settings, ip):
    """``request_id`` 与 ``X-Request-Id`` 同值 —— 用户报 ID 就能在日志里定位。"""
    email = _make_user(client, settings, "GoodPass1234")
    trace = f"blf1381-{uuid.uuid4().hex[:12]}"

    resp = _login(client, email, "WrongPass000", {**ip, "X-Request-Id": trace})

    assert resp.status_code == 401
    assert resp.json()["request_id"] == trace
    assert resp.headers["X-Request-Id"] == trace


def test_unexpected_error_returns_json_with_internal_code(
    client, settings, ip, monkeypatch
):
    """未预期异常（数据库不可用等）→ JSON + LOGIN_INTERNAL_ERROR。

    修复前这里会冒泡成 Starlette 的纯文本 500 ``Internal Server Error``：前端
    ``response.json()`` 解析失败，最终显示「后端连接错误 / 邮箱或密码错误」，把
    真正的服务端故障藏了起来。
    """
    email = _make_user(client, settings, "GoodPass1234")

    def _boom():
        raise RuntimeError("db pool exhausted")

    monkeypatch.setattr(auth_module, "SessionLocal", _boom)

    resp = _login(client, email, "GoodPass1234", ip)

    assert resp.status_code == 500, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    body = resp.json()
    assert body["code"] == "LOGIN_INTERNAL_ERROR"
    assert body["detail"] == "Login failed due to an internal error"
    assert "请求 ID" in body["message"]
    assert body["request_id"]
    assert "db pool exhausted" not in resp.text, "异常原文只在服务端日志里"


class _FailingSession:
    """模拟「查库就炸」的 session：锁住 ``login()`` 主干的 ``except Exception``。"""

    def __init__(self, *, rollback_boom: bool = False, close_boom: bool = False):
        self._rollback_boom = rollback_boom
        self._close_boom = close_boom

    def execute(self, *_args, **_kwargs):
        raise RuntimeError("connection reset by peer")

    def rollback(self):
        if self._rollback_boom:
            raise RuntimeError("rollback exploded")

    def close(self):
        if self._close_boom:
            raise RuntimeError("close exploded")


def test_query_failure_returns_json_internal_code(client, settings, ip, monkeypatch):
    """建 session 成功、但查库 / 业务分支抛错 → 仍是 JSON + LOGIN_INTERNAL_ERROR。

    这里锁的是 ``login()`` 主干那个 ``except Exception``（真正承诺住的位置）。
    ``test_unexpected_error_returns_json_with_internal_code`` 走的是「session 建
    不起来」的窄分支，覆盖不到它。
    """
    monkeypatch.setattr(
        auth_module, "SessionLocal", lambda: _FailingSession(rollback_boom=True)
    )

    resp = _login(client, f"{EMAIL_PREFIX}probe@example.com", "GoodPass1234", ip)

    assert resp.status_code == 500, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    body = resp.json()
    assert body["code"] == "LOGIN_INTERNAL_ERROR"
    assert body["detail"] == "Login failed due to an internal error"
    assert body["request_id"]
    assert "connection reset by peer" not in resp.text


def test_close_failure_does_not_break_internal_error_response(
    client, settings, ip, monkeypatch
):
    """``finally: db.close()`` 自己抛错，也不能顶掉刚构造好的 JSON 500。

    未包住时这里会变成 Starlette 的纯文本 ``Internal Server Error``（
    ``content-type: text/plain``）——前端 ``response.json()`` 再次解析失败，
    又把服务端故障显示成「后端连接错误」。真实 SQLAlchemy 下 ``close()`` 极少
    抛（事务已 DEACTIVE/CLOSED），但这是「500 一定是 JSON」链上的最后一处漏点。
    """
    monkeypatch.setattr(
        auth_module,
        "SessionLocal",
        lambda: _FailingSession(rollback_boom=True, close_boom=True),
    )

    resp = _login(client, f"{EMAIL_PREFIX}probe@example.com", "GoodPass1234", ip)

    assert resp.status_code == 500, resp.text
    assert resp.headers["content-type"].startswith("application/json")
    body = resp.json()
    assert body["code"] == "LOGIN_INTERNAL_ERROR"
    assert "close exploded" not in resp.text


def test_internal_error_does_not_consume_failure_budget(
    client, settings, ip, monkeypatch
):
    """后端故障不该吃掉账号的失败额度：预占要在每条非「密码错」路径上退回。

    ``/auth/login`` 是先原子预占、再查库（BLF-1381 / #747）。如果内部错误路径
    忘了 ``release_attempt``，一次数据库抖动、连续 5 次 500 就能把该邮箱锁在
    429 外面 30 分钟 —— 用户看到的现象又变回「登不进去」。
    """
    email = _make_user(client, settings, "GoodPass1234")
    original = auth_module.SessionLocal
    monkeypatch.setattr(auth_module, "SessionLocal", lambda: _FailingSession())
    try:
        for _ in range(6):
            assert _login(client, email, "GoodPass1234", ip).status_code == 500
    finally:
        monkeypatch.setattr(auth_module, "SessionLocal", original)

    resp = _login(client, email, "WrongPass000", ip)

    assert resp.status_code == 401, "内部错误不该计入失败次数"
    assert resp.json()["code"] == "LOGIN_INVALID_CREDENTIALS"
