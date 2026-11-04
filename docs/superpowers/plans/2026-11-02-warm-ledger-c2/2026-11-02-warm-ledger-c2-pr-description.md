## Summary

- Completed the Warm Ledger C2 migration for Inventory Ledger, Shipping Plan, Shipment Management, and SKU Info on the exact approved routes.
- Preserved each page's existing queries, business calculations, exports, write payloads, and role behavior. No backend/API or shared token defaults changed.
- Fixed two confirmed behavior gaps: Shipping Plan growth-factor saves now reload exactly one forecast for the same scope/SKU; stale Shipment Management list responses can no longer overwrite the newest filter state.
- Fixed narrow-screen grid overflow in Shipment Management/SKU Info and the Inventory Ledger month-retry hit target.
- Added a self-contained six-width Playwright matrix with fixture authentication and mocked backend traffic.

## Verification

- Focused Vitest: 27 files / 199 tests passed (`--maxWorkers=4`).
- Playwright: 78/78 across Chromium and mobile, covering four exact routes at 1440/1024/820/767/390/320px plus filters, exports, mocked writes, retry, dialogs/sheets/lightbox, and keyboard focus return.
- 1440px Chromium auth smoke: 4/4 routes passed without manually setting `NEXTAUTH_URL`.
- Changed-file ESLint, `pnpm.cmd build`, `pnpm.cmd check:mocks` (295 test files, 0 hits), `git diff --check`, and CodeGraph status passed.
- No browser request reached a real backend. Inventory Ledger's Batches tab is read-only history and has no CSV upload handler on that route.

## Follow-ups

Backend project-scope authorization findings and SKU Info pagination/export/image-replacement issues remain explicitly documented in the C2 security follow-up. This PR does not claim to resolve them.

## Build warnings

The build completed successfully with existing Next.js workspace-root/NFT, stale Browserslist, and Turbopack NFT-list warnings.