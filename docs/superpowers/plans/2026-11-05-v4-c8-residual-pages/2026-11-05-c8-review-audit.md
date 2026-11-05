# V4 Warm Ledger C8 Residual Pages Review Audit

Date: 2026-11-05

Branch: `feat/v4-c8-residual`

Final code head: `f458441f`

## Scope

C8 migrates the 26 remaining active dashboard routes outside C1-C7 to the desktop-only V4 Warm Ledger presentation:

| Domain | Routes |
| --- | ---: |
| Reports | 10 |
| Operations | 14 |
| Agent Center | 2 |
| **Total** | **26** |

`/dashboard/reports/report-reconciliation` remains a redirect alias to `/dashboard/reports/monthly-report/reconcile`; the desktop matrix verifies the redirect target.

C4 advertising remains deferred. AI Chat, Office presentation, Digital Display, utility/profile pages, and redirect-only routes outside the C8 scope remain excluded as documented in the plan.

## Domain Delivery and Review

### Reports: Monthly and Pricing

- Migrated monthly-report generate/reconcile and pricing-calculation root/new-product/shop-calculation.
- Preserved URL project/country state, quote and save requests, export downloads and filenames, permission gates, and workflow separation.
- Remediation covered page-local Warm header filters, the shared-by-domain shop-calculation table, complete financial values, reduced-motion behavior, real workflow/export assertions, WarmButton busy states, and numeric typography.
- Luna/max domain review passed after remediation.

### Reports: Automation and Scheduled Reports

- Migrated auto-upload and scheduled subscription/ledger routes while preserving upload, subscription, send/resend, bulk action, AI summary, and export contracts.
- Remediation covered light-theme focus visibility, duplicate loading icons, hover priority, selected-row emphasis, mono/sans typography, progress animation, and CSS cascade contracts.
- Luna/max domain review passed after remediation.

### Operations: Monitoring

- Migrated complaint center root/list, platform inspection, and review tracking.
- Remediation covered page-local Warm header controls, dialog/sheet typography and close controls, screenshot upload/delete/submission coverage, and snapshot-safe complaint trend summaries.
- Luna/max domain review passed after remediation.

### Operations: Planning and Analysis

- Migrated inventory replenishment, return analysis, seasonal replenishment, and weekly product analysis.
- Remediation covered loading/error/empty separation, forced cache bypass on retry, categorical chart colors, contrast, numeric typography, and the return-analysis refresh row.
- The desktop matrix caught an invalid `<div>` directly under `<table>` from `RefreshProgressBar as="tbody"`. Return Analysis now uses page-local `tbody > tr > td > div` progress markup with Warm tokens and no shared UI change.
- Return Analysis remediation also covers first-load and Raw Tab lazy-load `aria-busy`/status semantics plus static Warm skeletons. Empty “图表展示区域（可扩展）” placeholders were removed.
- Luna/max domain and final gates passed after remediation.

### Operations: Workflow and Navigation

- Migrated project goals, project launch root/templates, research analysis, site navigation, and store navigation.
- Remediation covered empty-chart height, template typography, route-local chart colors, empty filter placeholders, and attachment filename typography.
- Luna/max domain review passed after remediation.

### Agent Center

- Migrated overview and employee roster with preserved read-only APIs, sorting, status, and links.
- Remediation restored the real 11-column/8-column loading skeleton geometry and numeric/center header alignment.
- Luna/max domain review passed after remediation.

## Verification

- Full Vitest: `364 files / 2619 tests` passed.
- `pnpm lint`: `0 errors / 11 existing warnings`.
- `pnpm build`: passed; Next generated `97/97` static pages and TypeScript completed.
- `pnpm check:mocks`: 364 test files scanned, 0 findings.
- `pnpm check:motion`: hard gate passed, 0 findings.
- `git diff --check`: passed.
- Playwright Chromium desktop matrix: 2 tests passed, including the combined C5-C8 61-route matrix at `1440x900`.
- Matrix assertions cover HTTP commit success, Warm shell/topbar visibility, equal 8px four-sided stage insets, 22px app-window radius, and no page-level horizontal overflow.
- The Office presentation exception bypasses the Warm shell.
- The C8 matrix fixture now provides contract-shaped project, complaint overview, inventory, return, seasonal, project-goal, workflow-summary, and weekly payloads; redirect aliases finish before the next route navigation.

## Follow-Ups

The visual migration does not claim fixes for the existing security/data findings recorded in prior rollout audits, including finance project-scope authorization, Exchange Rate partial-date filtering, System Logs summary state, Project Info partial writes, CRM scope/write boundaries, Tools public retention/PDF/EXIF issues, digital-employee visibility/state issues, or the remaining Security Track.

## Final Gate

- [x] Whole-batch independent Luna/max review passed at `f458441f`.
