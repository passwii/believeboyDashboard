# 库存分类账分析扩展与统一 Excel 导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让库存分类账页面与统一 Excel 导出共用所选月份的全量数据，并扩展总览、Summary、Detail 分析。

**Architecture:** 后端新增 `month-analysis` 聚合接口，返回全量原始行与既有聚合结果；前端一次加载该接口，用 ExcelJS 生成九 Sheet 工作簿，并从共享派生模块驱动新增分析区块。

**Tech Stack:** FastAPI、SQLAlchemy、Pydantic、pytest、Next.js、React、TypeScript、Vitest、ExcelJS。

## Global Constraints

- 所选月份必须是完整自然月；部分月份窗口返回 400。
- Excel 数据范围固定为整月全量，不受页面维度筛选影响。
- Excel Sheet 顺序：分析总览、SKU期末与环比、SKU事件汇总、仓库状态库存、每日事件分析、近6月趋势、数据质量与批次、Summary原始数据、Detail原始数据。
- 最后两张必须是原始数据，字段名保持 Amazon 英文列名。
- 移除两个 CSV 按钮，只保留一个 Excel 导出按钮。
- ExcelJS 样式复用 `frontend/lib/excel-styles.ts`。
- 不修改上传格式和数据库结构。

---

### Task 1: 后端全量月度分析数据接口

**Files:**
- Modify: `backend/app/services/inventory/ledger.py`
- Modify: `backend/app/schemas/inventory_ledger.py`
- Modify: `backend/app/api/v1/endpoints/inventory_ledger.py`
- Test: `backend/tests/services/inventory/test_ledger_month_analysis.py`

**Interfaces:**
- Produces: `LedgerMonthAnalysisResponse`
- Produces: `GET /api/v1/inventory-ledger/month-analysis`
- Consumes: existing `get_ledger_summary_rows`, `get_ledger_detail_rows`, `get_sku_month_eom`, `get_month_disposition_summary`, `get_trend`, `check_ledger_consistency`, `list_ingest_batches`

- [ ] **Step 1: Write failing service/API tests**

```python
def test_month_analysis_returns_all_rows_and_nested_results(client, db_session, project):
    seed_ledger_rows(db_session, project.id)
    response = client.get(
        "/api/v1/inventory-ledger/month-analysis",
        params={"project_id": project.id, "period": "2026-08"},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["summary_rows"]) == 2
    assert len(body["detail_rows"]) == 2
    assert body["snapshot"]["report_month"] == "2026-08-01"
    assert body["trend"]["months"]
    assert body["batches"]


def test_month_analysis_rejects_partial_period(client, project):
    response = client.get(
        "/api/v1/inventory-ledger/month-analysis",
        params={"project_id": project.id, "period": "30d"},
    )
    assert response.status_code == 400
```

- [ ] **Step 2: Run tests and confirm missing endpoint failure**

Run: `cd backend && pytest tests/services/inventory/test_ledger_month_analysis.py -q`
Expected: FAIL because endpoint/schema do not exist.

- [ ] **Step 3: Implement schemas and service**

Add `limit=None` support to row queries, `report_month` filtering to batches, and a schema containing project metadata, full rows, snapshot, trend, consistency and batches.

- [ ] **Step 4: Implement the full-month endpoint**

Resolve period, reject when `report_month is None`, assemble the existing service results, and return `LedgerMonthAnalysisResponse`.

- [ ] **Step 5: Run tests**

Run: `cd backend && pytest tests/services/inventory/test_ledger_month_analysis.py tests/services/inventory/test_ingest_ledger_csv.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/inventory/ledger.py backend/app/schemas/inventory_ledger.py backend/app/api/v1/endpoints/inventory_ledger.py backend/tests/services/inventory/test_ledger_month_analysis.py
git commit -m "feat(库存分类账): 新增整月全量分析数据接口"
```

---

### Task 2: 页面切换全量数据源与代理超时

