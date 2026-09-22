# Agent Shop Calculation Export and Negative Profit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent shop-calculations 域增加复用后端当前态/历史快照的 `.xlsx` 导出端点，并允许合法负利润写入、自动告警和确认预览展示。

**Architecture:** 在现有 `shop_calculations_router` 上增加 `GET /export.xlsx`，查询服务复用 `ShopCalculation` 的 append-only 最新快照口径，同时从 `SkuRecord` 补齐项目内全部 SKU。导出服务使用已存在的 `openpyxl` 生成内存文件流，路由使用 Agent 现有鉴权、`project_scope`、`shop_calculations` business scope 和操作审计。负利润由 Agent 请求 schema 自动补 `NEGATIVE_PROFIT`，确认预览复用既有 anchor 计算返回盈亏平衡广告费率。

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic v2, openpyxl, pytest/TestClient。

## Global Constraints

- 导出数据必须来自 `shop_calculation` 后端查询结果；Agent/客户端不重算、不重新分类。
- `mode=current|history`；默认 `current`，默认 `include_uncomputed=true`，不静默丢弃 SKU。
- 支持 `country`、`sku`、`as_of`、`include_uncomputed`；当前态按 `(project_id, sku, country)` 取最新有效快照。
- 导出列保留前端现有美国/欧洲店铺 SKU 测算列，并增加 `ASIN`、`source`、`observed_at`、`warnings`；未核算行的 `warnings` 必须包含 `未核算/缺数据`。
- 文件流 media type 必须为 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，文件名包含项目、站点和时间。
- 导出动作记录 `operation_audit_logs`，action 为 `shop_calculation.export`，不把文件内容写入审计。
- Agent 写入仍校验 `sale_price_usd > 0`、`total_fee_usd > 0`；`profit_usd` 和 `profit_rate` 允许负数。
- 负利润行自动在 `warnings` 增加 `NEGATIVE_PROFIT`，确认预览明确返回负利润字段和盈亏平衡广告费率。
- 不添加数据库迁移；复用仓库已锁定的 `openpyxl==3.1.5`。

---

### Task 1: 锁定负利润 Agent 写入行为

**Files:**
- Modify: `backend/tests/api/agent/test_shop_calc_confirm.py`
- Modify: `backend/app/schemas/shop_calculation_agent.py`
- Modify: `backend/app/api/v1/endpoints/agent/shop_calculations.py`

**Interfaces:**
- Consumes: 现有 `AgentShopCalculationAppendRequest`、`_preview_append` 和 confirm replay。
- Produces: `AgentShopCalculationAppendRequest` 在 `profit_usd < 0` 或 `profit_rate < 0` 时将 `NEGATIVE_PROFIT` 加入 `warnings`；`_validate_append` 仅拒绝非正售价/总费用；预览返回 `warnings` 与 `breakeven_advertising_rate`。

- [x] **Step 1: Write the failing tests**

在 `TestAppendValidation` 增加以下测试，使用现有 `shop_calc_body`、`_post` 和 confirm fixture：

```python
def test_negative_profit_is_accepted_and_warned(
    self, client, shipment_env, confirm_memory_store
):
    body = shop_calc_body(sku="X-001", profit_usd=-2.5, profit_rate=-0.125)
    preview = _post(client, shipment_env, body)
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    assert payload["requires_confirmation"] is True
    assert payload["preview"]["profit_usd"] == -2.5
    assert payload["preview"]["profit_rate"] == -0.125
    assert "NEGATIVE_PROFIT" in payload["preview"]["warnings"]
    assert payload["preview"]["breakeven_advertising_rate"] is not None

    replay = _post(
        client,
        shipment_env,
        body,
        token=payload["confirm_token"],
        idem=f"negative-{uuid.uuid4().hex[:12]}",
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["data"]["profit"]["profit_usd"] == -2.5
    assert "NEGATIVE_PROFIT" in replay.json()["data"]["warnings"]


def test_negative_profit_rate_is_not_rejected(
    self, client, shipment_env, confirm_memory_store
):
    body = shop_calc_body(sku="X-001", profit_usd=0.5, profit_rate=-0.01)
    response = _post(client, shipment_env, body)
    assert response.status_code == 200, response.text
    assert "NEGATIVE_PROFIT" in response.json()["preview"]["warnings"]


def test_non_positive_sale_price_or_total_fee_is_still_rejected(
    self, client, shipment_env, confirm_memory_store
):
    for overrides in ({"sale_price_usd": 0}, {"total_fee_usd": 0}):
        response = _post(client, shipment_env, shop_calc_body(**overrides))
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/api/agent/test_shop_calc_confirm.py -k "negative_profit or non_positive_sale_price" -q`

