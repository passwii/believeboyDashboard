"""confirm 流 token 生命周期 + 装饰器（设计稿 §3；spec S3/S4 的机制层）。

不依赖真实 Redis：注入 InMemoryConfirmStore。真实写路由的端到端
confirm 用例（S2-S6）属 P2 plan。
"""

from __future__ import annotations

import json
import threading

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.agent.confirm import (
    DEFAULT_CONFIRM_TTL_SECONDS,
    ConfirmRecord,
    InMemoryConfirmStore,
    RedisConfirmStore,
    get_confirm_context,
    get_confirm_record,
    get_confirm_store,
    issue_confirm_token,
    consume_confirm_token,
    ConfirmReplayError,
    require_confirmation,
    set_confirm_store,
)
from app.api.agent.errors import register_agent_error_handlers
from app.api.agent.response import agent_ok
from app.core.config import get_settings
from app.services.infra.redis import is_redis_available

EXECUTED: list[dict] = []


def _build_app() -> FastAPI:
    app = FastAPI()
    register_agent_error_handlers(app)

    @app.post("/w")
    @require_confirmation(
        action="test.action",
        build_preview=lambda body, request: {"echo": body},
        validate=_validate,
    )
    async def write_route(request: Request):
        body = json.loads(await request.body() or b"{}")
        EXECUTED.append(body)
        return agent_ok({"executed": True})

    @app.middleware("http")
    async def _stamp_agent_id(request: Request, call_next):
        request.state.agent_id = "confirm-agent"
        return await call_next(request)

    return app


def _validate(body: dict, request) -> None:
    from app.api.agent.errors import AgentApiError, ErrorCode

    if body.get("sku") == "BAD":
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="SKU 无效", details=[]
        )


@pytest.fixture
def client():
    set_confirm_store(InMemoryConfirmStore())
    EXECUTED.clear()
    yield TestClient(_build_app())
    set_confirm_store(None)


def _post(client, body: dict, *, token: str | None = None, idem: str = "idem-1"):
    headers = {"Idempotency-Key": idem}
    if token:
        headers["X-Confirm-Token"] = token
    return client.post("/w", json=body, headers=headers)


class TestTokenLifecycle:
    def test_issue_and_consume(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            record, ttl = issue_confirm_token(
                agent_id="a", action="x", idempotency_key="k", body=b'{"v":1}'
            )
            assert record.token.startswith("cf_")
            assert ttl == DEFAULT_CONFIRM_TTL_SECONDS
            got = consume_confirm_token(
                token=record.token, agent_id="a", idempotency_key="k", body=b'{"v":1}'
            )
            assert got.token == record.token
        finally:
            set_confirm_store(None)

    def test_consume_is_single_use(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key=None, body=b"{}"
            )
            consume_confirm_token(
                token=record.token, agent_id="a", idempotency_key=None, body=b"{}"
            )
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token, agent_id="a", idempotency_key=None, body=b"{}"
                )
            assert exc.value.reason == "invalid"
        finally:
            set_confirm_store(None)

    def test_body_hash_mismatch_invalid(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key=None, body=b'{"v":1}'
            )
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token,
                    agent_id="a",
                    idempotency_key=None,
                    body=b'{"v":2}',
                )
            assert exc.value.reason == "invalid"
        finally:
            set_confirm_store(None)

    def test_expired_classified(self):
        store = InMemoryConfirmStore()
        set_confirm_store(store)
        try:
            record, _ = issue_confirm_token(
                agent_id="a",
                action="x",
                idempotency_key=None,
                body=b"{}",
                ttl_seconds=1,
            )
            store._rows[record.token]["record"].created_at -= 2  # 逻辑过期
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token,
                    agent_id="a",
                    idempotency_key=None,
                    body=b"{}",
                    ttl_seconds=1,
                )
            assert exc.value.reason == "expired"
        finally:
            set_confirm_store(None)


