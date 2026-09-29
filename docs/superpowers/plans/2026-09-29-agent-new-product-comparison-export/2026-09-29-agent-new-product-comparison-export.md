# Agent 新品测算对比矩阵导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Agent 新品测算域增加按 `snapshot_ids` 导出最多 12 条已保存快照的 XLSX 对比矩阵。

**Architecture:** 新增一个纯快照导出服务，按前端对比矩阵结构用 `openpyxl` 生成内存工作簿；Agent 路由校验参数和项目归属后直接返回二进制 XLSX，并记录导出审计。实现不新增迁移、不改前端手动导出、不调用定价引擎。

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic v2, openpyxl 3.1.5, pytest/TestClient。

## Global Constraints

- 成功响应必须是 XLSX 二进制流，不使用 `agent_ok`，不使用 Base64。
- 单次导出 `1..12` 个 `snapshot_ids`，必须是正整数且不能重复。
- 仅允许读取路径项目下的快照；任一记录缺失或跨项目时整批失败。
- Excel 分区顺序为：货品数据 → DDP 成本 → 费用支出 → 售价与利润 → 核算规则。
- 快照未持久化的竞品链接、头程单价(RMB/kg)、头程数量显示 `-`。
- 平台佣金率由 `referral_fee_usd / sale_price_usd` 反推。
- 成功导出写 `new_product_calculation.export` 审计，不记录文件内容。
- 不新增迁移，不修改前端现有导出。

---

### Task 1: 建立快照对比矩阵导出服务

**Files:**
- Create: `backend/app/services/new_product_calculation_export.py`
- Create: `backend/tests/services/test_new_product_calculation_export.py`

**Interfaces:**
- Consumes: `NewProductCalculation` ORM rows。
- Produces:
  - `XLSX_MEDIA_TYPE: str`
  - `MAX_COMPARISON_SNAPSHOTS = 12`
  - `NewProductComparisonExportResult(content: bytes, filename: str, column_count: int)`
  - `build_new_product_comparison_export(rows: Sequence[NewProductCalculation], *, project_name: str, snapshot_ids: Sequence[int]) -> NewProductComparisonExportResult`

- [ ] **Step 1: Write the failing service tests**

创建 `backend/tests/services/test_new_product_calculation_export.py`，使用
根 conftest 的 `db_session` 和 `new_product_calculation_service.upsert_snapshot`
构造记录，验证列顺序、字段映射、缺失占位、佣金率反推和 12 列导出：

