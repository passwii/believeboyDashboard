# Warm Ledger Foundations Contract

> B0 design contract with user-approved post-launch refinements for `/dashboard` and the C1 route allowlist. The current values below supersede the initial B0 surface ramp while keeping the route boundary, amber accent, and component promotion rules.

## Scope and source of truth

- Warm Ledger is a dark, route-scoped visual system for the BelieveBoy operations dashboard. Its character is warm, operational, and exact; real operating data carries the visual emphasis.
- The app root uses `.warm-ledger`. All tokens use the `--warm-ledger-*` namespace. Do not change, alias, or override `--term-*`, global shadcn tokens, or the V3 Terminal defaults.
- Light theme is outside B0. Do not infer a light palette from the dark values.
- The user's 2026-11-02 post-launch refinement supersedes the earlier surface ramp below: it lifts the warm graphite surfaces, makes hairlines and highlights clearer, expands the desktop canvas, and aligns the sidebar on a 20px icon column. `tokens.css` is the source for current values.
- The dashboard draft demonstrates values and layout. Its sample business numbers, timestamps, order IDs, and percentages are not product data and must not be carried into production or this state gallery.

## Color

| Token role | Value | Use |
| --- | --- | --- |
| Stage | `#1c1d1d` | Outside the centered desktop work window |
| Window | `#242525` | Dashboard work surface |
| Sidebar | `#202120` | Navigation surface |
| Panel | `#2b2c2b` | Metric and content surfaces |
| Panel strong | `#333433` | Local panel emphasis where hierarchy requires it |
| Raised | `#3b3c3b` | Selected and raised controls |
| Raised hover | `#454644` | Interactive hover surface |
| Hairline | `rgba(246, 238, 226, 0.12)` | Quiet 1px separators and panel outlines |
| Strong hairline | `rgba(246, 238, 226, 0.20)` | Window edge and important control outline |
| Text | `#f1ede5` | Primary text |
| Soft text | `#c2bbaf` | Secondary text |
| Muted text | `#a9a297` | Labels and supporting copy; retain at least 4.5:1 contrast for text |
| Faint | `#837d74` | Non-text chart grid and decorative separators only |
| Accent | `#e8b35a` | Current-week series, Pending emphasis, selected marker |
| Accent strong | `#f3c875` | Focus ring and small key numeric accents |
| Accent soft | `rgba(232, 179, 90, 0.12)` | Selected surface tint |
| Accent area | `rgba(232, 179, 90, 0.10)` | Current-series chart area |
| Positive | `#65cfa1` | Positive comparison only |
| Negative | `#ee8580` | Negative comparison or error only |
| Chart grid | `rgba(246, 238, 226, 0.09)` | Chart grid lines |

Color rules:

- Amber is the only general data accent. Do not add decorative blue, purple, rainbow series, glow, or gradient text.
- Positive and negative colors always accompany a signed value, arrow, or explicit status. Color alone never carries meaning.
- Do not use Faint for readable labels, disabled text, or essential boundaries.
- Surfaces are warm graphite steps. Avoid adding extra near-black layers without a hierarchy or interaction reason.

## Typography

| Role | Size / line height | Weight | Font |
| --- | --- | --- | --- |
| Page title | `44px / 1.0` at `>=1241px`; `38px / 1.0` at `821–1240px`; `40px / 1.0` at `<=820px`; `36px / 1.05` at `<=460px` | 400 | Interface sans |
| Primary metric | `50px / 1.0` | 400 | DM Mono |
| Secondary metric | `34px / 1.0` | 400 | DM Mono |
| Section heading | `16px / 1.4` | 500 | Interface sans |
| Body | `14px / 1.5` | 400–500 | Interface sans |
| Controls and table body | `12–14px / 1.4` | 400–500 | Interface sans; mono for values |
| Auxiliary labels / chart axis | `11–12px / 1.4` | 400–500 | Interface sans or DM Mono |

- Interface stack: `Instrument Sans`, `PingFang SC`, `Microsoft YaHei`, `Noto Sans SC`, then `sans-serif`.
- Numeric stack: `DM Mono`, `SFMono-Regular`, `PingFang SC`, then `monospace`; apply `font-variant-numeric: tabular-nums` to money, dates, counts, percentages, and IDs.
- Keep the body copy floor at 11px. Avoid weights 700–900. Page titles use zero letter spacing at 44px, 40px, 38px, and 36px; do not apply negative letter spacing at any responsive title size.
- Keep unit and comparison labels legible beside values; do not shrink them to make a metric fit.

## Spacing and shape

