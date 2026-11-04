# V4 Warm Ledger C8 Residual Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`. Use DeepSeek V4.1 Flash with max reasoning for implementation and independent Luna/max reviewers for domain and final gates. Follow the write scopes and do not overlap files.

**Goal:** Migrate the 26 active residual dashboard pages outside C1-C7 to the V4 Warm Ledger desktop presentation.

**Architecture:** One integration owner registers all 26 routes in the Warm route registry and desktop matrix first. Six disjoint implementation agents then migrate Reports, Operations, and Agent Center page-local surfaces in parallel. Reviews gate each domain before one final integrated desktop and whole-batch review.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript, CSS Modules, Vitest, Playwright.

## Global Constraints

- V4 Warm Ledger is authoritative. V3 Terminal is legacy maintenance only.
- Desktop-only acceptance at `1440x900`; do not add new page-level mobile behavior or breakpoints.
- App window keeps equal 8px outer gutters, a 22px radius, and fills the available desktop viewport.
- Preserve every API endpoint, URL key, filter, sort, pagination, write, role/permission, formula, export column, filename, public-link, and destructive-confirmation behavior.
- Do not change `frontend/components/ui/**`, `frontend/components/terminal/**`, global CSS defaults, `frontend/lib/sidebar-config.ts`, or frozen Warm tokens unless a reviewer explicitly approves a shared-contract change.
- Keep styles page-local and use Warm controls/tokens. Do not leave `--term-*`, `term-*`, `rounded-none`, square Terminal panels, or mono-by-default form typography in migrated production surfaces.
- Every visible element must map to a real field, state, navigation action, or accessibility requirement. Do not add secondary labels/descriptions or decorative stats.
- Wide tables must scroll inside their own container; the page shell must not overflow horizontally.
- Existing security/data findings remain separate; no migration task may claim they are fixed.

## Scope

| Domain | Routes |
| --- | ---: |
| C8-R Reports | 10 |
| C8-O Operations | 14 |
| C8-A Agent Center | 2 |
| **Total** | **26** |

## Task 1: Shared Warm Route Integration

**Files:**

- Modify: `frontend/lib/dashboard-route-meta.ts`
- Modify: `frontend/app/dashboard/layout.test.tsx`
- Modify: `frontend/components/dashboard-v2/warm-ledger/shell/warm-ledger-shell.test.tsx`
- Modify: `frontend/tests/dashboard/warm-ledger-expansion-desktop.spec.ts` or add a C8 matrix spec
- Modify: `docs/design-drafts/2026-11-01-operations-dashboard/components/rollout.md`

**Routes to register exactly:**

- Reports: `/dashboard/reports/auto-upload`, `/dashboard/reports/monthly-report/generate`, `/dashboard/reports/monthly-report/reconcile`, `/dashboard/reports/pricing-calculation`, `/dashboard/reports/pricing-calculation/new-product`, `/dashboard/reports/pricing-calculation/shop-calculation`, `/dashboard/reports/report-reconciliation`, `/dashboard/reports/scheduled-reports`, `/dashboard/reports/scheduled-reports/ledger`, `/dashboard/reports/scheduled-reports/subscriptions`
- Operations: `/dashboard/operations/complaint-center`, `/dashboard/operations/complaint-center/list`, `/dashboard/operations/inventory-replenishment`, `/dashboard/operations/platform-inspection`, `/dashboard/operations/project-goals`, `/dashboard/operations/project-launch`, `/dashboard/operations/project-launch/templates`, `/dashboard/operations/research-analysis`, `/dashboard/operations/return-analysis`, `/dashboard/operations/review-tracking`, `/dashboard/operations/seasonal-replenishment`, `/dashboard/operations/site-navigation`, `/dashboard/operations/store-navigation`, `/dashboard/operations/weekly-product-analysis`
- Agent Center: `/dashboard/agent-center/overview`, `/dashboard/agent-center/employees`

