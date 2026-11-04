# Warm Ledger V4 C3 Contract Audit — 2026-11-04

## Scope and method

The audit covers only the exact C3 routes:

- `/dashboard/reports/order-info`
- `/dashboard/reports/product-analysis`
- `/dashboard/reports/monthly-report/display`

Three independent `believeboy/GPT-6-Luna` agents with `max` reasoning reviewed one route each in isolated worktrees based on `origin/main` before the model-policy switch. The reviews were read-only; agents did not modify source or run tests. Findings below are implementation inputs, not claims of browser verification. Subsequent implementation uses `believeboy/DeepSeek-V4.1-Flash` with `max` reasoning; the final independent review uses `believeboy/GPT-6-Luna` with `max` reasoning.

## Shared Warm Ledger boundary

- Extend the exact route allowlist and title map in `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame.tsx`.
- Use “报表中心” as the breadcrumb section for C3 routes; keep “运营” for existing operations routes.
- `sidebar-config.ts` already exposes all three routes. The Warm sidebar already links to the monthly display as the reports primary route and to Order Info as a QuickLink. Add a single direct Product Analysis link; do not duplicate the other two.
- Order Info currently reads `TerminalGlobalFilterProvider` state and needs a Warm primary-slot adapter for project, site, and date. Product Analysis has three distinct tab-local filter scopes. Monthly Report Display already owns route header slots for its project/site/month controls.
- Use page-local CSS Modules under the existing `.warm-ledger` scope. Keep frozen foundations, global UI defaults, `--term-*`, backend APIs, and the shared monthly project hook unchanged.

## Page contracts

### Order Info

- Data flow: first/filter load uses `GET /api/v1/order-info/overview`; pagination and sort use `GET /api/v1/order-info/list` and reuse first-page statistics. Page size is 50. Default sort is `purchase_at_pt desc`; only quantity and amount are interactive sort columns.
- Filters: global `gProject`, `gCountry`, `gDateFrom`, `gDateTo` plus local fulfillment channel, order status, currency, SKU, order ID, and ASIN filters. The API receives `project_ids`, `fulfillment_channels`, `order_statuses`, `countries`, `currencies`, keywords, PT `date_from/date_to`, `page`, `page_size`, `sort_by`, and `sort_dir`. `'all'` means no `project_ids`; only US/DE/UK map to a country filter.
- Table: 12 business columns plus row selection, with complete columns preserved inside an internal horizontal scroller. Keep status tones, hyperlinks/copy actions, row selection, and the current differing statistics/table amount formulas.
- Export: `POST /api/v1/order-info/export` uses all active filters, not current page, sort, or selected rows. CSV columns and filename stay unchanged. Backend caps export at 5,000 rows, but the UI does not disclose truncation.
- Edit: FBM PATCH stays backend-authorized and writes audit logs. Current editor does not prefill existing logistics fields and cannot clear some values; do not change empty-field/PATCH semantics in the visual task.
- Tests: `frontend/app/dashboard/reports/order-info/page.test.tsx` has broad filter, URL, pagination, race, and error coverage. There is no export-payload assertion or dedicated `OrderEditDialog` test. Existing mobile coverage is in `frontend/tests/dashboard/reports-mobile-blf616.spec.ts`.

### Product Analysis

- The page has three separate workflows and local state; do not unify their submit, upload, or result behavior:
  - Product Analysis: historical availability check → explicit historical calculation → period summaries / SKU details → two-sheet Excel. Weekly date default.
  - Manual Calculation: project/date selection → report recognition and per-type confirmation → historical availability/run → separate Excel. Business/payment confirmation writes A-table data; advertisement confirmation is dry-run.
  - Monthly SKU Analysis: monthly date default → temporary report recognition/confirmation → preview from temporary files → download. All confirmations are dry-run; no historical availability/run and no result table.
- Filters are tab-local and not written to the URL. Project/site/date defaults differ between tabs; preserve them. Switching tabs currently unmounts inactive panels and loses their local pending upload state.
- Product Analysis and Monthly SKU share `frontend/lib/product-analysis-export.ts` and its two-sheet workbook. Manual Calculation has its own workbook; do not converge the formats or workbook columns.
- Tests: `page.test.tsx` tests tabs/default activation but mocks all three panels. `lib/product-analysis-export.test.ts` covers only part of the workbook. There are no component tests for the three panels. Existing browser coverage targets only the Product Analysis tab in `frontend/tests/dashboard/reports-mobile-blf616.spec.ts`.

