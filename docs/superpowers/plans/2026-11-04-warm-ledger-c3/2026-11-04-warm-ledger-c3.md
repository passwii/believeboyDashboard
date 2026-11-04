# Warm Ledger V4 C3 Implementation Plan

> **For agentic workers:** Use DeepSeek / max implementers with disjoint write scopes. Task 2 completes first; Tasks 3 and 4 may then run in parallel in separate worktrees. Perform one independent Luna / max review of the integrated C3 stage after the page implementations and browser matrix are complete.

**Goal:** Migrate Order Info, Product Analysis, and Monthly Report Display to the existing Warm Ledger route shell while preserving each page's filters, data scope, formulas, permissions, writes, and export contracts.

**Architecture:** Extend the exact-route Warm Ledger allowlist and add route-aware report breadcrumbs. Keep the existing reports primary link and Order Info QuickLink, and add only the missing direct Product Analysis link. Use route-local CSS Modules and existing Warm controls/slots; keep each page's business orchestration and specialized tables local. Do not change backend contracts or shared UI defaults.

**Tech Stack:** Next.js App Router, React, TypeScript, CSS Modules, existing Warm Ledger shell/controls, Vitest, Testing Library, Playwright.

> **Final review status (2026-11-04):** C3 implementation and desktop acceptance are complete, but the final Luna/max review found two P2 issues. Order Info V3 visual residue is being remediated and C3 documentation is reset to implementation complete + final review remediation in progress. Do not mark C3 complete or check the independent-review gate until a fresh Luna/max re-review passes.

## Global Constraints

- C3 routes are exactly `/dashboard/reports/order-info`, `/dashboard/reports/product-analysis`, and `/dashboard/reports/monthly-report/display`; all other report routes remain on `TerminalShell`.
- Reuse the approved dark, route-scoped Warm Ledger tokens and shell. Do not change `--warm-ledger-*`, `--term-*`, global theme defaults, or frozen foundation values. The coordinator may append the user-approved exact C3 route scope to `foundations/freeze.md` without changing its visual contract.
- Add no feature flag. Preserve existing C1/C2 routes, primary navigation, four QuickLinks, and active-route behavior.
- Avoid unnecessary secondary labels and descriptions. Let layout, existing field names, status, and navigation explain the interface.
- This Warm Ledger operations/business page migration is desktop-only per the 2026-11-04 user direction. Do not add mobile or multi-breakpoint page adaptations or include phone viewports in C3 acceptance; leave existing shared-shell mobile behavior untouched.
- The floating rounded app window must use equal, compact 8px outer gutters on all four sides at the desktop acceptance viewport, maximizing the usable canvas while retaining the existing window radius. The current 1840px width and 960px height caps are the source of the unequal gutters and must be removed from the desktop shell geometry.
- Preserve current data, filter, URL, sort, pagination, authorization, write, formula, and export semantics. Do not silently change report payloads, totals, workbook sheets/columns, or file names.
- Loading, error, empty, and zero-data states must remain distinct; their presentation may be corrected to meet the Warm Ledger state contract without changing API or data semantics.
- Keep page-specific tables, filters, uploads, dialogs, and export UI local. Promote no component to a shared design primitive in this stage.
- From 2026-11-04 onward, all new implementation agents use `codex/believeboy/DeepSeek-V4.1-Flash`, `full-access`, `max` reasoning. The final independent reviewer uses `codex/believeboy/GPT-6-Luna`, `full-access`, `max` reasoning. Task 1 and the in-flight Task 2 predate this switch; their historical model record remains unchanged.
- The 5 known full-Vitest failures on main (`inventory-analysis-client.test.tsx` and `portfolio-overview-client.test.tsx`) are pre-existing baseline failures; reconcile them after the single C3 full run and do not hide them with skip/xfail.

## Audit Baseline

The C3 page-contract audits completed read-only on `origin/main`:

| Page | Current contract to preserve | Existing verification |
| --- | --- | --- |
| Order Info | Overview + list API split; page size 50; sort by quantity or amount; global project/country/PT date range plus local multi-select and keyword filters; CSV exports all matching rows (backend cap 5,000); FBM PATCH stays permission-checked by the backend. | `frontend/app/dashboard/reports/order-info/page.test.tsx`, `frontend/tests/dashboard/reports-mobile-blf616.spec.ts` |
| Product Analysis | Three distinct tabs: historical Product Analysis, Manual Calculation, and temporary-file Monthly SKU Analysis. Weekly and monthly date defaults differ. Manual business/payment confirmation writes A-table data; advertisement confirmation is dry-run; all Monthly SKU confirmations are dry-run. Product and Monthly SKU share the two-sheet export helper; Manual Calculation has a separate workbook. | `frontend/app/dashboard/reports/product-analysis/page.test.tsx`, `frontend/lib/product-analysis-export.test.ts`, `frontend/tests/dashboard/reports-mobile-blf616.spec.ts` |
| Monthly Report Display | Keep the `project`, `country`, `fromMonth`, `toMonth`, and rolling `monthRange=last12m` URL behavior; preserve the shared project preference, financial series/recalculate calls, and admin-aware view. Financial Analysis exports two client-built sheets over the selected range; Accounting Detail downloads a separate server-built workbook for one selected month. | `frontend/app/dashboard/reports/monthly-report/display/display-client.test.tsx`, `frontend/app/dashboard/reports/monthly-report/display/excel-num-fmt.test.ts`, `frontend/tests/dashboard/reports-mobile-blf617.spec.ts` |

