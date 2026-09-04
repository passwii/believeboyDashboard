/**
 * BLF-611 手机端回归测试 fixture（仅供测试，非生产 secret）。
 *
 * playwright.config.ts（webServer.env）与 ad-mobile-blf611.spec.ts（伪造
 * next-auth session cookie）共用同一常量，避免两处漂移。
 */
export const BLF611_FIXTURE_SECRET =
  'blf611-e2e-fixture-secret-0123456789-abcdefghijklmnopqrstuvwxyz-42'