- Base spacing unit is 4px. Use 4px increments for component internals and group gaps.
- Desktop stage inset: 8px. Main content inset: 20px. Panel inset: 20px. At narrow widths, page inset becomes 16px and then 12px at `<=460px`.
- Desktop work window maximum width: 1840px. The dashboard home can use up to 1600px of its available workspace. The full sidebar remains 280px.
- Related control/icon gaps: 8px. Sidebar icon/title columns use a shared 20px icon track and the same 8px gap; section labels align with title text. Dense item gaps: 8–12px. Between sections: 16–24px. Dashboard metric cards: 12px gap.
- Window radius: 22px. Panel radius: 16px. Primary control radius: 10px. Nested rows, nav items, and order groups: 8px maximum. Mobile app window: square edges, no desktop shadow.
- Borders are 1px. The active navigation rail is 2px amber. Avoid thick colored outlines.

## Surface highlight and elevation

- The desktop work window uses a restrained exterior shadow and a top inset highlight of `rgba(255, 255, 255, 0.07)`.
- Controls use a 1px warm hairline and a 1px top inset highlight at rest (`rgba(255, 255, 255, 0.08)`). Hover may raise that highlight to `0.14` while shifting the surface to Raised hover.
- Pressed controls use a subtle dark inset (`rgba(0, 0, 0, 0.28)`) and translate down by 1px. No colored outer glow or broad colored shadow.
- Panels do not receive hover treatment unless the whole panel is an actionable target.

## Focus and keyboard

- Every interactive control has a persistent `:focus-visible` ring: 2px solid Accent strong, 3px offset. Do not remove the outline without an equivalent visible indicator.
- Focus is distinct from hover and selected state. It must remain visible on Raised surfaces and in the mobile drawer.
- Native button, link, select, and disclosure semantics are preferred. A custom sort control uses `aria-pressed`; current navigation uses `aria-current="page"`; order groups expose `aria-expanded`.
- The mobile navigation drawer traps Tab while open, closes on Escape and scrim activation, marks the obscured workspace inert, and restores focus to its opener. Crossing to desktop while open moves focus to a visible workspace target. Crossing from desktop to mobile while focus is inside the sidebar moves focus to the visible menu button before the sidebar becomes inert; focus elsewhere is left in place.

## Motion

- Initial app window only: 520ms fade and 10px upward travel with `cubic-bezier(0.22, 1, 0.36, 1)`. Do not add a second staggered page-content entrance.
- Hover surface/color and border changes: 140ms. Press feedback: 100ms with a 1px downward translation. Disclosure and drawer motion may use 180–240ms with the same decelerating curve.
- Do not use pulse, floating, scale-up, glow, bounce, or `transition: all`. Skeletons are static shapes; loading is communicated by explicit status copy and `aria-busy`.
- Under `prefers-reduced-motion: reduce`, remove nonessential animation and transition, and keep scrolling immediate.

## Control dimensions

| Control | Desktop | Touch layout |
| --- | --- | --- |
| Standard button | 36–38px high | Minimum 44px target |
| Compact button / sort segment | 34px high | Minimum 44px target |
| IconButton | 36px square | Minimum 44px square target |
| Project Select | 40px high | Minimum 44px high |
| Navigation item | 36px minimum | 44px minimum |
| QuickLink | 40px minimum in compact rail | 48px minimum in drawer |
| Order group summary | 32px minimum | 44px minimum |

Expand hit areas on touch layouts without shrinking visible labels or focus rings. Icon-only controls require a programmatic accessible name.

## Responsive contract

| Viewport | Layout contract |
| --- | --- |
| `>=1241px` | 280px full sidebar; three metric columns; chart and order flow side by side; project rank and daily ledger side by side. |
| `1051–1240px` | 88px icon rail; featured metric takes a full row; chart and narrower order flow remain side by side. |
| `821–1050px` | 88px icon rail; two metric columns with featured metric spanning both; chart/order flow and rank/daily ledger stack; diagnostics use two columns. |
| `<=820px` | Full-width work surface; no outer radius or shadow; full navigation moves to a left drawer; sticky topbar retains menu, project filter, and notification; content stacks in reading order; tables may scroll horizontally. |
| `<=460px` | One metric column; 36px page title; hide secondary topbar actions while keeping essential navigation, project scope, and notifications; allow metric footnotes to wrap. |

- The `<=1050px` layout stacks chart/order flow and rank/daily ledger. No page-level horizontal overflow at 1440, 1280, 1240, 1051, 1050, 1024, 821, 820, 460, 390, and 320px widths.
- Preserve table column meaning; scroll a table container horizontally instead of compressing or hiding required columns.
- Long project labels wrap in full navigation and drawer. In constrained single-line controls, truncate visually only when the full accessible name remains available. Never silently truncate order IDs or SKUs.
- At `<=820px`, IconButton, ProjectSelect, SortControl, NavItem, and OrderGroup summary targets are at least 44px high / wide as applicable.

## Accessibility and state contract

### Button and IconButton