class TestDecoratorFlow:
    def test_first_call_returns_preview_shell(self, client):
        resp = _post(client, {"sku": "X-001", "qty": 2})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["requires_confirmation"] is True
        assert body["confirm_token"].startswith("cf_")
        assert body["expires_in_sec"] == DEFAULT_CONFIRM_TTL_SECONDS
        assert body["preview"] == {
            "action": "test.action",
            "echo": {"sku": "X-001", "qty": 2},
        }
        assert EXECUTED == []  # 未落库

    def test_replay_executes_once(self, client):
        preview = _post(client, {"sku": "X-001"}).json()
        replay = _post(client, {"sku": "X-001"}, token=preview["confirm_token"])
        assert replay.status_code == 200
        assert replay.json() == {"ok": True, "data": {"executed": True}}
        assert EXECUTED == [{"sku": "X-001"}]
        # token 用后即删：第二次重放无效
        again = _post(client, {"sku": "X-001"}, token=preview["confirm_token"])
        assert again.status_code == 400
        assert again.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        assert len(EXECUTED) == 1

    def test_replay_with_changed_body_rejected(self, client):
        preview = _post(client, {"sku": "X-001", "qty": 1}).json()
        replay = _post(
            client, {"sku": "X-001", "qty": 999}, token=preview["confirm_token"]
        )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        assert EXECUTED == []

    def test_replay_with_changed_idempotency_key_rejected(self, client):
        preview = _post(client, {"sku": "X-001"}, idem="idem-A").json()
        replay = _post(
            client, {"sku": "X-001"}, token=preview["confirm_token"], idem="idem-B"
        )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_validation_error_before_token_issued(self, client):
        resp = _post(client, {"sku": "BAD"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        # 未签发 token：存储为空
        assert get_confirm_store()._rows == {}


class TestAtomicConsume:
    def test_concurrent_replay_only_one_wins(self):
        """TOCTOU 回归：N 个并发重放只有一个成功（P0 终审准入门槛）。"""
        store = InMemoryConfirmStore()
        set_confirm_store(store)
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key=None, body=b'{"v":1}'
            )
            wins: list[bool] = []
            lock = threading.Lock()

            def attempt():
                try:
                    consume_confirm_token(
                        token=record.token,
                        agent_id="a",
                        idempotency_key=None,
                        body=b'{"v":1}',
                    )
                    ok = True
                except ConfirmReplayError:
                    ok = False
                with lock:
                    wins.append(ok)

            threads = [threading.Thread(target=attempt) for _ in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            assert sum(wins) == 1
        finally:
            set_confirm_store(None)


@pytest.mark.skipif(not is_redis_available(), reason="本地 Redis 不可用")
class TestRedisStoreRoundtrip:
    def test_put_pop_and_prefix(self):
        from app.services.infra.redis import get_redis_client

        store = RedisConfirmStore()
        set_confirm_store(store)
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key="k", body=b'{"v":1}'
            )
            expected_key = (
                f"{get_settings().redis_key_prefix}:agent:confirm:{record.token}"
            )
            assert get_redis_client().exists(expected_key) == 1
            got = consume_confirm_token(
                token=record.token, agent_id="a", idempotency_key="k", body=b'{"v":1}'
            )
            assert got.token == record.token
            # 原子 pop 后 key 消失；再 pop 为 invalid
            assert get_redis_client().exists(expected_key) == 0
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token,
                    agent_id="a",
                    idempotency_key="k",
                    body=b'{"v":1}',
                )
            assert exc.value.reason == "invalid"
        finally:
            set_confirm_store(None)


class TestCallbacksReceiveRequest:
    def test_validate_and_preview_get_request(self):
        """装饰器回调签名升级为 (body, request)。"""
        from fastapi import FastAPI, Request
        from fastapi.testclient import TestClient

        from app.api.agent.errors import register_agent_error_handlers
        from app.api.agent.response import agent_ok

        seen: dict = {}

        app = FastAPI()
        register_agent_error_handlers(app)

        def _val(body: dict, request: Request) -> None:
            seen["validate_path"] = request.url.path
            seen["validate_body"] = body

        def _prev(body: dict, request: Request) -> dict:
            seen["preview_path"] = request.url.path
            return {"echo": body}

        @app.post("/w")
        @require_confirmation(action="t.a", build_preview=_prev, validate=_val)
        async def _w(request: Request):
            return agent_ok({"executed": True})

        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(app)
            resp = client.post("/w", json={"a": 1}, headers={"Idempotency-Key": "k1"})
            assert resp.status_code == 200
            assert seen["validate_path"] == "/w"
            assert seen["validate_body"] == {"a": 1}
            assert seen["preview_path"] == "/w"
            token = resp.json()["confirm_token"]
            replay = client.post(
                "/w",
                json={"a": 1},
                headers={"Idempotency-Key": "k1", "X-Confirm-Token": token},
            )
            assert replay.json() == {"ok": True, "data": {"executed": True}}
        finally:
            set_confirm_store(None)


