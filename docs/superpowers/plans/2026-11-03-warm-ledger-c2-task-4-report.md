# C2 Task 4 Implementation Report — Shipment Management

Status: R1 PASS; Task 4 source implementation gate is closed. Integrated viewport, interaction, build, and cross-route evidence remains assigned to Task 6.

## Approved direction

- **Product:** Help operations inspect and maintain formal shipment batches from overview through costing and FBA carton details.
- **Character:** Precise, steady, operational.
- **World:** A freight manifest ledger built from shipment numbers, dates, cartons, and costs.
- **Moments:** The active tab's real table, actual cost totals, and FBA carton rows.
- **Signature:** Keep shipment number and ETD/ETA visible as the batch identity through overview and cost inspection.

## Unslop audit and passes

Audit was source-based because this page task excludes browser checks. The route previously used legacy terminal styling and controls; no decorative image or background effect was present.

- **Spacing:** The filter set now uses the Warm primary/secondary route slots and mobile strip. The table panels share one local inset and header rhythm; the edit dialog's four bordered metric tiles became one compact ledger strip.
- **Color:** Arbitrary blue/violet/amber country badges in the Overview and SKU Summary tables became neutral Warm badges. Shipment states keep semantic Warm tones. Route-local tab styling removes the inherited Term glow while retaining a flat amber selection marker.
- **Icons:** The SKU carton-rate warning emoji became a 16px Lucide warning icon. Existing action icons remain from the same set.
- **Copy:** Removed the redundant “Shipping Cost”, “SKU Summary”, and “FBA Box List” eyebrows and the edit-only helper sentence. Removed the sample shipment-number placeholder. Cost recalculation now says “核算并写回”; SKU CSV import says “CSV 整体替换” so the existing write effect is clear without adding a confirmation.
- **Type:** Page controls and dialog fields use Warm type and sizes. Shipment identifiers, dates, and values use tabular numerals; small table headers no longer inherit the old tracked micro-label treatment.
- **Layout:** The four existing tabs remain the work surface. Project and shipment-number filters occupy the primary slot; status and country occupy the secondary slot; date controls appear only on Cost. The mobile strip carries the same filters and exposes the date range only on Cost. Shipment-number and carton tables still scroll inside their own containers.
- **Details:** Pickers use `WarmSelect`; country labels use `WarmBadge`; dialogs use route-local Warm surfaces and visible focus states. List, detail, cost summary, SKU summary, FBA, project, shipment-option, and project-SKU request failures have explicit error states. Loading, empty, and error results remain distinguishable.
- **Visuals and motion:** The page's real tables and totals carry the visual emphasis; no generated image or new entrance motion was needed. Existing tab transitions remain, and route-local controls respect reduced motion.

Source-observed signs refer to the page at base HEAD `6fb3f4c3`; no browser rendering was captured in this phase:

- Legacy Term header filters and form selectors: `page.tsx:2954-3050` and `page.tsx:4068, 4106, 4125, 4144, 4228`. Replaced with route-slot controls and `WarmSelect`.
- Country-specific blue, violet, and amber badge colors: `page.tsx:454-470, 3310, 3704, 3766`. Country labels are now neutral.
- Floating rounded “updating” pills: `page.tsx:3216, 3453, 3646, 3835`. Replaced with inline status text.
- Redundant English eyebrows: `page.tsx:3389, 3582, 3742`. Removed from the Cost, SKU Summary, and FBA headers.
- Four equal bordered metric tiles: `page.tsx:4323-4350`. Replaced with a single flat metrics strip.
- Warning emoji: `page.tsx:4449`. Replaced with a Lucide icon.
- Example shipment number in the form placeholder: `page.tsx:4100`. Removed.
- Shared create/edit form description at baseline `page.tsx:4058-4062`, including the edit-only helper sentence at `page.tsx:4061` (“可直接在下方维护 SKU 明细，支持项目 SKU 下拉选择与手动增行。”): the edit helper was removed; the create-only guidance remains at the current `page.tsx:4152`, while the edit fields and actions provide their own labels with no replacement description.
- Glow on the active Term tab indicator: `frontend/components/ui/tab-motion.tsx:107`. Suppressed by this route's CSS without changing the shared component.

