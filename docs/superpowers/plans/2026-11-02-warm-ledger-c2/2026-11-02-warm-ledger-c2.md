# Warm Ledger C2 Implementation Plan

> **For agentic workers:** Execute task by task with `subagent-driven-development`. Use one fresh GPT-6-Luna / max implementer at a time, then a separate GPT-6-Luna / max reviewer before starting the next task. The user has already approved Agent Team rollout and direct use without a feature flag.

**Goal:** Migrate Inventory Ledger, Shipping Plan, Shipment Management, and SKU Info to the approved Warm Ledger shell while keeping each page's real data, filters, operations, permissions, and export behavior intact.

**Architecture:** Extend the exact-route Warm Ledger allowlist and add an “库存与履约” navigation group. Keep page orchestration and business APIs in their existing route directories; style page content with page-local CSS Modules and consume the existing Warm controls, route slots, and mobile filter strip. Do not modify the legacy shell or backend contracts in this UI batch.

**Tech Stack:** Next.js App Router, React, TypeScript, CSS Modules, existing Radix primitives, existing Warm Ledger controls and tokens.

## Global Constraints

- Treat `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md` and `tokens.css` as the visual contract; do not change token values.
- Warm styling applies only to these exact routes: `/dashboard/operations/inventory-ledger`, `/dashboard/operations/shipping-plan`, `/dashboard/operations/shipment-management`, and `/dashboard/operations/sku-info`.
- Keep `/dashboard`, all C1 routes, and every non-C2 route on their current routing behavior. Do not add a feature flag.
- Preserve each page's current API fields, URL keys, request scope, business formulas, date/country semantics, sorting, tabs, page sizes, write effects, confirmation rules, and export payloads.
- Scope all new visual rules to `.warm-ledger` and page-local CSS Modules. Do not edit `TerminalShell`, `--term-*`, shared UI defaults, or `sidebar-config.ts` defaults.
- Reuse existing `WarmSelect`, `WarmButton`, `WarmIconButton`, `WarmBadge`, `WarmSegmentedControl`, route slots, and `MobileFilterStrip`; keep new charts, tables, filter groups, and dialogs page-local until a second real consumer proves the same interaction contract.
- At widths `<=820px`, preserve the Warm compact topbar and 44px touch targets. The desktop route-slot row remains through 768px; `MobileFilterStrip` is used below 768px.
- Do not alter backend authorization, API response, or database contracts in this visual batch. Record existing permission concerns separately; hiding a control is not an authorization fix.
- Do not add or run tests in this batch. Run focused ESLint, `pnpm build`, browser visual/interaction checks, and `git diff --check` after implementation.
- Do not commit, push, deploy, or stage the pre-existing dirty C1 work as part of a C2 page task.

## Page Design Contract

The page-by-page information hierarchy, filter placement, data semantics, and known limitations are recorded in `docs/design-drafts/2026-11-01-operations-dashboard/components/c2-page-contracts.md`. That file is the requirements source for the four page tasks below.

## Tasks

### Task 1: Exact C2 Routes and Navigation

**Files:**

- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame.tsx`.
- Modify `frontend/app/dashboard/layout.tsx`.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-sidebar.tsx`.
- Modify `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/freeze.md` to record the approved exact C2 scope.

Extend the route type and allowlist to exactly the four C2 paths. Rename the C1-only route predicate/type to generic Warm route names because the union now includes C2. Add explicit topbar/document titles: “库存分类账”, “发货规划”, “货件管理”, and “SKU 信息中心”. Keep route matching exact and leave all other dashboard paths on `TerminalShell`.

Add a distinct “库存与履约” sidebar group using the existing `sidebar-config.ts` items and icons for Inventory Ledger, Shipping Plan, Shipment Management, and SKU Info. Preserve the existing primary navigation, portfolio link, four QuickLinks, active-route behavior, mobile drawer close behavior, and role filtering. Do not add duplicate copies of existing links.

