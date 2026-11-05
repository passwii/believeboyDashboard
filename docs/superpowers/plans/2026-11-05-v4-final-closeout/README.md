# V4 Warm Ledger Final Closeout Plan

Date: 2026-11-05

Status: complete

> Implementation agents use DeepSeek V4.1 Flash with max reasoning. Domain and final reviewers use Luna with max reasoning. Desktop acceptance is `1440x900`; do not add new page-level mobile behavior.

## Goal

Finish every remaining dashboard surface outside V4 Warm Ledger, then remove `TerminalShell` from the dashboard layout so no route can fall back to the legacy shell.

## Scope

### Utility and account

- `/dashboard/profile`
- `/dashboard/change-password`
- `/dashboard/feature-updates`
- `/dashboard/table-showcase`

### Advertising analysis (C4)

- `/dashboard/advertising/ad-analysis`
- `/dashboard/advertising/ad-analysis/overview`
- `/dashboard/advertising/ad-analysis/budget`
- `/dashboard/advertising/ad-analysis/campaigns`
- `/dashboard/advertising/ad-analysis/placements`
- `/dashboard/advertising/ad-analysis/products`
- `/dashboard/advertising/ad-analysis/purchased-products`
- `/dashboard/advertising/ad-analysis/search-terms`
- `/dashboard/advertising/ad-analysis/targets`
- `/dashboard/advertising/ad-analysis/time-trend`
- `/dashboard/advertising/ad-analysis/traffic-quality`

### Advertising data (C4)

- `/dashboard/advertising/ad-data`

### Warm standalone / visual exceptions

- `/dashboard/ai`
- `/dashboard/ai/chat`
- `/dashboard/system/digital-display`
- `/dashboard/ai/digital-employees/office?mode=presentation`

These preserve full-screen behavior but must remove Terminal styling and must not render `TerminalShell`.

## Workstreams

- **Utility:** profile/change-password/feature-updates/table-showcase.
- **Advertising Analysis:** ad-analysis layout, loading, filters, tab navigation, all analysis views and shared ad-analysis components.
- **Advertising Data:** ad-data layout, explorer, filters, upload/sync flows and tests.
- **AI / Fullscreen:** AI landing, Chat, Digital Display and presentation-mode visual cleanup without shared-shell edits.
- **Integration:** register every remaining route, introduce a Warm fullscreen boundary, delete the dashboard `TerminalShell` fallback, expand route/shell tests and the desktop route matrix.

## Contracts

- Preserve API endpoints, URL/filter state, sorting, pagination, permissions, writes, exports, filenames, SSE behavior and destructive confirmations.
- Use Warm controls/tokens and page-local CSS Modules. No production `--term-*`, `term-*`, `rounded-none`, square Terminal panels or mono-by-default body text in migrated surfaces.
- Avoid unnecessary secondary labels and descriptions; the layout should explain the information.
- Tables scroll inside their own containers; the page shell must not overflow horizontally.
- Keep existing safety/security follow-ups separate and do not claim they are fixed.

## Gates

- Independent Luna/max review for each workstream.
- Full Vitest, lint, build, mocks/motion gates and range diff check.
- Desktop Playwright matrix covers every dashboard route, with standalone presentation exceptions checked separately.
- Final whole-batch Luna/max review.

## Completion

- Integration commit `1d51592b` registered the remaining routes and removed `frontend/components/terminal/terminal-shell.tsx` from the dashboard layout. `4fcb013f` added the header-slot provider required by standalone AI/Digital Display routes.
- Domain implementations and remediations are recorded above. Final thresholds, constraints, and API contracts remain unchanged; documented security/data follow-ups remain separate.
- Closeout commits `bf8357ec` and `57872e8c` removed every legacy route-level Terminal skeleton, added the shared static `WarmRouteLoading`, deleted the obsolete `page-skeletons.tsx` / `dashboard-page-loading.tsx` stack, and expanded the Playwright matrix to all page routes.
- The home loading path now renders inside `WarmLedgerShell`, so `/dashboard` keeps the same Warm token scope and floating-window geometry during route transitions. All other paths reuse the layout-owned Warm route frame without nesting another shell.
- `WarmRouteLoading` exposes a `role="status"` / `aria-live="polite"` loading announcement while its visual skeleton is hidden from assistive technology.
- Every dashboard `page.tsx` is covered: 90 Warm framed route entries, 3 Warm standalone routes, `/dashboard` home, and the `office?mode=presentation` exception. Redirect aliases are explicitly followed and asserted.
- Final verification: `374 files / 2631 tests` passed; `pnpm lint` passed with `0 errors / 8 existing warnings`; production build passed with `97/97` pages and Next TypeScript checks; the full desktop matrix passed `4/4` cases across all routes at `1440x900`.
- The production-source scan finds no `TerminalShell` import, fallback, or rendered class. Remaining `term-*` references in older page-local adapter CSS target shared inner widgets and are not an alternate dashboard shell; no route can select the V3 shell.
- Final Luna/max whole-batch gate returned **PASS** at `57872e8c`; both loading-scope findings were closed with no new findings.