Expected: the negative-profit request fails with `VALIDATION_FAILED`, and/or the preview lacks the requested warning/field. The existing positive-value tests must remain unaffected.

- [x] **Step 3: Write minimal implementation**

在 `AgentShopCalculationAppendRequest` 增加 Pydantic v2 `model_validator(mode="after")`，仅在 warning 不重复时 append `NEGATIVE_PROFIT`。在 `_validate_append` 中把金额判断改为：

```python
if req.sale_price_usd <= 0 or req.total_fee_usd <= 0:
    raise AgentApiError(
        ErrorCode.VALIDATION_FAILED,
        human_message="sale_price_usd / total_fee_usd 必须为正数",
    )
if req.profit_rate >= 1:
    raise AgentApiError(
        ErrorCode.VALIDATION_FAILED,
        human_message="profit_rate 必须小于 1",
    )
```

在 `_preview_append` 中把 `warnings` 和 `breakeven_advertising_rate` 放到预览顶层；其中 rate 来自既有 `anchor.model_dump(mode="json")`，不另写公式：

```python
anchor_payload = anchor.model_dump(mode="json")
return {
    # existing preview fields...
    "profit_usd": req.profit_usd,
    "profit_rate": req.profit_rate,
    "warnings": req.warnings,
    "breakeven_advertising_rate": anchor_payload["breakeven_advertising_rate"],
    "anchor": anchor_payload,
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/api/agent/test_shop_calc_confirm.py -k "negative_profit or non_positive_sale_price" -q`

Expected: all selected tests pass.

- [x] **Step 5: Refactor without changing behavior**

确认 `NEGATIVE_PROFIT` 只由 schema 添加一次，preview 和落库返回共用同一 `req.warnings`，不在路由和服务各自复制告警判断。

---

### Task 2: 增加可复用的导出查询与 Excel 构造服务

**Files:**
- Create: `backend/app/services/shop_calculation_export.py`
- Create: `backend/tests/services/test_shop_calculation_export.py`

**Interfaces:**
- Consumes: `Session`、`ShopCalculation`、`SkuRecord`、`shop_calculation_service.latest_stmt()` 以及既有前端列顺序。
- Produces: `build_shop_calculation_export(db, project_id, project_name, country, sku, mode, as_of, include_uncomputed) -> ExportResult`，其中 `ExportResult.content` 为 `bytes`、`filename` 为安全文件名、`row_count` 为实际数据行数、`countries` 为审计元数据。

- [x] **Step 1: Write the failing service tests**

创建服务测试，使用 `backend/tests/api/agent/conftest.py` 的 `seed_shop_calculation` 和 SQLAlchemy `SkuRecord` fixture/构造方式，覆盖：

```python
def test_current_export_uses_latest_snapshot_and_keeps_uncomputed_skus(...):
    # seed X-001 twice; create X-002 only in product_costs
    result = build_shop_calculation_export(..., country="US", mode="current", include_uncomputed=True)
    rows = load_rows(result.content)
    assert rows[0]["SKU"] == "X-001"
    assert rows[0]["售价(USD)"] == 12.0  # only latest ShopCalculation row
    assert rows[1]["SKU"] == "X-002"
    assert rows[1]["warnings"] == "未核算/缺数据"


def test_history_export_returns_all_valid_snapshots_and_respects_as_of(...):
    # seed three observed_at versions, with the newest after as_of
    result = build_shop_calculation_export(..., country="US", mode="history", as_of=as_of)
    rows = load_rows(result.content)
    assert [row["售价(USD)"] for row in rows] == [10.0, 11.0]


def test_export_preserves_frontend_columns_and_trace_columns(...):
    result = build_shop_calculation_export(...)
    headers = load_headers(result.content)
    assert headers[:28] == US_FRONTEND_HEADERS
    assert headers[-4:] == ["ASIN", "source", "observed_at", "warnings"]


def test_negative_profit_row_is_exported_as_a_number(...):
    # seed a valid negative-profit ShopCalculation row
    row = load_rows(build_shop_calculation_export(...).content)[0]
    assert row["利润"] < 0
```

