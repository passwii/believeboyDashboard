import { describe, it, expect } from 'vitest'
import {
  getProxyTimeoutMs,
  resolveProxyTimeoutTier,
  TIMEOUT_TIERS,
} from './backend-proxy-timeout-policy'

describe('日销售 API 代理 deadline（10s）', () => {
  it.each([
    'api/v1/daily-analysis',
    'api/v1/daily-analysis/all',
    'api/v1/daily-analysis/all-countries',
    'api/v1/daily-analysis/all-projects-countries',
  ])('%s 使用 10 秒 deadline', (path) => {
    expect(getProxyTimeoutMs(path, null, 'GET')).toBe(10_000)
  })

  it('不扩大到未知 daily-analysis 子路径或其他 API', () => {
    expect(getProxyTimeoutMs('api/v1/daily-analysis/unknown', null, 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/report-upload/recognize', null, 'GET')).toBe(5_000)
  })
})

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
    expect(getProxyTimeoutMs('api/v1/report-upload/commit', 'application/json', 'GET')).toBe(60_000)
  })

  it('matches the `report` tier for no Accept header (some clients omit it)', () => {
    expect(getProxyTimeoutMs('api/v1/report-upload/commit', null, 'GET')).toBe(60_000)
  })

  it('matches the `report` tier when the path is prefixed with `/`', () => {
    // Real Next.js proxy joins the path with the backend prefix, so
    // getProxyTimeoutMs may receive either shape depending on call site.
    expect(getProxyTimeoutMs('/api/v1/report-upload/commit', 'application/json', 'GET')).toBe(60_000)
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
    expect(getProxyTimeoutMs('api/v1/report-upload/recognize', 'application/json', 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/report-upload/status', 'application/json', 'GET')).toBe(5_000)
  })
})

describe('月度核算明细导出 timeout tier', () => {
  it('matches the report tier instead of the 5s default', () => {
    expect(
      getProxyTimeoutMs(
        'api/v1/monthly-reports/financial-series/accounting-detail/export',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      , 'GET')
    ).toBe(60_000)
  })

  it('does not over-match neighboring accounting-detail paths', () => {
    expect(
      getProxyTimeoutMs('api/v1/monthly-reports/financial-series/accounting-detail', null, 'GET')
    ).toBe(5_000)
    expect(
      getProxyTimeoutMs(
        'api/v1/monthly-reports/financial-series/accounting-detail/export/other',
        null
      , 'GET')
    ).toBe(5_000)
  })
})

/**
 * BLF-1019：`GET /api/v1/order-info/filter-options` 是 3 个 distinct 全表扫
 * （3-6s）。默认 5s 档会掐掉它 → 前端三个筛选下拉永久空白（旧一次性空壳
 * fallback 再也补不回来）。BLF-1262 后端单语句预算为 15s；代理预留 5s
 * 透传后端明确的 504。此测试 guard 正则，防止 endpoint deadline 不匹配。
 */
describe('BLF-1019: order-info/filter-options timeout tier', () => {
  it('leaves time for the backend statement deadline to return an actionable 504', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/filter-options', 'application/json', 'GET')).toBe(20_000)
  })

  it('also applies to a slash-prefixed path', () => {
    expect(getProxyTimeoutMs('/api/v1/order-info/filter-options', null, 'GET')).toBe(20_000)
  })

  it('keeps the filter-options and overview budgets ahead of generic list routes', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/overview', 'application/json', 'GET')).toBe(20_000)
    expect(getProxyTimeoutMs('api/v1/order-info/list', 'application/json', 'GET')).toBe(20_000)
  })
})

describe('BLF-1262: order-info/overview timeout tier', () => {
  it('allows the backend 15s statement deadline to return a clear 504 first', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/overview', 'application/json', 'GET')).toBe(20_000)
    expect(getProxyTimeoutMs('/api/v1/order-info/overview', null, 'GET')).toBe(20_000)
  })

  it('does not extend export or unlisted endpoints without evidence', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/list', 'application/json', 'GET')).toBe(20_000)
    expect(getProxyTimeoutMs('api/v1/order-info/export', 'application/json', 'GET')).toBe(5_000)
  })
})

describe('Insight canonical stream timeout tier', () => {
  it('does not apply the ordinary 5s timeout to Insight streams', () => {
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', 'application/json', 'GET')).toBe(0)
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', null, 'GET')).toBe(0)
  })

  it('recognizes the explicit SSE Accept header for any Insight path', () => {
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', 'text/event-stream', 'GET')).toBe(0)
  })
})

