import { describe, it, expect } from 'vitest'
import { getProxyTimeoutMs, TIMEOUT_TIERS } from './backend-proxy-timeout-policy'

/**
 * BEL-417: `POST /api/v1/report-upload/commit` ingests large monthly reports
 * (e.g. inventory_ledger 30-50k rows). The default 5s timeout was killing
 * the upload long before the batched `ON CONFLICT` inserts finished. The
 * route is matched by the `report` tier (60s) in
 * `backend-proxy-timeout-policy.ts`. These tests guard the regex addition
 * so future tier-table edits don't silently drop the commit endpoint back
 * to the 5s default and re-introduce the bug.
 */
describe('BEL-417: report-upload/commit timeout tier', () => {
  it('matches the `report` tier (60_000ms) for application/json POSTs', () => {
    expect(getProxyTimeoutMs('api/v1/report-upload/commit', 'application/json')).toBe(60_000)
  })

  it('matches the `report` tier for no Accept header (some clients omit it)', () => {
    expect(getProxyTimeoutMs('api/v1/report-upload/commit', null)).toBe(60_000)
  })

  it('matches the `report` tier when the path is prefixed with `/`', () => {
    // Real Next.js proxy joins the path with the backend prefix, so
    // getProxyTimeoutMs may receive either shape depending on call site.
    expect(getProxyTimeoutMs('/api/v1/report-upload/commit', 'application/json')).toBe(60_000)
  })

  it('exposes the `report-upload/commit` pattern in the TIMEOUT_TIERS table', () => {
    const reportTier = TIMEOUT_TIERS.find((t) => t.label === 'report')
    expect(reportTier).toBeDefined()
    expect(reportTier?.timeoutMs).toBe(60_000)
    // Belt-and-suspenders: ensure the regex actually matches the path.
    expect(reportTier?.pathPattern?.test('api/v1/report-upload/commit')).toBe(true)
  })

  it('does NOT over-match sibling paths (e.g. /recognize, /status)', () => {
    // `/report-upload/recognize` is a tiny preview call — keep it on the
    // 5s default. The new regex must be anchored with `$` so it does not
    // accidentally lift sibling endpoints into the 60s tier.
    expect(getProxyTimeoutMs('api/v1/report-upload/recognize', 'application/json')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/report-upload/status', 'application/json')).toBe(5_000)
  })
})

/**
 * BLF-1019：`GET /api/v1/order-info/filter-options` 是 3 个 distinct 全表扫
 * （3-6s）。默认 5s 档会掐掉它 → 前端三个筛选下拉永久空白（旧一次性空壳
 * fallback 再也补不回来）。路由进 `stats` 档（15s），与页面 15s 客户端
 * 超时对齐。此测试 guard 正则，防止 tier 表改动悄悄把它打回 5s 默认。
 */
describe('BLF-1019: order-info/filter-options timeout tier', () => {
  it('matches the `stats` tier (15_000ms)', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/filter-options', 'application/json')).toBe(15_000)
  })

  it('matches the `stats` tier when the path is prefixed with `/`', () => {
    expect(getProxyTimeoutMs('/api/v1/order-info/filter-options', null)).toBe(15_000)
  })

  it('does NOT over-match sibling order-info paths (list/overview stay on default)', () => {
    // /overview 与 /list 是分页查询，走 5s 默认；只有 filter-options 需要提档。
    expect(getProxyTimeoutMs('api/v1/order-info/overview?page=1', 'application/json')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/order-info/list', 'application/json')).toBe(5_000)
  })
})
