# C2 Task 3 Implementation Report — Shipping Plan

## Scope and outcome

- Migrated `/dashboard/operations/shipping-plan` to the approved route-scoped Warm Ledger presentation. Changes are confined to the shipping-plan route files and local CSS Module.
- Project and site filters use the primary filter slot and mobile strip; supported sites remain US, DE, and UK. No date selector was added.
- The selected SKU list, parameter/data-quality state, 180-day forecast, and expected-arrival workflow now lead the page. Shipment history follows this focused work area.
- Existing Warm controls replace raw and legacy single-choice dropdowns. The route-frame refresh action is the only refresh control.

## Unslop pass

- Chart series mixed amber, positive, warning, and negative colors without a clear lead. The forecast and shipment-history charts now use a restrained Warm amber lead with neutral comparison series; provisional and paired series keep their semantic line styles.
- Chart axis labels were 10px, and KPI labels used uppercase tracked text. Chart labels now meet the Warm type floor, and KPI labels use sentence case.
- The page description and separate data-explanation card repeated information already present in the route title, chart, and planning workflow. They were removed; arrival data-quality warnings remain within the relevant workflow.
- History appeared before SKU work; native/legacy dropdowns and a duplicate page refresh action interrupted the route. The page now follows the C2 hierarchy, uses WarmSelect, and relies on the shell refresh action.

## Preserved behavior

- API endpoints and parameters, site-local `as_of_date`, the 365-day ETD history range, the following 180-day forecast, and the forecast formulas remain unchanged.
- SKU pagination, history coverage/provisional-sales/missing-ETD semantics, candidate cap of 25 per shipment status, and plan batch create/edit/cancel behavior remain intact.
- Allocation and unallocation validation, available-quantity accounting, write effects, and audit behavior remain intact. Saving a growth factor now triggers a fresh forecast request without changing its formula.
- Loading, API error, no-SKU, no-batch, no-candidate, and truncated-candidate states are distinct. Same-scope refresh remains registered through the route frame.

## Validation

- Focused ESLint on the five changed TS/TSX files passed with no diagnostics.
- `git diff --check` passed.
- CodeGraph incremental sync completed.
- The existing shipping-plan browser spec only covers the unsupported ALL-scope state and mobile strip; it provides no forecast/batch fixture. Tests, build, and browser interaction screenshots were not run in this page task. The full C2 viewport and interaction matrix remains scheduled for Task 6.
- No files were staged or committed.

## Implementer review notes

- The implementer reports that an internal Luna max review identified contradictory truncated-candidate messaging, missing history loading space, and a duplicate selected-SKU label. Those findings were addressed before the independent task R1 review.

## Independent R1 review

- Verdict: FAIL. The reviewer identified four actionable findings: previous-scope data remains visible while a new scope loads or fails; a late mutation callback can start a reload for its captured old scope; unknown project IDs are accepted and an empty global project is automatically replaced by the first managed project; and the combined `Promise.all` error is presented as SKU and plan errors even when only history failed.
- The Luna max/max follow-up fixer applied the four fixes in `shipping-plan-client.tsx` and `components/sku-forecast-table.tsx`. Focused ESLint reported 0 errors and one `react-hooks/exhaustive-deps` warning for the scoped `batches` fallback; `git diff --check` passed. Tests, build, and browser checks remain deferred to Task 6.
- The separate Luna max/max R1 re-review verified the four fixes and found two remaining items: shared mutation busy flags can appear in a newly selected scope, and the scoped `batches` fallback causes the reported ESLint warning.
- A second Luna max/max follow-up isolated mutation busy flags by scope/operation token, made allocation duplicate guards scope-specific, and replaced the unstable empty `batches` fallback with a module-level array. Focused ESLint passes without diagnostics; `git diff --check` and CodeGraph sync passed.
- The third independent Luna max/max R1 verified the six prior findings are fixed, then returned FAIL on five new items: clear a successfully submitted draft in its original scope without overwriting newer drafts; avoid duplicate forecast GETs on refresh; restore ETD-month/date-basis context in the history chart; bound SKU-card DOM/focus count while retaining all API pages; and replace three hard-coded 12px radii with frozen Warm tokens. Reviewer `e239171f-f0be-4eb4-afed-0f355d958651` was archived.
- The reviewer also identified an existing browser test fixture that does not mock `usePrimaryFilterSlot` and retains old content/interaction assertions. This is recorded for Task 6; no test has been run or edited.
- Luna max/max fixer `623b18a4-5acb-413b-9732-0d74995acafa` applied the five final R1 fixes in the Shipping Plan route files only. Tests/build/browser remain deferred to Task 6; Task 4 remains gated until the next independent R1 returns PASS.
- Luna max/max fix agent `6682a3b3-3779-4a6d-a1af-8540f0d9d136` is restoring the dedicated forecast-retry trigger without reintroducing duplicate requests from page refresh. Fifth-round independent R1 is required after this P1 fix.
- The five final R1 fixes are now applied in the Shipping Plan route. Focused ESLint on the three changed TSX files passed with no diagnostics; `git diff --check` and CodeGraph sync passed. First fourth-round reviewer `50b69d29-12e7-4c3e-8fd2-a2f09868ae36` errored with a service 429 and was archived without editing files. Retry reviewer `4f9222e1-1aba-4636-8848-7faec7e7ecd5` verified the previous fixes but found one P1: the forecast retry button referenced removed `setForecastRefreshKey`; all other checks passed.
- Fix agent `6682a3b3-3779-4a6d-a1af-8540f0d9d136` restored a separate `forecastRetryKey` used only by the retry button/effect. `refreshPage` remains single-triggered by `skuLoading`. Focused ESLint, `git diff --check`, and CodeGraph sync pass.
- Fifth-round independent Luna max/max R1 (`3da0a498-27df-495d-ab98-c294c20dab8b`) returned PASS with no findings. The six earlier findings, five visual/data follow-ups, busy-scope and radius/token follow-ups, and forecast retry P1 all pass static review. Task 3 gate is closed; Task 4 may proceed. Browser viewport and interaction checks remain scheduled for Task 6.