/**
 * BLF-1017：canonical 域 run 入口（广告分析 / 库存健康）在服务端先收敛口径
 * 再建 run，默认 5s 档会掐掉提交。落 `ai` 档（30s），与 `/ai-insights/generate`
 * 同档；创建后的正文推送走 SSE，不受影响。
 */
describe('canonical domain run submit timeout tier', () => {
  it('matches the `ai` tier (30_000ms) for both domains', () => {
    expect(getProxyTimeoutMs('api/v1/insight/ad-analysis/runs', 'application/json', 'GET')).toBe(30_000)
    expect(getProxyTimeoutMs('api/v1/insight/inventory-health/runs', 'application/json', 'GET')).toBe(30_000)
  })

  it('matches the `ai` tier when the path is prefixed with `/`', () => {
    expect(getProxyTimeoutMs('/api/v1/insight/ad-analysis/runs', null, 'GET')).toBe(30_000)
  })

  it('does NOT over-match other Insight paths', () => {
    // 只有「建 run」进 30s 档；单 run 的 detail 走默认 5s，事件流走 stream 档 0。
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1', 'application/json', 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/insight/runs/run-1/stream', null, 'GET')).toBe(0)
    expect(getProxyTimeoutMs('api/v1/insight/ad-analysis/runs/run-1', null, 'GET')).toBe(5_000)
  })
})

/**
 * BLF-1019：`GET /api/v1/order-info/filter-options` 是 3 个 distinct 全表扫
 * （3-6s）。默认 5s 档会掐掉它 → 前端三个筛选下拉永久空白（旧一次性空壳
 * fallback 再也补不回来）。BLF-1262 后端单语句预算为 15s；代理预留 5s
 * 透传后端明确的 504。此测试 guard 正则，防止 endpoint deadline 不匹配。
 */
describe('BLF-1019: order-info/filter-options timeout tier', () => {
  it('leaves time for the backend statement deadline to return an actionable 504', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/filter-options', 'application/json', 'GET')).toBe(20_000)
  })

  it('also applies to a slash-prefixed path', () => {
    expect(getProxyTimeoutMs('/api/v1/order-info/filter-options', null, 'GET')).toBe(20_000)
  })

  it('keeps export outside the bounded read policy', () => {
    expect(getProxyTimeoutMs('api/v1/order-info/export', 'application/json', 'GET')).toBe(5_000)
  })
})