```python
from io import BytesIO

from openpyxl import load_workbook

from app.models.new_product_calculation import NewProductCalculation
from app.schemas.new_product_calculation import NewProductCalculationCreateRequest
from app.services import new_product_calculation_service
from app.services.new_product_calculation_export import (
    build_new_product_comparison_export,
)


def _read_matrix(content: bytes):
    sheet = load_workbook(BytesIO(content), data_only=True).active
    headers = [sheet.cell(1, col).value for col in range(1, sheet.max_column + 1)]
    rows = {
        sheet.cell(row, 2).value: [
            sheet.cell(row, col).value for col in range(3, sheet.max_column + 1)
        ]
        for row in range(2, sheet.max_row + 1)
    }
    return headers, rows


def _seed_snapshot(
    db_session,
    project_id: int,
    project_name: str,
    *,
    sku: str,
    sale_price_usd: float = 19.99,
    referral_fee_usd: float = 3.0,
) -> int:
    payload = NewProductCalculationCreateRequest(
        project_id=project_id,
        project_name=project_name,
        sku=sku,
        country="US",
        calculation_type="profit_calc",
        package_length_cm=10.0,
        package_width_cm=8.0,
        package_height_cm=5.0,
        weight_kg=0.5,
        fob_product_cost_rmb=20.0,
        first_leg_cost_rmb=5.0,
        ddp_cost_rmb=30.0,
        ddp_cost_usd=4.2,
        sale_price_usd=sale_price_usd,
        advertising_rate=0.12,
        return_loss_rate=0.04,
        storage_months=1.0,
        inbound_placement_mode="single_destination",
        usd_to_rmb_rate=7.2,
        usd_to_rmb_rate_source="test",
        size_tier="standard",
        size_tier_label="标准尺寸",
        price_band="15_25",
        price_band_label="$15-25",
        longest_side_in=4.0,
        middle_side_in=3.0,
        shortest_side_in=2.0,
        length_plus_girth_in=14.0,
        volume_cubic_in=24.0,
        volume_cubic_ft=0.014,
        product_weight_lb=1.0,
        product_weight_oz=16.0,
        dimensional_weight_lb=0.8,
        chargeable_weight_lb=1.0,
        chargeable_weight_oz=16.0,
        chargeable_weight_rule="actual",
        fulfillment_fee_rule_label="rule",
        inbound_config_fee_rule_label="rule",
        storage_fee_rule_label="rule",
        referral_fee_usd=referral_fee_usd,
        advertising_fee_usd=2.4,
        return_loss_usd=0.8,
        fba_fulfillment_fee_usd=3.5,
        inbound_config_fee_usd=0.3,
        storage_fee_usd=0.2,
        total_fee_usd=10.2,
        payout_usd=15.0,
        profit_usd=4.8,
        profit_rate=0.24,
        source="agent_listing_pull",
    )
    item = new_product_calculation_service.upsert_snapshot(
        db_session, payload, operator=None
    )
    db_session.flush()
    return item.id


def test_export_preserves_selected_order_and_missing_fields(db_session):
    project_id = 90000001
    project_name = "导出测试项目"
    first = _seed_snapshot(
        db_session,
        project_id,
        project_name,
        sku="X-001",
        sale_price_usd=19.99,
        referral_fee_usd=3.0,
    )
    second = _seed_snapshot(
        db_session,
        project_id,
        project_name,
        sku="X-002",
        sale_price_usd=20.0,
        referral_fee_usd=4.0,
    )

    ordered_rows = [
        db_session.get(NewProductCalculation, snapshot_id)
        for snapshot_id in [second, first]
    ]
    result = build_new_product_comparison_export(
        ordered_rows,
        project_name=project_name,
        snapshot_ids=[second, first],
    )
    headers, rows = _read_matrix(result.content)

    assert headers[2:] == [
        f"{project_name} / X-002",
        f"{project_name} / X-001",
    ]
    assert rows["SKU"] == ["X-002", "X-001"]
    assert rows["竞品链接"] == ["-", "-"]
    assert rows["头程单价(RMB/kg)"] == ["-", "-"]
    assert rows["头程数量"] == ["-", "-"]
    assert rows["平台佣金率"][1] == 3.0 / 19.99
    assert result.column_count == 2


def test_export_supports_twelve_columns(db_session):
    project_id = 90000002
    project_name = "导出测试项目"
    ids = [
        _seed_snapshot(
            db_session,
            project_id,
            project_name,
            sku=f"X-{index:03d}",
        )
        for index in range(1, 13)
    ]

    result = build_new_product_comparison_export(
        [db_session.get(NewProductCalculation, snapshot_id) for snapshot_id in ids],
        project_name=project_name,
        snapshot_ids=ids,
    )
    headers, _ = _read_matrix(result.content)
    assert len(headers) == 14  # 指标 + 子项 + 12 条记录
    assert result.column_count == 12
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd backend && pytest tests/services/test_new_product_calculation_export.py -q
```

Expected: collection fails because `new_product_calculation_export` does not exist.

- [ ] **Step 3: Implement the minimal export service**

创建 `backend/app/services/new_product_calculation_export.py`。定义
`XLSX_MEDIA_TYPE`、`MAX_COMPARISON_SNAPSHOTS`、结果 dataclass、与前端一致的
section/row 顺序和字段 getter，并用 `openpyxl.Workbook` 写单个
`测算对比矩阵` sheet。关键接口：

```python
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_COMPARISON_SNAPSHOTS = 12


@dataclass(frozen=True)
class NewProductComparisonExportResult:
    content: bytes
    filename: str
    column_count: int


def build_new_product_comparison_export(
    rows: Sequence[NewProductCalculation],
    *,
    project_name: str,
    snapshot_ids: Sequence[int],
) -> NewProductComparisonExportResult:
    rows_by_id = {row.id: row for row in rows}
    ordered_rows = [rows_by_id[snapshot_id] for snapshot_id in snapshot_ids]
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "测算对比矩阵"
    worksheet.sheet_view.showGridLines = False
    # header row: 指标 / 子项 / 每条记录标题
    # 43 个 row definitions exactly mirroring getExportComparisonSections()
    # C..N cells: numeric / percent / currency values, missing rows use "-"
    # freeze C2, apply section fills, borders, number formats
    output = BytesIO()
    workbook.save(output)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    return NewProductComparisonExportResult(
        content=output.getvalue(),
        filename=f"{_safe_filename_part(project_name)}_新品测算对比矩阵-{timestamp}.xlsx",
        column_count=len(ordered_rows),
    )
```

金额与比例必须写数值而不是文本；金额格式分别使用美元/人民币格式，
`平台佣金率`、`广告费率`、`退货折损率`、`利润率` 使用 `0.00%`。
`_commission_rate(row)` 返回
`float(row.referral_fee_usd) / float(row.sale_price_usd)`，售价为 0 时返回 `-`。

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd backend && pytest tests/services/test_new_product_calculation_export.py -q
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/new_product_calculation_export.py \
  backend/tests/services/test_new_product_calculation_export.py