- [ ] **Step 1: Extend route tests first**

Add every route to `WARM_ROUTE_CASES`, update any now-stale non-Warm lists, and assert exact title/section metadata.

- [ ] **Step 2: Run the failing route tests**

Run: `cd frontend && pnpm exec vitest run app/dashboard/layout.test.tsx components/dashboard-v2/warm-ledger/shell/warm-ledger-shell.test.tsx`

Expected: FAIL for routes not yet present in `WARM_LEDGER_EXACT_ROUTE_META`.

- [ ] **Step 3: Register exact routes**

Add all 26 entries to `WARM_LEDGER_EXACT_ROUTE_META`. Use `REPORTS_SECTION` for Reports and `OPERATIONS_SECTION` for Operations and Agent Center. Keep route titles aligned with the page heading and sidebar concept.

- [ ] **Step 4: Extend the desktop matrix**

Add all 26 routes to the 1440x900 matrix. Preserve the Office presentation exception check.

- [ ] **Step 5: Run integration verification**

Run: `cd frontend && pnpm exec vitest run app/dashboard/layout.test.tsx components/dashboard-v2/warm-ledger/shell/warm-ledger-shell.test.tsx`

Expected: PASS.

## Task 2: Monthly Report Generate and Reconcile

**Files:**

- Modify: `frontend/app/dashboard/reports/monthly-report/generate/**`
- Modify: `frontend/app/dashboard/reports/monthly-report/reconcile/**`
- Modify: `frontend/app/dashboard/reports/monthly-report/layout.tsx` only if the Warm tab shell requires page-local styling
- Test: existing `generate-client.test.tsx`, reconcile tests, plus route-local Warm contract tests

**Surfaces:** `/dashboard/reports/monthly-report/generate`, `/dashboard/reports/monthly-report/reconcile`

- [ ] Add failing tests for the Warm page marker, current tabs/forms, and desktop table containment.
- [ ] Migrate existing controls, filters, upload flows, progress states, exports, and dialogs to local Warm styles without changing contracts.
- [ ] Run generate/reconcile Vitest plus changed-file ESLint.
- [ ] Commit with a Chinese Conventional Commit.

## Task 3: Pricing Calculation and Report Automation

**Files:**

- Modify: `frontend/app/dashboard/reports/pricing-calculation/**`
- Modify: `frontend/app/dashboard/reports/auto-upload/**`
- Modify: `frontend/app/dashboard/reports/report-reconciliation/**`
- Test: existing route tests plus Warm contract coverage

**Surfaces:** `/dashboard/reports/pricing-calculation`, `/new-product`, `/shop-calculation`, `/auto-upload`, `/report-reconciliation`

- [ ] Add failing tests for Warm surfaces and preserved workflow/API controls.
- [ ] Migrate all five route surfaces, including editors, tables, dialogs, upload states, and destructive confirmations.
- [ ] Run focused Vitest, changed-file ESLint, `pnpm check:mocks`, and `git diff --check`.
- [ ] Commit with a Chinese Conventional Commit.

## Task 4: Scheduled Reports

**Files:**

- Modify: `frontend/app/dashboard/reports/scheduled-reports/**`
- Test: existing layout/subscription/ledger tests plus Warm contract coverage

**Surfaces:** `/dashboard/reports/scheduled-reports`, `/ledger`, `/subscriptions`

- [ ] Add failing tests for Warm shell, tables, dialogs, and status tokens.
- [ ] Migrate scheduled subscription, ledger, AI summary, resend, edit, delete, and bulk actions without changing API behavior.
- [ ] Run the complete scheduled-reports lane and changed-file ESLint.
- [ ] Commit with a Chinese Conventional Commit.

## Task 5: Complaint Center, Inspection, and Review Tracking

**Files:**

- Modify: `frontend/app/dashboard/operations/complaint-center/**`
- Modify: `frontend/app/dashboard/operations/platform-inspection/**`
- Modify: `frontend/app/dashboard/operations/review-tracking/**`
- Test: route-local tests and Warm contract coverage

