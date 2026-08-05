# Agent API P2 货件域写通道实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/api/v1/agent/projects/{project_id}/shipments/*` 开放货件域的读 + 写路由（spec §5 全部 10 条），写接口全部走 confirm 两步确认 + agent 审计归因，并完成 P0 终审遗留的 confirm 存储原子化准入门槛。

**Architecture:** 复用 `app.services.shipment.*` 既有 service（路由层只做：鉴权→参数映射→confirm 门→调 service→缓存失效→审计→响应壳）；service 抛出的裸 HTTPException 在路由边界统一翻译成 agent 响应壳；confirm 存储改原子 pop（Lua GET+DEL）消除 TOCTOU，装饰器回调升级为 `(body, request)` 签名以获得路径参数与独立 DB 会话。

**Tech Stack:** FastAPI / SQLAlchemy 2.x / redis-py（Lua 原子脚本）/ pytest + TestClient（真实测试库，无 mock DB）。

**配套文档：**
- 设计稿：`docs/agent-api-design.md` v0.4（§3 confirm、§5 响应壳、§7 限流/幂等）
- 实施规格：`docs/superpowers/specs/2026-08-04-agent-readwrite-api-spec.md` v0.4 §5（用例 S1-S7）
- P0 实施记录：`.git/sdd/progress.md`（含 confirm TOCTOU 准入门槛裁决）

**不在本计划：** P1 路径迁移（`/external/*` 镜像 + Deprecation 头）、定价/店铺/库存域（P3）、AI Chat 工具注册（P4）、货件删除/隐藏对 Agent 开放（admin only，spec §3.2）。

---

## Global Constraints

- **Commit author email 必须 `jr.way123@gmail.com`**（Vercel 校验，BEL-153）；commit 前 `git config user.email` 自查。
- **Commit 规范**：中文 + Conventional Commits（scope 中文，subject 动宾 ≤50 字无句号）。
- **分支**：`feat/agent-api-p2`，基于最新 main（开工前 `git fetch origin && git rebase origin/main`）。工作区可能有无关 WIP：提交只 add 各任务列出的路径，**严禁 `git add -A`**。
- **无迁移**：P2 不改 schema（P0 已备好 agent_id/idempotency_key 列）；测试库与 dev 库都在 alembic 234。
- **状态词表**（`validation.ALLOWED_SHIPMENT_STATUS`）：只有 `draft / in_transit / completed`，agent 传其他值 → `SHIPMENT_STATUS_INVALID`。
- **运输方式词表**（`validation.ALLOWED_SHIPPING_METHOD`）：`sea / air / express / truck / rail / other`——**英文 token，不接受中文**（spec §5.3 示例里的"海运"是笔误，测试与文档一律用 `sea`）。
- **写接口**：全部 confirm（装饰器 `@require_confirmation`）+ 写桶限流依赖 + 审计行 `operator=NULL`、`agent_id`/`idempotency_key` 归因、`target_type="shipment_schedule"`、`target_id=<schedule.id>`（数字 id，非 shipment_no）。
- **读接口**：不落审计（与 `append_operation_view_log` no-op 决策一致）；**绕过 Redis 读缓存**直查 DB（agent 读要拿最新态，量级可承受）。
- **写后必须失效 7 个缓存**（对齐内部端点）：detail / list / cost_summary / sku_summary / fba_box_details / in_transit_qty(project_id) / daily_analysis(project_id)。
- **Idempotency-Key 头**：可缺失；出现则必须非空且 ≤64 字符，否则 400 `VALIDATION_FAILED`。
- **并发语义**：PATCH/状态推进为读-改-写 last-write-wins，无乐观锁（spec §5.1 关键事实）。
- **测试顺序**：`cd backend && pytest`；失败立即修；全量里既有失败（R2/ai_chat/ad-upload/inventory/pydantic_ai 类）不修、如实记录。

---

## File Structure

| 责任 | 文件 |
|---|---|
| confirm 原子化 + 装饰器签名升级 | `backend/app/api/agent/confirm.py`（改）、`backend/tests/api/agent/test_confirm.py`（改） |
| SHIPMENT 错误码 | `backend/app/api/agent/errors.py`（改） |
| 货件路由（读+写，单模块，spec §2.1） | `backend/app/api/v1/endpoints/agent/shipments.py`（新建，逐任务增长） |
| 路由装配 | `backend/app/api/v1/endpoints/agent/__init__.py`（改：挂载，注意兜底路由警告） |
| 审计查询 | `backend/app/services/audit_log_service.py`（改：加查询函数） |
| 测试 | `backend/tests/api/agent/conftest.py`（新建 fixture）、`test_shipments_read.py`、`test_shipment_errors.py`、`test_shipments_confirm.py`、`test_shipments_audit.py` |
| 文档 | `backend/docs/agent-api.md`（改）、`docs/agent-api-design.md` §3.1（key 前缀措辞） |

---

### Task 1: confirm 存储原子化 + 装饰器回调签名升级（P2 准入门槛）

**为什么先做**：P0 终审把 confirm TOCTOU 列为 P2 写路由准入门槛——`get→校验→delete` 非原子，并发重放可能双双通过；confirm 是危险写的安全门，必须先原子化再接真实写路由。同时把装饰器回调从 `(body)` 升级为 `(body, request)`：P2 的 validate/preview 需要路径参数（project_id/shipment_no）与独立 DB 会话。

**Files:**
- Modify: `backend/app/api/agent/confirm.py`
- Modify: `backend/tests/api/agent/test_confirm.py`
- Modify: `docs/agent-api-design.md`（§3.1 Redis key 措辞）

**Interfaces:**
- Produces: `ConfirmStore.pop(token) -> ConfirmRecord | None`（原子取出并删除；替代 get+delete）；`require_confirmation(*, action, build_preview: Callable[[dict, Request], dict] | None, validate: Callable[[dict, Request], None] | None)`；Redis key 形如 `{redis_key_prefix}:agent:confirm:{token}`（对齐 infra `_p()` 前缀惯例，消除 P0 终审 Minor T5-2）

- [ ] **Step 1: 写失败测试（原子性 + 新签名 + 真实 Redis 路径）**

在 `backend/tests/api/agent/test_confirm.py` **追加**三个测试类（文件头部 import 区补 `import threading`、`from app.core.config import get_settings`、`from app.services.infra.redis import is_redis_available`；`pytest` 已有）：

```python
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
                        token=record.token, agent_id="a",
                        idempotency_key=None, body=b'{"v":1}',
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
            expected_key = f"{get_settings().redis_key_prefix}:agent:confirm:{record.token}"
            assert get_redis_client().exists(expected_key) == 1
            got = consume_confirm_token(
                token=record.token, agent_id="a", idempotency_key="k", body=b'{"v":1}'
            )
            assert got.token == record.token
            # 原子 pop 后 key 消失；再 pop 为 invalid
            assert get_redis_client().exists(expected_key) == 0
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token, agent_id="a", idempotency_key="k", body=b'{"v":1}'
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
                "/w", json={"a": 1},
                headers={"Idempotency-Key": "k1", "X-Confirm-Token": token},
            )
            assert replay.json() == {"ok": True, "data": {"executed": True}}
        finally:
            set_confirm_store(None)
```

同时把该文件**既有** `_build_app()` 里的回调改成新签名：

```python
    @app.post("/w")
    @require_confirmation(
        action="test.action",
        build_preview=lambda body, request: {"echo": body},
        validate=_validate,
    )
    async def write_route(request: Request):
```

以及 `_validate` 定义：

```python
def _validate(body: dict, request) -> None:
    from app.api.agent.errors import AgentApiError, ErrorCode

    if body.get("sku") == "BAD":
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="SKU 无效", details=[]
        )
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_confirm.py
```

Expected: 新增用例 FAIL（`pop` 不存在 / 回调多传 request 参数报 TypeError）；既有用例中涉及 get/delete 的部分随实现一起调整。

- [ ] **Step 3: 改 confirm.py**

`app/api/agent/confirm.py` 逐处修改：

1. 顶部 import 加 `from app.core.config import get_settings`；删掉不再需要的 import（无）。
2. key 构造（模块级，替换 `CONFIRM_KEY_PREFIX` 的直接拼接用法）：

```python
CONFIRM_KEY_PREFIX = "agent:confirm:"


def _confirm_key(token: str) -> str:
    """全局前缀 + confirm 前缀（对齐 infra ``_p()`` 惯例，P0 终审 Minor T5-2）。"""
    return f"{get_settings().redis_key_prefix}:{CONFIRM_KEY_PREFIX}{token}"
```

3. Protocol 用 `pop` 替代 `get`/`delete`：

```python
class ConfirmStore(Protocol):
    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None: ...

    def pop(self, token: str) -> ConfirmRecord | None:
        """原子取出并删除；不存在返回 None。"""
        ...
```

4. RedisConfirmStore（Lua 一步 GET+DEL，任意 Redis 版本可用，与 `infra/redis.py` 的 `validate_session` Lua 先例一致）：

