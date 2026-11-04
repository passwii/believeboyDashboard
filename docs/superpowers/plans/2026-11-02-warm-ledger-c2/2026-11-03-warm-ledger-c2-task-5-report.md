# C2 Task 5 Implementation Report — SKU Info

Status: source implementation complete; Task 6 still owns integration, viewport, interaction, and browser verification.

## Approved direction

- **Product:** Help operations maintain and verify product cost, dimensions, attributes, listing copy, labels, and images.
- **Character:** Exact, careful, traceable.
- **World:** A structured product catalog ledger with identifiers and auditable edits.
- **Moments:** The selected tab's real data table and actual product media; information density follows the active view.
- **Signature:** Keep SKU, ASIN, and FNSKU visible as the identity chain across views.

## Unslop audit and passes

The audit was source-based. This page task explicitly excludes browser checks, so no rendered screenshot or runtime appearance is claimed.

Source-observed signs at base `6fb3f4c3`:

- All four filters and Query/Reset occupied one legacy header row, with the same set duplicated for mobile: `frontend/app/dashboard/operations/sku-info/page.tsx:646-710, 717-780`. The filter hierarchy was not reflected in the approved Warm route slots.
- Table headers repeated uppercase, tracked micro-label styling across the cost, dimension, factory, label, and listing views: `frontend/app/dashboard/operations/sku-info/page.tsx:1220-1244, 1550-1571, 1888-1903, 2077-2089, 2390`; the image table repeated it at `frontend/components/dashboard/sku-info/image-tab.tsx:127-146`. Review-group section labels used the same treatment at `frontend/components/dashboard/sku-info/review-group-sheet.tsx:320, 392`.
- Data cards mixed old Term surfaces with soft shadows and floating, blurred update-status pills: `frontend/app/dashboard/operations/sku-info/page.tsx:1162, 1197-1199` and the equivalent table cards/statuses in the other views. The page needed the frozen Warm ramp and quieter status placement.
- Inline country/status controls and the review-group representative control used legacy Select styling; the row controls were compact `h-6`/`h-8` fields: `frontend/app/dashboard/operations/sku-info/page.tsx:1403-1422, 1428-1446, 1781-1798` and `frontend/components/dashboard/sku-info/review-group-sheet.tsx:361-378`.
- Listing title, description, and selling-points values were truncated and visible in full only through hover titles: `frontend/app/dashboard/operations/sku-info/page.tsx:2405-2417`.
- The product-image table and image actions used the old shared surface colors and small tracked headers: `frontend/components/dashboard/sku-info/image-tab.tsx:96-146`.
- Review-group sheets and image-upload sheets used the shared body portal by default, so their surfaces could not inherit route-scoped Warm tokens: `frontend/components/ui/sheet.tsx:48-70` at base. The lightbox also used a catch-all `transition-all`: `frontend/components/dashboard/sku-info/image-lightbox.tsx:58`.
- The shared active tab indicator includes a glow in `frontend/components/ui/tab-motion.tsx:53-85`; this route now suppresses that glow locally without changing shared defaults.

Passes applied in sequence:

- **Spacing:** Split desktop filters across the primary project/identifier slot and secondary site/status/action slot. Kept the existing mobile strip below its current breakpoint, aligned controls to Warm spacing, and gave every data view a contained horizontal-scroll surface with enough column width for its existing fields.
- **Color:** Applied Warm Ledger surfaces and hairlines through the route CSS Module. Amber marks the primary action and active tab; positive and neutral statuses retain their meanings. Removed the old blur/shadow treatment from update status and kept shared tokens unchanged.
- **Icons:** Kept the existing Lucide set and normalized page action/tab icons to 16px with a 1.6 stroke. Added no decorative icon or image.
- **Copy:** Kept business and workflow copy unchanged. Table headers now render in sentence case; listing-copy cells wrap so their values are visible without hover. The loading state names the actual SKU page.
- **Type:** Applied Warm interface typography, mono identifiers, and tabular figures. Replaced tracked uppercase table labels and kept identifiers readable with wrapping and per-view column widths.
- **Layout:** The six existing tabs remain the work surface. Route filters follow the approved primary/secondary hierarchy; the mobile strip carries the same filters and Query/Reset. The active table remains the main canvas, and product media stays in its existing image view.
- **Details:** Project/country/status and inline edit pickers use `WarmSelect`; project-list failures expose a retry. Sheets and the lightbox use the existing Warm portal root, opener focus restoration, visible focus rings, and 44px targets at `<=820px`. The review-group picker keeps its searchable, multi-select, remove-chip, and clear-all behavior while rendering in the Warm portal.
- **Visuals:** The data table and real product photographs provide the screen's visual emphasis. No generated or sample imagery was added.
- **Motion:** Added no page entrance motion. Existing tab transitions remain; loading skeletons are static, reduced motion is respected, and the lightbox keeps its keyboard zoom/focus behavior without `transition-all`.

