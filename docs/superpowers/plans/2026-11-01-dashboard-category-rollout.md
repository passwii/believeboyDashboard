# Dashboard Category Rollout Implementation Plan

> **For agentic workers:** Follow the approved Warm Ledger contract and the task briefs below. Each page task has a disjoint write scope and is reviewed before the next category starts.

**Goal:** Extend the approved Warm Ledger design from `/dashboard` to the first C1 operations pages while preserving each page's real data and interaction contracts.

**Architecture:** Add an exact-route Warm Ledger frame for `/dashboard/operations/daily-analysis`, `/dashboard/operations/portfolio-overview`, and `/dashboard/operations/inventory-analysis`. The frame owns the Warm shell, route title, provider bridge, header slots, mobile filter strip, search, notifications, and refresh. Each page keeps its existing API orchestration and receives page-local layout and styles. Every other dashboard route remains in `TerminalShell`.

**Tech Stack:** Next.js App Router, React, TypeScript, CSS Modules, existing Radix primitives, existing Warm Ledger controls and tokens.

## Global Constraints

- Use `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md` and `tokens.css` as read-only visual inputs; the user-approved scope extension is recorded in `foundations/freeze.md`.
- Apply the `unslop` direction: precise, calm, warm; neutral graphite surfaces; one amber accent; rich detail belongs to real charts or operational states.
- Do not add decorative copy, fake metrics, helper descriptions, badges, or cards. Every visible element must map to existing data, an action, navigation, or accessibility.
- Preserve every current data source, filter value, URL parameter, sort action, tab, drilldown, export, loading/error/empty state, and refresh behavior.
- Preserve each page's country and date semantics. Do not apply the homepage's seven-day PT rule to sales analysis, portfolio, or inventory pages.
- Keep business formulas unchanged where definitions differ; record discrepancies instead of silently choosing a new formula.
- Scope Warm Ledger with `.warm-ledger` and `--warm-ledger-*`. Do not change `TerminalShell`, `--term-*`, shared UI defaults, or `sidebar-config.ts` defaults.
- Only the three exact C1 paths use the Warm route frame. `/dashboard` remains page-owned; all other paths keep `TerminalShell`.
- Use Warm `WarmSelect` or an equivalently styled Radix select for selectors in the Warm shell. Do not leave browser-native, unstyled selectors on migrated routes.
- Page styles stay local. Do not promote a page-local panel, table, or control until a second real consumer has the same interaction contract.
- Luna Agent Team implementers and reviewers use the configured `Luna 工作` profile with GPT-6-Luna and max reasoning. Archive every child agent after integrating its work.
- Do not add or run tests. Validate changed files with ESLint, build, and visual inspection.

## Approved Design Direction

- **Product:** A cross-border commerce operations console for teams comparing sales, portfolio performance, and inventory health.
- **Character:** Precise, calm, warm.
- **World:** A graphite operations ledger, with warm neutrals for long work sessions.
- **Moments:** The real sales trend and inventory-aging distribution carry data color; the rest of the chrome stays quiet.
- **Signature:** A thin amber selection marker for current navigation and the lead data series.
- **Layout:** A full Warm Ledger navigation shell and a fluid work canvas; each page's real filters sit in the topbar or mobile strip, with its primary chart/table getting the largest uninterrupted area.
- **Reduce:** Remove duplicated page titles, filter labels, and decorative card copy when the topbar or data already conveys the context.

## File Structure

