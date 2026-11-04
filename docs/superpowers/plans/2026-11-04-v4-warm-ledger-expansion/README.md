# V4 Warm Ledger C5–C7 Expansion Implementation Plan

> **For agentic workers:** Use DeepSeek V4.1 Flash with max reasoning for implementation and an independent Luna/max reviewer per domain. Follow the DAG and do not overlap write scopes.

**Goal:** Migrate C5 Finance, C6 CRM, and the split C7 AI/Tools/System domains to V4 Warm Ledger desktop presentation in one combined delivery wave.

**Architecture:** One integration owner first extends the exact-route Warm frame, titles, breadcrumbs, and sidebar behavior. Each domain then owns its existing local/shared components and page-local CSS. Domain reviewers gate their own area before one final integrated desktop and contract review.

**Scope:** C4 remains deferred. This plan starts only after explicit user approval of the combined batch.

## Global Constraints

- V4 Warm Ledger is current. V3 Terminal is legacy maintenance only.
- Desktop-only acceptance at `1440x900`; do not add new mobile or multi-breakpoint page behavior.
- App window uses equal 8px outer gutters and fills the available desktop viewport.
- Preserve every endpoint, URL key, filter, sort, pagination, write, permission behavior, formula, export column, filename, and public-link contract.
- Keep page/domain-specific UI local until a second real consumer proves a shared contract.
- Do not change `frontend/lib/sidebar-config.ts`, shared Terminal defaults, global UI defaults, or frozen Warm tokens.
- Existing security and behavior findings remain separate follow-ups unless explicitly approved as security fixes.

## Actual Scope

| Domain | User-facing routes | Rendered screens | Notes |
| --- | ---: | ---: | --- |
| C5 Finance | 4 | 8 | VAT has 2 tabs; Commission has 4. `/finance/vat-invoices` is redirect-only. |
| C6 CRM | 10 | 10 | `/crm` and `/crm/workbench` are redirects. Proposal detail needs a dynamic route pattern. |
| C7-AI | 10 | 10 | 8 Warm targets; AI landing and Chat remain the independent Chat exception; Office presentation mode remains an exception. |
| C7-Tools | 5 dashboard routes | 6 rendered URLs | Includes public `/p/[id]`; white document-preview exceptions remain. |
| C7-System | 9 | 9 | 8 Warm targets; digital-display remains forced-dark/full-screen exception. |

**Combined dashboard route templates:** 38. The dependent public page render adds one rendered URL.

## DAG

```text
Wave 0: contract audits (completed)
  C5 / C6 / C7-AI / C7-Tools / C7-System
                    |
Wave 1: shared route integration + domain shared boundaries
  I0 / C5-I / C6-W0 / AI-S0 / Tools-I / System-I
                    |
Wave 2: page implementation (parallel, disjoint)
  C5-A/B / C6-A/B/C/D / AI-A/B/C / Tools-A/B / System-A/B/C
                    |
Wave 3: independent domain reviews (parallel)
  R-C5 / R-C6 / R-AI / R-Tools / R-System
                    |
Wave 4: integrated matrix + final Luna/max review
```

## Shared Integration

**I0 — Cross-domain shell owner**

- Modify only `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame.tsx`, `warm-ledger-sidebar.tsx`, `frontend/lib/dashboard-route-meta.ts`, `frontend/app/dashboard/layout.tsx` if required, route/shell tests, and expansion freeze/rollout docs.
- Add exact static route matching for C5/C6/C7 and explicit dynamic patterns for CRM proposal detail and AI employee detail.
- Add correct group labels: Finance, CRM, AI, Tools, System.
- Keep Chat landing/chat visual exception, presentation mode exception, and digital-display exception outside Warm content migration.
- Consume existing `sidebar-config.ts`; do not create a second navigation source.
- Do not change page business logic.
- [x] Wave 1 shared frame complete: 35 expansion templates added to the exact/dynamic matcher, route titles and breadcrumbs aligned, and all configured items exposed without duplicate links. Route matrix and exceptions: [`2026-11-04-wave-1-shared-frame.md`](./2026-11-04-wave-1-shared-frame.md).

## C5 Finance Team

**Files:**

- C5-I: `frontend/app/dashboard/finance/loading.tsx`, C5 tests/docs.
- C5-A: `frontend/app/dashboard/finance/platform-revenue/**`, `frontend/app/dashboard/finance/exchange-rate/**`.
- C5-B: `frontend/app/dashboard/finance/vat-invoice/**`, `frontend/app/dashboard/finance/commission-management/**`.

**Tasks:**

- [x] C5-A migrates Platform Revenue and Exchange Rate, preserving admin/read behavior, filters, writes, pagination, and XLSX semantics.
- [x] C5-B migrates both VAT tabs and four Commission tabs, preserving invoice issue/void/export, payment/recompute, and financial units.
- [x] C5-I integrates the four exact routes and Warm-compatible finance loading state.
- [ ] R-C5 independently reviews all C5 routes, formulas, permissions, writes, exports, and desktop states using Luna/max.

**Known follow-ups, not visual fixes:** unauthenticated Commission endpoints, unfiltered VAT history scope, mixed-currency export total, exchange single-field filtering, and request duplication.

## C6 CRM Team

**Files:**