The route frame already supplies `TerminalGlobalFilterProvider`, `TerminalHeaderSlotProvider`, action/primary/secondary slots, refresh, notifications, search, and the mobile strip mount. Do not add a new provider or global-filter bar for C2 pages. Pages place their own filters in the slots they need.

**Review gate:** A Luna max reviewer confirms only the intended four routes use the frame, titles match page meaning, all C2 pages are reachable and have active states, existing C1/QuickLink behavior remains, and non-C2 paths still use `TerminalShell`.

### Task 2: Inventory Ledger

**Files:**

- Modify `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-client.tsx`.
- Modify `frontend/app/dashboard/operations/inventory-ledger/ledger-overview.tsx`.
- Modify `frontend/app/dashboard/operations/inventory-ledger/ledger-summary-tab.tsx`.
- Modify `frontend/app/dashboard/operations/inventory-ledger/ledger-detail-tab.tsx`.
- Modify `frontend/app/dashboard/operations/inventory-ledger/ledger-batches-tab.tsx`.
- Modify `frontend/app/dashboard/operations/inventory-ledger/ledger-table-parts.tsx` and `ledger-badges.tsx` where page styles require a local hook.
- Modify `frontend/app/dashboard/operations/inventory-ledger/loading.tsx`.
- Create `frontend/app/dashboard/operations/inventory-ledger/inventory-ledger-warm.module.css`.

Use `usePrimaryFilterSlot` for project/month and `useSecondaryHeaderSlot` for the four derived dimension filters plus clear action. Move the existing filter set to the mobile strip below 768px and keep its summary as project + month + active-filter count. Keep the full-month Excel action in the page-content action row next to the integrity/consistency state; do not put it among filter controls.

Keep this content order: full-month Excel action, integrity/consistency state, eight current inventory KPIs, six-month trend/distribution panels, then Summary, Detail, and Batches tabs. Preserve URL keys `project_id`, `month`, `tab`, `msku`, `fc`, `disp`, and `evt`; preserve router replacement/default-key deletion; keep deep-link dimensions on first mount and clear them only when project or month changes.

Preserve the one-call full-month `month-analysis` request, client-side filtering, 50-row Summary/Detail pages, no server pagination, and the nine-sheet Excel contract. Excel always uses all rows for the selected project/month, independent of the four dimension filters. Keep trend, integrity, consistency, and batches on their current distinct filter scopes. Do not change the “damaged inventory” KPI formula: every disposition except `SELLABLE` contributes.

Add an in-context project/month loading and retry path if those option fetches fail. Keep API errors distinct from a genuine empty month. Retain the current empty-month snapshot behavior unless the source contract is changed separately. Add stale-response protection to the month-options request if implementation confirms the current project-switch race.

**Review gate:** A Luna max reviewer checks URL defaults, filter reset behavior, KPI/filter scope, full-month export, empty-month/API-error states, loading races, slot duplication, 820/767px transitions, 320px table scrolling, and no formula changes.

### Task 3: Shipping Plan

**Files:**

- Modify `frontend/app/dashboard/operations/shipping-plan/shipping-plan-client.tsx`.
- Modify `frontend/app/dashboard/operations/shipping-plan/components/forecast-chart.tsx`.
- Modify `frontend/app/dashboard/operations/shipping-plan/components/shipment-history-chart.tsx`.
- Modify `frontend/app/dashboard/operations/shipping-plan/components/sku-forecast-table.tsx`.
- Modify `frontend/app/dashboard/operations/shipping-plan/loading.tsx`.
- Create `frontend/app/dashboard/operations/shipping-plan/shipping-plan-warm.module.css`.

Put the project and supported site selectors in the primary filter slot. Keep the filter scope to US, DE, or UK; `ALL` remains unsupported. Do not show a date control: the page computes site-local `as_of_date`, uses the 365-day history window, and forecasts the following 180 days.

Make the selected SKU forecast, its real parameters/data-quality state, and the expected-arrival plan/association workflow the main work area. Keep the SKU list next to the forecast as the selection control. Keep history as project/site context after the focused SKU work area; keep four summary metrics compact.