class TestBoundContext:
    """``bind`` 绑定值随 confirm 记录存储，重放复用（BLF-1347 review 修正）。

    非确定性派生值（日期、编号候选）不能靠重算保证「预览=落库」：预览与重放可能
    跨日，候选也可能被并发占用。``bind`` 在预览期算一次，随 token 存储。
    """

    def _build_app(self, seen: dict) -> FastAPI:
        app = FastAPI()
        register_agent_error_handlers(app)
        calls = {"bind": 0}

        def _bind(body: dict, request: Request) -> dict:
            calls["bind"] += 1
            return {"derived": f"V-{calls['bind']}", "day": "2026-10-15"}

        def _prev(body: dict, request: Request) -> dict:
            return dict(get_confirm_context(request) or {})

        @app.post("/bound")
        @require_confirmation(action="t.bound", build_preview=_prev, bind=_bind)
        async def _bound(request: Request):
            seen["context"] = get_confirm_context(request)
            seen["record"] = get_confirm_record(request)
            return agent_ok({"executed": True})

        @app.middleware("http")
        async def _stamp(request: Request, call_next):
            request.state.agent_id = "confirm-agent"
            return await call_next(request)

        seen["calls"] = calls
        return app

    def test_preview_binds_context_and_replay_reuses_it(self):
        seen: dict = {}
        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(self._build_app(seen))
            preview = client.post(
                "/bound", json={"a": 1}, headers={"Idempotency-Key": "k1"}
            )
            assert preview.status_code == 200, preview.text
            body = preview.json()
            # 预览阶段：bind 算一次，预览读到的就是绑定值（此时 handler 未执行）
            assert body["preview"] == {
                "action": "t.bound",
                "derived": "V-1",
                "day": "2026-10-15",
            }
            assert seen["calls"] == {"bind": 1}
            assert "context" not in seen

            replay = client.post(
                "/bound",
                json={"a": 1},
                headers={
                    "Idempotency-Key": "k1",
                    "X-Confirm-Token": body["confirm_token"],
                },
            )
            assert replay.json() == {"ok": True, "data": {"executed": True}}
            # 重放阶段：不重新 bind，直接用确认记录里的值
            assert seen["calls"] == {"bind": 1}
            assert seen["context"] == {"derived": "V-1", "day": "2026-10-15"}
            assert seen["record"] is not None
            assert seen["record"].context == seen["context"]
        finally:
            set_confirm_store(None)

    def test_context_is_json_serializable_for_redis_store(self):
        """绑定值随记录进 Redis（``json.dumps(asdict(record))``），必须可序列化。"""
        from dataclasses import asdict

        set_confirm_store(InMemoryConfirmStore())
        try:
            record, _ = issue_confirm_token(
                agent_id="a",
                action="x",
                idempotency_key="k",
                body=b"{}",
                context={
                    "create_defaults": {
                        "shipment_no": "FBA-20261015-K7Q2",
                        "created_date": "2026-10-15",
                        "auto_filled": ["shipment_no", "created_date"],
                    }
                },
            )
            payload = json.loads(json.dumps(asdict(record)))
            assert payload["context"]["create_defaults"]["shipment_no"] == (
                "FBA-20261015-K7Q2"
            )
        finally:
            set_confirm_store(None)

    def test_legacy_record_without_context_still_loads(self):
        """旧记录（无 context 字段）反序列化不报错（向后兼容）。

        Redis 里可能还留着升级前写入的 JSON（无 ``context`` 键）。
        """
        legacy_payload = {
            "token": "cf_legacy",
            "agent_id": "a",
            "action": "x",
            "idempotency_key": None,
            "body_hash": "h",
            "created_at": 0.0,
        }
        record = ConfirmRecord(**legacy_payload)  # type: ignore[arg-type]
        assert record.context is None