Existing `SKU-DEMO` sample rows remain only inside the downloadable CSV templates; template content was left unchanged.

## Behavior preserved

- Kept the `overview`, `cost`, `sku-summary`, and `fba-box-detail` tabs, initial `tab` behavior, `shipment_no` URL input, local filter state, per-tab lazy loading, 20-row page size, and first-open shipment-number option loading.
- Kept API paths, request parameters, payloads, data scopes, and filter semantics. Shipment date controls are available only on Cost; the existing date state and request semantics remain.
- Kept create/edit, the admin-only delete control and its existing destructive confirmation, batch CSV import, full-replacement SKU CSV import without a new confirmation, and cost recalculation as a POST writeback.
- Kept overview, cost, SKU summary, and FBA export scopes, FBA template unit behavior, FBA carton details, product-image lightbox, and label ZIP skip/download behavior.
- Kept all current table fields and required actions. No persistent inspector was added; shipment number and ETD/ETA remain prominent in Overview, and ETD/ETA are shown alongside shipment number in Cost rows.

## Authorization follow-up

Rechecked `backend/app/api/v1/endpoints/shipment_schedules.py` and the shipment service sources. Create, batch CSV import, update, SKU replacement import, and cost calculation still lack an operator-to-project authorization check. Delete still has its explicit admin-only gate, with no additional project-scope check; whether global admin deletion is intended remains a backend decision. These findings are recorded in [the C2 security follow-up](2026-11-02-warm-ledger-c2-security-follow-up.md). No backend permissions changed.

## Changed files

- `frontend/app/dashboard/operations/shipment-management/page.tsx`
- `frontend/app/dashboard/operations/shipment-management/loading.tsx`
- `frontend/app/dashboard/operations/shipment-management/shipment-management-warm.module.css`
- `frontend/components/dashboard/shipment/shipment-batch-combobox.tsx`
- `frontend/components/dashboard/sku-info/image-lightbox.tsx`
- `frontend/components/ui/combobox.tsx`
- `frontend/components/ui/dialog.tsx`
- `docs/superpowers/plans/2026-11-02-warm-ledger-c2-security-follow-up.md`
- `docs/superpowers/plans/2026-11-03-warm-ledger-c2-task-4-report.md`

## Validation and limits

- Initial Task 4 focused ESLint on the page and loading skeleton passed. R1 follow-up ESLint: `pnpm exec eslint app/dashboard/operations/shipment-management/page.tsx components/dashboard/shipment/shipment-batch-combobox.tsx` — passed with no diagnostics.
- `git diff --check` — passed after the R1 follow-up.
- Latest focused ESLint: `pnpm exec eslint app/dashboard/operations/shipment-management/page.tsx app/dashboard/operations/shipment-management/loading.tsx` — passed with no diagnostics. `git diff --check` and the Task 4 CSS/report trailing-whitespace scan — passed after this follow-up.
- Tests, build, and browser checks were not run in this per-page phase. The final source-only independent R1 passed; runtime/browser verification remains pending under Task 6.

## Independent review

- The first read-only Luna max R1 found six issues: shared dialog width constraints, nested `<main>` landmarks, narrow control hit targets, wrapped/legible project error copy, loading-table geometry, and missing source locations in the Unslop audit. All six were addressed in the page CSS, route wrappers, skeleton, and this report.
- The second R1 identified two remaining narrow-screen hit targets: SKU picker options and the shared dialog close button. Route-local 44px sizing was added for both; desktop close controls remain 36px.
- The third independent Luna max/max R1 returned PASS with no remaining source findings. The Task 6 visual and interaction evidence is still pending.
- A fresh coordinator-requested Luna max R1 found eight additional source issues, followed by later portal, import, date hover, focus, touch, lightbox, and clear-control findings. Each was fixed in the follow-up sections below. The final independent review record appears at the end of this report.

## R1 follow-up fixes

