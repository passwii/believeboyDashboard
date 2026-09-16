# Agent 扁平锚列契约补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 R5/R6/R7 补齐可关闭的锚列、`non_ad_fee_usd` 解释字段和 OpenAPI 显式响应类型。

**Architecture:** 保持现有扁平行结构，不新增嵌套 `anchor`。统一查询参数控制四个锚列是否出现在响应中；使用泛型 Agent 成功壳声明 OpenAPI schema。所有字段继续由现有锚计算逻辑派生，不新增数据库状态。

**Tech Stack:** FastAPI、Pydantic v2、pytest、OpenAPI、openapi-typescript。

## Global Constraints

- `include_anchor` 默认值为 `true`；传 `false` 时四个锚列必须完全缺席，而不是值为 `null`。
- 四个扁平锚列为 `breakeven_advertising_rate`、`non_ad_fee_usd`、`max_ad_spend_per_unit_usd`、`target_advertising_rate`。
- 不修改数据库模型、不新增 Alembic 迁移、不修改锚计算公式。
- 不新增或改变 compute 的落库语义。
- 默认响应只能增量新增 `non_ad_fee_usd`，不得删除已有字段。
- R5/R6/R7 的 OpenAPI `200` schema 必须引用显式 Pydantic 模型，不得继续是 `additionalProperties: true`。

---

### Task 1: 扁平响应补齐 `non_ad_fee_usd`

**Files:**

- Modify: `backend/app/schemas/external/shop_calculation.py`
- Modify: `backend/app/services/external/_shop_calculation.py`
- Modify: `backend/app/services/external/_pricing_calculation_snapshot.py`
- Test: `backend/tests/api/agent/test_shop_calc_anchor.py`

**Interfaces:**

- Consumes: `PricingAnchor.non_ad_fee_usd: float | None`
- Produces: `ShopCalculationHistoryRow.non_ad_fee_usd: float | None`

- [ ] **Step 1: 写失败测试，锁定三个扁平路由都返回 `non_ad_fee_usd`**

在 `TestBiFlatContract.test_flat_history_exposes_breakeven_column` 的锚断言后增加：

```python
        assert row["non_ad_fee_usd"] == BASE_NON_AD_FEE
```

在 `TestBiFlatContract.test_flat_snapshots_carry_same_columns` 的 `max_ad_spend` 断言后增加：

```python
        assert row["non_ad_fee_usd"] == BASE_NON_AD_FEE
```

在 `TestPricingSnapshot.test_pricing_snapshot_exposes_breakeven_column` 的
`max_ad_spend_per_unit_usd` 断言后增加：

```python
            assert rows[0]["non_ad_fee_usd"] == BASE_NON_AD_FEE
```

- [ ] **Step 2: 运行测试并确认因字段缺失失败**

Run:

```bash
cd backend && pytest \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract::test_flat_history_exposes_breakeven_column \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract::test_flat_snapshots_carry_same_columns \
  tests/api/agent/test_shop_calc_anchor.py::TestPricingSnapshot::test_pricing_snapshot_exposes_breakeven_column \
  -q
```

Expected: FAIL，三个测试均因响应字典没有 `non_ad_fee_usd` 触发 `KeyError`。

- [ ] **Step 3: 给扁平 row schema 增加字段**

在 `backend/app/schemas/external/shop_calculation.py` 的
`ShopCalculationHistoryRow` 中，将锚列段改为：

```python
    breakeven_advertising_rate: float | None = None
    non_ad_fee_usd: float | None = None
    max_ad_spend_per_unit_usd: float | None = None
    target_advertising_rate: float | None = None
```

同时把该段上方注释改为：

```python
    # BLF-1043 定价派生列（服务端推，不改 append-only 语义）。
    # 扁平行没有费用拆项，所以消费方算不出锚，也解释不了锚偏低的原因；
    # 服务端显式补四个派生列：breakeven / non_ad_fee / max_ad_spend / target。
```

- [ ] **Step 4: 在两个扁平化服务里映射字段**

在 `backend/app/services/external/_shop_calculation.py` 的
`_flatten_history_row()` 中，在 `breakeven_advertising_rate` 参数后增加：

```python
        non_ad_fee_usd=(anchor.non_ad_fee_usd if anchor is not None else None),
```