- C6-W0: new domain-local Warm CRM kit under `frontend/components/dashboard-v2/warm-ledger/crm/**` and its tests.
- C6-A: CRM dashboard, follow-ups, customers, sea, and shared record drawer files.
- C6-B: leads table/form files.
- C6-C: proposal list/detail components and tests.
- C6-D: tasks plus audit/settings files.
- C6-I: `frontend/app/dashboard/crm/layout.tsx` and CRM integration tests/docs only.

**Tasks:**

- [x] C6-W0 publishes Warm page frame, table frame, toolbar, record-drawer frame, status, and state primitives without changing business APIs.
- [x] C6-A migrates dashboard, follow-ups, customers, sea, and the shared record drawer.
- [x] C6-B migrates leads and conversion flow.
- [x] C6-C migrates proposal list/detail, upload/version/preview/download states.
- [x] C6-D migrates tasks, audit, and settings, preserving admin and board/list behavior.
- [x] R-C6 independently reviews all 10 screens, CRM owner/scope semantics, writes, dynamic proposal detail, and desktop acceptance using Luna/max.

**Known follow-ups, not visual fixes:** owner checks on contacts/follows, sea drawer write exposure, non-admin scope presentation, and misleading 403/empty states.

## C7-AI Team

**Files:**

- AI-S0: `frontend/components/insight/**`, `frontend/lib/insight/**`, shared insight hooks and schedules.
- AI-A: insights, ad-analysis, inventory-health page/domain adapters.
- AI-B: customer-service and believeboy-models.
- AI-C: digital-employees list/detail/office normal mode.
- AI-X: Chat exception guardian for `app/dashboard/ai/page.tsx`, `app/dashboard/ai/chat/**`, and `components/chat/**`; preserve existing visual language.

**Tasks:**

- [x] AI-S0 creates a Warm-compatible shared presentation boundary without unifying legacy, canonical, Chat, or Office transports.
- [x] AI-A migrates Insights, Ad Analysis, and Inventory Health while preserving run/stream/schedule behavior.
- [x] AI-B migrates Customer Service and model reference.
- [x] AI-C migrates Digital Employee list/detail and Office normal mode; presentation mode remains an exception.
- [x] AI-X protects Chat and landing styling/shell refresh behavior; no Warm restyle.
- [x] R-AI independently reviews streams/state, permissions, writes, Chat/Office exceptions, and desktop acceptance using Luna/max.

## C7-Tools Team

**Files:**

- Tools-I: shared tool Warm frame/panel and `frontend/app/dashboard/tools/loading.tsx`.
- Tools-A: `markdown-to-word/**`, `page-render/**`, and coupled `/p/[id]` preview behavior.
- Tools-B: `brand-registration-example/**`, `product-label/**`, `cross-border-compliance/**`.

**Tasks:**

- [x] Tools-I freezes a local Warm tool panel and upload-zone adapter; do not change shared `UploadZone` defaults.
- [x] Tools-A migrates Markdown/Page Render while preserving local/export/public persistence boundaries, iframe sandbox, and white preview exceptions.
- [x] Tools-B migrates brand reference, Product Label, and Compliance while preserving assets, fail-closed PDF rules, sources, disclaimers, and local-only state.
- [x] R-Tools independently reviews all five dashboard screens plus `/p/[id]`, privacy boundaries, downloads, and desktop acceptance using Luna/max.

**Known follow-ups, not visual fixes:** Markdown PDF layout/pagination, public render retention/indexing, EXIF in static assets, and filename/action accessibility.

## C7-System Team

**Files:**

- System-A: account-management, agent-management, alerts.
- System-B: operator-management, project-info, project-context components.
- System-C: logs, changelog, data-management, digital-display exception.

**Tasks:**

- [x] System-A migrates Accounts, Agent credentials, and Alerts while preserving lifecycle, credential, alert-write, and project-access contracts.
- [x] System-B migrates Operator Management and Project Info, preserving financial writes, project ownership, Shop-ID mapping, and context behavior.
- [x] System-C migrates Logs/Changelog/Data Management and protects the forced-dark digital-display exception.
- [x] R-System independently reviews all nine routes, admin/destructive-action risks, data exposure, display exception, and desktop acceptance using Luna/max.

**Known follow-ups, not visual fixes:** system-management authorization gaps, global logs/alerts exposure, destructive cache clearing, last-admin invariants, and stale system route metadata.

## Integration Gate

- [x] All 38 dashboard route templates are classified as Warm target or explicit exception; `/p/[id]` is reviewed as a coupled surface.
- [x] C5/C6/C7 domain tests pass.
- [x] One combined desktop Playwright matrix covers every Warm route at `1440x900`, while exception routes retain their existing behavior.
- [x] Full Vitest has no new failures beyond the reconciled `main` baseline; CI-unblock work is tracked separately.
- [x] `pnpm lint`, `pnpm build`, and `git diff --check` pass.
- [ ] All five domain reviewers pass.
- [ ] Final Luna/max review passes before the expansion batch is marked complete.

Review evidence: [`2026-11-05-expansion-review-audit.md`](./2026-11-05-expansion-review-audit.md).

## Security Track

The audits found existing P0/P1 authorization and data-isolation gaps outside visual migration. Do not silently change permissions as part of styling. Record them for a separately approved backend security plan:

- Commission/VAT finance access scope.
- System-management/account/operator authorization.
- Alert/log project visibility.
- CRM contact/follow/sea write boundaries.
- Page Render public deletion/cache behavior.