Preserve SKU pagination, history semantics (complete sales coverage vs provisional months and missing ETD counts), forecast formulas, chart series, growth-factor limits, batch create/edit/cancel behavior, allocation/unallocation rules, and audit-producing writes. Cancelled plans remain historical rows and do not delete formal shipments. Use one page-owned refresh path and avoid duplicating the route-frame refresh action.

Verify whether a saved growth factor triggers a fresh forecast. If the current code confirms it does not, repair the page-local request refresh and document the fix; do not alter the forecast formula. Make loading, error, no-SKU, no-batch, no-candidate, and truncated-candidate states distinguishable without inventing data.

**Review gate:** A Luna max reviewer checks country/date semantics, forecast scenarios and formulas, growth-factor refresh, all plan mutations and association balances, active refresh registration, 44px targets, table scrolling, and 320/768–820px layouts.

### Task 4: Shipment Management

**Files:**

- Modify `frontend/app/dashboard/operations/shipment-management/page.tsx`.
- Modify `frontend/app/dashboard/operations/shipment-management/loading.tsx`.
- Create `frontend/app/dashboard/operations/shipment-management/shipment-management-warm.module.css`.

Use the current tab's table as the main canvas; do not add a persistent read-only detail inspector. Keep the four existing tabs, lazy-load behavior, and tab query behavior. Put project/status/country/shipment-number filters in the route filter slots; show shipment date controls only on the Cost tab. Preserve the 20-row page size, shipment-number lazy-load behavior, and table-contained horizontal scrolling.

Preserve create/edit, admin-only deletion and its destructive confirmation, batch CSV import, SKU CSV full-replacement import, cost recalculation writeback, export scopes, FBA template unit rules, FBA carton details, and label ZIP behavior. Cost recalculation is a write, not a preview. Do not silently add/remove confirmations or change import/delete effects. Keep filter/query state local except the existing `tab` and `shipment_no` URL inputs.

Keep errors and busy states visible. Preserve separate errors for list, detail, cost, and FBA requests; an API failure must not look like a valid empty result. Page-local styles may be applied to dialog surfaces but must not change shared Dialog defaults.

Record the source-confirmed project authorization gaps on write endpoints in the C2 security follow-up; do not change backend permissions in this page task.

The authoritative workflow contract is this section plus the Shipment Management entry in `docs/design-drafts/2026-11-01-operations-dashboard/components/c2-page-contracts.md` and the C2 `sdd/task-4-brief.md`. The same-named `sdd/task-4-contract.md` is a stale C1 Inventory Analysis artifact and does not govern C2 Task 4.

**Review gate:** A Luna max reviewer checks all four tabs, lazy-load, exact request parameters, destructive SKU replacement, cost-write behavior, admin delete guard, export scopes, URL state, error/empty distinctions, slot layout, and narrow-screen scrolling.

### Task 5: SKU Info

**Files:**

- Modify `frontend/app/dashboard/operations/sku-info/page.tsx`.
- Modify `frontend/app/dashboard/operations/sku-info/loading.tsx`.
- Create `frontend/app/dashboard/operations/sku-info/sku-info-warm.module.css`.
- Modify `frontend/components/dashboard/sku-info/batch-factory-info-sheet.tsx`, `factory-info-sheet.tsx`, `image-lightbox.tsx`, `image-tab.tsx`, `image-upload-sheet.tsx`, `listing-copy-sheet.tsx`, and `review-group-sheet.tsx` only for page-local Warm surface hooks needed by their portal/dialog UI.

Use project and identifier search in the primary filter slot; use country/status and query/reset actions in the secondary slot. Preserve submit-on-Query/Enter behavior. Do not turn selection changes into automatic queries. Keep the six current data views and their actual columns; retain table row identity by record ID and the current sort order.

Preserve line editing/deletion, import modes, current result count and page-size behavior, factory-info parsing/batch save, listing-copy updates, admin-only review groups and their same-project/same-country constraints, first-leg sync, per-tab exports, FNSKU PDF upload/verification, and batch ZIP downloads. Respect explicit admin-only gates; do not invent permission affordances or claim backend project scope that is not implemented.