- States: default, hover, focus-visible, pressed, disabled, and loading. Loading Button examples expose `aria-busy` and a clear accessible name.
- Disabled controls use the native `disabled` attribute where possible, do not react to hover/press, and retain enough text contrast to identify the control.
- Loading uses `aria-busy="true"`, a clear accessible name such as “正在刷新当前页数据”, and a polite status update on completion. Do not replace the whole dashboard with a spinner.

### Select

- Give the project filter a visible or programmatic label. Preserve keyboard operation and the native selected value. Long names may clip visually but must remain available to assistive technology.
- A project-list error stays in the control context, exposes `aria-invalid` / described error copy, and offers retry; it must not look like a valid project option.

### SortControl

- Use a named group with one selected sort option. Expose selection with `aria-pressed` or equivalent, and show a visible selected surface/indicator in addition to text color.
- Sorting applies only to the displayed project ranking and does not imply a data filter.

### NavItem and QuickLink

- Render real routes from the existing sidebar configuration. Current page uses `aria-current="page"`, a 2px amber rail, and a Raised surface. Inactive route rows do not show hover unless interactive.
- QuickLinks are anchors to real product destinations. Do not render a link without a route or a button without an action.

### OrderGroup

- Disclosure summary is keyboard operable and exposes `aria-expanded`. Hover feedback applies only to the disclosure/action target, not to passive order rows.
- Keep project label, count, and chevron aligned when the label wraps. Keep all order details readable at narrow widths; long IDs/SKUs may wrap at safe break points.
- Demonstrate a valid count of `0`, list loading, list empty, and list error as distinct states. A list retry retains the current scope. A zero count is a valid value; do not replace it with an empty placeholder.
- Long Order IDs and SKUs wrap at safe break points; never ellipsize or force page-level horizontal overflow.

### Loading, Empty, and Error

- Loading preserves the eventual content geometry using static skeletons and a status label. For the order flow, preserve the count slot while loading.
- Empty content has domain-specific copy and only real next actions. Main sales empty state may offer “切换到上周” and “刷新”; project ranking has no fake rows or bars; order flow says “当前没有待处理订单”.
- Errors name the failed data area and offer retry when a retry action exists. Keep filters and unaffected content available. Country breakdown may degrade without covering the main sales metrics, as specified by the existing design.
- Use `role="status"` for nonurgent progress and completion, `role="alert"` for actionable failures, and avoid duplicate live announcements.

### General

- Body text contrast is at least 4.5:1 against its surface; large text may use WCAG 3:1. Check each token pairing used in production.
- Provide a text summary for charts. Keep PT operational-day scope visible wherever dates are interpreted.
- Do not rely on color alone for trends or selected states. Respect reduced motion and preserve keyboard access at all breakpoints.

## Component ownership

- B0 introduced its tokens and visual rules on `/dashboard` through `.warm-ledger`. The user-approved C1 extension reuses the unchanged values on the exact routes recorded in `foundations/freeze.md`; do not extend these tokens globally.
- The four `components/foundations/` files are frozen B0 inputs and read-only for A1–A5.
- A1 owns the Warm controls wrapper and token consumption in the Dashboard implementation: Button, IconButton, ProjectSelect, FilterControl, SortControl, Badge, and Input. A2–A5 consume A1's controls and do not implement parallel versions.
- A1 owns the implementation use of `--warm-ledger-*` tokens; token values in the frozen B0 files change only through an explicit B0/Damon decision.
- A6 owns shared cross-component props types and their data integration. A1–A5 consume those shared types and keep private implementation details local.
- Warm-specific Shell, NavItem, QuickLink, metric, chart, table, and panel styles remain in the Dashboard implementation area while `/dashboard` is the only consumer.
- `OrderFlowCard`, `ProjectOrderGroup`, pending-order rows, live-event rows, `DailyLedgerTable`, dashboard data orchestration, and `computeStats()` / `computeTopProjects()` semantics are Dashboard-local business components.
- Existing shared UI primitives may inform behavior, but do not edit their defaults to make them adopt Warm Ledger. In particular, keep the existing global Button, Select, Table, Terminal shell, and `--term-*` contracts unchanged.
- Promotion requires a second real consumer, matching visual/state/API contracts, removal of route and business dependencies, and named callers in the promotion change. A planned page is not a consumer.

## Pending and PT date scope

- Pending KPI and OrderFlow headline use the same pending count/list API family with the same selected project scope and the same seven PT operational dates. The count endpoint total is the collapsed headline; the expanded list response `total` must represent that same filtered total.
- Daily `summary_rows[].pending_order_qty` is a per-day snapshot only. Label the daily column “待处理（日快照）”; never sum it into the KPI, use it as a fallback, or describe its seven rows as a Pending total.
- Complete per-project Pending totals require a separate confirmed API contract. Until Damon confirms it, do not infer project group counts or shares from daily snapshots or partial list pages.