在 `backend/app/services/external/_pricing_calculation_snapshot.py` 的
`find_pricing_snapshot_as_of()` 构造 `ShopCalculationHistoryRow` 时，在
`breakeven_advertising_rate` 参数后增加：

```python
                non_ad_fee_usd=anchor.non_ad_fee_usd,
```

- [ ] **Step 5: 运行聚焦测试并确认通过**

Run:

```bash
cd backend && pytest \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract::test_flat_history_exposes_breakeven_column \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract::test_flat_snapshots_carry_same_columns \
  tests/api/agent/test_shop_calc_anchor.py::TestPricingSnapshot::test_pricing_snapshot_exposes_breakeven_column \
  -q
```

Expected: `3 passed`。

- [ ] **Step 6: 提交**

```bash
git add \
  backend/app/schemas/external/shop_calculation.py \
  backend/app/services/external/_shop_calculation.py \
  backend/app/services/external/_pricing_calculation_snapshot.py \
  backend/tests/api/agent/test_shop_calc_anchor.py
git commit -m "feat(Agent锚列): 扁平行补齐非广告费用字段"
```

---

### Task 2: R5/R6/R7 增加可关闭的 `include_anchor`

**Files:**

- Create: none
- Modify: `backend/app/api/v1/endpoints/agent/_helpers.py`
- Modify: `backend/app/api/v1/endpoints/agent/shop_calculation.py`
- Modify: `backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py`
- Test: `backend/tests/api/agent/test_shop_calc_anchor.py`

**Interfaces:**

- Consumes: `ShopCalculationHistoryResponse`、`ShopCalculationSnapshotsResponse`
- Produces: `render_flat_anchor_response(value: BaseModel, *, include_anchor: bool) -> dict[str, Any]`

- [ ] **Step 1: 写三个失败测试，锁定关闭后四列完全缺席**

在 `backend/tests/api/agent/test_shop_calc_anchor.py` 顶部的常量区增加：

```python
FLAT_ANCHOR_FIELDS = {
    "breakeven_advertising_rate",
    "non_ad_fee_usd",
    "max_ad_spend_per_unit_usd",
    "target_advertising_rate",
}
```

在 `TestBiFlatContract` 中增加：

```python
    def test_flat_history_include_anchor_false_omits_anchor_columns(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/shop-calculation-history?include_anchor=false",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert FLAT_ANCHOR_FIELDS.isdisjoint(row)

    def test_flat_snapshots_include_anchor_false_omits_anchor_columns(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/shop-calculation/snapshots?sku=X-001&include_anchor=false",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert FLAT_ANCHOR_FIELDS.isdisjoint(row)
```

在 `TestPricingSnapshot` 中增加：

```python
    def test_pricing_snapshot_include_anchor_false_omits_anchor_columns(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        snapshot_id, as_of = self._seed_snapshot(shipment_env)
        base = f"/api/v1/agent/projects/{shipment_env['project_id']}/pricing-snapshots"
        try:
            row = client.get(
                f"{base}?as_of={as_of}&include_anchor=false",
                headers=shipment_env["headers"],
            ).json()["data"]["data"][0]
            assert FLAT_ANCHOR_FIELDS.isdisjoint(row)
        finally:
            self._cleanup(snapshot_id)
```

- [ ] **Step 2: 运行测试并确认参数尚未生效**

Run:

```bash
cd backend && pytest \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract::test_flat_history_include_anchor_false_omits_anchor_columns \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract::test_flat_snapshots_include_anchor_false_omits_anchor_columns \
  tests/api/agent/test_shop_calc_anchor.py::TestPricingSnapshot::test_pricing_snapshot_include_anchor_false_omits_anchor_columns \
  -q
```

Expected: FAIL，响应仍包含四个锚列。

- [ ] **Step 3: 在共享 helper 中实现统一过滤**

在 `backend/app/api/v1/endpoints/agent/_helpers.py` 增加：

```python
from typing import Any

from pydantic import BaseModel


FLAT_ANCHOR_FIELDS = (
    "breakeven_advertising_rate",
    "non_ad_fee_usd",
    "max_ad_spend_per_unit_usd",
    "target_advertising_rate",
)


def render_flat_anchor_response(
    value: BaseModel, *, include_anchor: bool
) -> dict[str, Any]:
    """Serialize a flat response and optionally remove all derived anchor fields."""
    payload = value.model_dump(mode="json")
    if include_anchor:
        return payload
    rows = payload.get("data", [])
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            for field in FLAT_ANCHOR_FIELDS:
                row.pop(field, None)
    return payload
```