测试使用 `openpyxl.load_workbook(BytesIO(content), data_only=True)` 读取第一张 sheet；不要断言样式细节，只断言列顺序、筛选、最新态、缺数据标记和数值类型。

- [x] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/services/test_shop_calculation_export.py -q`

Expected: import/service symbol does not exist.

- [x] **Step 3: Write minimal implementation**

在服务中定义：

```python
US_FRONTEND_HEADERS = [...28 个前端现有美国列...]
EU_FRONTEND_HEADERS = [...25 个前端现有欧洲列...]
TRACE_HEADERS = ["ASIN", "source", "observed_at", "warnings"]
```

实现查询规则：

1. `mode == "current"` 使用 `shop_calculation_service.latest_stmt()`；传 `as_of` 时使用同样的 `MAX(id)` 分组逻辑，但在子查询中增加 `observed_at <= as_of`，保证不读到未来快照。
2. `mode == "history"` 读取项目/站点/可选 SKU 的全部 `deleted_at IS NULL` 行，按 `sku,country,observed_at,id` 稳定排序，并按 `as_of` 过滤。
3. `SkuRecord` 读取 active SKU；以 `(sku,country)` 去重，保留 `sort_order,id` 最先的主数据记录。`include_uncomputed=True` 时，将没有匹配测算行的主数据 SKU 追加为缺数据行；history 模式也只为没有任何历史行的 SKU 追加一行。
4. 已计算行的数值全部读取 `ShopCalculation`，只从 `SkuRecord` 补全缺失 ASIN/基础 SKU 字段，不调用定价引擎；缺数据行仅写入 SKU/ASIN/基础尺寸/FOB/头程和 `warnings="未核算/缺数据"`。
5. US/EU 行值严格按当前前端 `handleExport` 的 28/25 列顺序映射；EU 利润优先 `profit_after_vat_usd`/`profit_after_vat_rate`，与前端一致。追溯四列始终追加到末尾。
6. 用 `openpyxl.Workbook` 写一个 worksheet，标题、分组行、表头和数据行；负利润金额保持 numeric，利润率设置为 `0.00%`，未计算字段留空。用 RFC 5987 兼容的文件名由路由设置响应头。

`ExportResult` 只携带 bytes/filename/row_count/countries，不把 workbook 暴露给路由；所有计算派生逻辑仅限已有 `ShopCalculation` 字段映射。

- [x] **Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/services/test_shop_calculation_export.py -q`

Expected: all service tests pass.

- [x] **Step 5: Refactor without changing behavior**

把“缺数据行”和“已计算行”分开成小函数；保留列常量可供 API 测试导入，避免路由复制列定义。

---

