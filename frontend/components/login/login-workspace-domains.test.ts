import { describe, expect, it } from 'vitest'

import { SIDEBAR_TOP_GROUPS } from '@/lib/sidebar-config'
import { LOGIN_WORKSPACE_DOMAINS } from './login-workspace-domains'

/**
 * 登录页工作区地图是 `SIDEBAR_TOP_GROUPS` 的轻量副本（登录页不引入 sidebar-config 以避开
 * CRM badge 轮询组件）。本测试守卫两者不漂移：权威源改 id / label / 顺序 / 模块名时在此失败。
 */
describe('登录页工作区地图与 sidebar 权威源一致', () => {
  it('业务域 id、label 与顺序逐项一致', () => {
    expect(LOGIN_WORKSPACE_DOMAINS.map((domain) => domain.id)).toEqual(
      SIDEBAR_TOP_GROUPS.map((group) => group.id)
    )
    expect(LOGIN_WORKSPACE_DOMAINS.map((domain) => domain.label)).toEqual(
      SIDEBAR_TOP_GROUPS.map((group) => group.label)
    )
  })

  it('每个域的预览模块名都真实存在于该域 items 中', () => {
    for (const domain of LOGIN_WORKSPACE_DOMAINS) {
      const group = SIDEBAR_TOP_GROUPS.find((candidate) => candidate.id === domain.id)
      const titles = group?.items.map((item) => item.title) ?? []
      expect(domain.modules.length).toBeGreaterThan(0)
      for (const moduleTitle of domain.modules) {
        expect(titles).toContain(moduleTitle)
      }
    }
  })
})
