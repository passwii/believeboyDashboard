import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_TOP_GROUPS,
  findGroupByPathname,
  flattenAllItems,
  getVisibleGroups,
} from './sidebar-config'

/**
 * 运营统一导航断言（2026-09-11 合并「Agent 中心」回运营；
 * 方案见 docs/superpowers/plans/2026-09-11-sidebar-merge-agent-operations/）。
 *
 * 守卫的是使用者可观察的导航契约：分组数量与顺序、总览置顶 / 接入管理置底、
 * 各页面归属与报表自动化唯一归属、URL 不重复。
 */

const groupIds = SIDEBAR_TOP_GROUPS.map((g) => g.id)
const urlsOf = (id: string) =>
  SIDEBAR_TOP_GROUPS.find((g) => g.id === id)?.items.map((i) => i.url) ?? []

describe('SIDEBAR_TOP_GROUPS — 运营统一分组', () => {
  it('顶级分组 9 个且顺序固定（BLF-1234 新增「项目管理」）', () => {
    expect(groupIds).toEqual([
      'operations',
      'project-management',
      'reports',
      'finance',
      'advertising',
      'ai',
      'crm',
      'tools',
      'system',
    ])
    expect(SIDEBAR_TOP_GROUPS.find((g) => g.id === 'agent')).toBeUndefined()
  })

  it('「项目管理」是与「运营」并列的独立顶级分组（BLF-1234）', () => {
    expect(groupIds.indexOf('project-management')).toBe(groupIds.indexOf('operations') + 1)
    expect(urlsOf('project-management')).toEqual([
      '/dashboard/operations/project-launch',
      '/dashboard/operations/project-launch/templates',
    ])
    expect(
      getVisibleGroups(SIDEBAR_TOP_GROUPS, 'admin')
        .find((group) => group.id === 'project-management')
        ?.items.map((item) => item.url)
    ).toContain('/dashboard/operations/project-launch/templates')
    expect(
      getVisibleGroups(SIDEBAR_TOP_GROUPS, 'operator')
        .find((group) => group.id === 'project-management')
        ?.items.map((item) => item.url)
    ).not.toContain('/dashboard/operations/project-launch/templates')
    expect(
      getVisibleGroups(SIDEBAR_TOP_GROUPS)
        .find((group) => group.id === 'project-management')
        ?.items.map((item) => item.url)
    ).not.toContain('/dashboard/operations/project-launch/templates')
    // 项目启动台不挂进运营分组（设计稿 §7：独立顶级分组，唯一入口）。
    expect(urlsOf('operations')).not.toContain('/dashboard/operations/project-launch')
    expect(findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/operations/project-launch')).toBe(
      'project-management'
    )
  })

  it('数据流总览置顶、Agent 接入管理置底', () => {
    const urls = urlsOf('operations')
    expect(urls[0]).toBe('/dashboard/agent-center/overview')
    expect(urls[urls.length - 1]).toBe('/dashboard/system/agent-management')
  })

  it('Agent 体系页面统一归入 operations（跨原三组）', () => {
    const urls = urlsOf('operations')
    expect(urls).toContain('/dashboard/agent-center/employees')
    expect(urls).toContain('/dashboard/operations/complaint-center')
    expect(urls).toContain('/dashboard/operations/platform-inspection')
    expect(urlsOf('system')).not.toContain('/dashboard/system/agent-management')
  })

  it('中段保留各类型业务页面（原有运营项一个不少）', () => {
    const urls = urlsOf('operations')
    expect(urls).toEqual(
      expect.arrayContaining([
        '/dashboard/operations/site-navigation',
        '/dashboard/operations/store-navigation',
        '/dashboard/operations/daily-analysis',
        '/dashboard/operations/return-analysis',
        '/dashboard/operations/project-goals',
        '/dashboard/operations/research-analysis',
        '/dashboard/operations/inventory-analysis',
        '/dashboard/operations/weekly-product-analysis',
        '/dashboard/operations/portfolio-overview',
        '/dashboard/operations/sku-info',
        '/dashboard/operations/inventory-replenishment',
        '/dashboard/operations/inventory-ledger',
        '/dashboard/operations/seasonal-replenishment',
        '/dashboard/operations/shipping-plan',
        '/dashboard/operations/shipment-management',
      ])
    )
  })

  it('发货规划紧邻货件管理之前，两个页面路径独立且稳定', () => {
    const items = SIDEBAR_TOP_GROUPS.find((group) => group.id === 'operations')?.items ?? []
    const planIndex = items.findIndex((item) => item.url === '/dashboard/operations/shipping-plan')
    expect(planIndex).toBeGreaterThanOrEqual(0)
    expect(items[planIndex]?.title).toBe('发货规划')
    expect(items[planIndex + 1]).toMatchObject({
      title: '货件管理',
      url: '/dashboard/operations/shipment-management',
    })
  })

  it('报表自动化回归 reports（紧随定时报告），且不在其他分组', () => {
    const reports = urlsOf('reports')
    expect(reports).toContain('/dashboard/reports/auto-upload')
    expect(reports.indexOf('/dashboard/reports/auto-upload')).toBe(
      reports.indexOf('/dashboard/reports/scheduled-reports') + 1
    )
    expect(urlsOf('operations')).not.toContain('/dashboard/reports/auto-upload')
  })

  it('全分组 URL 无重复', () => {
    const all = flattenAllItems().map((i) => i.url)
    expect(new Set(all).size).toBe(all.length)
  })

  it('品牌备案示例归入工具箱且 URL 唯一', () => {
    const tools = urlsOf('tools')
    expect(tools).toContain('/dashboard/tools/brand-registration-example')
    expect(
      flattenAllItems().filter((item) => item.url === '/dashboard/tools/brand-registration-example')
    ).toHaveLength(1)
    expect(
      findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/tools/brand-registration-example')
    ).toBe('tools')
  })

  it('产品标签制作归入工具箱且 URL 唯一', () => {
    const tools = urlsOf('tools')
    expect(tools).toContain('/dashboard/tools/product-label')
    expect(
      flattenAllItems().filter((item) => item.url === '/dashboard/tools/product-label')
    ).toHaveLength(1)
    expect(findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/tools/product-label')).toBe('tools')
  })

  it('客户消息 /list 子页命中 operations 分组（matchPrefixes）', () => {
    expect(
      findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/operations/complaint-center/list')
    ).toBe('operations')
    expect(
      findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/operations/complaint-center')
    ).toBe('operations')
  })

  it('Agent 员工子页命中 operations 分组（matchPrefixes）', () => {
    expect(findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/agent-center/employees')).toBe(
      'operations'
    )
  })
})
