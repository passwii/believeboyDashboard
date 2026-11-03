# Warm Ledger G0 Freeze

> Foundations contract: Damon has confirmed the whole-page Warm Ledger direction and all four G0 decisions. Production uses the new design directly without a feature flag.

## Freeze checklist

- [x] D0 scope: `.warm-ledger` tokens were introduced on `/dashboard` and do not change `--term-*` or global UI defaults.
- [x] Damon confirms the whole-page Warm Ledger direction, keeps `DiagnosticStrip` and project sorting, defaults order groups to collapsed, and ships dark-only first; light theme is deferred.
- [x] Dark token values, typography, spacing, shapes, focus, motion, control sizes, breakpoints, accessibility, and component states are documented in `spec.md` and `tokens.css`.
- [x] `states.html` covers required controls, navigation, order disclosure, data states, long text, and responsive behavior without a component library or business statistics.
- [x] Dashboard-local components and promotion rule are explicit: no component promotion before a second real consumer uses the same contract.
- [x] Pending recommendation is explicit: KPI and OrderFlow headline use the same count/list API family and identical project / seven-day PT filters; expanded list `total` matches the count total. Daily `pending_order_qty` is separately labeled as a daily snapshot and is never summed into Pending.
- [x] Initial date window is seven PT operational days, ending on the latest completed PT operating day returned by the current dashboard contract.
- [x] Navigation: add “运营总览” → `/dashboard`, keep “数据流总览” as a separate entry, and use the four draft QuickLinks.
- [x] Production uses the new design directly. No feature flag and no dual shell/page matrix.
- [x] Project-level Pending distribution is omitted until a complete API-backed total exists; first release shows only the shared global Pending total.
- [x] Exact `/dashboard` shell exception approved. Extract the dashboard data layer before bypassing `TerminalShell` providers.

G0 is complete. Implementation proceeds with direct production use.

## Post-launch visual refinement

On 2026-11-01 Damon approved a detail pass after seeing the production page. It supersedes the initial B0 grayscale and geometry values:

- Raise the neutral surface ramp and hairline/highlight contrast; keep amber as the chart/data accent.
- Expand the desktop work window and reduce the outer/content insets.
- Set the sidebar to 280px and align icon/title columns at 18px.
- Replace the dashboard project filter's native browser menu with a Warm-styled accessible Select; keep its API and project filtering behavior unchanged.

`tokens.css` and `spec.md` contain the revised values. The D0 release remains scoped to `/dashboard`.

On 2026-11-01 Damon approved extending the same unchanged Warm Ledger tokens to these exact C1 routes:

- `/dashboard/operations/daily-analysis`
- `/dashboard/operations/portfolio-overview`
- `/dashboard/operations/inventory-analysis`

This is a route allowlist extension, not a token or global-theme change. The Warm frame is mounted only on `/dashboard` and the three listed C1 routes; every other route keeps `TerminalShell`. Do not alter `--term-*`, shared component defaults, or `sidebar-config.ts`.

On 2026-11-02 Damon approved another post-launch refinement after using the live dashboard:

- Lift and neutralize the graphite ramp; strengthen hairlines and top highlights so the window, sidebar, panels, and raised controls read as separate surfaces.
- Expand the desktop work window maximum to 1840px, reduce the stage inset to 8px and the main content inset to 20px, and allow the dashboard home to use up to 1600px.
- Align sidebar navigation and QuickLinks on a shared 20px icon track with an 8px text gap and consistent 36px rows. Align section labels with the title column.
- Keep the homepage project filter on the Radix-based WarmSelect. During category migration, replace native selects with Warm controls when their existing API and interaction contracts fit; leave unmigrated pages unchanged.

These values supersede the 2026-11-01 refinement where they differ. At this point, the Warm scope remained limited to `/dashboard` and the three C1 routes; do not alter `--term-*`, shared defaults, or `sidebar-config.ts`.

On 2026-11-02 Damon approved extending the unchanged Warm Ledger route frame to these exact C2 routes:

- `/dashboard/operations/inventory-ledger`
- `/dashboard/operations/shipping-plan`
- `/dashboard/operations/shipment-management`
- `/dashboard/operations/sku-info`

This adds only an exact route allowlist and navigation scope. C2 pages provide their own filters through the existing slots; do not add a global-filter bar or change tokens, `--term-*`, shared defaults, or `sidebar-config.ts`. All other dashboard routes continue to use `TerminalShell`.

## Allowed and frozen files

This A0F delivery may add or update only:

- `docs/design-drafts/2026-11-01-operations-dashboard/index.html`
- `docs/design-drafts/2026-11-01-operations-dashboard/design.md`
- `docs/design-drafts/2026-11-01-operations-dashboard/review.md`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/spec.md`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/tokens.css`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/states.html`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/foundations/freeze.md`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/plan.md`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/registry.md`
- `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md`

Read-only for A1–A5:

- All four files under `components/foundations/`; these are the frozen B0 contract.
- `design.md`, `review.md`, `components/plan.md`, `components/registry.md`, and `components/rollout.md`.
- All `frontend/` files, including shared `components/ui/*`, `components/terminal/*`, app shell/layout, page data flow, sidebar configuration, and global theme/tokens.
- Any backend API, schema, or database file.

Do not modify read-only files to make a demo pass. If an interface decision needs a product or API change, record the dependency and return it to Damon or the owning implementation agent.

## Dashboard first-batch boundaries

All Warm Ledger implementations remain under `frontend/components/dashboard-v2/` until the promotion rule is met. Existing shared components can be referenced for behavior, but their default styling is not part of this migration.