保留文件原有 `parse_country` / `parse_countries`，不要改动其行为。

- [ ] **Step 4: R5/R6 增加参数并统一走 helper**

在 `backend/app/api/v1/endpoints/agent/shop_calculation.py`：

1. 从 `_helpers` 导入 `render_flat_anchor_response`。
2. 删除本文件已有的 `_to_json()`。
3. 在 `get_agent_shop_calculation_history()` 的 `target_net_margin` 参数后增加：

```python
    include_anchor: bool = Query(
        default=True,
        description=(
            "是否返回四个扁平锚列（BLF-1043）；false 时四列全部省略"
        ),
    ),
```

4. 将该路由返回改为：

```python
    return agent_ok(
        render_flat_anchor_response(resp, include_anchor=include_anchor)
    )
```

5. 在 `get_agent_shop_calculation_snapshots()` 中加入同一参数，并将返回改为：

```python
    return agent_ok(
        render_flat_anchor_response(resp, include_anchor=include_anchor)
    )
```

- [ ] **Step 5: R7 增加参数并统一走 helper**

在 `backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py`：

1. 从 `_helpers` 导入 `render_flat_anchor_response`。
2. 删除本文件已有的 `_to_json()`。
3. 在 `get_agent_pricing_snapshot_as_of()` 的 `target_net_margin` 参数后增加：

```python
    include_anchor: bool = Query(
        default=True,
        description=(
            "是否返回四个扁平锚列（BLF-1043）；false 时四列全部省略"
        ),
    ),
```

4. 将该路由返回改为：

```python
    return agent_ok(
        render_flat_anchor_response(resp, include_anchor=include_anchor)
    )
```

- [ ] **Step 6: 运行聚焦测试并确认通过**

Run:

```bash
cd backend && pytest \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract \
  tests/api/agent/test_shop_calc_anchor.py::TestPricingSnapshot \
  -q
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add \
  backend/app/api/v1/endpoints/agent/_helpers.py \
  backend/app/api/v1/endpoints/agent/shop_calculation.py \
  backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py \
  backend/tests/api/agent/test_shop_calc_anchor.py
git commit -m "feat(Agent锚列): 扁平路由支持关闭锚列"
```

---

### Task 3: 显式 OpenAPI 响应模型

**Files:**

- Modify: `backend/app/schemas/external/shop_calculation.py`
- Modify: `backend/app/api/v1/endpoints/agent/shop_calculation.py`
- Modify: `backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py`
- Create: `backend/tests/api/agent/test_shop_calculation_flat_openapi.py`

**Interfaces:**

- Consumes: `ShopCalculationHistoryResponse`、`ShopCalculationSnapshotsResponse`
- Produces: `AgentOkResponse[T]`，OpenAPI `data` 指向具体扁平模型

- [ ] **Step 1: 写 OpenAPI 失败测试**

创建 `backend/tests/api/agent/test_shop_calculation_flat_openapi.py`：

```python
"""R5/R6/R7 扁平锚列响应必须能从 OpenAPI 自动生成客户端类型。"""

from __future__ import annotations

from app.api.v1.lazy_router import preload_all_lazy_groups
from app.main import app


ROUTES = {
    "/api/v1/agent/projects/{project_id}/shop-calculation-history": (
        "ShopCalculationHistoryResponse"
    ),
    "/api/v1/agent/projects/{project_id}/shop-calculation/snapshots": (
        "ShopCalculationSnapshotsResponse"
    ),
    "/api/v1/agent/projects/{project_id}/pricing-snapshots": (
        "ShopCalculationSnapshotsResponse"
    ),
}


def _resolve_ref(schema: dict, ref: str) -> dict:
    assert ref.startswith("#/components/schemas/")
    return schema["components"]["schemas"][ref.rsplit("/", 1)[-1]]


def test_flat_anchor_routes_expose_explicit_openapi_schema() -> None:
    preload_all_lazy_groups()
    schema = app.openapi()
    schemas = schema["components"]["schemas"]

    assert "ShopCalculationHistoryRow" in schemas
    row_properties = schemas["ShopCalculationHistoryRow"]["properties"]
    assert {
        "breakeven_advertising_rate",
        "non_ad_fee_usd",
        "max_ad_spend_per_unit_usd",
        "target_advertising_rate",
    }.issubset(row_properties)

    for path, data_schema_name in ROUTES.items():
        operation = schema["paths"][path]["get"]
        parameter_names = {
            parameter["name"] for parameter in operation.get("parameters", [])
        }
        assert "include_anchor" in parameter_names

        response_schema = operation["responses"]["200"]["content"][
            "application/json"
        ]["schema"]
        assert "$ref" in response_schema
        wrapper = _resolve_ref(schema, response_schema["$ref"])
        assert wrapper["properties"]["ok"]["const"] is True
        data_ref = wrapper["properties"]["data"]["$ref"]
        assert data_ref.endswith(f"/{data_schema_name}")
```