git commit -m "feat(Agent): 新增新品测算对比矩阵导出服务"
```

---

### Task 2: 暴露 Agent 二进制导出路由

**Files:**
- Modify: `backend/app/api/v1/endpoints/agent/new_product_calculations.py`
- Modify: `backend/tests/api/agent/test_new_product_read.py`

**Interfaces:**
- Consumes:
  - `build_new_product_comparison_export(rows, project_name=..., snapshot_ids=...)`
  - `XLSX_MEDIA_TYPE`
- Produces:
  - `GET /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx`
  - 成功响应为 XLSX `Response`
  - 审计 action `new_product_calculation.export`

- [ ] **Step 1: Write the failing API tests**

在 `TestBusinessScope` 前追加 `TestExportComparison`，覆盖二进制流、顺序、
参数错误、缺失/跨项目与审计：

```python
def _export_url(env, ids: list[int]) -> str:
    query = "&".join(f"snapshot_ids={snapshot_id}" for snapshot_id in ids)
    return (
        f"/api/v1/agent/projects/{env['project_id']}"
        f"/new-product-calculations/export.xlsx?{query}"
    )


class TestExportComparison:
    def test_export_returns_binary_xlsx_in_requested_order(
        self, client, shipment_env
    ):
        first = seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
        )
        second = seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-002",
        )

        resp = client.get(
            _export_url(shipment_env, [second, first]),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        assert "filename" in resp.headers["content-disposition"]
        assert int(resp.headers["content-length"]) == len(resp.content)

        sheet = load_workbook(BytesIO(resp.content), data_only=True).active
        assert sheet.cell(1, 3).value.endswith("X-002")
        assert sheet.cell(1, 4).value.endswith("X-001")

        db = SessionLocal()
        try:
            audits = query_operation_audit_log_for_targets(
                db,
                target_type="new_product_calculation",
                target_ids=[shipment_env["project_id"]],
            )
            export_audits = [
                row for row in audits if row.action == "new_product_calculation.export"
            ]
            assert len(export_audits) == 1
            assert export_audits[0].after_json["snapshot_ids"] == [second, first]
            assert export_audits[0].after_json["row_count"] == 2
        finally:
            db.close()

    @pytest.mark.parametrize(
        "query",
        [
            "",
            "snapshot_ids=1&snapshot_ids=1",
            "snapshot_ids=0",
            "&".join(f"snapshot_ids={index}" for index in range(1, 14)),
        ],
    )
    def test_export_rejects_invalid_ids(self, client, shipment_env, query):
        suffix = f"?{query}" if query else ""
        resp = client.get(
            _url(shipment_env, f"/export.xlsx{suffix}"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_export_rejects_missing_or_cross_project_snapshot(
        self, client, shipment_env
    ):
        other_project_id = shipment_env["project_id"] + 100000
        other_id = seed_new_product_calculation(
            other_project_id, "other-project", sku="X-OTHER"
        )
        db = SessionLocal()
        try:
            db.query(NewProductCalculation).filter(
                NewProductCalculation.id == other_id
            ).delete()
            db.commit()
        finally:
            db.close()

        resp = client.get(
            _export_url(shipment_env, [other_id]),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        assert resp.json()["error"]["details"]["missing_snapshot_ids"] == [other_id]
```

在文件顶部补入：

```python
from io import BytesIO

from openpyxl import load_workbook

from app.models.new_product_calculation import NewProductCalculation
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd backend && pytest tests/api/agent/test_new_product_read.py -k export -q
```

Expected: `/export.xlsx` is not found or returns the wrong response.

- [ ] **Step 3: Implement the Agent route**

在 `new_product_calculations.py` 补入 `Response`、`quote`、导出服务和常量导入，
并添加 `_XLSXResponse`、`_content_disposition`、`_parse_snapshot_ids`：

```python
class _XLSXResponse(Response):
    media_type = XLSX_MEDIA_TYPE


def _parse_snapshot_ids(snapshot_ids: list[int] | None) -> list[int]:
    if not snapshot_ids:
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message="snapshot_ids 必填")
    if len(snapshot_ids) > MAX_COMPARISON_SNAPSHOTS:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="snapshot_ids 最多 12 条",
        )
    if any(snapshot_id <= 0 for snapshot_id in snapshot_ids):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="snapshot_ids 必须为正整数",
        )
    if len(set(snapshot_ids)) != len(snapshot_ids):
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="snapshot_ids 不允许重复",
        )
    return snapshot_ids


