# 日报导出作用域竞态修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复日报分析导出时 SKU 明细被旧项目/国家筛选成空的问题，并统一 Excel Blob 下载的释放时机。

**Architecture:** 把项目/国家作用域转换为可测试的纯函数；SKU 请求使用作用域与递增请求序号双重校验，旧响应不得覆盖当前状态。导出继续使用“仅激活 SKU”的业务口径，但只有当前作用域的 SKU 列表才可以参与过滤。所有 ExcelJS Blob 下载通过共享下载函数延迟释放 URL。

**Tech Stack:** Next.js/React、TypeScript、ExcelJS、Vitest、Testing Library。

## Global Constraints

- 不改变日报接口和“仅激活 SKU”业务规则。
- 不改动月度财务后端导出逻辑；日报问题必须在前端作用域与导出时机层解决。
- 前端验证顺序为 `pnpm lint` → `pnpm build` → `pnpm test`。
- 所有新增行为先写失败测试，再写最小实现。

---

### Task 1: 增加可测试的 SKU 作用域与 Blob 下载工具

**Files:**
- Create: `frontend/lib/daily-analysis-sku-scope.ts`
- Create: `frontend/lib/daily-analysis-sku-scope.test.ts`
- Create: `frontend/lib/download-blob.ts`
- Create: `frontend/lib/download-blob.test.ts`

**Interfaces:**
- `buildSkuScopeKey(projectId, country): string | null`
- `filterRowsBySkuScope<T extends { sku: string }>(rows, skuOptions, optionsScope, currentScope): T[]`
- `downloadBlob(blob, filename, revokeDelayMs?): void`

- [x] **Step 1: Write failing tests**

测试以下行为：旧作用域 SKU 列表不得过滤当前明细；相同作用域才过滤下架 SKU；`ALL` 没有 SKU 作用域；下载链接点击后不能立即释放 URL，而是在延迟计时器触发后释放。

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run lib/daily-analysis-sku-scope.test.ts lib/download-blob.test.ts`

Expected: FAIL because the new modules do not exist.

- [x] **Step 3: Implement the minimal pure helpers**

`filterRowsBySkuScope` 在 `currentScope` 为空、`optionsScope` 不匹配或 SKU 列表为空时原样返回；只有作用域匹配且存在 SKU 列表时才按 SKU 过滤。`downloadBlob` 创建隐藏 `<a>`、触发点击、移除节点，并通过 `setTimeout` 延迟 `URL.revokeObjectURL`。

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm exec vitest run lib/daily-analysis-sku-scope.test.ts lib/download-blob.test.ts`

Expected: PASS.

### Task 2: 修复日报 SKU 请求竞态与导出时机

**Files:**
- Modify: `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`
- Create: `frontend/app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts`
- Test with existing: `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx`

**Interfaces:**
- 日报组件消费 Task 1 的 SKU 作用域过滤函数和下载工具。
- SKU 请求完成时只允许当前 `requestId` 且当前作用域匹配的响应写入状态。

- [x] **Step 1: Add failing regression tests**

覆盖：旧异步响应不会写入新作用域；SKU 加载或日报加载中导出按钮不可用；导出构造函数生成的两个工作表都包含数据；旧作用域不会把当前明细过滤为空。

- [x] **Step 2: Run the focused daily-analysis tests and verify the new assertions fail**

Run: `pnpm exec vitest run app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx app/dashboard/operations/daily-analysis/daily-analysis-excel-export.test.ts lib/daily-analysis-sku-scope.test.ts`

Expected: the new race/disabled-state assertions fail against the current implementation.

- [x] **Step 3: Implement the minimal race fix**

在日报组件中维护当前 SKU 作用域、请求序号和 `skuOptionsScope`；作用域变化时清空选项并使旧请求失效；`loadProjectSkus` 只提交当前请求结果；`detailRows` 和比较期明细通过作用域过滤函数计算。导出按钮和处理函数同时守卫 `loading`、`skuLoading`。

- [x] **Step 4: Run focused tests and verify they pass**

Run: `pnpm exec vitest run app/dashboard/operations/daily-analysis/daily-analysis-client.test.tsx lib/daily-analysis-sku-scope.test.ts`

Expected: PASS.

### Task 3: 迁移 ExcelJS Blob 下载释放模式

**Files:**
- Modify: all frontend ExcelJS exporters that call `writeBuffer()` and `revokeObjectURL()` in the same file, including daily analysis, monthly report display, weekly/product analysis, inventory/replenishment, return analysis, shipment management, pricing calculation, and manual calculation exporters.
- Test: `frontend/lib/download-blob.test.ts`

- [x] **Step 1: Replace each inline URL lifecycle with `downloadBlob`**

保留每个导出的文件名和审计日志，只替换 `createObjectURL`、`link.click`、立即 `revokeObjectURL` 这一段，避免改变工作簿内容。

- [x] **Step 2: Run targeted exporter tests and type checking**

Run: `pnpm exec vitest run lib/download-blob.test.ts app/dashboard/operations/return-analysis/return-analysis-client.test.tsx`

Expected: PASS.

### Task 4: 全量验证与交付检查

**Files:**
- Modify: `docs/superpowers/plans/2026-09-22-daily-analysis-export-race.md`（完成后归档到日期 slug 目录）

- [ ] **Step 1: Run frontend checks in repository order**

Run: `pnpm lint`; `pnpm build`; `pnpm test`。已完成 `pnpm lint`、`pnpm build`；`pnpm test` 已尝试以 `--maxWorkers=4` 执行，约 8 分钟后仍停留在单个高 CPU worker，已终止，结果记为未完成而非通过。

- [x] **Step 2: Run backend regression checks**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://damon@/BLF_test?host=/tmp' pytest -q tests/services/test_report_export_styles.py tests/services/test_report_export_concurrency.py tests/services/test_excel_num_fmt_currency.py`。

- [x] **Step 3: Inspect the diff and verify no unrelated files changed**

Run: `git diff --check` and `git status --short`。

- [ ] **Step 4: Archive the completed plan**

待全量前端测试完成后，将计划移动到 `docs/superpowers/plans/2026-09-22-daily-analysis-export-race/2026-09-22-daily-analysis-export-race.md`，保留实施记录并更新复选框。
