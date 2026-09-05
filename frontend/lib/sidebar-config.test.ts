import { describe, expect, it } from 'vitest'
import { SIDEBAR_TOP_GROUPS, findGroupByPathname, flattenAllItems } from './sidebar-config'

const groupIds = SIDEBAR_TOP_GROUPS.map((g) => g.id)

/** Agent 中心分组（2026-09-05，方案见 docs/superpowers/plans/2026-09-05-agent-center-sidebar/） */
describe('SIDEBAR_TOP_GROUPS — Agent 中心分组', () => {
  it('新增 agent 顶级分组，位于 ai 与 crm 之间', () => {
    expect(groupIds).toContain('agent')
    expect(groupIds.indexOf('agent')).toBe(groupIds.indexOf('ai') + 1)
    expect(groupIds.indexOf('crm')).toBe(groupIds.indexOf('agent') + 1)
  })

  it('数据流总览 + A 档四项归入 agent 组（总览居首）', () => {
    const agent = SIDEBAR_TOP_GROUPS.find((g) => g.id === 'agent')
    expect(agent?.label).toBe('Agent 中心')
    expect(agent?.items.map((i) => i.url)).toEqual([
      '/dashboard/agent-center/overview',
      '/dashboard/operations/complaint-center',
      '/dashboard/operations/platform-inspection',
      '/dashboard/reports/auto-upload',
      '/dashboard/system/agent-management',
    ])
  })

  it('原分组不再保留已迁出项', () => {
    const urlsOf = (id: string) =>
      SIDEBAR_TOP_GROUPS.find((g) => g.id === id)?.items.map((i) => i.url) ?? []
    expect(urlsOf('operations')).not.toContain('/dashboard/operations/complaint-center')
    expect(urlsOf('operations')).not.toContain('/dashboard/operations/platform-inspection')
    expect(urlsOf('reports')).not.toContain('/dashboard/reports/auto-upload')
    expect(urlsOf('system')).not.toContain('/dashboard/system/agent-management')
  })

  it('全分组 URL 无重复', () => {
    const all = flattenAllItems().map((i) => i.url)
    expect(new Set(all).size).toBe(all.length)
  })

  it('客诉中心 /list 子页命中 agent 分组（matchPrefixes）', () => {
    expect(
      findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/operations/complaint-center/list')
    ).toBe('agent')
    expect(
      findGroupByPathname(SIDEBAR_TOP_GROUPS, '/dashboard/operations/complaint-center')
    ).toBe('agent')
  })
})