## Behavior preserved

- Kept submit-on-Query and identifier Enter behavior. Project, country, and status changes only update draft values; they do not issue a query. Reset, URL-entry search, refresh, and current-versus-loaded data behavior retain their existing handlers and semantics.
- Kept all six views, current columns, record-ID row identity, `sort_order`/ID ordering, 10,000-row page-size behavior, and the existing page/result count display.
- Kept inline edits/deletes, both CSV import modes and template rows, factory parsing and batch-save payloads, listing-copy writes, admin-only review groups with same-project/same-country candidates, first-leg sync, per-tab exports, FNSKU PDF verification, and ZIP label download.
- Kept selected-row behavior, confirmations, endpoint paths, request parameters, and existing empty/error/query behavior. No pagination, selection clearing, sample-row edits, response-header repairs, or R2 replacement-order changes were made.
- The existing Task 4 ImageLightbox `portalContainer`, `contentClassName`, close-focus callback, keyboard zoom button, and pressed/name state were preserved and wired to the SKU route's Warm portal and opener.

## Authorization and technical follow-ups

- The legacy project-name search can bypass `managed_project_ids`; record-ID write/delete routes use the shared API key without explicit project-scope checks. This UI does not provide an authorization fix or establish project isolation. A backend owner must decide and implement the authorization contract separately; Task 6 must retain this limitation in rollout documentation.
- Keep the existing no-pagination/10,000-row query behavior and current-versus-loaded result semantics as separate follow-ups. Do not change the current behavior as part of this visual migration.
- Separately address the batch-label download count headers not forwarded by the Next proxy and the R2 replacement failure window (old image deletion before new upload). This task does not change response headers or replacement order.

## Changed files

- `frontend/app/dashboard/operations/sku-info/page.tsx`
- `frontend/app/dashboard/operations/sku-info/loading.tsx`
- `frontend/app/dashboard/operations/sku-info/sku-info-warm.module.css`
- `frontend/components/dashboard/sku-info/batch-factory-info-sheet.tsx`
- `frontend/components/dashboard/sku-info/factory-info-sheet.tsx`
- `frontend/components/dashboard/sku-info/image-lightbox.tsx`
- `frontend/components/dashboard/sku-info/image-tab.tsx`
- `frontend/components/dashboard/sku-info/image-upload-sheet.tsx`
- `frontend/components/dashboard/sku-info/listing-copy-sheet.tsx`
- `frontend/components/dashboard/sku-info/review-group-sheet.tsx`
- `frontend/components/ui/sheet.tsx` — added optional `portalContainer`; omitted callers keep the existing body portal.

## Independent source review

- The first Luna max R1 found two Minor issues: the member-search input lacked a visible keyboard focus ring, and the selected-member display counted only IDs present in the current candidate result set.
- Added a Warm focus ring to the portaled command input. The member chips and count now include every selected record ID, with `#id` shown when the current candidate result does not include that record; selectable options remain limited to the existing same-project/same-country candidates.
- A focused Luna max re-review returned PASS. No Critical or Important findings remain. The reviewer confirmed the existing selected IDs still flow into the same create/update payload.

## Validation and Task 6 visual gaps

- Focused ESLint on all changed TSX files and `frontend/components/ui/sheet.tsx` passed with no diagnostics.
- `git diff --check` passed.
- CodeGraph incremental sync completed. `codegraph status .` still reports one added Warm route-frame node from the known shared worktree state; no route-frame or token source was changed here.
- Tests, build, and browser checks were not run in this page task. No browser verification is claimed.
- Task 6 should inspect 1440, 1024, 820, 767, 390, and 320px widths; mobile filter expansion; all six tables and their internal scrolling; long identifiers/copy; list loading/error states; project retry; every sheet and lightbox; focus return; 44px touch targets; and representative edit, import, export, sync, label verification, and batch ZIP flows.
- The page still uses the shared `useConfirm` provider for destructive/clear confirmations; inspect those existing global confirmation surfaces and focus behavior in Task 6. This task only routed the listed page-owned sheets and lightbox.