- [ ] **Step 2: 运行测试并确认响应仍是通用 object**

Run:

```bash
cd backend && pytest \
  tests/api/agent/test_shop_calculation_flat_openapi.py \
  -q
```

Expected: FAIL，`responses.200.schema` 没有 `$ref`，仍是 `additionalProperties: true`。

- [ ] **Step 3: 增加泛型 Agent 成功壳 schema**

在 `backend/app/schemas/external/shop_calculation.py` 顶部导入区增加：

```python
from typing import Generic, TypeVar
```

在 `ShopCalculationHistoryRow` 前增加：

```python
T = TypeVar("T")


class AgentOkResponse(BaseModel, Generic[T]):
    """OpenAPI-visible success envelope for native Agent flat read routes."""

    ok: bool = True
    data: T
```

- [ ] **Step 4: R5/R6 声明响应模型**

在 `backend/app/api/v1/endpoints/agent/shop_calculation.py` 导入：

```python
from app.schemas.external.shop_calculation import AgentOkResponse
```

将 R5 装饰器改为：

```python
@shop_calculation_router.get(
    "/shop-calculation-history",
    response_model=AgentOkResponse[ShopCalculationHistoryResponse],
    response_model_exclude_unset=True,
)
```

将 R6 装饰器改为：

```python
@shop_calculation_router.get(
    "/shop-calculation/snapshots",
    response_model=AgentOkResponse[ShopCalculationSnapshotsResponse],
    response_model_exclude_unset=True,
)
```

- [ ] **Step 5: R7 声明响应模型**

在 `backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py` 导入：

```python
from app.schemas.external.shop_calculation import AgentOkResponse
```

将 R7 装饰器改为：

```python
@pricing_snapshots_router.get(
    "/pricing-snapshots",
    response_model=AgentOkResponse[ShopCalculationSnapshotsResponse],
    response_model_exclude_unset=True,
)
```

- [ ] **Step 6: 运行 OpenAPI 与行为测试**

Run:

```bash
cd backend && pytest \
  tests/api/agent/test_shop_calculation_flat_openapi.py \
  tests/api/agent/test_shop_calc_anchor.py::TestBiFlatContract \
  tests/api/agent/test_shop_calc_anchor.py::TestPricingSnapshot \
  -q
```

Expected: 全部 PASS；关闭锚时四列仍完全缺席。

- [ ] **Step 7: 提交**

```bash
git add \
  backend/app/schemas/external/shop_calculation.py \
  backend/app/api/v1/endpoints/agent/shop_calculation.py \
  backend/app/api/v1/endpoints/agent/pricing_calculation_snapshots.py \
  backend/tests/api/agent/test_shop_calculation_flat_openapi.py
git commit -m "feat(Agent锚列): 声明扁平响应 OpenAPI 模型"
```

---

### Task 4: 文档、生成契约与完整回归

**Files:**

- Modify: `backend/docs/agent-api.md`
- Modify: `backend/docs/agent-skills/believeboy-shop-calculation.md`
- Modify: `frontend/app/dashboard/system/agent-management/agent-usage-guide.tsx`
- Modify: `frontend/app/dashboard/system/agent-management/agent-usage-guide.test.ts`
- Generated: `frontend/types/api-generated/openapi.json`
- Generated: `frontend/types/api-generated/api.d.ts`

