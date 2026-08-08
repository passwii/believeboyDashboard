import { describe, expect, it } from 'vitest'

import { buildUsageText } from './agent-usage-guide'

describe('buildUsageText', () => {
  it('未提供 baseUrl 时保留 <后端地址> 占位符', () => {
    const text = buildUsageText({ plaintextKey: 'bbx_test', agentId: 'agent-1' })
    expect(text).toContain('<后端地址>')
  })

  it('传入 baseUrl 时替换占位符为真实 API 地址', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: 'https://dash-api.believeboy.com',
    })
    expect(text).toContain('https://dash-api.believeboy.com/api/v1/agent/health')
    expect(text).toContain(
      'https://dash-api.believeboy.com/api/v1/agent/projects/$PROJECT_ID/shipments?page_size=20'
    )
    expect(text).not.toContain('<后端地址>')
  })

  it('BLF-461：示例里先展示「项目名 → ID」解析步骤，不再用 {project_id} 占位符', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: 'https://dash-api.believeboy.com',
    })
    expect(text).toContain('/projects?name=')
    expect(text).toContain('$PROJECT_ID')
    expect(text).not.toContain('{project_id}')
  })

  it('baseUrl 末尾斜杠会被去掉，避免出现双斜杠', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: 'https://dash-api.believeboy.com/',
    })
    expect(text).toContain('https://dash-api.believeboy.com/api/v1/agent/health')
    expect(text).not.toContain('com//api')
  })

  it('baseUrl 为空串时回退占位符', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: '',
    })
    expect(text).toContain('<后端地址>')
  })
})

describe('buildUsageText · 业务域分支（BLF-448）', () => {
  it('缺省 domain 仍为货件示例（兼容旧签名）', () => {
    const text = buildUsageText({ plaintextKey: 'bbx_test', agentId: 'agent-1' })
    expect(text).toContain('/shipments?page_size=20')
  })

  it('domain=shipments 显式货件示例', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'shipments',
    })
    expect(text).toContain('/shipments?page_size=20')
    expect(text).toContain('货件管理')
  })

  it('domain=shop_calculations 输出店铺测算示例', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'shop_calculations',
    })
    expect(text).toContain('/shop-calculations?page_size=20')
    expect(text).toContain('/shop-calculations/compute')
    expect(text).toContain('店铺测算')
    expect(text).not.toContain('/shipments?page_size=20')
  })

  it('domain=return_analysis 输出退货分析示例（BLF-474）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'return_analysis',
    })
    expect(text).toContain('退货分析')
    expect(text).toContain('/return-analysis/overview')
    expect(text).toContain('/return-analysis?period=30d')
    expect(text).toContain('/return-analysis-raw')
    expect(text).toContain('/return-analysis/skus/{sku}')
    expect(text).toContain('/return-analysis/coverage')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=inventory 输出库存信息示例（BLF-478）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'inventory',
    })
    expect(text).toContain('库存信息')
    expect(text).toContain('/inventory?country=US')
    expect(text).toContain('/inventory?country=US&sku=X-001')
    expect(text).toContain('report_date')
    expect(text).toContain('补货分析')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=inventory_ledger 输出库存台账示例（BLF-485）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'inventory_ledger',
    })
    expect(text).toContain('库存台账')
    expect(text).toContain('/inventory-ledger/months')
    expect(text).toContain('/inventory-ledger/snapshot?period=last_month')
    expect(text).toContain('/inventory-ledger/events?period=2026-06')
    expect(text).toContain('/inventory-ledger/receipt-clusters?period=30d')
    expect(text).toContain('/inventory-ledger/integrity?period=last_month')
    expect(text).toContain('/inventory-ledger/trend?months=6')
    expect(text).toContain('/inventory-ledger/detail?period=2026-06')
    expect(text).toContain('/inventory-ledger/summary?period=2026-06')
    expect(text).toContain('/inventory-ledger/batches?limit=20')
    expect(text).toContain('/inventory-ledger/consistency?period=last_month')
    expect(text).toContain('period=custom')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=report_upload_status 输出报表状态示例（BLF-484）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'report_upload_status',
    })
    expect(text).toContain('报表状态')
    expect(text).toContain('/report-upload-status?report_date=2026-06-15&country=US')
    expect(text).toContain('report_date')
    expect(text).toContain('missing_report_types')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=ad_analysis 输出广告分析示例（BLF-490，10 条聚合路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'ad_analysis',
    })
    expect(text).toContain('广告分析')
    expect(text).toContain('/ad-campaigns?period=30d&country=US')
    expect(text).toContain('/ad-search-terms?period=30d&country=US')
    expect(text).toContain('/ad-budgets?period=30d&country=US')
    expect(text).toContain('/ad-targets?period=30d&country=US')
    expect(text).toContain('/ad-placements?period=30d&country=US')
    expect(text).toContain('/ad-promoted-products?period=30d&country=US')
    expect(text).toContain('/ad-time-trends?period=30d&country=US')
    expect(text).toContain('/ad-search-term-shares?period=30d&country=US')
    expect(text).toContain('/ad-invalid-traffic?period=30d&country=US')
    expect(text).toContain('/ad-purchased-products?period=30d&country=US')
    expect(text).toContain('period=custom')
    expect(text).toContain('ad-campaigns-raw')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=replenishment_analysis 输出补货分析示例（BLF-502，6 条路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'replenishment_analysis',
    })
    expect(text).toContain('补货分析')
    expect(text).toContain('/replenishment-analysis?country=US&inventory_state=critical')
    expect(text).toContain('replenishment_action')
    expect(text).toContain('/replenishment-analysis/skus/')
    expect(text).toContain('/replenishment-analysis/summary')
    expect(text).toContain('/replenishment-analysis/coverage')
    expect(text).toContain('/replenishment-analysis/settings')
    expect(text).toContain('confirm_token')
    expect(text).toContain('decision_path')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=new_product_calculations 输出新品测算示例（BLF-526，5 条路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'new_product_calculations',
    })
    expect(text).toContain('新品测算')
    expect(text).toContain('/new-product-calculations?calculation_type=profit_calc')
    expect(text).toContain('/new-product-calculations/skus/{sku}')
    expect(text).toContain('/new-product-calculations/skus/{sku}/audit')
    expect(text).toContain('/new-product-calculations/compute')
    expect(text).toContain('confirm_token')
    expect(text).toContain('fbm_calc')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('未知域输出占位说明', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'mystery_domain',
    })
    expect(text).toContain('尚未接入 Agent API')
  })
})
