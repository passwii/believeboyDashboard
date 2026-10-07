import { describe, it, expect } from 'vitest'
import { getProxyTimeoutMs, getProxyTimeoutTier, TIMEOUT_TIERS } from './backend-proxy-timeout-policy'

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

describe('月度核算明细导出 timeout tier', () => {
  it('matches the report tier instead of the 5s default', () => {
    expect(
      getProxyTimeoutMs(
        'api/v1/monthly-reports/financial-series/accounting-detail/export',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe(60_000)
  })

  it('does not over-match neighboring accounting-detail paths', () => {
    expect(
      getProxyTimeoutMs('api/v1/monthly-reports/financial-series/accounting-detail', null)
    ).toBe(5_000)
    expect(
      getProxyTimeoutMs(
        'api/v1/monthly-reports/financial-series/accounting-detail/export/other',
        null
      )
    ).toBe(5_000)
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

  it('does NOT over-match sibling order-info paths (only filter-options is covered here)', () => {
    // /overview 与 /list 由 BLF-1263 的独立档位规则覆盖。
    expect(getProxyTimeoutMs('api/v1/order-info/overview', 'application/json')).toBe(15_000)
    expect(getProxyTimeoutMs('api/v1/order-info/list', 'application/json')).toBe(15_000)
  })
})
describe('Insight canonical stream timeout tier', () => {
  it('does not apply the ordinary 5s timeout to Insight streams', () => {
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', 'application/json')).toBe(0)
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', null)).toBe(0)
  })

  it('recognizes the explicit SSE Accept header for any Insight path', () => {
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', 'text/event-stream')).toBe(0)
  })
})

/**
 * BLF-1017：canonical 域 run 入口（广告分析 / 库存健康）在服务端先收敛口径
 * 再建 run，默认 5s 档会掐掉提交。落 `ai` 档（30s），与 `/ai-insights/generate`
 * 同档；创建后的正文推送走 SSE，不受影响。
 */
describe('canonical domain run submit timeout tier', () => {
  it('matches the `ai` tier (30_000ms) for both domains', () => {
    expect(getProxyTimeoutMs('api/v1/insight/ad-analysis/runs', 'application/json')).toBe(30_000)
    expect(getProxyTimeoutMs('api/v1/insight/inventory-health/runs', 'application/json')).toBe(30_000)
  })

  it('matches the `ai` tier when the path is prefixed with `/`', () => {
    expect(getProxyTimeoutMs('/api/v1/insight/ad-analysis/runs', null)).toBe(30_000)
  })

  it('does NOT over-match other Insight paths', () => {
    // 只有「建 run」进 30s 档；单 run 的 detail 走默认 5s，事件流走 stream 档 0。
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1', 'application/json')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', null)).toBe(0)
    expect(getProxyTimeoutMs('api/v1/insight/ad-analysis/runs/run-1', null)).toBe(5_000)
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

  it('does NOT over-match sibling order-info paths (only filter-options is covered here)', () => {
    // /overview 与 /list 由 BLF-1263 的独立档位规则覆盖。
    expect(getProxyTimeoutMs('api/v1/order-info/overview', 'application/json')).toBe(15_000)
    expect(getProxyTimeoutMs('api/v1/order-info/list', 'application/json')).toBe(15_000)
  })
})

describe('BLF-1263 order-info proxy timeout tiers', () => {
  it.each(['overview', 'list', 'stats', 'page', 'live-stream'])(
    '%s 使用 15 秒 stats timeout',
    (endpoint) => {
      expect(getProxyTimeoutMs(`api/v1/order-info/${endpoint}`, 'application/json')).toBe(15_000)
      expect(getProxyTimeoutTier(`api/v1/order-info/${endpoint}`, null).label).toBe('stats')
    }
  )

  it('export 使用 60 秒 report timeout，且不影响其他路径', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/export', 'application/json')).toBe(60_000)
    expect(getProxyTimeoutTier('api/v1/order-info/export', null).label).toBe('report')
    expect(getProxyTimeoutMs('api/v1/order-info/export/csv', null)).toBe(5_000)
  })

  it('不会把其他 order-info 路由扩大到 stats 档', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/filter-options', null)).toBe(15_000)
    expect(getProxyTimeoutMs('api/v1/order-info/unknown', null)).toBe(5_000)
  })
})

describe('退货分析原始行端点：stats 档（15s）', () => {
  it('matches the `stats` tier (15_000ms)', () => {
    expect(getProxyTimeoutMs('api/v1/return-analysis/raw-rows', null)).toBe(15_000)
    expect(getProxyTimeoutMs('/api/v1/return-analysis/raw-rows', null)).toBe(15_000)
  })

  it('不误伤 /return-analysis 主端点（保持默认 5_000ms）', () => {
    expect(getProxyTimeoutMs('api/v1/return-analysis', null)).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/return-analysis?period=30d', null)).toBe(5_000)
  })

  it('不误伤 raw-rows 的更长子路径（锁死 `$` 锚）', () => {
    // 该档位依赖 `$` 锚定：去掉锚点后下面这条会被误提到 15s（未来若新增
    // /raw-rows/<id> 等分页子路径，它们应当各自评估而非沾光提档）。
    expect(getProxyTimeoutMs('api/v1/return-analysis/raw-rows/extra', null)).toBe(5_000)
  })
})
