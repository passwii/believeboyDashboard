# V4 Warm Ledger Final Closeout Plan

Date: 2026-11-05

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
