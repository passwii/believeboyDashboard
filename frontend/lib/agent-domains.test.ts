import { describe, expect, it } from 'vitest'

import {
  AGENT_DOMAINS,
  BUSINESS_SCOPE_ALL,
  formatBusinessScope,
  getAgentDomain,
  liveAgentDomains,
  normalizeBusinessScope,
  scopeHasDomain,
} from './agent-domains'

describe('normalizeBusinessScope', () => {
  it('空串 / 空白 → 全部业务域 *', () => {
    expect(normalizeBusinessScope('')).toBe('*')
    expect(normalizeBusinessScope('   ')).toBe('*')
  })

  it('null / undefined → 全部业务域 *', () => {
    expect(normalizeBusinessScope(null)).toBe('*')
    expect(normalizeBusinessScope(undefined)).toBe('*')
  })

  it('* 保持原样', () => {
    expect(normalizeBusinessScope('*')).toBe('*')
    expect(normalizeBusinessScope(' * ')).toBe('*')
  })

  it('白名单保持逗号分隔域 code', () => {
    expect(normalizeBusinessScope('shipments,shop_calculations')).toBe(
      'shipments,shop_calculations'
    )
  })
})

describe('getAgentDomain', () => {
  it('已知域返回注册表条目', () => {
    expect(getAgentDomain('shipments')?.label).toBe('货件管理')
    expect(getAgentDomain('shop_calculations')?.status).toBe('live')
  })

  it('未知域返回 undefined', () => {
    expect(getAgentDomain('not_a_domain')).toBeUndefined()
  })
})

describe('scopeHasDomain', () => {
  it('* 恒为 true', () => {
    expect(scopeHasDomain('*', 'shipments')).toBe(true)
    expect(scopeHasDomain('*', 'return_analysis')).toBe(true)
  })

  it('白名单命中返回 true', () => {
    expect(scopeHasDomain('shipments,shop_calculations', 'shipments')).toBe(true)
    expect(scopeHasDomain('shipments', 'shipments')).toBe(true)
  })

  it('白名单未命中返回 false', () => {
    expect(scopeHasDomain('shipments', 'shop_calculations')).toBe(false)
    expect(scopeHasDomain('', 'shipments')).toBe(true) // 空串归一为 *
  })
})

describe('formatBusinessScope', () => {
  it('* 格式化为全部业务域', () => {
    expect(formatBusinessScope('*')).toBe('全部业务域')
    expect(formatBusinessScope(null)).toBe('全部业务域')
  })

  it('白名单映射为中文名', () => {
    expect(formatBusinessScope('shipments,shop_calculations')).toBe('货件管理、店铺测算')
  })

  it('未知 code 回退为 #code', () => {
    expect(formatBusinessScope('mystery')).toBe('#mystery')
  })
})

describe('AGENT_DOMAINS 注册表', () => {
  it('live 域包含 shipments、shop_calculations、return_analysis 与 inventory', () => {
    const live = liveAgentDomains()
    expect(live.map((d) => d.code)).toEqual(
      expect.arrayContaining([
        'shipments',
        'shop_calculations',
        'return_analysis',
        'inventory',
      ])
    )
  })

  it('return_analysis 已翻 live 且 routeCount=5（BLF-474）', () => {
    const domain = getAgentDomain('return_analysis')
    expect(domain?.status).toBe('live')
    expect(domain?.routeCount).toBe(5)
    expect(domain?.capabilities).toEqual({ read: true, write: false })
  })

  it('inventory 已翻 live 且 routeCount=1、纯读（BLF-478）', () => {
    const domain = getAgentDomain('inventory')
    expect(domain?.status).toBe('live')
    expect(domain?.label).toBe('库存信息')
    expect(domain?.routeCount).toBe(1)
    expect(domain?.capabilities).toEqual({ read: true, write: false })
  })

  it('inventory_ledger 已翻 live 且 routeCount=10、纯读（BLF-485）', () => {
    const domain = getAgentDomain('inventory_ledger')
    expect(domain?.status).toBe('live')
    expect(domain?.label).toBe('库存台账')
    expect(domain?.routeCount).toBe(10)
    expect(domain?.capabilities).toEqual({ read: true, write: false })
  })

  it('report_upload_status 已接入且 routeCount=1、纯读（BLF-484）', () => {
    const domain = getAgentDomain('report_upload_status')
    expect(domain?.status).toBe('live')
    expect(domain?.label).toBe('报表状态')
    expect(domain?.routeCount).toBe(1)
    expect(domain?.capabilities).toEqual({ read: true, write: false })
  })

  it('replenishment_analysis 已接入且 routeCount=6、读写（BLF-502）', () => {
    const domain = getAgentDomain('replenishment_analysis')
    expect(domain?.status).toBe('live')
    expect(domain?.label).toBe('补货分析')
    expect(domain?.routeCount).toBe(6)
    expect(domain?.capabilities).toEqual({ read: true, write: true })
  })

  it('new_product_calculations 已接入且 routeCount=5、读写（BLF-526）', () => {
    const domain = getAgentDomain('new_product_calculations')
    expect(domain?.status).toBe('live')
    expect(domain?.label).toBe('新品测算')
    expect(domain?.routeCount).toBe(5)
    expect(domain?.capabilities).toEqual({ read: true, write: true })
  })

  it('ad_analysis 已翻 live 且 routeCount=10、纯读（BLF-490）', () => {
    const domain = getAgentDomain('ad_analysis')
    expect(domain?.status).toBe('live')
    expect(domain?.label).toBe('广告分析')
    expect(domain?.routeCount).toBe(10)
    expect(domain?.capabilities).toEqual({ read: true, write: false })
  })

  it('注册表有规划中域（roadmap 待迁移）', () => {
    expect(AGENT_DOMAINS.some((d) => d.status === 'planned')).toBe(true)
  })

  it('全域哨兵值与后端 server_default 一致', () => {
    expect(BUSINESS_SCOPE_ALL).toBe('*')
  })
})