Keep existing query-vs-loaded-result semantics during visual migration. Do not silently add pagination, change the submit model, clear selected rows, alter imported sample rows, repair response headers, or change R2 replacement order in this page task; record those as separate technical follow-ups.

**Security note:** The current legacy API lets a project-name query bypass `managed_project_ids`, and record-ID write/delete routes are protected by the shared API key without explicit project-scope checks. The UI migration must not present hidden buttons as a permission fix. Keep this finding in rollout documentation and request a separate backend authorization decision before claiming the legacy SKU flow is project-isolated.

**Review gate:** A Luna max reviewer checks query submission, current-vs-loaded values, row IDs/order, every tab and write path, admin review-group constraints, import/export/label behavior, project-scope caveat, dialogs, focus, mobile strip, and horizontal table scrolling.

### Task 6: C2 Integration and Record

- Run focused ESLint on all changed TS/TSX page and shell files.
- Run `pnpm build` from `frontend/` and `git diff --check`.
- Before Task 6 test verification, update `frontend/app/dashboard/operations/shipping-plan/shipping-plan-client.test.tsx`: its `terminal-header-slot` mock lacks the Warm route-slot hooks, it does not mock the managed-project list, and its old shadcn Select, title, and removed-description assertions target the previous page. Replace them with current Warm filter/SKU controls and page content assertions while preserving the existing API payload assertions. Per-page implementation and R1 work have not run tests.
- Inspect all four exact routes at 1440, 1024, 820, 767, 390, and 320px. Cover each page's real loading/error/empty state, tab switching, filter submit, one representative write confirmation, exports, and contained table scrolling.
- Update `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md` with C2 route scope, page outcomes, actual viewport behavior, component reuse evidence, and the open SKU/shipment authorization concerns.
- Run one final Luna max review of C2 integration and the four page diffs. Archive every implementer/reviewer after integrating its task.

**Exit gate:** All four routes use the Warm shell with correct sidebar active states; each page preserves its existing workflow and API semantics; focused ESLint/build/browser checks pass; all four per-page reviews and the final C2 review have no unresolved visual or behavior findings. Backend security follow-ups remain explicitly listed and are not represented as fixed by this UI batch.

## Coordinator checkpoint (2026-11-03)

