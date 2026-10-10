import { describe, expect, it } from 'vitest'

import { getDashboardPageTitle } from './dashboard-route-meta'

describe('getDashboardPageTitle', () => {
  it('品牌备案示例路由显示对应标题', () => {
    expect(getDashboardPageTitle('/dashboard/tools/brand-registration-example')).toBe('品牌备案示例')
  })

  it('产品标签制作路由显示对应标题', () => {
    expect(getDashboardPageTitle('/dashboard/tools/product-label')).toBe('产品标签制作')
  })

  it('Shipping Plan 与 Shipment Management 使用准确标题且保留原页面路由', () => {
    expect(getDashboardPageTitle('/dashboard/operations/shipping-plan')).toBe('发货规划')
    expect(getDashboardPageTitle('/dashboard/operations/shipment-management')).toBe('货件管理')
  })

  it('流程模板管理子路由不被项目启动台父路由抢先匹配', () => {
    expect(getDashboardPageTitle('/dashboard/operations/project-launch/templates')).toBe(
      '流程模板管理'
    )
  })
})
