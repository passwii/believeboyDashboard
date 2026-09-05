import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import AgentOverviewClient, { formatRelativeTime } from './agent-overview-client'
import { AGENT_DOMAINS } from '@/lib/agent-domains'
import type { DomainSummaryMap } from '@/lib/hooks/use-agent-domain-summary'

const useAgentDomainSummaryMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/hooks/use-agent-domain-summary', async () => {
  // 只 mock hook(数据来源);freshnessFor 等纯函数走真实实现
  const actual = await vi.importActual<typeof import('@/lib/hooks/use-agent-domain-summary')>(
    '@/lib/hooks/use-agent-domain-summary'
  )
  return { ...actual, useAgentDomainSummary: useAgentDomainSummaryMock }
})

function mockSummary(data: DomainSummaryMap | null, status: 'ok' | 'error' = data ? 'ok' : 'error') {
  useAgentDomainSummaryMock.mockReturnValue({ data, status })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentOverviewClient 数据流总览', () => {
  it('每个注册表域渲染一行(16 域 + 表头)', () => {
    mockSummary(null)
    render(<AgentOverviewClient />)
    expect(screen.getAllByRole('row')).toHaveLength(AGENT_DOMAINS.length + 1)
  })

  it('产出域置顶:客诉中心是第一行业务域', () => {
    mockSummary(null)
    render(<AgentOverviewClient />)
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('客诉中心')
  })

  it('A 档产出域与 B 档工作台域都给出入口链接', () => {
    mockSummary(null)
    render(<AgentOverviewClient />)
    expect(screen.getByRole('link', { name: '打开客诉中心' }).getAttribute('href')).toBe(
      '/dashboard/operations/complaint-center'
    )
    expect(screen.getByRole('link', { name: '打开库存台账' }).getAttribute('href')).toBe(
      '/dashboard/operations/inventory-ledger'
    )
  })

  it('规划中域(finance_profit)显示规划中且无入口链接', () => {
    mockSummary(null)
    render(<AgentOverviewClient />)
    expect(screen.getByText('规划中')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '打开财务利润' })).not.toBeInTheDocument()
  })

  it('已接入域的入口链接数 = 有 dashboardPath 的 live 域数', () => {
    mockSummary(null)
    render(<AgentOverviewClient />)
    const expected = AGENT_DOMAINS.filter((d) => d.status === 'live' && d.dashboardPath).length
    expect(screen.getAllByRole('link', { name: /^打开/ })).toHaveLength(expected)
  })

  it('聚合数据缺位时运行时三列降级为占位(P2b 端点未上线)', () => {
    mockSummary(null)
    render(<AgentOverviewClient />)
    // 无任何 "N / N" 调用量与百分比特征
    expect(screen.queryByText(/^\d+ \/ \d+$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument()
  })

  it('聚合数据就位时点亮:调用量 / 错误率着色 / 新鲜度相对时间', () => {
    const now = Date.now()
    mockSummary(
      {
        complaint_center: {
          domain: 'complaint_center',
          calls_24h: 12,
          calls_7d: 89,
          writes_24h: 2,
          writes_7d: 14,
          errors_7d: 0,
          last_active_at: new Date(now - 3 * 3_600_000).toISOString(),
        },
        sku_info: {
          domain: 'sku_info',
          calls_24h: 3,
          calls_7d: 23,
          writes_24h: 1,
          writes_7d: 5,
          errors_7d: 3,
          last_active_at: new Date(now - 2 * 86_400_000).toISOString(),
        },
      },
      'ok'
    )
    render(<AgentOverviewClient />)
    expect(screen.getByText('12 / 89')).toBeInTheDocument()
    expect(screen.getByText('3 / 23')).toBeInTheDocument()
    expect(screen.getByText('3 小时前')).toBeInTheDocument()
    expect(screen.getByText('2 天前')).toBeInTheDocument()
    // 零错误 → 常规色;有错 → 告警色
    expect(screen.getByText('0%')).toBeInTheDocument()
    const errCell = screen.getByText('13%')
    expect(errCell.className).toContain('text-term-neg')
  })

  it('formatRelativeTime 纯函数:分 / 时 / 天 / 日期分层', () => {
    const now = new Date('2026-09-05T12:00:00Z')
    expect(formatRelativeTime('2026-09-05T11:59:40Z', now)).toBe('刚刚')
    expect(formatRelativeTime('2026-09-05T11:55:00Z', now)).toBe('5 分钟前')
    expect(formatRelativeTime('2026-09-05T09:00:00Z', now)).toBe('3 小时前')
    expect(formatRelativeTime('2026-09-03T12:00:00Z', now)).toBe('2 天前')
    expect(formatRelativeTime('2026-07-01T08:00:00Z', now)).toBe('7/1')
    expect(formatRelativeTime(null, now)).toBe('从未')
    expect(formatRelativeTime('garbage', now)).toBe('从未')
  })
})