- C2 Task 3 Shipping Plan passed its fifth-round independent Luna max R1 with no findings. The test fixture and viewport/interaction checks remain assigned to Task 6.
- C2 Task 4 Shipment Management is assigned to Luna max/max implementer `310fdc81-64f0-461e-8866-4263c387557d`. It owns the route page/loading/CSS and the authorized security follow-up/report only. No tests/build/browser checks run in this page phase; a separate Luna max R1 follows implementation.
- The follow-up independent Luna max R1 (`d573ced0-49b0-4fe9-9aad-5c2006df89c3`) returned eight actionable findings: shipment-number retry/listbox semantics, swallowed batch-history errors, batch picker Warm/touch styling, narrow retry height, focus offsets, CSV import control styling, table tabular numerals, and one missing Unslop source citation. All were confirmed against current source. Fixer `15714087-4c5c-4387-b9c5-22cf673b2dae` addressed these within route-local styles and the single-consumer shipment-batch helper; generic UI defaults and backend permissions remain unchanged. Target ESLint, `git diff --check`, the untracked CSS/report whitespace check, and CodeGraph sync passed. Fresh independent Luna max R1 `6d557b59-b33a-4642-852b-10fc143f8543` is now reviewing; Task 4 remains gated.
- That fresh R1 found four further gaps: inherited focus glow/rings still layer with Warm outlines; the CSV label/input trigger is neither keyboard reachable nor truly disabled while importing; batch hide is pointer-only in the conditional Combobox option; and dialog tables miss tabular numerals. These are confirmed against source. Luna max/max fixer `4842c624-5e38-46df-91e7-e3a69b6cc86b` is addressing them with route-scoped styles, a semantic import button/in-flight guard, and conditional `onHide` keyboard support; Task 4 remains gated on another independent R1.
- Fixer `4842c624-5e38-46df-91e7-e3a69b6cc86b` completed those four items. Fresh focused ESLint, `git diff --check`, CSS/report whitespace scan, and CodeGraph sync passed. New independent Luna max R1 `4bf12ba8-bf34-4fc2-887e-ecd1bcf71a64` is reviewing the current source; Task 4 remains gated.
- That R1 found a P1 portal-scope issue: body-portaled Dialog/Popover controls cannot inherit `.warm-ledger` tokens, invalidating route focus, touch, and dialog table styles; it also found the report omitted the Combobox source from its changed-file inventory. Luna max/max fixer `42fca86a-4358-4af5-884a-558c2032be41` is routing page-owned surfaces to the existing `#warm-ledger-portal-root` and adding a default-preserving optional portal container to DialogContent; Task 4 remains gated on a fresh R1.
- Fixer `42fca86a-4358-4af5-884a-558c2032be41` completed portal scoping for the route dialogs, shipment-number and batch popovers, Cost date range, and edit-form date pickers. Optional portal props retain body-portal defaults for other callers. The report inventory now includes `combobox.tsx` and `dialog.tsx`. Fresh focused ESLint, `git diff --check`, and CodeGraph sync passed. Independent Luna max R1 `6706776b-0f14-43f9-99b7-2d4d24e676fb` is reviewing; Task 4 remains gated.
- That R1 found additional portal/accessibility issues: popovers need to restore pointer events under the inert portal root; FBA ImageLightbox was still body-portaled; conditional batch-hide buttons remained inside the listbox and missed 44px touch sizing; date calendar day targets and focus rings need final local overrides; report should distinguish reused pre-existing DatePicker/Popover portal props from Task 4 changes. Luna max/max fixer `19811ba5-ef56-4d6b-a8df-af5d05bcf012` completed the page-local fixes: route popovers restore pointer input, all five date pickers use the existing Warm portal class, the FBA lightbox uses the Warm root, and batch-hide buttons sit outside the listbox with narrow touch sizing. Focused ESLint, `git diff --check`, whitespace scan, and CodeGraph sync passed. Fresh independent Luna max R1 `a7aaebae-0778-46b6-8cf4-376be09f1962` is reviewing; Task 4 remains gated.
- The latest Luna max source review (`a7aaebae-0778-46b6-8cf4-376be09f1962`) found two remaining issues: SKU CSV replacement uses a non-keyboard label and lacks a synchronous in-flight guard; selected calendar days can be recolored by the generic hover selector. Both were confirmed. Luna max/max fixer `f38b65d7-9082-4983-9c40-ca2454c6017b` is addressing them on the authorized shared worktree; Task 4 remains gated pending a new R1.
- Fixer `f38b65d7-9082-4983-9c40-ca2454c6017b` completed both fixes: SKU replacement uses a semantic keyboard-trigger button, disabled labeled input, and synchronous request guard; date hover excludes selected/disabled buttons. Fresh focused ESLint, `git diff --check`, CSS/report whitespace scan, and CodeGraph sync passed. Fixer archived. Independent Luna max R1 `802a2718-1cb0-439a-9d49-ea7a9860cb5f` is reviewing current source; Task 4 remains gated.
- The latest Luna max R1 (`802a2718-1cb0-439a-9d49-ea7a9860cb5f`) found selected calendar hover still targets the wrong element, 40px filter search inputs, undersized FBA lightbox close control, controlled dialogs without opener focus restoration, and pointer-only FBA zoom. Coordinator also confirmed the shipment-batch clear affordance remains a nested nonkeyboard `span role=button`; this is included. Luna max/max fixer `8a720160-700c-49c6-bf5e-d857f8bd4367` is addressing route-scoped UI/a11y follow-ups; Task 4 remains gated on a fresh independent R1.
- Luna max/max accessibility fixer `8a720160-700c-49c6-bf5e-d857f8bd4367` completed the follow-up: date-cell hover preserves selected/range colors; search and close targets reach 44px at touch widths; controlled dialogs restore focus; the lightbox zoom and batch clear actions are keyboard-operable. The existing SKU count now opens the read-only detail dialog and returns focus after close. Final independent Luna max source review `3dc7727e-e895-4041-8f68-c1b41b664d05` returned PASS with no residual findings. Focused ESLint, `git diff --check`, whitespace checks, and CodeGraph sync passed. Task 4 source-review gate is closed; Task 6 visual/interaction evidence remains. Task 5 SKU Info may begin.
- C2 Task 5 SKU Info is assigned to Luna max/max implementer `ce65c9e0-34bb-4a3f-bb39-e7e4e05ca064`. It owns the SKU route, local loading/CSS, and the listed route dialog/sheet portal hooks only. Preserve Task 4 ImageLightbox portal/focus/keyboard changes already present. No per-page tests/build/browser; focused ESLint and diff/whitespace checks only, followed by a separate Luna max R1.
- Luna max/max accessibility fixer `8a720160-700c-49c6-bf5e-d857f8bd4367` completed the follow-up: date-cell hover preserves selected/range colors; search and close targets reach 44px at touch widths; controlled dialogs restore focus; the lightbox zoom and batch clear actions are keyboard-operable. The existing SKU count now opens the read-only detail dialog and returns focus after close. Final independent Luna max source review `3dc7727e-e895-4041-8f68-c1b41b664d05` returned PASS with no residual findings. Focused ESLint, `git diff --check`, whitespace checks, and CodeGraph sync passed. Task 4 source-review gate is closed; Task 6 visual/interaction evidence remains. Task 5 SKU Info may begin.