**Interfaces:**

- Consumes: Task 1-3 的最终 API 行为与 OpenAPI schema
- Produces: 与生产接口一致的用户文档、技能文档和生成类型

- [ ] **Step 1: 更新契约与技能文档**

在 `backend/docs/agent-api.md` 中，把 R5/R6/R7 的说明改为：

```text
R5/R6/R7 扁平行返回四个平铺列：
breakeven_advertising_rate / non_ad_fee_usd /
max_ad_spend_per_unit_usd / target_advertising_rate。
三条路由都支持 include_anchor，默认 true；false 时四列全部省略。
```

在 `backend/docs/agent-skills/believeboy-shop-calculation.md` 中同步：

```text
R5/R6/R7 是恒定的扁平锚列契约，但支持 include_anchor=false 显式关闭；
默认 true。non_ad_fee_usd = total_fee_usd - advertising_fee_usd，
是解释 breakeven_advertising_rate 偏低原因的必要拆项。
```

同时删除旧的“扁平行没有 include_anchor 开关”表述。

- [ ] **Step 2: 更新前端接入指南与断言**

在 `frontend/app/dashboard/system/agent-management/agent-usage-guide.tsx`
的扁平路由说明中加入：

```text
四条锚列：breakeven_advertising_rate / non_ad_fee_usd /
max_ad_spend_per_unit_usd / target_advertising_rate。
R5/R6/R7 均支持 ?include_anchor=false；默认 true。
```

在 `frontend/app/dashboard/system/agent-management/agent-usage-guide.test.ts`
增加断言：

```typescript
expect(text).toContain('non_ad_fee_usd')
expect(text).toContain('include_anchor=false')
```

- [ ] **Step 3: 运行前端聚焦测试**

Run:

```bash
cd frontend && pnpm test -- \
  app/dashboard/system/agent-management/agent-usage-guide.test.ts
```

Expected: PASS。

- [ ] **Step 4: 重新生成后端 OpenAPI 与前端类型**

Run:

```bash
cd backend && python -m scripts.openapi_export \
  --out ../frontend/types/api-generated/openapi.json
cd ../frontend && pnpm gen:api-types
```

Expected:

- `openapi.json` 中三条路由的 `200` 响应引用 `AgentOkResponse_*`。
- `ShopCalculationHistoryRow` 包含四个锚列。
- `api.d.ts` 同步更新。

- [ ] **Step 5: 运行后端完整相关回归**

Run:

```bash
cd backend && pytest tests/api/agent/test_shop_calc_anchor.py \
  tests/api/agent/test_shop_calculation_native.py \
  tests/api/agent/test_pricing_snapshots_native.py \
  tests/api/agent/test_shop_calculation_flat_openapi.py \
  tests/api/test_pricing_calculation_snapshot_anchor.py \
  -q
```

Expected: 全部 PASS。

- [ ] **Step 6: 运行前端质量门**

Run:

```bash
cd frontend && pnpm lint
cd frontend && pnpm build
cd frontend && pnpm test
```

Expected: 全部 PASS；如出现与本改动无关的既有失败，必须记录具体文件并证明在改动前同样失败。

- [ ] **Step 7: 提交**

```bash
git add \
  backend/docs/agent-api.md \
  backend/docs/agent-skills/believeboy-shop-calculation.md \
  frontend/app/dashboard/system/agent-management/agent-usage-guide.tsx \
  frontend/app/dashboard/system/agent-management/agent-usage-guide.test.ts \
  frontend/types/api-generated/openapi.json \
  frontend/types/api-generated/api.d.ts
git commit -m "docs(Agent锚列): 更新扁平契约与生成类型"
```

---

## Plan Self-Review

- Spec coverage:
  - `include_anchor` 统一：Task 2。
  - `non_ad_fee_usd`：Task 1。
  - R5/R6/R7 OpenAPI 显式 schema：Task 3。
  - 文档和生成类型：Task 4。
  - 无迁移、compute 不落库：Task 1-4 均遵守 Global Constraints。
- Placeholder scan: 无 TODO / TBD / “稍后实现”。
- Type consistency: `render_flat_anchor_response`、`AgentOkResponse[T]`、
  `ShopCalculationHistoryRow.non_ad_fee_usd` 在任务间名称一致。