**Files:**
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-types.ts`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.tsx`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.test.tsx`
- Modify: `frontend/lib/server/backend-proxy-timeout-policy.ts`
- Test: `frontend/lib/server/backend-proxy-timeout-policy.test.ts`

**Interfaces:**
- Consumes: `GET /inventory-ledger/month-analysis`
- Produces: page state populated from `LedgerMonthAnalysisResponse`

- [ ] **Step 1: Add failing timeout-policy test**

```typescript
it('gives inventory ledger month analysis the 60s report tier', () => {
  expect(getProxyTimeoutMs('api/v1/inventory-ledger/month-analysis', 'GET', '')).toBe(60_000)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd frontend && pnpm vitest run lib/server/backend-proxy-timeout-policy.test.ts`
Expected: FAIL with 5_000 instead of 60_000.

- [ ] **Step 3: Add proxy tier and frontend type**

Add `/inventory-ledger/month-analysis$/` to report path patterns and add `LedgerMonthAnalysisResponse` to `ledger-types.ts`.

- [ ] **Step 4: Replace six page requests with one**

Fetch `month-analysis`, then set summary/detail/snapshot/trend/consistency/batches from the payload. Keep months endpoint separate.

- [ ] **Step 5: Update page tests**

Assert one `month-analysis` request replaces six old endpoint requests and all states render.

- [ ] **Step 6: Run tests**

Run: `cd frontend && pnpm vitest run lib/server/backend-proxy-timeout-policy.test.ts app/dashboard/operations/inventory-ledger/inventory-ledger-client.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/dashboard/operations/inventory-ledger/ledger-types.ts frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.tsx frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.test.tsx frontend/lib/server/backend-proxy-timeout-policy.ts frontend/lib/server/backend-proxy-timeout-policy.test.ts
git commit -m "feat(库存分类账): 页面切换整月全量分析数据"
```

---

### Task 3: Excel 派生分析与工作簿

**Files:**
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-derive.ts`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-derive.test.ts`
- Create: `frontend/app/dashboard/operations/inventory-ledger/ledger-excel-export.ts`
- Create: `frontend/app/dashboard/operations/inventory-ledger/ledger-excel-export.test.ts`

**Interfaces:**
- Produces: `buildLedgerAnalysisWorkbook(data: LedgerMonthAnalysisResponse): Promise<Workbook>`
- Produces: `exportLedgerAnalysisToExcel(data: LedgerMonthAnalysisResponse): Promise<void>`
- Produces derive helpers for SKU ranking, warehouse×disposition, daily events, extended KPIs

- [ ] **Step 1: Write failing pure-derivation tests**

```typescript
it('builds date-level event summaries', () => {
  expect(dailyEventSummary(detailRows)).toEqual([
    expect.objectContaining({ date: '2026-08-02', eventCount: 2, netQty: -2 }),
  ])
})
```

- [ ] **Step 2: Run and confirm missing helper failure**

Run: `cd frontend && pnpm vitest run app/dashboard/operations/inventory-ledger/ledger-derive.test.ts`
Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement derive helpers**

Add extended KPI, SKU ranking, warehouse×disposition, daily event summary and 6-month trend derivations using existing raw datasets.

- [ ] **Step 4: Write failing workbook tests**

```typescript
it('creates the nine required sheets in order', async () => {
  const workbook = await buildLedgerAnalysisWorkbook(fixture)
  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
    '分析总览', 'SKU期末与环比', 'SKU事件汇总', '仓库状态库存',
    '每日事件分析', '近6月趋势', '数据质量与批次',
    'Summary原始数据', 'Detail原始数据',
  ])
})
```

- [ ] **Step 5: Implement workbook builder**

Use dynamic `import('exceljs')`, shared excel styles, fixed sheet order, English raw headers, number formats, freeze panes, autofilter and blob download.

- [ ] **Step 6: Run tests**

Run: `cd frontend && pnpm vitest run app/dashboard/operations/inventory-ledger/ledger-derive.test.ts app/dashboard/operations/inventory-ledger/ledger-excel-export.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/dashboard/operations/inventory-ledger/ledger-derive.ts frontend/app/dashboard/operations/inventory-ledger/ledger-derive.test.ts frontend/app/dashboard/operations/inventory-ledger/ledger-excel-export.ts frontend/app/dashboard/operations/inventory-ledger/ledger-excel-export.test.ts
git commit -m "feat(库存分类账): 生成九工作表分析 Excel"
```

---

### Task 4: 页面分析扩展与导出入口

**Files:**
- Modify: `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.tsx`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-overview.tsx`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-summary-tab.tsx`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-detail-tab.tsx`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/ledger-table-parts.tsx`
- Modify: `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.test.tsx`
- Test: `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.test.tsx`

**Interfaces:**
- Consumes: `exportLedgerAnalysisToExcel`
- Consumes: new derive helpers
- Produces: unified Excel button and expanded analysis sections

- [ ] **Step 1: Write failing page tests**

```typescript
it('removes CSV exports and exports the unified workbook', async () => {
  render(<InventoryLedgerPage />)
  expect(screen.queryByRole('button', { name: /导出 CSV/ })).not.toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: /导出库存分析 Excel/ }))
  expect(exportLedgerAnalysisToExcel).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd frontend && pnpm vitest run app/dashboard/operations/inventory-ledger/inventory-ledger-client.test.tsx`
Expected: FAIL because CSV buttons still exist and Excel button is missing.

- [ ] **Step 3: Add overview KPI and analysis panels**

Add SKU count, sellable, damaged and event count KPIs plus SKU Top 10 and daily event activity panels.

- [ ] **Step 4: Add Summary and Detail analysis**

Rename monthly water-level copy, add `SKU 月度汇总` to Summary and `每日事件汇总` to Detail.

- [ ] **Step 5: Remove CSV UI and wire unified export**

Delete `ExportCsvButton`, remove both usages, add top-level loading/error state and unified export button.

- [ ] **Step 6: Run tests**

Run: `cd frontend && pnpm vitest run app/dashboard/operations/inventory-ledger`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/dashboard/operations/inventory-ledger
git commit -m "feat(库存分类账): 扩展分析总览并统一 Excel 导出"
```