```python
_POP_LUA = """
local v = redis.call('GET', KEYS[1])
if v then
    redis.call('DEL', KEYS[1])
end
return v
"""


class RedisConfirmStore:
    """生产实现：``app/services/infra/redis`` 的全局连接池。"""

    def put(self, record: ConfirmRecord, *, physical_ttl_seconds: int) -> None:
        from app.services.infra.redis import get_redis_client

        get_redis_client().setex(
            _confirm_key(record.token),
            physical_ttl_seconds,
            json.dumps(asdict(record)),
        )

    def pop(self, token: str) -> ConfirmRecord | None:
        from app.services.infra.redis import get_redis_client

        raw = get_redis_client().eval(_POP_LUA, 1, _confirm_key(token))
        if raw is None:
            return None
        try:
            return ConfirmRecord(**json.loads(raw))
        except (json.JSONDecodeError, TypeError, ValueError):
            logger.warning("confirm token payload corrupted: %s", token)
            return None
```

5. InMemoryConfirmStore：

```python
    def pop(self, token: str) -> ConfirmRecord | None:
        row = self._rows.pop(token, None)
        if row is None or time.time() > row["expires_at"]:
            return None
        return row["record"]
```

（`put` 不变；删掉原 `get`/`delete` 方法。）

6. `consume_confirm_token` 改用 pop（逻辑过期分类保留）：

```python
def consume_confirm_token(
    *,
    token: str,
    agent_id: str,
    idempotency_key: str | None,
    body: bytes,
    ttl_seconds: int = DEFAULT_CONFIRM_TTL_SECONDS,
) -> ConfirmRecord:
    """校验并消费（原子 pop，用后即删）。不匹配抛 ConfirmReplayError。"""
    record = get_confirm_store().pop(token)
    if record is None:
        raise ConfirmReplayError("invalid")
    if time.time() - record.created_at > ttl_seconds:
        raise ConfirmReplayError("expired")
    if (
        record.agent_id != agent_id
        or record.idempotency_key != idempotency_key
        or record.body_hash != compute_body_hash(body)
    ):
        raise ConfirmReplayError("invalid")
    return record
```

7. 装饰器类型标注与 gate 调用升级：

```python
def require_confirmation(
    *,
    action: str,
    build_preview: Callable[[dict, Request], dict] | None = None,
    validate: Callable[[dict, Request], None] | None = None,
):
```

docstring 对应行更新（validate/build_preview 接收 `(body, request)`）。`_confirm_gate` 内两处调用：

```python
        if validate is not None:
            validate(body, request)  # 业务校验先于 confirm（spec S6）；抛 AgentApiError 直接短路
```

```python
        preview: dict[str, Any] = {"action": action}
        if build_preview is not None:
            preview.update(build_preview(body, request))
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_confirm.py
```

Expected: 全绿（含新增 3 个类；本地 Redis 可用时 TestRedisStoreRoundtrip 实跑，否则 skip）。

- [ ] **Step 5: 更新设计稿措辞**

`docs/agent-api-design.md` §3.1 中：

> `confirm_token` 存 Redis（现有 `app/services/infra` 提供 Redis 客户端），key=`agent:confirm:{token}`，value 含 `{agent_id, action, body_hash, created_at}`，TTL=300s，用后即删。

改为：

> `confirm_token` 存 Redis（现有 `app/services/infra` 提供 Redis 客户端），key=`{redis_key_prefix}:agent:confirm:{token}`，value 含 `{agent_id, action, idempotency_key, body_hash, created_at}`，逻辑 TTL=300s（物理 TTL=2×，以区分过期与不存在），**原子 pop（Lua GET+DEL）用后即删**——并发重放只有一个能取到 token（P2 准入门槛）。

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/agent/confirm.py backend/tests/api/agent/test_confirm.py docs/agent-api-design.md
git commit -m "refactor(Agent-API): confirm 存储原子化并升级装饰器回调签名"
```

---

### Task 2: 货件读路由（4 条）+ 响应壳翻译层

**Files:**
- Create: `backend/app/api/v1/endpoints/agent/shipments.py`
- Modify: `backend/app/api/v1/endpoints/agent/__init__.py`
- Create: `backend/tests/api/agent/conftest.py`
- Test: `backend/tests/api/agent/test_shipments_read.py`

**Interfaces:**
- Consumes: Task 1 装饰器新签名（本任务不用，后续写任务用）；P0 的 `agent_ok` / `AgentApiError` / `ErrorCode` / `require_agent_credential`（router 级已挂）；`app.services.shipment`（`list_shipment_schedules` / `get_shipment_schedule_detail` / `list_shipment_fba_box_details`）、`app.services.shipment.summary.list_shipment_sku_summary`、`app.services.shipment.serialization`（`serialize_schedule_list_item` / `build_shipment_schedule_detail`）
- Produces: `shipments_router`（prefix=`/projects/{project_id}/shipments`）；模块级 helper `_service_errors()`（contextmanager，翻译 service HTTPException）、`_resolve_schedule(db, project_id, shipment_no)`、`_get_project_or_shell_404(db, project_id)`——Task 3-9 在同文件追加路由与 helper

- [ ] **Step 1: 写测试 fixture（货件环境）**

Create `backend/tests/api/agent/conftest.py`:

```python
"""Agent 货件域测试 fixture（P2）。

shipment_env：临时项目 + 2 个 SKU（X-001/X-002，US，装箱率 10）+ 一张 agent 凭据。
测试后按 items → schedules → skus → project 顺序清理（key 由 make_api_key 自清）。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models import Project
from app.models.sku_info import SkuRecord
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.schemas.shipment_schedule import ShipmentScheduleCreate
from app.services import shipment as shipment_service
from app.services.shipment.item import replace_shipment_schedule_items


def seed_schedule(project_id: int, shipment_no: str) -> int:
    """建一张 draft 货件 + 2 行明细（X-001×100、X-002×50），返回 schedule id。

    放在 conftest 里供同目录测试文件 `from conftest import seed_schedule`
    （tests 目录非 package，不能跨模块 `from tests....` 导入）。
    """
    db = SessionLocal()
    try:
        payload = ShipmentScheduleCreate(
            project_id=project_id,
            country="US",
            shipment_no=shipment_no,
            shipping_method="sea",
            shipment_status="draft",
            logistics_unit_price=13.5,
        )
        row = shipment_service.create_shipment_schedule(db, payload, operator="pytest")
        items = [
            {
                "row_no": 1,
                "project_name": None,
                "shipment_no": None,
                "item_date": None,
                "sku": "X-001",
                "quantity": 100,
                "carton_count": 10,
                "remark": None,
            },
            {
                "row_no": 2,
                "project_name": None,
                "shipment_no": None,
                "item_date": None,
                "sku": "X-002",
                "quantity": 50,
                "carton_count": 5,
                "remark": None,
            },
        ]
        replace_shipment_schedule_items(db, row, items, source_type="manual")
        db.commit()
        return row.id
    finally:
        db.close()


@pytest.fixture
def shipment_env(make_api_key):
    agent_id = f"p2-agent-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id)
    suffix = uuid.uuid4().hex[:8]
    project_name = f"agent-p2-{suffix}"

    db = SessionLocal()
    try:
        project = Project(
            project_name=project_name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        for sku in ("X-001", "X-002"):
            db.add(
                SkuRecord(
                    project_id=project.id,
                    project_name=project_name,
                    sku=sku,
                    asin=f"ASIN-{sku}",
                    country="US",
                    fob_unit_cost=10,
                    first_leg_cost_rmb=1,
                    package_length_cm=10,
                    package_width_cm=10,
                    package_height_cm=10,
                    weight_kg=0.5,
                    carton_length_cm=20,
                    carton_width_cm=20,
                    carton_height_cm=20,
                    carton_weight_kg=5,
                    units_per_carton=10,
                    currency="USD",
                    sort_order=0,
                    is_active=True,
                )
            )
        db.commit()
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "headers": {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        },
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(ShipmentScheduleItem).where(
                ShipmentScheduleItem.project_id == project_id
            )
        )
        db.execute(
            delete(ShipmentSchedule).where(ShipmentSchedule.project_id == project_id)
        )
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()
```

- [ ] **Step 2: 写读路由失败测试**

Create `backend/tests/api/agent/test_shipments_read.py`:

```python
"""Agent 货件读路由（spec S1 + E6 完整版 + 读不落审计）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app

from conftest import seed_schedule


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _audit_count() -> int:
    db = SessionLocal()
    try:
        return db.execute(text("select count(*) from operation_audit_logs")).scalar()
    finally:
        db.close()


