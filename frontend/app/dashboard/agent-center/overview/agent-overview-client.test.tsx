import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import AgentOverviewClient from './agent-overview-client'
import { productionCell } from './agent-overview-client'
import { formatRelativeTime } from '@/lib/hooks/use-agent-domain-summary'
import { AGENT_DOMAINS } from '@/lib/agent-domains'
import type { AgentProduction } from '@/lib/hooks/use-agent-production'
import type { DomainSummaryMap } from '@/lib/hooks/use-agent-domain-summary'

const useAgentDomainSummaryMock = vi.hoisted(() => vi.fn())
const useAgentProductionMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/hooks/use-agent-domain-summary', async () => {
  // 只 mock hook(数据来源);freshnessFor 等纯函数走真实实现
  const actual = await vi.importActual<typeof import('@/lib/hooks/use-agent-domain-summary')>(
    '@/lib/hooks/use-agent-domain-summary'
  )
  return { ...actual, useAgentDomainSummary: useAgentDomainSummaryMock }
})

vi.mock('@/lib/hooks/use-agent-production', () => ({
  useAgentProduction: useAgentProductionMock,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
}))

function mockSummary(data: DomainSummaryMap | null, status: 'ok' | 'error' = data ? 'ok' : 'error') {
  useAgentDomainSummaryMock.mockReturnValue({ data, status, reload: vi.fn() })
}

function mockProduction(overrides: Partial<AgentProduction> = {}) {
  useAgentProductionMock.mockReturnValue({
    complaints: { hasRun: false, needsReply: null, status: 'error' },
    inspection: { submitted: null, total: null, status: 'error' },
    reports: { uploaded: null, total: null, status: 'error' },
    loading: false,
    reload: vi.fn(),
    ...overrides,
  })
}

beforeEach(() => {
  mockSummary(null)
  mockProduction()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentOverviewClient 数据流总览', () => {
  it('页面标题由 TerminalHeader 承载,不渲染重复 PageHeader', () => {
    render(<AgentOverviewClient />)

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByText('Agent 中心 · 数据流')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '业务域活动矩阵' })).toBeInTheDocument()
    expect(
      screen.getByText(
        '17 个业务域、16 个已接入 —— Agent 员工在各业务域活动的归集点,点击入口前往对应工作台。 「今日产出」为实时业务数据(客诉概览 / 巡检周期 / 报表完成度);运行时活动列(最近活动 / 24h·7d 调用量 / 7d 错误率)由 domain-summary 端点驱动(契约见 docs/superpowers/plans/2026-09-05-agent-dataflow-overview §P2b),端点上线前显示占位「—」。'
      )
    ).toBeInTheDocument()
  })
  it('每个注册表域渲染一行(16 域 + 表头)', () => {
    render(<AgentOverviewClient />)
    expect(screen.getAllByRole('row')).toHaveLength(AGENT_DOMAINS.length + 1)
  })

  it('产出域置顶:客户消息是第一行业务域', () => {
    render(<AgentOverviewClient />)
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('客户消息')
  })

  it('A 档产出域与 B 档工作台域都给出入口链接', () => {
    render(<AgentOverviewClient />)
    expect(screen.getByRole('link', { name: '打开客户消息' }).getAttribute('href')).toBe(
      '/dashboard/operations/complaint-center'
    )
    expect(screen.getByRole('link', { name: '打开库存台账' }).getAttribute('href')).toBe(
      '/dashboard/operations/inventory-ledger'
    )
  })

  it('规划中域(finance_profit)显示规划中且无入口链接', () => {
    render(<AgentOverviewClient />)
    expect(screen.getByText('规划中')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '打开财务利润' })).not.toBeInTheDocument()
  })

  it('已接入域的入口链接数 = 有 dashboardPath 的 live 域数', () => {
    render(<AgentOverviewClient />)
    const expected = AGENT_DOMAINS.filter((d) => d.status === 'live' && d.dashboardPath).length
    expect(screen.getAllByRole('link', { name: /^打开/ })).toHaveLength(expected)
  })

  it('聚合数据缺位时运行时三列降级为占位(P2b 端点未上线)', () => {
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
})

describe('今日产出列(P2c-1)', () => {
  it('客诉:有 run 展示待回复数,无 run 占位', () => {
    const first = render(<AgentOverviewClient />)
    expect(screen.queryByText(/待回复/)).not.toBeInTheDocument()
    first.unmount()

    mockProduction({
      complaints: { hasRun: true, needsReply: 3, status: 'ok' },
    })
    render(<AgentOverviewClient />)
    expect(screen.getByText('待回复 3')).toBeInTheDocument()
  })

  it('巡检与报表产出单元格点亮(共享域各两行)', () => {
    mockProduction({
      inspection: { submitted: 2, total: 5, status: 'ok' },
      reports: { uploaded: 8, total: 15, status: 'ok' },
    })
    render(<AgentOverviewClient />)
    // platform_inspection + account_health 共用巡检单元格;report_upload + report_upload_status 共用报表单元格
    expect(screen.getAllByText('2/5 报告')).toHaveLength(2)
    expect(screen.getAllByText('8/15 报表')).toHaveLength(2)
  })

  it('productionCell 纯函数:非产出域与无 run 客诉返回 null', () => {
    const fullProduction: AgentProduction = {
      complaints: { hasRun: true, needsReply: 3, status: 'ok' },
      inspection: { submitted: 2, total: 5, status: 'ok' },
      reports: { uploaded: 8, total: 15, status: 'ok' },
      loading: false,
      reload: vi.fn(),
    }
    expect(productionCell('shipments', null)).toBeNull()
    expect(productionCell('shipments', fullProduction)).toBeNull()
    expect(productionCell('complaint_center', fullProduction)?.text).toBe('待回复 3')
    expect(
      productionCell('complaint_center', {
        ...fullProduction,
        complaints: { hasRun: false, needsReply: 0, status: 'ok' },
      })
    ).toBeNull()
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