**Surfaces:** complaint center root/list, platform inspection, review tracking

- [ ] Add failing tests for Warm panels/tables, drawer/dialog behavior, and desktop containment.
- [ ] Migrate all four routes while preserving filters, uploads, charts, history, screenshots, external targets, and drawer behavior.
- [ ] Run the focused Operations lane and changed-file ESLint.
- [ ] Commit with a Chinese Conventional Commit.

## Task 6: Replenishment, Returns, Seasonality, and Weekly Analysis

**Files:**

- Modify: `frontend/app/dashboard/operations/inventory-replenishment/**`
- Modify: `frontend/app/dashboard/operations/return-analysis/**`
- Modify: `frontend/app/dashboard/operations/seasonal-replenishment/**`
- Modify: `frontend/app/dashboard/operations/weekly-product-analysis/**`
- Test: existing route-local tests plus Warm contract coverage

**Surfaces:** inventory replenishment, return analysis, seasonal replenishment, weekly product analysis

- [ ] Add failing tests for Warm controls/tables/charts, loading/error/empty states, and table containment.
- [ ] Migrate all four routes and all exports/filters/global-filter integrations without behavior changes.
- [ ] Run the focused Operations lane, changed-file ESLint, and `check:motion`.
- [ ] Commit with a Chinese Conventional Commit.

## Task 7: Goals, Project Launch, Research, and Navigation

**Files:**

- Modify: `frontend/app/dashboard/operations/project-goals/**`
- Modify: `frontend/app/dashboard/operations/project-launch/**`
- Modify: `frontend/app/dashboard/operations/research-analysis/**`
- Modify: `frontend/app/dashboard/operations/site-navigation/**`
- Modify: `frontend/app/dashboard/operations/store-navigation/**`
- Test: existing route-local tests plus Warm contract coverage

**Surfaces:** project goals, project launch root/templates, research analysis, site navigation, store navigation

- [ ] Add failing tests for Warm page shells, editor/dialog behavior, charts, navigation cards, and table containment.
- [ ] Migrate all six routes while preserving admin gates, writes, templates, external links, and project state.
- [ ] Run focused Operations tests and changed-file ESLint.
- [ ] Commit with a Chinese Conventional Commit.

## Task 8: Agent Center

**Files:**

- Modify: `frontend/app/dashboard/agent-center/overview/**`
- Modify: `frontend/app/dashboard/agent-center/employees/**`
- Modify: `frontend/app/dashboard/agent-center/loading.tsx` if needed
- Test: existing client tests plus Warm contract coverage

**Surfaces:** `/dashboard/agent-center/overview`, `/dashboard/agent-center/employees`

- [ ] Add failing tests for Warm panels/tables and preserved read-only data contracts.
- [ ] Migrate overview and employee roster surfaces using local Warm styles.
- [ ] Run the two client suites, changed-file ESLint, and `git diff --check`.
- [ ] Commit with a Chinese Conventional Commit.

## Review and Integration Gate

- [ ] R-Reports independently reviews all 10 report routes using Luna/max.
- [ ] R-Operations independently reviews all 14 operation routes using Luna/max.
- [ ] R-AgentCenter independently reviews both Agent Center routes using Luna/max.
- [ ] Full Vitest has no new failures.
- [ ] `pnpm lint`, `pnpm build`, `pnpm check:mocks`, `pnpm check:motion`, and `git diff --check` pass.
- [ ] A 26-route desktop Playwright matrix passes at `1440x900`.
- [ ] Final whole-batch Luna/max gate passes.

## Residual Follow-Ups

- Existing finance/system/CRM/Tools/AI security and behavior findings remain separate.
- C4 advertising remains deferred.
- Utility pages (`profile`, `change-password`, `feature-updates`, `table-showcase`) and the three explicit visual exceptions are outside C8.