describe('退货分析原始行端点：stats 档（15s）', () => {
  it('matches the `stats` tier (15_000ms)', () => {
    expect(getProxyTimeoutMs('api/v1/return-analysis/raw-rows', null, 'GET')).toBe(15_000)
    expect(getProxyTimeoutMs('/api/v1/return-analysis/raw-rows', null, 'GET')).toBe(15_000)
  })

  it('不误伤 /return-analysis 主端点（保持默认 5_000ms）', () => {
    expect(getProxyTimeoutMs('api/v1/return-analysis', null, 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/return-analysis?period=30d', null, 'GET')).toBe(5_000)
  })

  it('不误伤 raw-rows 的更长子路径（锁死 `$` 锚）', () => {
    // 该档位依赖 `$` 锚定：去掉锚点后下面这条会被误提到 15s（未来若新增
    // /raw-rows/<id> 等分页子路径，它们应当各自评估而非沾光提档）。
    expect(getProxyTimeoutMs('api/v1/return-analysis/raw-rows/extra', null, 'GET')).toBe(5_000)
  })
})

/**
 * 产品标签制作：服务端跑完整的 pypdf + pdfplumber + reportlab 叠加管线，
 * 冷启动导入这几个库本身就吃满 5s 默认档。落 `report` 档（60s）。
 */
describe('产品标签制作：report 档（60s）', () => {
  it('matches the `report` tier for the generate endpoint', () => {
    expect(getProxyTimeoutMs('api/v1/product-label/generate', 'application/pdf', 'GET')).toBe(60_000)
    expect(getProxyTimeoutMs('/api/v1/product-label/generate', null, 'GET')).toBe(60_000)
  })

  it('不误伤 product-label 的其他子路径（锁死 `$` 锚）', () => {
    expect(getProxyTimeoutMs('api/v1/product-label/generate/extra', null, 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/product-label', null, 'GET')).toBe(5_000)
  })
})

describe('库存分类账整月分析：report 档（60s）', () => {
  it('全量聚合读取不会被默认 5s 截断', () => {
    expect(getProxyTimeoutMs('api/v1/inventory-ledger/month-analysis', null, 'GET')).toBe(60_000)
    expect(getProxyTimeoutMs('/api/v1/inventory-ledger/month-analysis', null, 'GET')).toBe(60_000)
  })

  it('不误伤既有 inventory-ledger 子路径', () => {
    expect(getProxyTimeoutMs('api/v1/inventory-ledger/summary', null, 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/inventory-ledger/detail', null, 'GET')).toBe(5_000)
  })
})

/**
 * BLF-1404：客户方案上传 20MB HTML（#753 已把业务层上限从 5MB 放宽到 20MB），
 * 但代理超时仍是 5s 默认档 → 20MB 自包含文档（内联 base64 图）会被代理自己
 * 先 abort，前端收到 504「请求后端服务超时」。
 *
 * 关键难点：**建方案与列表同路径**（`POST|GET api/v1/crm/proposals`），
 * 路径正则无法区分 → 档位表新增 `methods` 维度（TimeoutTier.methods）。
 * 下面用例把三条路径 + method 组合的行为钉死：
 *   ① POST api/v1/crm/proposals                → 60s（建方案）
 *   ② POST api/v1/crm/proposals/{id}/versions  → 60s（追加版本）
 *   ③ GET  api/v1/crm/proposals                → 5s（列表，防误伤）
 */
describe('BLF-1404: 客户方案上传 timeout 档（60s）', () => {
  it('建方案（POST）命中 60s 档', () => {
    expect(getProxyTimeoutMs('api/v1/crm/proposals', 'application/json', 'POST')).toBe(60_000)
    // 代理路由可能带前导 `/`（取决于调用点）
    expect(getProxyTimeoutMs('/api/v1/crm/proposals', null, 'POST')).toBe(60_000)
  })

  it('追加版本（POST /proposals/{id}/versions）命中 60s 档', () => {
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42/versions', 'application/json', 'POST')).toBe(
      60_000
    )
    expect(getProxyTimeoutMs('/api/v1/crm/proposals/42/versions', null, 'POST')).toBe(60_000)
  })

  it('列表（GET）仍走 list 档 5s —— 不被上传档误伤', () => {
    expect(getProxyTimeoutMs('api/v1/crm/proposals', 'application/json', 'GET')).toBe(5_000)
    expect(getProxyTimeoutMs('/api/v1/crm/proposals', null, 'GET')).toBe(5_000)
  })

  it('锁死「命中的是哪一档」而不只是毫秒数（method 分流确实生效）', () => {
    expect(resolveProxyTimeoutTier('api/v1/crm/proposals', null, 'POST').label).toBe(
      'crm-proposal-upload'
    )
    expect(resolveProxyTimeoutTier('api/v1/crm/proposals/42/versions', null, 'POST').label).toBe(
      'crm-proposal-upload'
    )
    // 同路径 GET 必须落到 list 档，而不是默认档
    expect(resolveProxyTimeoutTier('api/v1/crm/proposals', null, 'GET').label).toBe('list')
  })

  it('上传档必须排在 list 档之前（否则 POST 会被 list 档先命中）', () => {
    const labels = TIMEOUT_TIERS.map((t) => t.label)
    expect(labels.indexOf('crm-proposal-upload')).toBeGreaterThanOrEqual(0)
    expect(labels.indexOf('crm-proposal-upload')).toBeLessThan(labels.indexOf('list'))
  })

  it('不误伤方案的其它子路径（详情 / 预览 / 下载 / 删除）', () => {
    // 详情 GET
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42', null, 'GET')).toBe(5_000)
    // 预览 GET
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42/versions/1/content', null, 'GET')).toBe(5_000)
    // 下载 GET
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42/versions/1/download', null, 'GET')).toBe(
      5_000
    )
    // 元信息更新 PATCH / 删除 DELETE 不该蹭上传档
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42', null, 'PATCH')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42', null, 'DELETE')).toBe(5_000)
  })

  it('不误伤 versions 的更深子路径（锁死 `$` 锚）', () => {
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42/versions/extra', null, 'POST')).toBe(5_000)
    expect(getProxyTimeoutMs('api/v1/crm/proposals/42/versions/1/content', null, 'POST')).toBe(5_000)
  })

  it('档位表里暴露的 upload 档声明了 POST method 限定', () => {
    const uploadTier = TIMEOUT_TIERS.find((t) => t.label === 'crm-proposal-upload')
    expect(uploadTier).toBeDefined()
    expect(uploadTier?.timeoutMs).toBe(60_000)
    expect(uploadTier?.methods).toEqual(['POST'])
    expect(uploadTier?.pathPattern?.test('api/v1/crm/proposals')).toBe(true)
    expect(uploadTier?.pathPattern?.test('api/v1/crm/proposals/42/versions')).toBe(true)
  })
})