@new_product_calculations_router.get("/export.xlsx", response_class=_XLSXResponse)
def export_new_product_comparison(
    project_id: int,
    request: Request,
    snapshot_ids: list[int] | None = Query(default=None),
    db: Session = Depends(get_primary_db_session),
    _scope=Depends(require_project_scope),
) -> Response:
    selected_ids = _parse_snapshot_ids(snapshot_ids)
    project = _get_project_or_shell_404(db, project_id)
    rows = list(
        db.scalars(
            select(NewProductCalculation).where(
                NewProductCalculation.project_id == project_id,
                NewProductCalculation.id.in_(selected_ids),
            )
        )
    )
    by_id = {row.id: row for row in rows}
    missing = [snapshot_id for snapshot_id in selected_ids if snapshot_id not in by_id]
    if missing:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            details={"missing_snapshot_ids": missing},
        )
    result = build_new_product_comparison_export(
        [by_id[snapshot_id] for snapshot_id in selected_ids],
        project_name=str(project.project_name),
        snapshot_ids=selected_ids,
    )
    append_operation_audit_log(
        db,
        action="new_product_calculation.export",
        target_type="new_product_calculation",
        target_id=project_id,
        operator=None,
        after={
            "snapshot_ids": selected_ids,
            "row_count": len(selected_ids),
            "column_count": result.column_count,
        },
        **_audit_kwargs(request),
    )
    db.commit()
    return Response(
        content=result.content,
        media_type=XLSX_MEDIA_TYPE,
        headers={
            "Content-Disposition": _content_disposition(result.filename),
            "Content-Length": str(len(result.content)),
        },
    )
```

`_content_disposition` 必须与店铺测算导出一致，使用 ASCII fallback +
RFC 5987 `filename*=UTF-8''...`。

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd backend && pytest tests/api/agent/test_new_product_read.py -k export -q
```

Expected: all export API tests PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/endpoints/agent/new_product_calculations.py \
  backend/tests/api/agent/test_new_product_read.py
git commit -m "feat(Agent): 新增新品测算对比矩阵导出接口"
```

---

### Task 3: 更新 Agent API 文档

**Files:**
- Modify: `backend/docs/agent-api.md`
- Modify: `docs/agent-api-design.md`

**Interfaces:**
- Consumes: Task 2 的 route contract。
- Produces: Agent 可发现的导出端点、参数、二进制响应和审计说明。

- [ ] **Step 1: Update the endpoint list**

在 `backend/docs/agent-api.md` 的新品测算路由列表加入：

```text
GET    /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx
```

并新增小节说明 `snapshot_ids`、1..12 上限、二进制流、缺失/跨项目整批失败、
缺失字段 `-` 和 `new_product_calculation.export` 审计。

- [ ] **Step 2: Update the design document**

在 `docs/agent-api-design.md` 的店铺测算导出之后增加新品测算对比矩阵导出契约，
明确：

```text
GET /api/v1/agent/projects/{project_id}/new-product-calculations/export.xlsx
  ?snapshot_ids=1&snapshot_ids=2
```

成功返回 XLSX 二进制流；最多 12 条；每 ID 一列并保持请求顺序；数据只读
`new_product_calculations`；缺失字段显示 `-`；不调用定价引擎。

- [ ] **Step 3: Verify documentation diff**

Run:

```bash
git diff --check
rg -n "new-product-calculations/export.xlsx|new_product_calculation.export" \
  backend/docs/agent-api.md docs/agent-api-design.md
```

Expected: 两条路径/action 均可检索到，diff 无空白错误。

- [ ] **Step 4: Commit**

```bash
git add backend/docs/agent-api.md docs/agent-api-design.md
git commit -m "docs(Agent): 补充新品测算导出接口说明"
```

---

### Task 4: 全量验证并整理计划

**Files:**
- Modify: `docs/superpowers/plans/2026-09-29-agent-new-product-comparison-export/2026-09-29-agent-new-product-comparison-export.md`

**Interfaces:**
- Consumes: Tasks 1-3。
- Produces: 可提交、已验证的完整功能。

- [ ] **Step 1: Run targeted tests**

Run:

```bash
cd backend && pytest \
  tests/services/test_new_product_calculation_export.py \
  tests/api/agent/test_new_product_read.py -q
```

Expected: PASS。

- [ ] **Step 2: Run the Agent API regression suite**

Run:

```bash
cd backend && pytest tests/api/agent -q
```

Expected: PASS；若本地数据库或环境依赖导致既有失败，记录准确失败项，不误报通过。

- [ ] **Step 3: Run syntax validation**

Run:

```bash
cd backend && python -m compileall -q \
  app/services/new_product_calculation_export.py \
  app/api/v1/endpoints/agent/new_product_calculations.py \
  tests/services/test_new_product_calculation_export.py
```

Expected: no syntax errors。

- [ ] **Step 4: Inspect diff and update plan checkboxes**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: 只有本功能代码、测试、文档和计划变化；`.codex/` 保持未跟踪且未被修改。

- [ ] **Step 5: Commit final plan/status updates**

```bash
git add docs/superpowers/plans/2026-09-29-agent-new-product-comparison-export
git commit -m "docs(Agent): 记录新品测算导出实施计划"
```