class TestMultipartConfirmation:
    """multipart/form-data 两步确认门（BLF-628 W4：require_multipart_confirmation）。

    与 JSON confirm 的差异点：
    * body 不做 JSON 解析（multipart 直接 400 是旧行为）；
    * token 绑定**规范化指纹**（source+filename+文件字节，不含 boundary）——
      重放可换 boundary，内容一致即通过；内容/文件名/source 任一变化 → invalid。
    """

    def _build_upload_app(self, store_rows=None) -> FastAPI:
        from app.api.agent.confirm import require_multipart_confirmation
        from app.api.agent.errors import register_agent_error_handlers
        from app.api.agent.response import agent_ok

        app = FastAPI()
        register_agent_error_handlers(app)

        def _val(fields: dict, request: Request) -> None:
            file_meta = fields.get("file") or {}
            if not file_meta.get("filename", "").endswith(".pdf"):
                from app.api.agent.errors import AgentApiError, ErrorCode

                raise AgentApiError(
                    ErrorCode.VALIDATION_FAILED, human_message="仅支持 PDF 文件"
                )

        def _prev(fields: dict, request: Request) -> dict:
            return {
                "filename": (fields.get("file") or {}).get("filename"),
                "source": fields.get("source"),
            }

        @app.post("/upload")
        @require_multipart_confirmation(
            action="test.upload", build_preview=_prev, validate=_val
        )
        async def _upload(request: Request):
            form = await request.form()
            up = form.get("file")
            content = await up.read() if up is not None else b""
            EXECUTED.append(
                {
                    "source": str(form.get("source") or ""),
                    "filename": getattr(up, "filename", None),
                    "size": len(content),
                }
            )
            return agent_ok({"executed": True, "size": len(content)})

        @app.middleware("http")
        async def _stamp(request: Request, call_next):
            request.state.agent_id = "confirm-agent"
            return await call_next(request)

        return app

    def _post_upload(
        self,
        client,
        *,
        source="agent_listing_pull",
        filename="label.pdf",
        content=b"%PDF-1.4 test",
        token=None,
        idem="idem-upload-1",
    ):
        headers = {"Idempotency-Key": idem}
        if token:
            headers["X-Confirm-Token"] = token
        return client.post(
            "/upload",
            files={"file": (filename, content, "application/pdf")},
            data={"source": source},
            headers=headers,
        )

    def test_preview_then_replay_executes(self):
        set_confirm_store(InMemoryConfirmStore())
        EXECUTED.clear()
        try:
            client = TestClient(self._build_upload_app())
            preview = self._post_upload(client)
            assert preview.status_code == 200, preview.text
            pbody = preview.json()
            assert pbody["ok"] is False
            assert pbody["requires_confirmation"] is True
            assert pbody["confirm_token"].startswith("cf_")
            assert pbody["preview"]["action"] == "test.upload"
            assert pbody["preview"]["filename"] == "label.pdf"
            assert pbody["preview"]["source"] == "agent_listing_pull"

            # 重放：TestClient 每次 files= 生成新 boundary，内容一致即通过
            replay = self._post_upload(
                client, token=pbody["confirm_token"], idem="idem-upload-1"
            )
            assert replay.status_code == 200, replay.text
            assert replay.json()["data"]["executed"] is True
            assert EXECUTED == [
                {
                    "source": "agent_listing_pull",
                    "filename": "label.pdf",
                    "size": len(b"%PDF-1.4 test"),
                }
            ]
        finally:
            set_confirm_store(None)

    def test_replay_content_changed_rejected(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(self._build_upload_app())
            preview = self._post_upload(client, content=b"%PDF-1.4 v1")
            token = preview.json()["confirm_token"]
            replay = self._post_upload(
                client,
                content=b"%PDF-1.4 v2-different",
                token=token,
                idem="idem-upload-1",
            )
            assert replay.status_code == 400
            assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        finally:
            set_confirm_store(None)

    def test_replay_filename_changed_rejected(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(self._build_upload_app())
            preview = self._post_upload(client, filename="label.pdf")
            token = preview.json()["confirm_token"]
            replay = self._post_upload(
                client, filename="renamed.pdf", token=token, idem="idem-upload-1"
            )
            assert replay.status_code == 400
            assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        finally:
            set_confirm_store(None)

    def test_replay_source_changed_rejected(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(self._build_upload_app())
            preview = self._post_upload(client, source="agent_listing_pull")
            token = preview.json()["confirm_token"]
            replay = self._post_upload(
                client, source="external_api", token=token, idem="idem-upload-1"
            )
            assert replay.status_code == 400
            assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        finally:
            set_confirm_store(None)

    def test_replay_idempotency_changed_rejected(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(self._build_upload_app())
            preview = self._post_upload(client, idem="idem-upload-1")
            token = preview.json()["confirm_token"]
            replay = self._post_upload(client, token=token, idem="idem-upload-other")
            assert replay.status_code == 400
            assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        finally:
            set_confirm_store(None)

    def test_replay_expired(self):
        store = InMemoryConfirmStore()
        set_confirm_store(store)
        try:
            client = TestClient(self._build_upload_app())
            preview = self._post_upload(client)
            token = preview.json()["confirm_token"]
            store._rows[token]["record"].created_at -= 400
            replay = self._post_upload(client, token=token, idem="idem-upload-1")
            assert replay.status_code == 409
            assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"
        finally:
            set_confirm_store(None)

    def test_multipart_bad_file_validate_short_circuits_before_token(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            client = TestClient(self._build_upload_app())
            resp = client.post(
                "/upload",
                files={"file": ("label.txt", b"not a pdf", "text/plain")},
                data={"source": "agent_listing_pull"},
                headers={"Idempotency-Key": "idem-upload-1"},
            )
            assert resp.status_code == 400
            assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        finally:
            set_confirm_store(None)
