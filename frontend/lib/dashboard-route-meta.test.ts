import { describe, expect, it } from 'vitest'

import { getDashboardPageTitle } from './dashboard-route-meta'

describe('getDashboardPageTitle', () => {
  it('品牌备案示例路由显示对应标题', () => {
    expect(getDashboardPageTitle('/dashboard/tools/brand-registration-example')).toBe('品牌备案示例')
  })
})