| Agent | Owns | Inputs and outputs |
| --- | --- | --- |
| A1 Shell + Warm controls | `WarmLedgerShell`, Dashboard sidebar/topbar, workspace scope, mobile navigation drawer, `WarmControls` wrapper (Button, IconButton, ProjectSelect, FilterControl, SortControl, Badge, Input) | Owns shell, navigation, wrapper and Dashboard token consumption. Provides shared controls for A2–A5; does not own page data or route policy. |
| A2 Metrics | `MetricStrip`, `MetricCard`, `Delta`, `DiagnosticStrip` | Retains the confirmed DiagnosticStrip; receives scoped / aggregated values and loading/error/empty state; consumes A1 controls; does not fetch or redefine formulas. |
| A3 Chart | `SalesTrendPanel`, legend, axis, chart summary/tooltip | Receives current and comparison rows plus PT date labels; provides a nonvisual chart summary; does not own page fetching. |
| A4 Tables | `ProjectRankTable`, `DailyLedgerTable`, numeric/delta cells | Receives typed rows and sort state/callback; keeps columns intact on mobile via container scrolling; daily Pending is labeled “日快照”. |
| A5 Order flow | `OrderFlowCard`, `ProjectOrderGroup`, pending order row, live event row, mobile Sheet | Receives count and paginated list as separate data contracts; defaults groups collapsed; exposes retry/load-more/toggle/navigation callbacks; owns no route, API request, polling, or page-level aggregation. |
| A6 Integration | Shared cross-component props types, dashboard data layer, and page wiring | Owns shared props type definitions and connects A1–A5 contracts to data; owns API orchestration and route integration. |

Shared interface principles:

- A1 owns layout, navigation presentation, responsive drawer, shell landmarks, the Warm controls wrapper, and implementation use of the `--warm-ledger-*` tokens. It does not own page data or route policy. It reads navigation from the existing source; it does not rewrite sidebar configuration.
- A2–A5 are presentational and accept props typed by A6. They may own local sorting, disclosure, and visual state, but not API fetching, dashboard aggregation formulas, or duplicate controls.
- A6 owns shared cross-component props types. Component-specific private props remain local to each owner; do not create parallel shared types in A1–A5.
- A1–A5 consume the frozen token values; they do not edit `components/foundations/tokens.css` or any other foundations file. A token value change returns to an explicit B0 / Damon decision.
- Loading, empty, and error are explicit states on the component boundary. A stale value may remain visible only where its source contract says to retain it; do not imply fresh data while refresh is pending.
- Callbacks cross component boundaries for refresh, retry, sorting, navigation, pagination, and disclosure. A1–A5 do not reach across another agent's file boundary or add cross-agent imports into private implementation details.
- A5 receives `pendingCount` / `countLoading` and `items` / `listLoading` / `listError` / `hasMore` separately. KPI and OrderFlow headline share the same count/list API filters and total. The headline never comes from the currently loaded page length. Expanded list pages do not redefine the total.
- Per-project order-flow counts require a confirmed complete count API per project or a complete unpaginated result. The daily snapshot is not a substitute. Until Damon confirms that contract, omit project count / share values rather than inventing them.
- The parent owns route construction and PT date/project scope. An order row or group receives a callback; it does not import the router or create query parameters itself.
- Mobile Sheet behavior follows the existing focus trap, Escape close, focus restoration, and body/workspace inert contract.

## Pending and date semantics

- Pending means orders returned by the pending-order count/list API for the same selected project scope and seven-day PT date window. KPI and OrderFlow headline use the same filters and total.
- Collapsed OrderFlow may use the lightweight count endpoint. Expanded OrderFlow uses the list endpoint `total`; the count and list filters must match. Count failures must not be silently replaced with daily snapshot values.
- Project group counts need a confirmed complete API-backed per-project total. Do not sum the loaded first page, infer a total from `summary_rows`, or show an unlabeled snapshot as live Pending.
- The daily table's `pending_order_qty` is a per-day snapshot. Label the column “待处理（日快照）” or equivalent wherever the meaning could be mistaken for the live count.
- Seven days is the initial dashboard and daily-ledger window. Use PT operational dates; do not revive a 14-day window to match an older heading. A different window requires a separate data-scope decision.

## Navigation decision

Approved navigation:

1. Add “运营总览” → `/dashboard`.
2. Keep “数据流总览” → `/dashboard/agent-center/overview` as a separate entry.
3. Keep the four QuickLinks: 销售数据、订单信息、库存分析、客户消息.

## Resolved G0 product decisions

1. **Navigation:** “运营总览” and “数据流总览” coexist; QuickLinks approved.
2. **Release control:** direct production use; no feature flag.
3. **Project Pending groups:** omit project-level distribution until a complete API-backed total exists.
4. **Route architecture:** exact `/dashboard` shell branch approved; extract the dashboard data layer first.

## Component promotion rule

These stay Dashboard-local while there is one real consumer, even where the registry lists them as candidates for reuse:

- WarmLedgerShell, DashboardSidebar, DashboardTopbar, WorkspaceScope, MobileNavDrawer, and all Warm-specific Button/IconButton/Select wrappers.
- MetricStrip, MetricCard, Delta presentation, DiagnosticStrip/DiagnosticItem, SalesTrendPanel, chart legend/axis/tooltip, ProjectRankTable, DailyLedgerTable, NumericCell, and DeltaCell.
- OrderFlowCard, ProjectOrderGroup, PendingOrderItem, LiveEventRow, mobile order Sheet, dashboard request/polling orchestration, and the Dashboard's project/date aggregations.
- Page-specific labels, panel notes, separators, and field-formatting choices.

Do not move these to a global `warm-ledger` package or `components/ui/` before a second real page ships with matching visual, state, and interface contracts. A second page merely planned does not qualify. Promotion must name both consumers and remove route/API/business-specific dependencies first.