### Task 3: 暴露 Agent `.xlsx` 端点并写导出审计

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/shop_calculations.py`
- Modify: `backend/tests/api/agent/test_shop_calc_read.py`
- Modify: `backend/docs/agent-api.md`
- Modify: `docs/agent-api-design.md`

**Interfaces:**
- Consumes: Task 2 的 `build_shop_calculation_export`；现有 `require_project_scope` 和 router-level `require_business_scope("shop_calculations")`。
- Produces: `GET /api/v1/agent/projects/{project_id}/shop-calculations/export.xlsx`，返回标准 XLSX 文件流；查询参数 `country`, `sku`, `as_of`, `mode`, `include_uncomputed`。

- [x] **Step 1: Write the failing API tests**

在 `test_shop_calc_read.py` 增加：

```python
def test_export_current_returns_xlsx_all_skus_and_audits(client, shipment_env):
    # seed one calculated SKU and one product_costs-only SKU
    response = client.get(
        _url(shipment_env, "/export.xlsx?country=US"),
        headers=shipment_env["headers"],
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert "filename" in response.headers["content-disposition"]
    rows = load_rows(response.content)
    assert {row["SKU"] for row in rows} == {"X-001", "X-002"}
    assert "未核算/缺数据" in rows_by_sku["X-002"]["warnings"]

    db = SessionLocal()
    try:
        audits = query_operation_audit_log_for_targets(
            db,
            target_type="shop_calculation",
            target_ids=[shipment_env["project_id"]],
        )
        assert any(audit.action == "shop_calculation.export" for audit in audits)
    finally:
        db.close()


def test_export_supports_history_sku_as_of_and_scope(client, shipment_env):
    # seed two historical rows; as_of excludes the later row
    response = client.get(
        _url(shipment_env, "/export.xlsx?country=US&sku=X-001&mode=history&as_of=2026-09-01T00:00:00Z"),
        headers=shipment_env["headers"],
    )
    assert response.status_code == 200
    assert [row["售价(USD)"] for row in load_rows(response.content)] == [10.0]


def test_export_requires_agent_business_and_project_scope(client, shipment_env, make_api_key):
    no_business = make_api_key(agent_id="no-export-domain", business_scope="shipments")
    response = client.get(_url(shipment_env, "/export.xlsx"), headers=_headers(no_business))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
```

测试按仓库已有模式导入 `openpyxl` 读取响应，复用 `query_operation_audit_log_for_targets` 验证导出审计。

- [x] **Step 2: Run tests to verify they fail**

Run: `cd backend && pytest tests/api/agent/test_shop_calc_read.py -k "export" -q`

Expected: `/export.xlsx` 当前命中 Agent 兜底 404，或不存在导出审计。

- [x] **Step 3: Write minimal implementation**

在 `shop_calculations.py` 导入 `Response`、`quote`、`Literal` 和导出服务。增加 `_content_disposition`（复用 `sku_info.py` 的 RFC 5987 逻辑），并添加路由：

```python
@shop_calculations_router.get("/export.xlsx")
def export_shop_calculations(
    project_id: int,
    db: Session = Depends(get_primary_db_session),
    country: str | None = Query(default=None),
    sku: str | None = Query(default=None),
    as_of: str | None = Query(default=None),
    mode: str = Query(default="current"),
    include_uncomputed: bool = Query(default=True),
    request: Request,
    _scope=Depends(require_project_scope),
) -> Response:
    if mode not in {"current", "history"}:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="mode 必须是 current 或 history")
    project = _get_project_or_shell_404(db, project_id)
    result = build_shop_calculation_export(
        db, project_id=project_id, project_name=str(project.project_name),
        country=country, sku=sku, mode=mode, as_of=_parse_datetime(as_of),
        include_uncomputed=include_uncomputed,
    )
    append_operation_audit_log(
        db, action="shop_calculation.export", target_type="shop_calculation",
        target_id=project_id, operator=None,
        after={"project_id": project_id, "country": country, "sku": sku,
               "mode": mode, "as_of": as_of, "include_uncomputed": include_uncomputed,
               "row_count": result.row_count, "countries": result.countries},
        **_audit_kwargs(request),
    )
    db.commit()
    return Response(
        content=result.content,
        media_type=XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": _content_disposition(result.filename)},
    )
```

实际参数顺序按 Python/FastAPI 签名规则调整；`project`/时间/mode 校验继续走 Agent 错误处理壳。`get_primary_db_session` 用于同一事务完成审计写入，导出本身只读业务表。

- [x] **Step 4: Run tests to verify they pass**

Run: `cd backend && pytest tests/api/agent/test_shop_calc_read.py -k "export" -q`

Expected: all export API tests pass, including response headers, uncomputed row, scope denial, history/as_of and audit.

- [x] **Step 5: Update API docs**

在 `backend/docs/agent-api.md` 的 shop-calculations endpoint 清单中加入 export route 和参数表；在 `docs/agent-api-design.md` 补充导出数据源、未核算行、审计和负利润写入契约。明确 `mode=current` 复用当前态，`mode=history` 返回有效历史快照，`as_of` 以 `observed_at` 截止。

---

### Task 4: 全量验证并整理变更

**Files:**
- Modify: `docs/superpowers/plans/2026-09-22-agent-shop-calculation-export-negative-profit.md` (mark completed checkboxes only)

- [x] **Step 1: Run targeted backend tests**

Run: `cd backend && pytest tests/api/agent/test_shop_calc_confirm.py tests/api/agent/test_shop_calc_read.py tests/services/test_shop_calculation_export.py -q`

Expected: PASS。

- [x] **Step 2: Run backend lint/type checks available in repository**

Run: `cd backend && python -m compileall -q app tests/api/agent tests/services/test_shop_calculation_export.py`

Expected: no syntax errors。

- [x] **Step 3: Run the repository backend suite**

Run: `cd backend && pytest`

Expected: PASS；若已有环境依赖/数据库失败，记录准确失败测试与原因，不把未运行说成通过。

- [x] **Step 4: Inspect diff and status**

Run: `git diff --check && git status --short && git diff --stat`

Expected: 只有本功能代码、测试、文档和本计划变化；不修改用户已有的 `.codex/` 未跟踪内容。