class TestShipmentReads:
    def test_list_ok_and_no_audit(self, client, shipment_env):
        shipment_no = f"SH-R-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        before = _audit_count()

        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        nos = [item["shipment_no"] for item in body["data"]["items"]]
        assert shipment_no in nos
        assert _audit_count() == before  # 读不落审计

    def test_list_filters_by_status(self, client, shipment_env):
        shipment_no = f"SH-F-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments",
            params={"shipment_status": "draft", "shipment_no": shipment_no},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200
        items = resp.json()["data"]["items"]
        assert len(items) == 1 and items[0]["shipment_no"] == shipment_no

    def test_detail_ok(self, client, shipment_env):
        shipment_no = f"SH-D-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["shipment_no"] == shipment_no
        assert data["sku_count"] == 2
        assert data["total_quantity"] == 150
        assert {item["sku"] for item in data["items"]} == {"X-001", "X-002"}

    def test_sku_summary_ok(self, client, shipment_env):
        shipment_no = f"SH-S-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}/sku-summary",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        assert {item["sku"] for item in items} == {"X-001", "X-002"}

    def test_fba_box_detail_ok(self, client, shipment_env):
        shipment_no = f"SH-B-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}/fba-box-detail",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert shipment_no in data["shipment_nos"]
        assert len(data["items"]) > 0

    def test_unknown_project_404_shell(self, client, shipment_env):
        """spec E6 完整版。"""
        resp = client.get(
            "/api/v1/agent/projects/99999999/shipments",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_unknown_shipment_404_shell(self, client, shipment_env):
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/SH-NOPE",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_shipment_of_other_project_404(self, client, shipment_env):
        """跨项目越权读取 = 资源不存在（不泄漏存在性）。"""
        shipment_no = f"SH-X-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/99999999/shipments/{shipment_no}",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_read.py
```

Expected: FAIL（404 兜底把所有未匹配路径吞成鉴权后 404 壳，但断言的 data 结构不满足 / 或路由未定义）。

- [ ] **Step 4: 实现 shipments.py 读路由**

Create `backend/app/api/v1/endpoints/agent/shipments.py`:

```python
"""Agent 货件域路由（设计稿 P2；spec §5）。

读路由不落审计、绕过 Redis 读缓存直查 DB；写路由全部走 confirm 两步确认，
审计归因走 agent_id / idempotency_key（operator=NULL）。
service 层抛出的裸 HTTPException 在 ``_service_errors`` 里统一翻译成响应壳。
"""

from __future__ import annotations

from contextlib import contextmanager

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.deps import get_read_db_session
from app.models import Project
from app.models.shipment_schedule import ShipmentSchedule
from app.schemas.shipment_schedule import (
    ShipmentFbaBoxDetailItem,
    ShipmentFbaBoxDetailResponse,
    ShipmentScheduleListResponse,
)
from app.services import shipment as shipment_service
from app.services.shipment import summary as shipment_summary_service
from app.services.shipment.serialization import (
    build_shipment_schedule_detail,
    serialize_schedule_list_item,
)

shipments_router = APIRouter(
    prefix="/projects/{project_id}/shipments",
    tags=["agent-shipments"],
)


# ============================================================
# 壳翻译与解析 helper（后续写任务继续追加）
# ============================================================


def _translate_http_exception(exc: HTTPException) -> AgentApiError:
    detail = str(exc.detail) if exc.detail else None
    if exc.status_code == 404:
        return AgentApiError(ErrorCode.RESOURCE_NOT_FOUND, human_message=detail)
    if exc.status_code == 409:
        return AgentApiError(ErrorCode.SHIPMENT_DUPLICATE_NO, human_message=detail)
    if exc.status_code == 400 and "SKU" in (detail or ""):
        return AgentApiError(ErrorCode.SHIPMENT_ITEMS_INVALID_SKU, human_message=detail)
    return AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail)


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        raise _translate_http_exception(exc) from None


def _get_project_or_shell_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"项目 {project_id} 不存在",
        )
    return project


def _resolve_schedule(db: Session, project_id: int, shipment_no: str) -> ShipmentSchedule:
    row = db.scalars(
        select(ShipmentSchedule).where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.shipment_no == shipment_no,
        )
    ).first()
    if row is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"货件 {shipment_no} 不存在或不属于该项目",
        )
    return row


# ============================================================
# 读路由
# ============================================================