- Create `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame.tsx` for route-only provider, slot, search, and notification composition.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-topbar.tsx` only as needed to host route filters and preserve notifications/profile actions.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-sidebar.tsx` to expose the C1 portfolio route while keeping the four approved QuickLinks and leaving `sidebar-config.ts` unchanged.
- Modify `frontend/app/dashboard/layout.tsx` to route the three exact C1 paths through the Warm frame.
- Modify `frontend/components/dashboard-v2/warm-ledger/shell/theme.css` only for route-frame slots and mobile filter mounting, using frozen Warm tokens.
- Modify `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx`; create `frontend/app/dashboard/operations/daily-analysis/daily-analysis-warm.module.css`.
- Modify `frontend/app/dashboard/operations/portfolio-overview/portfolio-overview-client.tsx`, `frontend/components/dashboard/portfolio/portfolio-pie-chart.tsx`, and `frontend/lib/hooks/use-portfolio-data.ts`; create `frontend/app/dashboard/operations/portfolio-overview/portfolio-overview-warm.module.css`.
- Modify `frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx`; create `frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-warm.module.css`.
- Update `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md` with C1 outcomes and unresolved API/business contracts.
- Clarify the user-approved exact-route extension in `components/foundations/freeze.md` and `components/foundations/spec.md`; do not change token values.

## Tasks

### Task 1: Route frame and provider bridge

**Write scope:** `warm-ledger-route-frame.tsx`, `warm-ledger-topbar.tsx` if needed, `warm-ledger-sidebar.tsx`, `frontend/app/dashboard/layout.tsx`, and route-frame selectors in Warm `theme.css`.

- [ ] Compose `TerminalGlobalFilterProvider`, `TerminalHeaderSlotProvider`, `WarmLedgerShell`, route-aware `WarmLedgerTopbar`, `HeaderSlotMount`, `PrimaryFilterSlotMount`, `SecondaryHeaderSlotMount`, `MobileStripMount`, and `SearchCommand`.
- [ ] Use one exact-route title map for the topbar breadcrumb and `document.title`; the portfolio route must be titled “组合分析”, not the generic Dashboard fallback.
- [ ] At the existing `xl` breakpoint, keep the daily-analysis global project, country, and date filters visible with Warm styling and bind them to `TerminalGlobalFilterProvider`, preserving URL/local-storage synchronization. Narrower desktop keeps the page's own fallback filters; mobile keeps the page's filter strip. Portfolio and inventory filters remain page-owned.
- [ ] A project-list error in the global filter includes an actionable retry bound to the existing project refetch function.
- [ ] Keep the Warm topbar's route title, registered/fallback refresh, notifications, profile navigation, and global search. Do not add a theme switch; the approved first release is dark-only.
- [ ] Make the C1 portfolio route reachable through the Warm sidebar, with an active navigation state. Keep the four approved QuickLinks unchanged and do not change `sidebar-config.ts`.
- [ ] Branch on exact pathname membership in the three C1 routes. Keep `/dashboard` page-owned and use `TerminalShell` for every other dashboard route.
- [ ] Add scoped topbar-slot and mobile-strip styling. Do not edit `components/terminal/*`, global `--term-*`, or shared UI defaults.
- [ ] Review route matching, provider order, portal mount/unmount, focus targets, search, notification/profile actions, and refresh behavior.

**Review gate:** a Luna max reviewer confirms the allowlist is exact, providers and global filters are complete, topbar actions work, and non-C1 pages still use TerminalShell.

### Task 2: Portfolio overview

**Write scope:** `frontend/app/dashboard/operations/portfolio-overview/portfolio-overview-client.tsx`, `frontend/app/dashboard/operations/portfolio-overview/portfolio-overview-warm.module.css`, `frontend/components/dashboard/portfolio/portfolio-filters.tsx`, `frontend/components/dashboard/portfolio/portfolio-pie-chart.tsx`, and `frontend/lib/hooks/use-portfolio-data.ts`. If needed, `frontend/components/ui/popover.tsx` and `frontend/components/ui/date-picker.tsx` may gain optional portal-container/content-class props; defaults and existing callers must remain unchanged.

