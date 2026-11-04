# V4 Warm Ledger C5-C7 Expansion Review Audit

Date: 2026-11-05

Status: implementation and domain remediation complete; final whole-batch Luna/max gate pending.

## Scope

The combined expansion batch covers 35 Warm dashboard templates:

- C5 Finance: 4 routes / 8 visible views.
- C6 CRM: 10 routes, including proposal detail and the sea entry.
- C7-AI: 8 Warm routes, including digital-employee detail and normal Office mode.
- C7-Tools: 5 dashboard routes plus the coupled public `/p/[id]` surface.
- C7-System: 8 Warm routes.

AI landing/chat, Office presentation mode, white document previews, and Digital Display remain explicit visual exceptions. Redirect-only routes and the public page outside the dashboard shell remain outside the Warm matcher.

## Domain Review Remediation

### C5 Finance

- Reduced the finance parent loading fallback to a Warm-compatible local skeleton.
- Fixed VAT prompt cancellation so a cancelled reason no longer voids an invoice.
- Made the VAT tab controlled by `?tab=history`, including query-only navigation.
- Added distinct retryable error states for VAT history and Commission detail/summary loads.
- Removed the duplicate Commission detail request on country changes.
- Changed VAT CSV export to page through all filtered invoices at `limit=500` / increasing offsets.
- Stopped Platform Revenue Excel export from adding different currencies into one numeric total; multi-currency totals now use a visible currency-labelled string with adjacent cells left blank for overflow.

### C6 CRM

- Kept lead pagination and page-size recovery visible when an outdated page has no rows.
- Replaced the CRM parent Terminal loading fallback with the Warm CRM skeleton.
- Mapped the shared record-drawer Audit timeline surfaces into Warm tokens.
- Narrowed Audit idle selectors to exact class tokens so `hover:bg-term-hover` only applies on hover.

### C7-AI

- Made Office `?mode=presentation` bypass the Warm app frame while normal Office remains Warm.
- Added roving `tabIndex`, ArrowLeft/ArrowRight, Home/End, and stable `aria-controls` panels to Insights tabs.
- Tightened the shared Insight purity guard to reject domain imports under `warm-ledger`, relative imports, and `controls/..` path traversal while continuing to allow shared controls.

### C7-Tools

- Updated the Page Render browser locator to the accessible “页面历史表格” region.
- Mapped shared upload error and upload-in-progress nested content to Warm surfaces without changing shared `UploadZone` defaults.

### C7-System

- No migration regression found in Accounts, Agent credentials, Alerts, Logs, Changelog/Data Management, Operator Management, Project Info/Context, or the Digital Display exception.
- Existing Logs summary-state and Project Info partial-write risks remain separate follow-ups.

## Verification

- Full Vitest: `345 files / 2517 tests` passed.
- Domain regressions: C5 Finance `12 files / 49 tests`; C6 CRM `50 files / 276 tests`; C7-AI `20 files / 113 tests`; C7-Tools `19 files / 145 tests`.
- Desktop Playwright: combined 35-route matrix at `1440x900` passed, including exact `8px` four-sided stage insets, `22px` app-window radius, and no page-level horizontal overflow.
- Office presentation exception Playwright passed and confirmed no Warm app frame.
- Production build passed; Next generated `97/97` static pages. The first attempt exposed a root-layout `useSearchParams` CSR bailout; the final layout isolates search-param reading inside a Suspense boundary.
- `pnpm lint`: `0 errors / 13 existing warnings`.
- `pnpm check:mocks`: 345 test files, 0 findings.
- `pnpm check:motion`: all hard gates passed.
- `git diff --check`: passed.

Known non-blocking output remains: Node `localStorage` experimental warnings, stale Browserslist data, Tailwind ambiguous-duration warnings, and the existing Turbopack NFT trace warning.

## Residual Follow-Ups

These are not represented as fixed by the visual migration:

- **P1:** Commission cross-project reads, payment writes, and recompute lack project authorization.
- **P1:** VAT history default “all shops” can bypass project scope.
- **P2:** Exchange Rate year-only or month-only filtering is ignored by the proxy/backend contract.
- System Logs shares summary state across audit/login views.
- Project Info can partially save project fields before a later Shop-ID write fails.
- CRM owner checks, Sea write boundaries, and non-admin 403/scope presentation remain separate.
- Page Render public deletion/indexing/cache behavior, Markdown PDF layout/pagination, and image EXIF remain separate.
- Digital-employee global visibility, status writes, and stream/state gaps remain separate.
- Remaining authorization, alert/log visibility, destructive cache-clear, and last-admin invariants stay under the security track.