The audits also found existing behavior and data risks that this visual migration must not silently alter:

- Order Info's CSV endpoint caps output at 5,000 rows without a truncation notice. Its FBM editor does not prefill existing tracking fields and cannot clear some values. Its current global site mapping accepts only `US`/`DE`/`UK`; other terminal country values map to no country filter.
- Product Analysis retains old results after a country change; leaving Manual or Monthly SKU tabs unmounts their upload workspace; the shared multi-period workbook total currently sums ratio fields; upload/project error display has gaps; the SKU export includes a stock column whose source value can be absent.
- Monthly Report Display initially shows some KPI values as `$0.00` while loading and can show an error alongside an empty-state message. The Accounting Detail workbook's role-specific raw column scope needs a separate permission review.

Keep these as explicit follow-ups. Do not change them as a side effect of visual migration; make a separate behavior change only with a focused contract and regression coverage.

## Task 1: Warm Route Frame and Navigation

**Files:**

- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame.tsx`.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-sidebar.tsx`.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-shell.test.tsx`.
- Modify `frontend/app/dashboard/layout.test.tsx`.
- Modify `frontend/app/dashboard/reports/order-info/page.test.tsx` only for the Order Info deep-link/global-filter initialization contract.

**Interfaces:**

- `isWarmLedgerRoute(pathname)` and `getWarmLedgerPageTitle(pathname)` remain the exact route boundary consumed by `frontend/app/dashboard/layout.tsx`.
- Existing `/dashboard/reports/monthly-report/display` primary entry and `/dashboard/reports/order-info` QuickLink remain the single links for those routes. Add a direct Product Analysis link using the existing `SIDEBAR_TOP_GROUPS` item; do not add another reports section containing duplicate links.
- Report routes use a `报表中心` breadcrumb; operations routes keep their existing `运营` breadcrumb.
- Order Info receives project/site/date filters through the existing primary header slot and `TerminalGlobalFilterProvider`. Preserve its first-visible-project behavior and current `ALL`/`US`/`DE`/`UK` mapping. Product Analysis keeps its tab-local project/site/date state. Monthly Report Display keeps its existing page-owned header slots.

- [x] Add exact-route tests for all three C3 paths, their route titles, and adjacent non-C3 report paths remaining outside Warm Ledger.
- [x] Add sidebar tests proving each C3 route is reachable once, `aria-current` identifies the active page, four existing QuickLinks remain, and no route link is duplicated.
- [x] Add route-slot tests for report breadcrumbs and Order Info's three global filters, including `ALL` and supported country behavior.
- [x] Add a route-frame regression for country/date changes made while the project list is loading; after the list resolves, retain those user choices and fill only the missing project scope.
- [x] Add an Order Info integration regression where `project_id`, `date_from`, and `date_to` deep-link values override conflicting saved global project/date preferences in both the header and the first page request.
- [x] Run `cd frontend && pnpm exec vitest run app/dashboard/layout.test.tsx components/dashboard-v2/warm-ledger/shell/warm-ledger-shell.test.tsx app/dashboard/reports/order-info/page.test.tsx`.
- [x] Implement only the allowlist/title/breadcrumb/navigation/header-slot wiring required by those assertions.
- [x] Re-run the same targeted Vitest command and `git diff --check`; obtain a fresh independent max-reasoning review before Task 2.

## Task 2: Order Info Page

Completed in `f92b469e` before the 2026-11-04 DeepSeek model-policy switch. Targeted Vitest passed (2 files / 36 tests), changed-file ESLint and `git diff --check` passed. The in-flight implementer stopped its separate review; Task 2 now feeds the consolidated C3 review.

**Files:**

- Modify `frontend/app/dashboard/reports/order-info/page.tsx` and `frontend/app/dashboard/reports/order-info/page.test.tsx`.
- Create `frontend/app/dashboard/reports/order-info/order-info-warm.module.css`.
- Modify `frontend/app/dashboard/reports/order-info/components/OrderEditDialog.tsx` only for Warm-scoped surface and accessibility changes; create `frontend/app/dashboard/reports/order-info/components/OrderEditDialog.test.tsx` for any changed dialog semantics.
- Do not modify `backend/`, `frontend/lib/order-status.ts`, `frontend/components/terminal/term-table.tsx`, global `MultiSelect`, or the backend proxy.

**Interfaces:**

- Keep `overview` for first/filter loads and `list` for pagination/sorting; page size remains 50 and existing stats are reused on subsequent pages.
- Keep the current endpoint headers, project scope, PT date semantics, filter mapping, status tones, selection aggregation, CSV payload/columns/UTC filename, and backend row cap.
- Keep the three multi-select filters multi-select. `WarmSelect` is single-select and cannot replace them.
- Keep FBM edit visibility and PATCH fields; current blank-field behavior is a separate follow-up.
- Keep the complete 13-column table and its `min-w-[1560px]` content width inside the table scroller.

- [x] Extend the existing page tests to assert Warm surfaces, route-slot filters, multi-select controls, current loading/empty/error states, and the existing payload/summary/sort behavior.
- [x] Add a failing dialog test for visible labels being programmatically associated with their inputs; do not change what empty fields submit.
- [x] Run `cd frontend && pnpm exec vitest run app/dashboard/reports/order-info/page.test.tsx app/dashboard/reports/order-info/components/OrderEditDialog.test.tsx`.
- [x] Apply page-local Warm CSS to the filter groups, table, statuses, pinned summary, pager, loading/empty/error states, and edit dialog; do not add secondary descriptions.
- [x] Keep page styles desktop-only; do not add mobile or multi-breakpoint adaptations.
- [x] Re-run targeted Vitest, changed-file ESLint, and `git diff --check`; commit only the Task 2 files and report the result for the consolidated C3 review.

## Task 3: Product Analysis Page

Task 3 and Task 4 have disjoint write scopes and may run in parallel after Task 2 is committed. Use separate worktrees and DeepSeek/max implementers; integrate both before the C3 browser matrix and consolidated review.

Completed by DeepSeek/max in `dfb71319`; integrated as `c3ffb46c`. Targeted Vitest passed (5 files / 15 tests), RED preceded implementation, changed-file ESLint / mock-stability / `git diff --check` passed.

**Files:**

- Modify `frontend/app/dashboard/reports/product-analysis/page.tsx` and `page.test.tsx`.
- Modify `frontend/app/dashboard/reports/product-analysis/components/product-analysis-panel.tsx`.
- Modify `frontend/app/dashboard/reports/product-analysis/components/manual-calculation-panel.tsx`.
- Modify `frontend/app/dashboard/reports/product-analysis/components/monthly-sku-analysis-panel.tsx`.
- Create `frontend/app/dashboard/reports/product-analysis/product-analysis-warm.module.css` and add panel tests under `frontend/app/dashboard/reports/product-analysis/components/`.
- Do not modify `frontend/lib/product-analysis-export.ts`, `frontend/lib/hooks/use-url-param.ts`, `frontend/app/dashboard/reports/monthly-report/shared-project.ts`, or shared report upload component defaults in this task.

**Interfaces:**

- Keep the three tabs and their distinct data flows, local filters, date defaults, confirmation steps, and loading/error/empty states.
- Preserve the Manual Calculation business/payment write versus advertisement dry-run distinction; all Monthly SKU upload commits remain dry-run.
- Preserve the two-sheet Product/Monthly SKU workbook and the separate Manual Calculation workbook.
- Keep upload identity and pending file state local to each existing panel; do not consolidate data or callbacks across tabs.
- Keep all business formulas, API request bodies, access checks, and existing export helper outputs unchanged. Record ratio-total and stale-site findings as separate follow-ups.

- [x] Expand `page.test.tsx` to exercise tab labels, selected state, and panel mount behavior without replacing its existing API/formula assertions.
- [x] Add focused component tests for each panel: date defaults, current filter/request behavior, required confirmation actions, write/dry-run request bodies, loading/error/empty states, and export calls.
- [x] Run `cd frontend && pnpm exec vitest run app/dashboard/reports/product-analysis/page.test.tsx app/dashboard/reports/product-analysis/components/product-analysis-panel.test.tsx app/dashboard/reports/product-analysis/components/manual-calculation-panel.test.tsx app/dashboard/reports/product-analysis/components/monthly-sku-analysis-panel.test.tsx lib/product-analysis-export.test.ts`.
- [x] Apply Warm CSS locally to the page tab strip, filters, result summary, SKU detail table, upload/recognition workflow, progress, empty/error states, and separate workbook actions. Retain any upload component markup and callbacks needed by non-Warm consumers.
- [x] Keep page styles desktop-only; do not add mobile or multi-breakpoint adaptations.
- [x] Re-run the same targeted Vitest command, changed-file ESLint, and `git diff --check`; commit only the Task 3 files and report the result for the consolidated C3 review.

## Task 4: Monthly Report Display

Completed by DeepSeek/max in `e80506e8`; integrated as `f577490e`. Targeted Vitest passed on integration (3 files / 34 tests), changed-file ESLint / mock-stability / motion guard / `git diff --check` passed. One pre-existing hook-dependency warning remains at `display-client.tsx:884`.

**Files:**

- Modify `frontend/app/dashboard/reports/monthly-report/display/display-client.tsx` and `display-client.test.tsx`.
- Create `frontend/app/dashboard/reports/monthly-report/display/display-warm.module.css`.
- Leave `frontend/app/dashboard/reports/monthly-report/display/page.tsx`'s `force-dynamic` and Suspense boundary intact.
- Do not modify `frontend/app/dashboard/reports/monthly-report/shared-project.ts`, `frontend/lib/hooks/use-url-param.ts`, sibling Generate/Reconcile pages, backend report services, or workbook exporters.

**Interfaces:**

- Keep URL keys and rolling-window rules; retain shared-project scope validation and avoid changes to the shared hook's Generate/Reconcile consumers.
- Preserve the two display tabs, their different data scopes, calculations, and the separate financial-analysis and accounting-detail export actions/workbooks.
- Keep admin-only visible columns and backend project authorization as-is. Do not infer permissions from hidden UI.
- Keep both wide tables horizontally scrollable inside their own containers, preserving every required column.

- [x] Extend `display-client.test.tsx` for Warm route-slot controls, tab switching, rolling URL filters, loading/error/empty separation, existing project memory, and both export request scopes.
- [x] Run `cd frontend && pnpm exec vitest run app/dashboard/reports/monthly-report/display/display-client.test.tsx app/dashboard/reports/monthly-report/display/excel-num-fmt.test.ts app/dashboard/reports/monthly-report/shared-project.test.tsx`.
- [x] Apply a route-local Warm style to the display filters, KPIs, trend, two tabs/tables, and separate export actions; render loading, request failure, and true empty data distinctly while keeping the report's existing calculations and semantic order.
- [x] Keep page styles desktop-only; do not add mobile or multi-breakpoint adaptations.
- [x] Re-run the same targeted Vitest command, changed-file ESLint, and `git diff --check`; commit only the Task 4 files and report the result for the consolidated C3 review.

## Task 5: C3 Browser Matrix and Integration

**Files:**

- Create `frontend/tests/dashboard/warm-ledger-c3-matrix.spec.ts`.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/theme.css` and its shell tests to remove the desktop app-window width/height caps and enforce the existing 8px stage inset evenly on all four sides; leave existing mobile rules untouched.
- Modify `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/freeze.md`, `spec.md`, and `tokens.css` to record the approved desktop canvas geometry and exact C3 route extension.
- Modify `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md` and update `2026-11-04-warm-ledger-c3-contract-audit.md` with implementation and verification outcomes after the consolidated C3 review passes.