- [ ] Apply Warm hierarchy to actual KPI values, the existing three tabs, charts, project comparison table, and loading/error/empty states.
- [ ] Preserve project/country/date filters, refresh registration, every sort key, project drilldown route parameters, tabs, and existing formula behavior.
- [ ] Format Sessions contribution as a count rather than a percentage. Make explicit refresh bypass the client cache, and mark retained data busy while a new filter request is loading.
- [ ] Keep the KPI and per-project conversion formulas exactly as they are; record the discrepancy and do not infer a replacement.
- [ ] Keep the canvas wide; scroll the table inside its own container on narrow screens.
- [ ] Catch project-list failures and provide an in-context retry; use Warm-styled select/popover surfaces without changing shared UI defaults.
- [ ] Make table sorting operable by keyboard and expose the current sort direction on the relevant header.
- [ ] Keep every filter and retry target at least 44px at widths `<=820px`; ensure date and project popovers inherit the Warm palette, focus ring, and active highlight.

**Review gate:** a Luna max reviewer checks business behavior, formula preservation, chart meaning, sorting, drilldown, accessibility, responsive layout, Warm filter/popover styling, and project-list retry.

### Task 3: Daily analysis

**Write scope:** `frontend/app/dashboard/operations/daily-analysis/daily-analysis-client.tsx` and its page-local CSS module.

- [ ] Recompose the existing date/project/country/SKU controls into desktop header slots and the mobile filter strip.
- [ ] Preserve URL synchronization, global filter binding, marketplace timezone/date behavior, refresh, chart queries, summary/SKU tabs, lazy SKU loading, exports, notifications, and current country choices.
- [ ] Use Warm-styled selectors and date popovers in header, fallback, and mobile controls; keep touch targets at least 44px through 820px.
- [ ] Make sales-request failure visibly distinct from a genuine empty result and offer retry through the existing refresh handler.
- [ ] Give the real sales trend a clear lead; keep both data tables legible with sticky headers and contained horizontal scrolling.

**Review gate:** a Luna max reviewer checks filter/URL parity, export behavior, error/empty distinction, table semantics, contrast, and mobile flow.

### Task 4: Inventory analysis

**Write scope:** `frontend/app/dashboard/operations/inventory-analysis/inventory-analysis-client.tsx` and its page-local CSS module.

- [ ] Apply the Warm treatment to project/country/snapshot selectors, summary values, table, loading/error/empty states, and export action.
- [ ] Preserve snapshot meaning, query parameters, refresh, table order, Excel export, detail totals, and existing supported country behavior.
- [ ] Use Warm-styled selector/date popovers and 44px touch targets at widths `<=820px`; represent unsupported `ALL` scope accurately.
- [ ] Keep SKU and ASIN identity readable with contained table scrolling.
- [ ] Do not invent shipment columns or claim that “全部站点” works. The audit found that the current API rejects `country=ALL` and omits shipment metadata returned by the service; document these pre-existing API gaps and do not fabricate client-side data.

**Review gate:** a Luna max reviewer checks snapshot semantics, export behavior, data fidelity, and responsive table layout.

### Task 5: C1 integration and rollout record

- [ ] Review the three page diffs together for duplicate headers, mismatched control heights, inconsistent icon sizing, and premature component promotion.
- [ ] Run `pnpm lint` and `pnpm build` from `frontend/`.
- [ ] Inspect each route at desktop and mobile widths and compare it with the frozen Warm Ledger contract. Record viewport coverage and observed states.
- [ ] Update `components/rollout.md` with the C1 outcome, confirmed shared contracts, and unresolved API/formula decisions.
- [ ] Run a whole-batch Luna max review for route behavior, business parity, accessibility, design direction, and regressions outside C1.

**Exit gate:** C1 is complete when the three routes use the Warm shell, existing workflows remain available, lint/build pass, visual inspection is recorded, known API gaps are explicit, and the whole-batch review has no open critical or important findings.

## Next Categories

After C1 passes its exit gate, proceed to C2 inventory and fulfillment pages in `components/rollout.md`. Do not start C2 during this batch. Promote only controls whose second real consumer proves the same interaction contract.