- Shipment-number and SKU picker errors/retry controls now sit outside their `CommandList` listboxes. Existing SKU options and shipment-number options remain selectable during an error, and a manually typed shipment number remains selectable when lazy loading fails.
- Shipment batch-history failures now have a separate alert and retry action rather than the valid-empty message. The history endpoint and parameters, free input, and batch-hide behavior remain unchanged. Route-local wrapper, error, trigger, and popover classes are optional props on the single-consumer helper; its existing test was not edited.
- The shipment-batch trigger and portaled options use route-local Warm neutral surfaces and interface type. At widths `<=820px`, batch options and error/retry controls use 44px targets. Request-state retries also use 44px targets; selected shipment chips and date-popover buttons use the frozen 3px focus offset, and the shipment-number search input has a 2px Accent Strong ring with 3px offset.
- The route-local `.page .actionButton` rule now overrides the CSV-import label's shared radius and mono type. Table cells and ETD/ETA date text use the Warm tabular-numeral token without changing formatted values.
- Focused ESLint and `git diff --check` passed as recorded in Validation and limits. Tests, build, and browser checks remain unrun; no browser verification is claimed.

## Latest R1 follow-up fixes

- Route-scoped focus rules now override inherited glow and ring shadows with the frozen 2px Accent Strong outline at a 3px offset. They cover route slots, page controls, the batch and shipment-number popovers, date controls, selected shipment chips, and dialogs; focus shadows are cleared without changing hover or selected states.
- Batch CSV import now uses a real Warm button to open a visually hidden, labeled file input. WarmButton disables itself and announces import progress, while a synchronous ref prevents duplicate import POSTs. The accepted `.csv` type and existing request/result handling remain intact.
- An earlier pass made the conditional Combobox hide action a keyboard reachable native button while preserving cmdk option navigation and the hide callback. The latest independent R1 follow-up below moves hide actions outside `CommandList`.
- Dialog table cells and inputs use the Warm tabular-numeral token, including the editable shipment detail table and portaled SKU detail table; formatted values are unchanged.

## Final R1 portal-scope correction

- The Shipment Management page resolves `#warm-ledger-portal-root` in an effect and passes it to all four page-owned DialogContent surfaces, the shipment-number filter, the Cost date-range picker, all four edit-form single-date pickers, and the shipment-batch picker. DialogContent, Combobox, and ShipmentBatchCombobox gained optional portal-container props whose defaults preserve body portals for every other caller. Existing CSS Module classes remain on the portal contents so Warm route tokens resolve from `.warm-ledger`.
- The changed-file inventory includes `frontend/components/ui/combobox.tsx` and `frontend/components/ui/dialog.tsx`. Browser verification remains pending under Task 6; no browser verification is claimed.
- The route also consumes the optional `portalContainer` and `popoverClassName` props already present in `frontend/components/ui/date-picker.tsx` and `frontend/components/ui/popover.tsx`. Both files were modified before Task 4 began; they are reused dependencies and are not Task 4 changes.
- The latest portal-interaction follow-up restores pointer input on Shipment Management popovers, passes the existing Warm date-picker portal class, applies 44px day targets at `<=820px`, portals the FBA ImageLightbox into the Warm root, and moves filtered batch-hide buttons outside the listbox with narrow touch sizing. These fixes are now under an independent Luna max review.

## Latest independent R1 follow-up fixes

- Shipment-number and batch PopoverContent now restore pointer input locally under the inert Warm portal root. All five route date pickers combine the existing `warm-ledger__date-picker-content` class with the page class, enabling Warm pointer handling and narrow calendar targets. Date-button focus clears the shared Button ring shadow and keeps the 2px Accent Strong outline at a 3px offset.
- The FBA ImageLightbox accepts optional `portalContainer` and `contentClassName` props. This route passes its existing Warm portal root and a page-local focus/style class; callers that omit both props retain the existing body portal and visuals. Zoom, Escape, and close-control behavior remain wired through the existing Dialog callbacks.
- Batch hide actions now render as native buttons in a labeled sibling group after `Command`, outside `CommandList` and its listbox. The group follows the current search filter, has bounded scrolling, keeps the existing hide callback and focus return, and gives each action a 44px minimum target at widths `<=820px`.
- These fixes were included in the final independent source review. No browser interaction or pointer-target behavior is claimed; Task 6 viewport and interaction checks remain pending.