@shipments_router.get("")
def list_shipments(
    project_id: int,
    db: Session = Depends(get_read_db_session),
    country: str | None = Query(default=None),
    shipment_status: str | None = Query(default=None),
    shipping_method: str | None = Query(default=None),
    shipment_no: str | None = Query(default=None),
    created_date_from: str | None = Query(default=None),
    created_date_to: str | None = Query(default=None),
    etd_from: str | None = Query(default=None),
    etd_to: str | None = Query(default=None),
    eta_from: str | None = Query(default=None),
    eta_to: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> dict:
    with _service_errors():
        _get_project_or_shell_404(db, project_id)
        rows, total, has_next = shipment_service.list_shipment_schedules(
            db,
            project_id=project_id,
            country=country,
            shipment_status=shipment_status,
            shipping_method=shipping_method,
            shipment_no=shipment_no,
            created_date_from=created_date_from,
            created_date_to=created_date_to,
            etd_from=etd_from,
            etd_to=etd_to,
            eta_from=eta_from,
            eta_to=eta_to,
            page=page,
            page_size=page_size,
            include_total=True,
        )
    payload = ShipmentScheduleListResponse(
        items=[
            serialize_schedule_list_item(row, sku_count, total_quantity)
            for row, sku_count, total_quantity in rows
        ],
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )
    return agent_ok(payload.model_dump())


@shipments_router.get("/{shipment_no}")
def get_shipment(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> dict:
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, schedule.id
        )
    detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
    return agent_ok(detail.model_dump())


@shipments_router.get("/{shipment_no}/sku-summary")
def get_shipment_sku_summary(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> dict:
    with _service_errors():
        _resolve_schedule(db, project_id, shipment_no)
        rows = shipment_summary_service.list_shipment_sku_summary(
            db,
            project_id=project_id,
            shipment_nos=[shipment_no],
            include_only_history_calc=False,
            shipment_status=None,
        )
    return agent_ok({"items": rows})


@shipments_router.get("/{shipment_no}/fba-box-detail")
def get_shipment_fba_box_detail(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
) -> dict:
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        rows, items = shipment_service.list_shipment_fba_box_details(
            db, shipment_nos=[shipment_no]
        )
    response = ShipmentFbaBoxDetailResponse(
        project_ids=[int(row.project_id) for row in rows],
        project_names=[str(row.project_name_snapshot) for row in rows],
        countries=[str(row.country) for row in rows],
        shipment_nos=[str(row.shipment_no) for row in rows],
        items=[ShipmentFbaBoxDetailItem(**item) for item in items],
    )
    return agent_ok(response.model_dump())
```

- [ ] **Step 5: 挂载 router（兜底路由之前！）**

`app/api/v1/endpoints/agent/__init__.py`：import 区加

```python
from app.api.v1.endpoints.agent.shipments import shipments_router
```

在 `agent_router.include_router(health_router)` 之后、**兜底路由定义之前**加：

```python
agent_router.include_router(shipments_router)
```

（兜底路由上方的遮蔽警告注释仍然有效——违反顺序会把货件路由吞成 404。）

- [ ] **Step 6: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent && pytest -q
```

Expected: 读用例全绿；全量无新增失败。

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/shipments.py backend/app/api/v1/endpoints/agent/__init__.py \
        backend/tests/api/agent/conftest.py backend/tests/api/agent/test_shipments_read.py
git commit -m "feat(Agent-API): 货件域读路由与壳翻译层"
```

---

### Task 3: 审计查询 service + 货件审计路由（S7）

**Files:**
- Modify: `backend/app/services/audit_log_service.py`
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`（追加审计路由）
- Test: `backend/tests/api/agent/test_shipments_audit.py`、`backend/tests/services/test_audit_log_query.py`

**Interfaces:**
- Consumes: Task 2 的 `_resolve_schedule` / `_service_errors` / `shipments_router`
- Produces: `audit_log_service.query_operation_audit_log(db, *, target_type, target_id, limit=50) -> list[OperationAuditLog]`（id 倒序）；`GET /{shipment_no}/audit` 路由

- [ ] **Step 1: 写 service 层失败测试**

Create `backend/tests/services/test_audit_log_query.py`:

```python
"""query_operation_audit_log（spec S7 的 service 层）。"""

from __future__ import annotations

import uuid

import pytest

from app.db.session import SessionLocal
from app.models.operation_audit_log import OperationAuditLog
from app.services.audit_log_service import (
    append_operation_audit_log,
    query_operation_audit_log,
)


@pytest.fixture
def seeded_rows():
    target_id = f"tgt-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        for i in range(3):
            append_operation_audit_log(
                db,
                action=f"agent.test.q{i}",
                target_type="shipment_schedule",
                target_id=target_id,
                agent_id="query-agent",
                after={"i": i},
            )
        # 干扰行：其他 target
        append_operation_audit_log(
            db,
            action="agent.test.other",
            target_type="shipment_schedule",
            target_id="other-target",
            agent_id="query-agent",
        )
        db.commit()
    finally:
        db.close()
    yield target_id
    db = SessionLocal()
    try:
        db.query(OperationAuditLog).filter(
            OperationAuditLog.agent_id == "query-agent"
        ).delete()
        db.commit()
    finally:
        db.close()


def test_query_filters_and_orders(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log(
            db, target_type="shipment_schedule", target_id=seeded_rows
        )
        assert len(rows) == 3
        assert rows[0].id > rows[1].id > rows[2].id  # id 倒序
        assert all(r.target_id == seeded_rows for r in rows)
    finally:
        db.close()


def test_query_limit(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log(
            db, target_type="shipment_schedule", target_id=seeded_rows, limit=2
        )
        assert len(rows) == 2
    finally:
        db.close()


def test_query_empty(seeded_rows):
    db = SessionLocal()
    try:
        rows = query_operation_audit_log(
            db, target_type="shipment_schedule", target_id="nonexistent"
        )
        assert rows == []
    finally:
        db.close()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/services/test_audit_log_query.py
```

Expected: FAIL（`query_operation_audit_log` 不存在）。

- [ ] **Step 3: 实现查询函数**

`app/services/audit_log_service.py` 顶部 import 补 `from sqlalchemy import select`（现有 `from sqlalchemy import text`，合并即可），文件末尾追加：

```python
def query_operation_audit_log(
    db: Session,
    *,
    target_type: str,
    target_id: str,
    limit: int = 50,
) -> list[OperationAuditLog]:
    """按 target 查审计行（id 倒序）。Agent 货件审计路由使用（spec S7）。"""
    return list(
        db.scalars(
            select(OperationAuditLog)
            .where(
                OperationAuditLog.target_type == target_type,
                OperationAuditLog.target_id == str(target_id),
            )
            .order_by(OperationAuditLog.id.desc())
            .limit(min(max(int(limit), 1), 200))
        )
    )
```

- [ ] **Step 4: 跑 service 测试确认通过**

```bash
cd backend && pytest -q tests/services/test_audit_log_query.py
```

Expected: PASS。

- [ ] **Step 5: 写路由层测试**

Create `backend/tests/api/agent/test_shipments_audit.py`:

```python
"""Agent 货件审计路由（spec S7：读该货件的审计行）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models.operation_audit_log import OperationAuditLog
from app.services.audit_log_service import append_operation_audit_log

from conftest import seed_schedule


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_audit_route_returns_rows_for_shipment(client, shipment_env):
    shipment_no = f"SH-A-{uuid.uuid4().hex[:8]}"
    schedule_id = seed_schedule(shipment_env["project_id"], shipment_no)

    # 直接注入两行该货件的审计（真实写审计由 Task 5+ 的写路由测试覆盖）
    db = SessionLocal()
    try:
        for action in ("shipment.create", "shipment.update"):
            append_operation_audit_log(
                db,
                action=action,
                target_type="shipment_schedule",
                target_id=schedule_id,
                agent_id=shipment_env["agent_id"],
                idempotency_key=f"idem-{uuid.uuid4().hex[:8]}",
                after={"shipment_no": shipment_no},
            )
        db.commit()
    finally:
        db.close()

    try:
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}/audit",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["shipment_no"] == shipment_no
        actions = [item["action"] for item in data["items"]]
        assert "shipment.create" in actions and "shipment.update" in actions
        first = data["items"][0]
        assert first["agent_id"] == shipment_env["agent_id"]
        assert first["idempotency_key"]
        assert first["id"] == max(item["id"] for item in data["items"])  # 倒序
    finally:
        db = SessionLocal()
        try:
            db.query(OperationAuditLog).filter_by(
                agent_id=shipment_env["agent_id"]
            ).delete()
            db.commit()
        finally:
            db.close()


def test_audit_route_unknown_shipment_404(client, shipment_env):
    resp = client.get(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/SH-NOPE/audit",
        headers=shipment_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
```

- [ ] **Step 6: 实现审计路由**

`app/api/v1/endpoints/agent/shipments.py` import 区加：

```python
from fastapi import Query  # 已有则跳过
from app.services.audit_log_service import query_operation_audit_log
```

在审计查询路由区追加（读路由区末尾）：

```python
@shipments_router.get("/{shipment_no}/audit")
def get_shipment_audit(
    project_id: int,
    shipment_no: str,
    db: Session = Depends(get_read_db_session),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        rows = query_operation_audit_log(
            db,
            target_type="shipment_schedule",
            target_id=str(schedule.id),
            limit=limit,
        )
    return agent_ok(
        {
            "shipment_no": shipment_no,
            "items": [
                {
                    "id": row.id,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                    "action": row.action,
                    "agent_id": row.agent_id,
                    "operator": row.operator,
                    "idempotency_key": row.idempotency_key,
                    "result": row.result,
                    "before": row.before_json,
                    "after": row.after_json,
                    "error_message": row.error_message,
                }
                for row in rows
            ],
        }
    )
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_audit.py tests/services/test_audit_log_query.py
```

Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/audit_log_service.py backend/app/api/v1/endpoints/agent/shipments.py \
        backend/tests/services/test_audit_log_query.py backend/tests/api/agent/test_shipments_audit.py
git commit -m "feat(Agent-API): 货件审计查询路由"
```

---

### Task 4: SHIPMENT 错误码 + 写前校验 helper

**Files:**
- Modify: `backend/app/api/agent/errors.py`
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`（追加校验 helper）
- Test: `backend/tests/api/agent/test_shipment_errors.py`

**Interfaces:**
- Consumes: Task 2 的 `_service_errors`（本任务的翻译码表扩展它）
- Produces: `ErrorCode.SHIPMENT_DUPLICATE_NO`(409) / `SHIPMENT_ITEMS_INVALID_SKU`(400) / `SHIPMENT_STATUS_INVALID`(400)；helper `_check_idempotency_header(request)`、`_normalize_items_body(body) -> list[dict]`、`_find_missing_skus(db, *, project_name, country, skus) -> list[str]`、`_validate_items_skus(db, *, project_name, country, normalized_items)`（缺 SKU 时抛结构化 details 的 `SHIPMENT_ITEMS_INVALID_SKU`）——Task 5-9 的 validate 回调全部复用

- [ ] **Step 1: 写失败测试**

Create `backend/tests/api/agent/test_shipment_errors.py`:

```python
"""SHIPMENT 错误码 + 写前校验 helper（Task 4）。"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.v1.endpoints.agent.shipments import (
    _check_idempotency_header,
    _normalize_items_body,
    _translate_http_exception,
)


class _FakeRequest:
    def __init__(self, idempotency_key: str | None):
        self.headers = {"idempotency-key": idempotency_key} if idempotency_key is not None else {}


class TestErrorCodeMapping:
    def test_new_codes_registered(self):
        assert AgentApiError(ErrorCode.SHIPMENT_DUPLICATE_NO).status_code == 409
        assert AgentApiError(ErrorCode.SHIPMENT_ITEMS_INVALID_SKU).status_code == 400
        assert AgentApiError(ErrorCode.SHIPMENT_STATUS_INVALID).status_code == 400

    def test_translate_404(self):
        exc = _translate_http_exception(HTTPException(status_code=404, detail="没找到"))
        assert exc.code is ErrorCode.RESOURCE_NOT_FOUND

    def test_translate_409(self):
        exc = _translate_http_exception(HTTPException(status_code=409, detail="货件编号已存在"))
        assert exc.code is ErrorCode.SHIPMENT_DUPLICATE_NO

    def test_translate_400_sku(self):
        exc = _translate_http_exception(
            HTTPException(status_code=400, detail="以下 SKU 未找到可用的 SKU 信息：X-999")
        )
        assert exc.code is ErrorCode.SHIPMENT_ITEMS_INVALID_SKU

    def test_translate_422_generic(self):
        exc = _translate_http_exception(HTTPException(status_code=422, detail="shipment_status 必须是: ..."))
        assert exc.code is ErrorCode.VALIDATION_FAILED
        assert exc.status_code == 400


class TestIdempotencyHeader:
    def test_absent_ok(self):
        _check_idempotency_header(_FakeRequest(None))  # 不抛

    def test_valid_ok(self):
        _check_idempotency_header(_FakeRequest("k" * 64))

    def test_empty_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _check_idempotency_header(_FakeRequest(""))
        assert exc.value.code is ErrorCode.VALIDATION_FAILED

    def test_too_long_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _check_idempotency_header(_FakeRequest("k" * 65))
        assert exc.value.code is ErrorCode.VALIDATION_FAILED


class TestNormalizeItemsBody:
    def test_valid(self):
        items = _normalize_items_body(
            {"items": [{"sku": "X-001", "quantity": 10}, {"sku": "X-002", "quantity": 5, "carton_count": 1}]}
        )
        assert items[0]["row_no"] == 1 and items[0]["sku"] == "X-001" and items[0]["quantity"] == 10
        assert items[1]["carton_count"] == 1

    def test_missing_items_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _normalize_items_body({})
        assert exc.value.code is ErrorCode.VALIDATION_FAILED

    def test_empty_items_rejected(self):
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": []})

    def test_duplicate_sku_rejected(self):
        with pytest.raises(AgentApiError) as exc:
            _normalize_items_body(
                {"items": [{"sku": "X-001", "quantity": 1}, {"sku": "X-001", "quantity": 2}]}
            )
        assert "重复" in exc.value.human_message

    def test_bad_quantity_rejected(self):
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": [{"sku": "X-001", "quantity": 0}]})
        with pytest.raises(AgentApiError):
            _normalize_items_body({"items": [{"sku": "X-001", "quantity": "abc"}]})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipment_errors.py
```

Expected: FAIL（新错误码/helper 不存在）。

- [ ] **Step 3: 扩展错误码注册表**

`app/api/agent/errors.py` 的 `ErrorCode` 枚举"通用"段之前加：

```python
    # 货件域（P2）
    SHIPMENT_DUPLICATE_NO = "SHIPMENT_DUPLICATE_NO"
    SHIPMENT_ITEMS_INVALID_SKU = "SHIPMENT_ITEMS_INVALID_SKU"
    SHIPMENT_STATUS_INVALID = "SHIPMENT_STATUS_INVALID"
```

`_HTTP_STATUS` 加三行：

```python
    ErrorCode.SHIPMENT_DUPLICATE_NO: 409,
    ErrorCode.SHIPMENT_ITEMS_INVALID_SKU: 400,
    ErrorCode.SHIPMENT_STATUS_INVALID: 400,
```

`_DEFAULTS` 加三条：

```python
    ErrorCode.SHIPMENT_DUPLICATE_NO: (
        "货件编号已存在",
        "请更换 shipment_no 后重试；可用列表端点查询已有货件",
    ),
    ErrorCode.SHIPMENT_ITEMS_INVALID_SKU: (
        "明细里有 SKU 在本项目不存在",
        "先核对 SKU 主数据（sku-info 相关端点），修正后重试",
    ),
    ErrorCode.SHIPMENT_STATUS_INVALID: (
        "货件状态值不合法",
        "合法状态值：draft、in_transit、completed",
    ),
```

- [ ] **Step 4: 追加校验 helper 到 shipments.py**

`app/api/v1/endpoints/agent/shipments.py` import 区加：

```python
from app.models.sku_info import SkuRecord
from app.services.shipment.validation import ALLOWED_SHIPMENT_STATUS, ALLOWED_SHIPPING_METHOD
```

在 helper 区追加：

```python
def _check_idempotency_header(request: Request) -> None:
    """Idempotency-Key 可缺失；出现则必须非空且 ≤64 字符（spec §3）。"""
    value = request.headers.get("idempotency-key")
    if value is not None and (len(value) == 0 or len(value) > 64):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="Idempotency-Key 必须为非空字符串且不超过 64 字符",
        )


def _normalize_items_body(body: dict) -> list[dict]:
    """把请求体里的 items 规范化为 service 层明细 dict；结构错误抛壳异常。"""
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="items 必须为非空数组"
        )
    normalized: list[dict] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_items, start=1):
        if not isinstance(item, dict):
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=f"第 {index} 行：明细必须是对象"
            )
        sku = str(item.get("sku") or "").strip()
        quantity = item.get("quantity")
        if not sku:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=f"第 {index} 行：sku 不能为空"
            )
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"第 {index} 行：quantity 必须为正整数",
            )
        if sku in seen:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message=f"SKU 明细中存在重复 SKU: {sku}",
            )
        seen.add(sku)
        carton_count = item.get("carton_count")
        normalized.append(
            {
                "row_no": index,
                "project_name": None,
                "shipment_no": None,
                "item_date": item.get("item_date"),
                "sku": sku,
                "quantity": int(quantity),
                "carton_count": int(carton_count) if carton_count is not None else None,
                "remark": item.get("remark"),
            }
        )
    return normalized


def _find_missing_skus(
    db: Session, *, project_name: str, country: str, skus: list[str]
) -> list[str]:
    found = set(
        db.scalars(
            select(SkuRecord.sku).where(
                SkuRecord.project_name == project_name,
                SkuRecord.country == country,
                SkuRecord.sku.in_(skus),
            )
        ).all()
    )
    return [sku for sku in skus if sku not in found]


def _validate_items_skus(
    db: Session,
    *,
    project_name: str,
    country: str,
    normalized_items: list[dict],
) -> None:
    """结构化 SKU 存在性校验（spec S6：details 逐行给出）。"""
    missing = _find_missing_skus(
        db,
        project_name=project_name,
        country=country,
        skus=[str(item["sku"]) for item in normalized_items],
    )
    if not missing:
        return
    sku_to_row = {str(item["sku"]): int(item["row_no"]) for item in normalized_items}
    raise AgentApiError(
        ErrorCode.SHIPMENT_ITEMS_INVALID_SKU,
        human_message=f"明细里有 {len(missing)} 个 SKU 在本项目不存在",
        details=[
            {"row": sku_to_row[sku], "sku": sku, "reason": "not_found"}
            for sku in missing
        ],
    )
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipment_errors.py && pytest -q tests/api/agent
```

Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/agent/errors.py backend/app/api/v1/endpoints/agent/shipments.py \
        backend/tests/api/agent/test_shipment_errors.py
git commit -m "feat(Agent-API): 货件错误码与写前校验 helper"
```

---

### Task 5: 创建货件路由（复合写 + confirm，S3/S6）

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`（追加写路由区）
- Test: `backend/tests/api/agent/test_shipments_confirm.py`

**Interfaces:**
- Consumes: Task 1 装饰器（`(body, request)` 回调）、Task 2 `_service_errors`/`_resolve_schedule`、Task 3 `query_operation_audit_log`（测试断言）、Task 4 全部 helper；`app.services.shipment.create_shipment_schedule`、`app.services.shipment.item.replace_shipment_schedule_items`；`app.services.infra` 缓存失效函数
- Produces: `POST /api/v1/agent/projects/{project_id}/shipments`（一次 confirm 覆盖建单+明细两步，同一事务）；写路由公共 helper `_audit_kwargs(request)`、`_invalidate_shipment_caches(row)`——Task 6-9 复用；confirm 测试的 `confirm_memory_store` fixture

- [ ] **Step 1: 写失败测试（S3 + S6 + 重复编号 + 写桶限流）**

Create `backend/tests/api/agent/test_shipments_confirm.py`:

```python
"""Agent 货件写路由 confirm 流（spec S2-S6；S2 在 Task 9 补）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.api.agent.confirm import InMemoryConfirmStore, get_confirm_store, set_confirm_store
from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log

from conftest import seed_schedule


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis，且可直接改 created_at 模拟过期。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


def _post(client, shipment_env, url_suffix, body, *, token=None, idem=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.post(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments{url_suffix}",
        json=body,
        headers=headers,
    )


def _create_body(shipment_no: str) -> dict:
    return {
        "shipment_no": shipment_no,
        "country": "US",
        "shipping_method": "sea",
        "shipment_status": "draft",
        "etd_date": "2026-08-20",
        "eta_date": "2026-09-15",
        "logistics_unit_price": 13.5,
        "items": [
            {"sku": "X-001", "quantity": 100},
            {"sku": "X-002", "quantity": 50},
        ],
    }


class TestCreateShipment:
    def test_s3_preview_then_replay(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-C-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        # 第一次：预览壳（HTTP 200 + ok:false + requires_confirmation）
        preview = _post(client, shipment_env, "", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["expires_in_sec"] == 300
        assert pbody["preview"]["shipment_no"] == shipment_no
        assert pbody["preview"]["items_count"] == 2
        assert pbody["preview"]["total_quantity"] == 150

        # 第二次：重放落库
        replay = _post(client, shipment_env, "", body, token=pbody["confirm_token"], idem=idem)
        assert replay.status_code == 200, replay.text
        rbody = replay.json()
        assert rbody["ok"] is True
        assert rbody["data"]["shipment_no"] == shipment_no
        assert rbody["data"]["total_quantity"] == 150
        assert rbody["idempotency_key"] == idem

        # 审计行：agent 归因
        db = SessionLocal()
        try:
            schedule_id = rbody["data"]["id"]
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(schedule_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "shipment.create"
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
            assert audit.operator is None
        finally:
            db.close()

    def test_replay_single_use(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-U-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, "", body, idem=idem)
        token = preview.json()["confirm_token"]
        first = _post(client, shipment_env, "", body, token=token, idem=idem)
        assert first.status_code == 200
        second = _post(client, shipment_env, "", body, token=token, idem=idem)
        assert second.status_code == 400
        assert second.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_s6_invalid_sku_before_confirm(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-VSKU-{uuid.uuid4().hex[:8]}")
        body["items"].append({"sku": "X-999", "quantity": 1})
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "SHIPMENT_ITEMS_INVALID_SKU"
        assert {"row": 3, "sku": "X-999", "reason": "not_found"} in err["details"]
        # 业务校验先于 confirm：未签发 token
        assert get_confirm_store()._rows == {}

    def test_invalid_status_rejected(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-VST-{uuid.uuid4().hex[:8]}")
        body["shipment_status"] = "shipped"
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 400
        err = resp.json()["error"]
        assert err["code"] == "SHIPMENT_STATUS_INVALID"
        assert sorted(err["details"]["allowed"]) == ["completed", "draft", "in_transit"]

    def test_invalid_shipping_method_rejected(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-VSM-{uuid.uuid4().hex[:8]}")
        body["shipping_method"] = "海运"  # 只接受英文 token
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_duplicate_shipment_no_rejected(self, client, shipment_env, confirm_memory_store):
        existing = f"SH-DUP-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], existing)
        body = _create_body(existing)
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "SHIPMENT_DUPLICATE_NO"

    def test_unknown_project_on_create_404(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-NP-{uuid.uuid4().hex[:8]}")
        headers = dict(shipment_env["headers"])
        headers["Idempotency-Key"] = "idem-x"
        resp = client.post(
            "/api/v1/agent/projects/99999999/shipments", json=body, headers=headers
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestWriteRateLimit:
    def test_write_bucket(self, client, shipment_env, confirm_memory_store, settings):
        settings.agent_api_write_rate_limit = "2/minute"
        for i in range(2):
            resp = _post(
                client, shipment_env, "", _create_body(f"SH-RL-{uuid.uuid4().hex[:8]}")
            )
            assert resp.status_code == 200, resp.text
        blocked = _post(
            client, shipment_env, "", _create_body(f"SH-RL-{uuid.uuid4().hex[:8]}")
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "AGENT_RATE_LIMIT_EXCEEDED"
```

文件头补 `settings` fixture（与 test_rate_limit.py 同款）：

```python
@pytest.fixture
def settings():
    from app.core.config import get_settings

    return get_settings()
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py
```

Expected: FAIL（写路由未定义 → 404/405）。

- [ ] **Step 3: 实现创建路由**

`app/api/v1/endpoints/agent/shipments.py` import 区加：

```python
import json

from fastapi import Depends  # 已有则跳过
from app.api.agent.confirm import require_confirmation
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.deps import get_primary_db_session  # 与 get_read_db_session 合并 import
from app.schemas.shipment_schedule import ShipmentScheduleCreate  # 并入既有 schemas import
from app.services import infra as redis_service
from app.services.audit_log_service import append_operation_audit_log  # 与 query 合并 import
from app.services.shipment.item import replace_shipment_schedule_items
```

写路由公共 helper（helper 区追加）：

```python
def _audit_kwargs(request: Request) -> dict:
    """agent 写审计归因（设计稿 §4.2：operator=NULL，agent_id/idempotency_key 归因）。"""
    return {
        "agent_id": getattr(request.state, "agent_id", None),
        "idempotency_key": request.headers.get("idempotency-key") or None,
        "request": request,
    }


def _invalidate_shipment_caches(row) -> None:
    """写后缓存失效，对齐内部端点（backend/app/api/v1/endpoints/shipment_schedules.py）。"""
    redis_service.invalidate_shipment_schedule_detail_cache(row.id)
    redis_service.invalidate_shipment_schedules_list_cache()
    redis_service.invalidate_shipment_schedules_cost_summary_cache()
    redis_service.invalidate_shipment_sku_summary_cache()
    redis_service.invalidate_shipment_fba_box_details_cache()
    redis_service.invalidate_shipment_in_transit_qty_cache(row.project_id)
    redis_service.invalidate_daily_analysis_cache(row.project_id)
```

创建路由的 validate/preview/handler：

```python
def _validate_create(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    shipment_no = str(body.get("shipment_no") or "").strip()
    shipping_method = str(body.get("shipping_method") or "").strip()
    shipment_status = str(body.get("shipment_status") or "").strip()
    if not shipment_no:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="shipment_no 不能为空")
    if shipping_method not in ALLOWED_SHIPPING_METHOD:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                f"shipping_method 必须是: {', '.join(sorted(ALLOWED_SHIPPING_METHOD))}"
            ),
        )
    if shipment_status not in ALLOWED_SHIPMENT_STATUS:
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )
    items = _normalize_items_body(body)

    db = SessionLocal()
    try:
        project = _get_project_or_shell_404(db, project_id)
        duplicate = db.scalars(
            select(ShipmentSchedule).where(ShipmentSchedule.shipment_no == shipment_no)
        ).first()
        if duplicate is not None:
            raise AgentApiError(
                ErrorCode.SHIPMENT_DUPLICATE_NO,
                human_message=f"货件编号 {shipment_no} 已存在",
            )
        _validate_items_skus(
            db,
            project_name=str(project.project_name),
            country=str(body.get("country") or "US"),
            normalized_items=items,
        )
    finally:
        db.close()


def _preview_create(body: dict, request: Request) -> dict:
    items = body.get("items") or []
    return {
        "shipment_no": body.get("shipment_no"),
        "shipment_status": body.get("shipment_status"),
        "shipping_method": body.get("shipping_method"),
        "items_count": len(items),
        "total_quantity": sum(
            int(item.get("quantity") or 0) for item in items if isinstance(item, dict)
        ),
    }


@shipments_router.post("", dependencies=[Depends(require_agent_write_rate_limit)])
@require_confirmation(
    action="shipment.create",
    build_preview=_preview_create,
    validate=_validate_create,
)
async def create_shipment(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    items = _normalize_items_body(body)
    create_payload = ShipmentScheduleCreate(
        project_id=project_id,
        country=str(body.get("country") or "US"),
        shipment_no=str(body["shipment_no"]).strip(),
        tracking_no=body.get("tracking_no"),
        warehouse_code=body.get("warehouse_code"),
        forwarder_name=body.get("forwarder_name"),
        shipping_method=str(body["shipping_method"]).strip(),
        created_date=body.get("created_date"),
        etd_date=body.get("etd_date"),
        eta_date=body.get("eta_date"),
        actual_inbound_date=body.get("actual_inbound_date"),
        logistics_unit_price=float(body.get("logistics_unit_price") or 0),
        include_in_history_shipping_calc=bool(
            body.get("include_in_history_shipping_calc", True)
        ),
        remark=body.get("remark"),
        shipment_status=str(body["shipment_status"]).strip(),
        shipment_batch=body.get("shipment_batch"),
    )
    with _service_errors():
        row = shipment_service.create_shipment_schedule(db, create_payload, operator=None)
        replace_shipment_schedule_items(db, row, items, source_type="manual")
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.create",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            after={
                "shipment_no": row.shipment_no,
                "project_id": row.project_id,
                "status": row.shipment_status,
                "items_count": len(items),
            },
            **_audit_kwargs(request),
        )
        db.commit()
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, row.id
        )
    detail = build_shipment_schedule_detail(row, sku_count, total_quantity)
    return agent_ok(
        detail.model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
```

`shipments.py` 顶部还需 `from app.db.session import SessionLocal`（validate 回调用独立会话）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py && pytest -q tests/api/agent
```

Expected: 全绿。常见失败点：装饰器包 async handler 后 FastAPI 依赖注入失效（functools.wraps 保留 __wrapped__，inspect.signature 会跟随——若真的失效，把 db 改为函数内 SessionLocal 手动管理并记录偏差）。

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/shipments.py backend/tests/api/agent/test_shipments_confirm.py
git commit -m "feat(Agent-API): 创建货件写路由与 confirm 流"
```

---

### Task 6: 替换明细路由（PUT items，替换语义 + confirm）

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`
- Modify: `backend/tests/api/agent/test_shipments_confirm.py`（追加测试类）

**Interfaces:**
- Consumes: Task 5 的 `_audit_kwargs` / `_invalidate_shipment_caches` / confirm fixture；`replace_shipment_schedule_items`
- Produces: `PUT /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/items`（**替换**语义：旧明细全删）

- [ ] **Step 1: 写失败测试**

`backend/tests/api/agent/test_shipments_confirm.py` 追加：

```python
class TestReplaceItems:
    def test_replace_preview_replay_and_semantics(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-IT-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)  # 已有 X-001×100、X-002×50
        body = {"items": [{"sku": "X-002", "quantity": 30}]}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, f"/{shipment_no}/items", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert pbody["preview"]["items_count"] == 1
        assert pbody["preview"]["total_quantity"] == 30

        replay = _post(
            client, shipment_env, f"/{shipment_no}/items", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        # 替换语义：只剩一行 X-002×30
        assert data["sku_count"] == 1
        assert data["total_quantity"] == 30
        assert data["items"][0]["sku"] == "X-002"

        # 审计行
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.items.replace")
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.before_json == {"items_count": 2}
            assert audit.after_json["total_quantity"] == 30
        finally:
            db.close()

    def test_replace_items_invalid_sku(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-ITSKU-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(
            client, shipment_env, f"/{shipment_no}/items",
            {"items": [{"sku": "X-999", "quantity": 1}]},
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SHIPMENT_ITEMS_INVALID_SKU"

    def test_replace_items_unknown_shipment_404(self, client, shipment_env, confirm_memory_store):
        resp = _post(client, shipment_env, "/SH-NOPE/items", {"items": [{"sku": "X-001", "quantity": 1}]})
        assert resp.status_code == 404
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py::TestReplaceItems
```

Expected: FAIL（路由未定义 → 404/405）。

- [ ] **Step 3: 实现 PUT items 路由**

`shipments.py` 写路由区追加：

```python
def _validate_replace_items(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    items = _normalize_items_body(body)
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        _validate_items_skus(
            db,
            project_name=str(schedule.project_name_snapshot),
            country=str(schedule.country),
            normalized_items=items,
        )
    finally:
        db.close()


def _preview_replace_items(body: dict, request: Request) -> dict:
    items = body.get("items") or []
    return {
        "shipment_no": request.path_params["shipment_no"],
        "items_count": len(items),
        "total_quantity": sum(
            int(item.get("quantity") or 0) for item in items if isinstance(item, dict)
        ),
        "note": "将完全替换该货件的现有明细（非追加）",
    }


@shipments_router.put(
    "/{shipment_no}/items", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.items.replace",
    build_preview=_preview_replace_items,
    validate=_validate_replace_items,
)
async def replace_shipment_items(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    items = _normalize_items_body(body)
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        before_count = len(schedule.items)
        replace_shipment_schedule_items(db, schedule, items, source_type="manual")
        db.flush()
        _invalidate_shipment_caches(schedule)
        append_operation_audit_log(
            db,
            action="shipment.items.replace",
            target_type="shipment_schedule",
            target_id=schedule.id,
            operator=None,
            before={"items_count": before_count},
            after={
                "items_count": len(items),
                "total_quantity": sum(int(item["quantity"]) for item in items),
            },
            **_audit_kwargs(request),
        )
        db.commit()
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, schedule.id
        )
    return agent_ok(
        build_shipment_schedule_detail(row, sku_count, total_quantity).model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/shipments.py backend/tests/api/agent/test_shipments_confirm.py
git commit -m "feat(Agent-API): 货件明细替换写路由"
```

---

### Task 7: PATCH 字段更新路由（读-改-写 + confirm）

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`
- Modify: `backend/tests/api/agent/test_shipments_confirm.py`

**Interfaces:**
- Consumes: Task 5 公共 helper；`shipment_service.update_shipment_schedule`（**全量** `ShipmentScheduleUpdate`）；`validation.normalize_status/normalize_shipping_method`
- Produces: `PATCH /{shipment_no}`（部分字段 patch → 合并当前值 → 全量 update；last-write-wins）；helper `_build_update_payload(schedule, patch)`

- [ ] **Step 1: 写失败测试**

`test_shipments_confirm.py` 追加：

```python
class TestPatchShipment:
    def test_patch_merges_partial_fields(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-P-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        body = {"remark": "agent 改的备注", "etd_date": "2026-10-01"}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, f"/{shipment_no}", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert sorted(pbody["preview"]["changed"]) == ["etd_date", "remark"]

        replay = _post(
            client, shipment_env, f"/{shipment_no}", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["remark"] == "agent 改的备注"
        assert data["etd_date"] == "2026-10-01"
        # 未 patch 的字段保持原值
        assert data["shipping_method"] == "sea"
        assert data["shipment_status"] == "draft"
        assert data["sku_count"] == 2  # 明细不受影响

    def test_patch_rejects_items_key(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-PI-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(
            client, shipment_env, f"/{shipment_no}",
            {"items": [{"sku": "X-001", "quantity": 1}]},
        )
        assert resp.status_code == 400
        assert "items" in resp.json()["error"]["human_message"]

    def test_patch_rejects_unknown_fields(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-PU-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(client, shipment_env, f"/{shipment_no}", {"nope_field": 1})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_patch_invalid_status(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-PS-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(client, shipment_env, f"/{shipment_no}", {"shipment_status": "arrived"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SHIPMENT_STATUS_INVALID"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py::TestPatchShipment
```

Expected: FAIL。

- [ ] **Step 3: 实现 PATCH 路由**

`shipments.py` import 区加：

```python
from datetime import date as date_type
from decimal import Decimal

from pydantic import ValidationError

from app.schemas.shipment_schedule import ShipmentScheduleUpdate  # 并入 schemas import
```

helper 与路由：

```python
_PATCHABLE_FIELDS = (
    "country",
    "shipment_no",
    "tracking_no",
    "warehouse_code",
    "forwarder_name",
    "shipping_method",
    "created_date",
    "etd_date",
    "eta_date",
    "actual_inbound_date",
    "logistics_unit_price",
    "include_in_history_shipping_calc",
    "remark",
    "shipment_status",
    "shipment_batch",
)


def _build_update_payload(schedule, patch: dict) -> ShipmentScheduleUpdate:
    """把部分 patch 合并成 update_shipment_schedule 需要的全量 payload。"""

    def current(name: str):
        value = getattr(schedule, name)
        if isinstance(value, date_type):
            return value.isoformat()
        if isinstance(value, Decimal):
            return float(value)
        return value

    data = {name: (patch[name] if name in patch else current(name)) for name in _PATCHABLE_FIELDS}
    data["project_id"] = int(schedule.project_id)
    return ShipmentScheduleUpdate(**data)


def _validate_patch(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    if not isinstance(body, dict) or not body:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="请求体必须是非空对象")
    if "items" in body:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="PATCH 不支持 items 字段；请改用 PUT .../items 替换明细",
        )
    unknown = sorted(set(body) - set(_PATCHABLE_FIELDS))
    if unknown:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=f"不支持的字段: {', '.join(unknown)}",
        )
    if "shipment_status" in body and body["shipment_status"] not in ALLOWED_SHIPMENT_STATUS:
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )
    if "shipping_method" in body and body["shipping_method"] not in ALLOWED_SHIPPING_METHOD:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message=(
                f"shipping_method 必须是: {', '.join(sorted(ALLOWED_SHIPPING_METHOD))}"
            ),
        )
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        try:
            _build_update_payload(schedule, body)
        except ValidationError as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                details=[
                    {"loc": [str(p) for p in e["loc"]], "msg": e["msg"]}
                    for e in exc.errors()
                ],
            ) from None
    finally:
        db.close()


def _preview_patch(body: dict, request: Request) -> dict:
    return {
        "shipment_no": request.path_params["shipment_no"],
        "changed": sorted(body.keys()),
    }


@shipments_router.patch(
    "/{shipment_no}", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.update", build_preview=_preview_patch, validate=_validate_patch
)
async def patch_shipment(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        before = {name: getattr(schedule, name) for name in body if name in _PATCHABLE_FIELDS}
        payload = _build_update_payload(schedule, body)
        row = shipment_service.update_shipment_schedule(
            db, schedule.id, payload, operator=None
        )
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.update",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            before={
                k: (v.isoformat() if isinstance(v, date_type) else v)
                for k, v in before.items()
            },
            after={
                "shipment_no": row.shipment_no,
                "project_id": row.project_id,
                "status": row.shipment_status,
            },
            **_audit_kwargs(request),
        )
        db.commit()
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, row.id
        )
    return agent_ok(
        build_shipment_schedule_detail(row, sku_count, total_quantity).model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/shipments.py backend/tests/api/agent/test_shipments_confirm.py
git commit -m "feat(Agent-API): 货件字段 PATCH 写路由"
```

---

### Task 8: 状态推进路由（confirm + before/after 审计，S5）

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`
- Modify: `backend/tests/api/agent/test_shipments_confirm.py`

**Interfaces:**
- Consumes: Task 7 的 `_build_update_payload`；`update_shipment_schedule`
- Produces: `POST /{shipment_no}/status`（body `{"to_status": ...}`；任意 to_status 都要 confirm——不可逆）

- [ ] **Step 1: 写失败测试（S5）**

`test_shipments_confirm.py` 追加：

```python
class TestStatusTransition:
    def test_s5_status_preview_replay_and_audit(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-ST-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)  # draft
        body = {"to_status": "in_transit"}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, f"/{shipment_no}/status", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert pbody["preview"]["from_status"] == "draft"
        assert pbody["preview"]["to_status"] == "in_transit"

        replay = _post(
            client, shipment_env, f"/{shipment_no}/status", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["shipment_status"] == "in_transit"

        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.status.transition")
            assert audit.before_json == {"shipment_status": "draft"}
            assert audit.after_json == {"shipment_status": "in_transit"}
            assert audit.agent_id == shipment_env["agent_id"]
        finally:
            db.close()

    def test_invalid_to_status(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-STI-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(client, shipment_env, f"/{shipment_no}/status", {"to_status": "shipped"})
        assert resp.status_code == 400
        err = resp.json()["error"]
        assert err["code"] == "SHIPMENT_STATUS_INVALID"
        assert sorted(err["details"]["allowed"]) == ["completed", "draft", "in_transit"]

    def test_missing_to_status(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-STM-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(client, shipment_env, f"/{shipment_no}/status", {})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py::TestStatusTransition
```

Expected: FAIL。

- [ ] **Step 3: 实现状态推进路由**

`shipments.py` 追加：

```python
def _validate_status(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    to_status = body.get("to_status")
    if not isinstance(to_status, str) or not to_status.strip():
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="to_status 必填且为字符串"
        )
    if to_status.strip() not in ALLOWED_SHIPMENT_STATUS:
        raise AgentApiError(
            ErrorCode.SHIPMENT_STATUS_INVALID,
            details={"allowed": sorted(ALLOWED_SHIPMENT_STATUS)},
        )


def _preview_status(body: dict, request: Request) -> dict:
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        from_status = str(schedule.shipment_status)
    finally:
        db.close()
    return {
        "shipment_no": shipment_no,
        "from_status": from_status,
        "to_status": str(body["to_status"]).strip(),
    }


@shipments_router.post(
    "/{shipment_no}/status", dependencies=[Depends(require_agent_write_rate_limit)]
)
@require_confirmation(
    action="shipment.status.transition",
    build_preview=_preview_status,
    validate=_validate_status,
)
async def transition_shipment_status(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    to_status = str(body["to_status"]).strip()
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        from_status = str(schedule.shipment_status)
        payload = _build_update_payload(schedule, {"shipment_status": to_status})
        row = shipment_service.update_shipment_schedule(
            db, schedule.id, payload, operator=None
        )
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.status.transition",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            before={"shipment_status": from_status},
            after={"shipment_status": to_status},
            **_audit_kwargs(request),
        )
        db.commit()
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, row.id
        )
    return agent_ok(
        build_shipment_schedule_detail(row, sku_count, total_quantity).model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/shipments.py backend/tests/api/agent/test_shipments_confirm.py
git commit -m "feat(Agent-API): 货件状态推进写路由"
```

---

### Task 9: 重算费用路由（写操作 + confirm，S2）

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/shipments.py`
- Modify: `backend/tests/api/agent/test_shipments_confirm.py`

**Interfaces:**
- Consumes: Task 5 公共 helper；`shipment_service.calculate_shipment_schedule_costs(db, schedule_id, *, logistics_unit_price)`（**会回写费用字段**）
- Produces: `POST /{shipment_no}/recalculate-costs`

- [ ] **Step 1: 写失败测试（S2）**

`test_shipments_confirm.py` 追加：

```python
class TestRecalculateCosts:
    def test_s2_preview_replay_and_audit(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-RC-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)  # 已有明细
        body = {"logistics_unit_price": 13.5}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs", body, idem=idem
        )
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert pbody["preview"]["action"] == "shipment.recalculate_costs"
        assert pbody["preview"]["shipment_no"] == shipment_no
        assert pbody["preview"]["logistics_unit_price"] == 13.5
        assert "note" in pbody["preview"]

        replay = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["logistics_unit_price"] == 13.5
        assert data["logistics_total_price"] > 0  # 费用被回写

        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.recalculate_costs")
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.after_json["logistics_unit_price"] == 13.5
        finally:
            db.close()

    def test_recalculate_without_items_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        # 空明细货件：直接建，不塞明细
        from app.schemas.shipment_schedule import ShipmentScheduleCreate
        from app.services import shipment as svc

        shipment_no = f"SH-RCE-{uuid.uuid4().hex[:8]}"
        db = SessionLocal()
        try:
            svc.create_shipment_schedule(
                db,
                ShipmentScheduleCreate(
                    project_id=shipment_env["project_id"],
                    country="US",
                    shipment_no=shipment_no,
                    shipping_method="sea",
                    shipment_status="draft",
                ),
                operator="pytest",
            )
            db.commit()
        finally:
            db.close()

        resp = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs",
            {"logistics_unit_price": 10},
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        assert get_confirm_store()._rows == {}  # 校验先于 confirm

    def test_negative_price_rejected(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-RCN-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs",
            {"logistics_unit_price": -1},
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py::TestRecalculateCosts
```

Expected: FAIL。

- [ ] **Step 3: 实现重算费用路由**

`shipments.py` 追加：

```python
def _validate_recalculate(body: dict, request: Request) -> None:
    _check_idempotency_header(request)
    price = body.get("logistics_unit_price")
    if not isinstance(price, (int, float)) or isinstance(price, bool) or price < 0:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="logistics_unit_price 必须为非负数字",
        )
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    db = SessionLocal()
    try:
        schedule = _resolve_schedule(db, project_id, shipment_no)
        if not schedule.items:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED,
                human_message="请先导入 SKU 明细，再执行核算",
            )
    finally:
        db.close()


def _preview_recalculate(body: dict, request: Request) -> dict:
    return {
        "shipment_no": request.path_params["shipment_no"],
        "logistics_unit_price": body.get("logistics_unit_price"),
        "note": "将按 SKU 尺寸/重量重算体积重与计费重，并回写该货件的物流费用",
    }


@shipments_router.post(
    "/{shipment_no}/recalculate-costs",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
@require_confirmation(
    action="shipment.recalculate_costs",
    build_preview=_preview_recalculate,
    validate=_validate_recalculate,
)
async def recalculate_shipment_costs(
    request: Request, db: Session = Depends(get_primary_db_session)
) -> dict:
    body = json.loads(await request.body() or b"{}")
    project_id = int(request.path_params["project_id"])
    shipment_no = str(request.path_params["shipment_no"])
    with _service_errors():
        schedule = _resolve_schedule(db, project_id, shipment_no)
        row, sku_count, total_quantity = shipment_service.calculate_shipment_schedule_costs(
            db, schedule.id, logistics_unit_price=body["logistics_unit_price"]
        )
        _invalidate_shipment_caches(row)
        append_operation_audit_log(
            db,
            action="shipment.recalculate_costs",
            target_type="shipment_schedule",
            target_id=row.id,
            operator=None,
            after={
                "shipment_no": row.shipment_no,
                "logistics_unit_price": float(row.logistics_unit_price or 0),
                "total_volume_m3": float(row.total_volume_m3 or 0),
                "total_chargeable_weight_kg": float(row.total_chargeable_weight_kg or 0),
                "logistics_total_price": float(row.logistics_total_price or 0),
                "sku_count": sku_count,
                "total_quantity": total_quantity,
            },
            **_audit_kwargs(request),
        )
        db.commit()
        row, sku_count, total_quantity = shipment_service.get_shipment_schedule_detail(
            db, row.id
        )
    return agent_ok(
        build_shipment_schedule_detail(row, sku_count, total_quantity).model_dump(),
        idempotency_key=request.headers.get("idempotency-key") or None,
    )
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py && pytest -q tests/api/agent
```

Expected: 全绿（S2-S6 全部就位）。

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/shipments.py backend/tests/api/agent/test_shipments_confirm.py
git commit -m "feat(Agent-API): 货件费用重算写路由"
```

---

### Task 10: confirm 过期用例（S4）+ 使用文档 + 最终验证门

**Files:**
- Modify: `backend/tests/api/agent/test_shipments_confirm.py`（S4 过期/改体/改 key 分支）
- Modify: `backend/docs/agent-api.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: spec S4 的路由级覆盖；用户面向文档的 P2 端点清单

- [ ] **Step 1: 写 S4 测试**

`test_shipments_confirm.py` 追加：

```python
class TestConfirmTokenFailures:
    def test_s4_expired_token(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-EXP-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, "", body, idem=idem)
        token = preview.json()["confirm_token"]

        # 模拟逻辑过期（TTL 300s）：直接回拨 created_at
        confirm_memory_store._rows[token]["record"].created_at -= 301

        replay = _post(client, shipment_env, "", body, token=token, idem=idem)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"

    def test_changed_body_rejected(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-CHB-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, "", body, idem=idem)
        token = preview.json()["confirm_token"]

        tampered = _create_body(shipment_no)
        tampered["items"][0]["quantity"] = 999999  # 预览小改动、确认大改动
        replay = _post(client, shipment_env, "", tampered, token=token, idem=idem)
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_changed_idempotency_key_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-CHK-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        preview = _post(client, shipment_env, "", body, idem="idem-A")
        token = preview.json()["confirm_token"]
        replay = _post(client, shipment_env, "", body, token=token, idem="idem-B")
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
```

- [ ] **Step 2: 跑测试确认通过**

```bash
cd backend && pytest -q tests/api/agent/test_shipments_confirm.py
```

Expected: 全绿（S4 三个分支由 body-hash 绑定与 TTL 逻辑天然满足）。

- [ ] **Step 3: 更新使用文档**

`backend/docs/agent-api.md` 的"端点（P0）"一节改为：

```markdown
## 2. 端点

    GET /api/v1/agent/health    存活探针

### 货件域（P2）

    GET    /api/v1/agent/projects/{project_id}/shipments
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/sku-summary
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/fba-box-detail
    GET    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/audit
    POST   /api/v1/agent/projects/{project_id}/shipments                      （confirm）
    PATCH  /api/v1/agent/projects/{project_id}/shipments/{shipment_no}        （confirm）
    PUT    /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/items  （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/status （confirm）
    POST   /api/v1/agent/projects/{project_id}/shipments/{shipment_no}/recalculate-costs （confirm）

写接口（confirm）两步：第一次调用返回 HTTP 200 + `requires_confirmation:true` +
`confirm_token`（300s 有效，与请求体 SHA-256 绑定）；向用户复述 preview 摘要，
确认后**用同一 Idempotency-Key + X-Confirm-Token + 完全相同的请求体**重放。

货件字段约定：`shipment_status` ∈ {draft, in_transit, completed}；
`shipping_method` ∈ {sea, air, express, truck, rail, other}（英文 token）。
```

错误码清单补三条：`SHIPMENT_DUPLICATE_NO`(409)、`SHIPMENT_ITEMS_INVALID_SKU`(400)、`SHIPMENT_STATUS_INVALID`(400)。

- [ ] **Step 4: 最终验证门**

```bash
cd backend && pytest -q
cd frontend && pnpm lint && pnpm build && pnpm test
```

Expected: 后端全量无新增失败（对照既有失败台账）；前端三连绿（P2 未动前端，基线保持）。

- [ ] **Step 5: Commit**

```bash
git add backend/tests/api/agent/test_shipments_confirm.py backend/docs/agent-api.md
git commit -m "docs(Agent-API): 货件域端点文档与 S4 用例"
```

- [ ] **Step 6: 交付与部署（人工确认项）**

1. 合入 main 后 `git deploy`（命中 backend/ 自动部署；P2 **无迁移**，beat 无改动不需重启）
2. 部署后冒烟：用管理页/内部端点建一张 agent 凭据 →
   `GET /api/v1/agent/projects/{id}/shipments` 200 →
   任一写接口预览 → 重放 → `GET .../audit` 出现归因行
3. 把"confirm 存储已原子化（Lua GET+DEL）"记入 P2 完成记录（P0 终审准入门槛关闭）

---

## 评审备注（自查记录）

- **spec 笔误修正**：spec §5.3 创建示例的 `"shipping_method": "海运"` 与代码事实不符——`ALLOWED_SHIPPING_METHOD` 是英文 token（sea/air/express/truck/rail/other）。本计划测试与文档一律用 `sea`，并加了"中文被拒"用例固化该事实。
- **spec S4 的"等待 >300s"** 改为回拨 `InMemoryConfirmStore` 的 `created_at` 模拟过期（机制等价，可在 CI 跑）；真实 TTL 行为由 Redis 的 setex 物理过期 + 逻辑 TTL 双层保证（Task 1 测试覆盖）。
- **confirm 装饰器回调签名升级为 `(body, request)`**：P0 测试同步改（Task 1 Step 1）；这是 P2 的硬需求（validate 需要路径参数 + 独立 DB 会话做 SKU/重复校验）。
- **validate 回调用独立 SessionLocal**：gate 在依赖注入的会话之外运行，短会话即开即关，与 auth 依赖同模式。
- **PATCH 拒绝 items 字段**：明细替换有专用 PUT 端点，避免两条写路径语义混淆（spec 把 items 定义为替换语义）。
- **service 层 `operator=None`**：`updated_by` 列为 NULL，归因全走审计 `agent_id`（与 P0 决策一致）；若未来要 UI 展示"agent 改的"，另起需求。
- **缓存**：agent 读绕过缓存直查 DB；写后失效 7 个缓存键与内部端点逐一对齐——漏一个都会让 UI 看到旧数据。
- **写桶限流**：5 条写路由全部挂 `require_agent_write_rate_limit`；读路由吃命名空间读桶（P0 已挂）。