---

### Task 5: 文档、全量验证与发布

**Files:**
- Modify: `backend/docs/inventory-ledger-api.md`
- Modify: `frontend/docs/dashboard-refresh-loading-audit.md` only if the page loading contract changes materially
- Verify: all changed code and tests

**Interfaces:**
- Produces: documented `month-analysis` endpoint and unified export contract

- [ ] **Step 1: Document month-analysis endpoint**

Add endpoint row, full-month-only rule, response shape, and note that page and Excel share this full dataset.

- [ ] **Step 2: Run backend focused regression**

Run: `cd backend && pytest tests/services/inventory tests/api/agent/test_inventory_ledger_native.py -q`
Expected: PASS.

- [ ] **Step 3: Run frontend target regression**

Run: `cd frontend && pnpm vitest run app/dashboard/operations/inventory-ledger lib/server/backend-proxy-timeout-policy.test.ts`
Expected: PASS.

- [ ] **Step 4: Run gates**

Run: `cd backend && ruff check app/services/inventory/ledger.py app/api/v1/endpoints/inventory_ledger.py app/schemas/inventory_ledger.py tests/services/inventory/test_ledger_month_analysis.py`
Run: `cd frontend && pnpm lint`
Run: `cd frontend && pnpm build`
Expected: no errors.

- [ ] **Step 5: Commit docs and final fixes**

```bash
git add backend/docs/inventory-ledger-api.md docs/superpowers/specs/2026-10-26-inventory-ledger-analysis-export-design.md docs/superpowers/plans/2026-10-26-inventory-ledger-analysis-export/implementation.md
git commit -m "docs(库存分类账): 记录全量分析与 Excel 导出契约"
```