## Final R1 findings follow-up

- SKU CSV full-replacement import now uses a keyboard-accessible Warm button to activate a visually hidden, labeled `.csv` input. The button and input are disabled while importing, and a synchronous ref guard prevents duplicate POSTs before React state updates. The existing endpoint, headers, `FormData`, notifications, refreshes, and no-confirmation behavior are unchanged.
- Date-range calendar hover styling now excludes disabled buttons and dates with `aria-selected="true"`, preserving the Warm selected-date colors and existing range start/end/middle states.
- Focused ESLint on the page and loading skeleton, `git diff --check`, and the Task 4 CSS/report trailing-whitespace scan passed for this follow-up. Tests, build, and browser checks were not run; Task 6 visual and interaction evidence remains pending.

## Task 6 visual evidence needed

- Inspect 1440, 1024, 820, 767, 390, and 320px widths, including Warm route slots, mobile filter expansion, and date visibility only on Cost.
- Check all four tabs with real loading/error/empty states, keyboard selection, focus restoration, modal scrolling, and the 44px narrow-screen targets.
- Verify contained horizontal scrolling and shipment number/ETD/ETA legibility, especially long identifiers and FBA carton rows.
- Exercise the existing edit/delete flow, full-replacement CSV import, cost writeback, each export scope, FBA template units, and label ZIP behavior with request assertions.

## Confirmed R1 accessibility and responsive follow-up — 2026-11-03

- Calendar hover now reads `aria-selected` from the DayPicker day cell and styles its child button. Selected range endpoints retain the Warm Accent/Stage colors, range-middle days retain Accent Soft/text colors, and the route's generic day hover targets unselected cells only.
- At widths `<=820px`, the shipment-number and shipment-batch search inputs use the 44px touch-target token. The FBA lightbox close control and the opt-in shipment-batch clear button also have 44px square targets; desktop dimensions remain 36px.
- SKU search, create/edit, SKU details, delete confirmation, and the Shipment Management FBA image lightbox now return focus to their opener when it remains connected. The overview SKU count opens the existing read-only SKU details dialog (zero counts are disabled), making that opener reachable without changing the detail endpoint or response semantics. The nested delete confirmation falls back to the create/edit opener when its own opener is no longer connected.
- The lightbox zoom surface is a native button with a dynamic `放大图片` / `缩小图片` name, pressed state, and route-visible focus. Image fitting, zoom sizing, Escape, and modal close behavior remain wired as before.
- The shared Combobox clear button is opt-in and defaults off. Shipment Management renders a separate native clear button; clearing preserves the existing empty value semantics, and focus returns to the combobox trigger after the clear button is removed.

## Final independent R1

- Luna max reviewer `3dc7727e-e895-4041-8f68-c1b41b664d05` completed a final read-only review after the SKU-count opener was added. Result: PASS with no residual findings across the two latest fixes and the four preceding accessibility/responsive items. The reviewer also rechecked the shipment request, URL/tab, write, delete, import/export, FBA, portal, and security follow-up contracts.
- This was source-only review. No tests, build, or browser checks were run in the per-page phase. Task 6 still owns the six-width responsive matrix and interactive shipment workflow evidence.

Files changed for this follow-up:

- `frontend/app/dashboard/operations/shipment-management/page.tsx`
- `frontend/app/dashboard/operations/shipment-management/shipment-management-warm.module.css`
- `frontend/components/ui/combobox.tsx`
- `frontend/components/dashboard/shipment/shipment-batch-combobox.tsx`
- `frontend/components/dashboard/sku-info/image-lightbox.tsx`
- `docs/superpowers/plans/2026-11-03-warm-ledger-c2-task-4-report.md`

Focused ESLint on `page.tsx`, `combobox.tsx`, `shipment-batch-combobox.tsx`, and `image-lightbox.tsx` passed with no diagnostics. `git diff --check` and the CSS/report trailing-whitespace scan passed. CodeGraph sync completed; `codegraph status` still reports one added file pending in the shared worktree, without exposing its path. A focused read-only Luna max source review passed with no residual findings. Tests, build, and browser checks were not run as instructed; runtime and viewport verification remain pending under Task 6.