### Monthly Report Display

- Scope is only `/dashboard/reports/monthly-report/display`. Leave `/generate` and `/reconcile` on their current shell and behavior. The monthly report outer three-route tabs remain separate from the display page's “月度汇总 / 月度明细” tabs.
- URL keys: `project`, `country`, `fromMonth`, `toMonth`, and optional `monthRange=last12m`. New/rolling windows cover the latest 12 months through the previous month; explicit month windows remain fixed. Preserve `force-dynamic` and query-only navigation behavior.
- Data: GET financial series with project, country, fill-missing, and optional month bounds; POST recalculation with the same scope; GET accounting detail and accounting-detail export with the same project, country, and one source-backed report month. Exchange-rate lookup remains separate.
- Financial Analysis export is a browser-built two-sheet workbook (`月度财务总览`, `年度财务总览`) for the selected date range. Accounting Detail is a separate server-built workbook for one selected month with a fixed reconciliation sheet and dynamic source-data sheets. Keep both actions and scopes separate.
- Preserve server-side project authorization, admin-only visible columns, VAT sign/display rules, signed profit and ratio formulas, and internal horizontal table scrolling. Do not alter the shared `useSharedReportProject` behavior because Generate and Reconcile also consume it.
- Tests: `display-client.test.tsx`, `excel-num-fmt.test.ts`, `monthly-report/shared-project.test.tsx`; existing mobile route coverage is in `frontend/tests/dashboard/reports-mobile-blf617.spec.ts`.

## Existing risks outside visual migration

Keep these findings visible for a separate behavior/security decision. Do not change formulas, authorization, export payloads, upload persistence, or update semantics as a side effect of styling:

- Order Info CSV truncates at 5,000 rows without a user-facing truncation notice; FBM edit fields do not prefill or clear some stored values; the Terminal country list is broader than the page's supported country mapping.
- Product Analysis, Manual Calculation, and Monthly SKU may retain prior-scope results or uploaded temporary IDs after a site change; changing tabs unmounts pending upload state; the shared product workbook currently sums some ratio fields in its total row; some upload/project errors are not visibly distinguished; the SKU export includes a stock column that can be absent from the source payload.
- Monthly Report Display initially renders some KPI zeros during loading, can show an API error beside an empty message, and needs a separate permission review of raw columns in the Accounting Detail workbook.

## Implementation handoff

Use `2026-11-04-warm-ledger-c3.md` for the staged tasks, file ownership, tests, browser matrix, and exit criteria. After Task 2, use separate DeepSeek/max implementers for the disjoint Task 3 and Task 4 page scopes, then one independent Luna/max review of the integrated C3 stage after the browser matrix is complete.

## Implementation and verification outcome

Task 5 completed the integration and browser matrix on 2026-11-04:

- The exact C3 route allowlist remains limited to Order Info, Product Analysis, and Monthly Report Display. Other report routes retain `TerminalShell`.
- Desktop shell geometry now fills the `1440×900` acceptance viewport with equal 8px outer gutters; the 1840px width and 960px height caps were removed. At acceptance size the window is `1424×884` with the existing 22px radius and shadow. Shared-shell mobile CSS was not changed.
- The focused shell test passed 14/14 after a confirmed RED assertion against the former caps.
- The self-contained Playwright matrix passed all 3 desktop cases and skipped the 3 mobile-project cases as out of scope. It covered Order Info scope/local filters/pagination/CSV/FBM edit, all Product Analysis tabs and mocked upload/run/export requests, and Monthly Display URL changes/both tabs/both exports/recalculation. The API dispatcher handled every `/api/**` request and reported no unhandled URL or real backend write/export.
- The single full Vitest run completed at 299 files / 2339 tests: 297 files / 2334 tests passed, and the documented 5 failures remained in `inventory-analysis-client.test.tsx` and `portfolio-overview-client.test.tsx`. The same 2 files / 5 tests failed identically on detached `origin/main` at `7e78063d2ff106da12182f6ecb094cf9a24c58e8`.
- `pnpm lint` passed with 0 errors / 15 existing warnings; `pnpm build` and `git diff --check` passed. Build retained its existing workspace-root, Turbopack NFT trace, and stale Browserslist warnings. Browser runs retained existing Radix Select and duplicate upload-card key warnings.
- No independent reviewer was started in this run, per the Task 5 instruction. The behavioral/security findings in “Existing risks outside visual migration” remain open and were not represented as fixed.