## Coordinator checkpoint — C2 integration close (2026-11-03)

- **Status:** Tasks 1–5 passed their independent Luna max page reviews. Task 6 focused verification and the final independent Luna max integration review both passed; the C2 closeout gate is closed.
- **Regression fixes:** Shipping Plan now refetches the selected scoped forecast after growth-factor saves. Shipment Management now ignores stale list-request success, error, and finally results after a newer filter request. Both fixes have targeted regression coverage.
- **Validation:** Focused Vitest — 27 files / 199 tests passed with `--maxWorkers=4`; changed-file ESLint, mock-stability check (295 test files, 0 hits), `pnpm.cmd build`, `git diff --check`, and CodeGraph status passed. The build emitted Next.js workspace-root/NFT and stale Browserslist warnings but exited successfully.
- **Browser matrix:** The self-contained Playwright suite passed 78/78 across Chromium and mobile projects for the four exact C2 routes at 1440, 1024, 820, 767, 390, and 320px. It confirmed no page-level horizontal overflow, contained table scrolling, mobile filter behavior, and 44px touch targets. Browser flows covered Inventory dimension filtering, full-month Excel export, month-options retry, and read-only batch history; Shipping Plan growth-factor PUT with exactly one scoped forecast refresh; Shipment Management cost-calculation POST, Cost workbook export, create-dialog Escape/focus return; SKU explicit query, export, record-ID PATCH, FactoryInfoSheet, and FBA ImageLightbox focus return. All backend traffic was intercepted; no request reached a real backend. Inventory Ledger Batches is a read-only history view with no file input/upload handler on this route.
- **Open product/security follow-up:** SKU Info project-name search and record-ID writes/deletes, plus Shipment Management write-route project scoping, remain unresolved backend authorization findings. Keep them explicit; do not treat page UI as an authorization fix. The 10,000-row SKU behavior, label ZIP response headers, and R2 replacement failure window remain separate technical follow-ups.
- **Next stage:** C3 orders and reports. This C2 closeout stops at Task 6; it does not include C3 audits or implementation. Start C3 only in a separate kickoff after its table/export contracts are frozen.
- C2 changes are on `feat/warm-ledger-c2-closeout` from `435c9cc7`; [PR #798](https://github.com/passwii/believeboyDashboard/pull/798) is open. The pre-existing untracked `gui/` is excluded and preserved; this C2 diff has no backend changes and has not been manually deployed.