- [ ] Add a desktop-only Playwright acceptance for the three exact routes at 1440x900. Assert 8px equal outer gutters, no page-level overflow, and contained table scrolling.
- [ ] Exercise Order Info global scope, local filters, pagination, CSV request and edit dialog; exercise all Product Analysis tabs and intercept upload/run/export requests; exercise Monthly Report Display project/country/month URL changes, both tabs, both exports, and recalculation. Intercept every backend request; no real writes or exports reach a backend.
- [ ] Run `cd frontend && pnpm test:ui -- tests/dashboard/warm-ledger-c3-matrix.spec.ts` at the single desktop acceptance viewport; intercept all backend requests and perform no real writes or exports.
- [ ] Run full `cd frontend && pnpm test` once because the route frame is a shared component, record the complete result, and reconcile the known five main-baseline failures without hiding them.
- [ ] Run `cd frontend && pnpm lint`, `cd frontend && pnpm build`, and `git diff --check`.
- [ ] Run one independent Luna/max whole-C3 review after all three page implementations, their targeted tests, and the browser matrix are complete.

## Stage Exit Gate

- Only the three exact C3 routes use Warm Ledger; other report pages continue using `TerminalShell`.
- Product Analysis has one direct navigation link; the monthly report primary entry and Order Info QuickLink remain unique.
- All existing endpoint, URL, permission, formula, write, table, and export contracts listed above remain intact.
- C3-specific Vitest and Playwright coverage passes; the single full Vitest run is reconciled against the documented main baseline; lint/build/diff checks pass.
- No known C3 behavioral/security risk discovered in audit is represented as fixed unless it received a separate focused implementation, approval, and verification.
