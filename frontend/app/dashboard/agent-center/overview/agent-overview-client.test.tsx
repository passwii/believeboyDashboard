import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import AgentOverviewClient from './agent-overview-client'
import { productionCell } from './agent-overview-client'
import AgentOverviewLoading from './loading'
import { formatRelativeTime } from '@/lib/hooks/use-agent-domain-summary'
import { AGENT_DOMAINS } from '@/lib/agent-domains'
import type { AgentProduction } from '@/lib/hooks/use-agent-production'
import type { DomainSummaryMap, DomainSummaryStatus } from '@/lib/hooks/use-agent-domain-summary'

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

function mockSummary(data: DomainSummaryMap | null, status: DomainSummaryStatus = data ? 'ok' : 'error') {
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AgentOverviewClient 数据流总览', () => {
  it('以 Warm 桌面表格面板呈现,保留只读数据入口', () => {
    const { container } = render(<AgentOverviewClient />)

    expect(container.querySelector('[data-warm-agent-overview="true"]')).toBeInTheDocument()
    expect(container.querySelector('[data-agent-overview-table-scroll] table')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(useAgentDomainSummaryMock).toHaveBeenCalled()
    expect(useAgentProductionMock).toHaveBeenCalled()
  })

  it('页面标题由 TerminalHeader 承载,不渲染重复 PageHeader', () => {
    render(<AgentOverviewClient />)

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByText('Agent 中心 · 数据流')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '业务域活动矩阵' })).toBeInTheDocument()
    expect(
      screen.getByText(
        '共 19 个业务域、18 个已接入,产出域置顶。 「今日产出」为实时业务数据,运行时活动与 30d 错误率由 domain-summary 提供;已接入域在 30 天内无调用时显示 0 和「无调用」,接口不可用时显示「—」。'
      )
    ).toBeInTheDocument()
  })
  it('每个注册表域渲染一行(19 域 + 表头)', () => {
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
    const row = screen.getByRole('row', { name: /客户消息/ })
    // 无调用量 / 错误率特征,运行时列(24h / 30d / 错误)显示占位
    expect(within(row).queryByText(/^\d+ \/ \d+$/)).not.toBeInTheDocument()
    expect(within(row).queryByText(/^\d+%$/)).not.toBeInTheDocument()
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(3)
  })

  it('接口成功但无活动的域显示零调用与明确的无活动状态', () => {
    mockSummary({}, 'ok')
    render(<AgentOverviewClient />)

    const row = screen.getByRole('row', { name: /货件管理/ })
    const cells = within(row).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('30 天内无调用')
    expect(cells[5]).toHaveTextContent('0')
    expect(cells[6]).toHaveTextContent('0')
    expect(cells[7]).toHaveTextContent('无调用')
    expect(cells[7]).toHaveAttribute('title', '30 天内无调用，错误率不可计算')
  })

  it.each([
    { calls24h: 4, calls30d: 20, errors30d: 5, rate: '25%' },
    { calls24h: 2, calls30d: 8, errors30d: 8, rate: '100%' },
  ])('月报行展示真实活动与 $rate 错误率,不伪造今日产出', ({ calls24h, calls30d, errors30d, rate }) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
    mockSummary({
      monthly_reports: {
        domain: 'monthly_reports',
        calls_24h: calls24h,
        calls_30d: calls30d,
        writes_24h: 1,
        writes_30d: 3,
        errors_30d: errors30d,
        last_active_at: '2026-10-10T10:00:00Z',
      },
    })
    mockProduction({ reports: { uploaded: 8, total: 15, status: 'ok' } })
    render(<AgentOverviewClient />)

    const row = screen.getByRole('row', { name: /财务月报/ })
    const cells = within(row).getAllByRole('cell')
    expect(within(cells[2]).getByText('读')).toBeInTheDocument()
    expect(within(cells[2]).getByText('写')).toBeInTheDocument()
    expect(cells[3]).toHaveTextContent(/^16$/)
    expect(cells[4]).toHaveTextContent('2 小时前')
    expect(cells[5]).toHaveTextContent(String(calls24h))
    expect(cells[5]).toHaveAttribute('title', '写 24h:1')
    expect(cells[6]).toHaveTextContent(String(calls30d))
    expect(cells[6]).toHaveAttribute('title', '写 30d:3')
    expect(cells[7]).toHaveAttribute('title', `${errors30d} 次错误 / ${calls30d} 次调用`)
    expect(within(cells[7]).getByText(rate)).toHaveAttribute('data-tone', 'negative')
    expect(cells[8]).toHaveTextContent(/^—$/)
    expect(cells[9]).toHaveTextContent('已接入')
    expect(within(row).getByRole('link', { name: '打开财务月报' })).toHaveAttribute(
      'href',
      '/dashboard/reports/monthly-report/display'
    )
  })

  it('月报在成功的 summary 中缺位时显示真实零调用,不显示 0% 错误率', () => {
    mockSummary({})
    render(<AgentOverviewClient />)

    const row = screen.getByRole('row', { name: /财务月报/ })
    const cells = within(row).getAllByRole('cell')
    expect(cells[4]).toHaveTextContent('30 天内无调用')
    expect(cells[5]).toHaveTextContent(/^0$/)
    expect(cells[6]).toHaveTextContent(/^0$/)
    expect(cells[7]).toHaveTextContent('无调用')
    expect(cells[7]).toHaveAttribute('title', '30 天内无调用，错误率不可计算')
    expect(within(row).queryByText('0%')).not.toBeInTheDocument()
    expect(cells[8]).toHaveTextContent(/^—$/)
  })

  it.each(['loading', 'error'] as const)('summary 为 %s 时月报活动保持未知占位,不当作零调用', (status) => {
    mockSummary(null, status)
    render(<AgentOverviewClient />)

    const row = screen.getByRole('row', { name: /财务月报/ })
    const cells = within(row).getAllByRole('cell')
    for (const index of [4, 5, 6, 7, 8]) {
      expect(cells[index]).toHaveTextContent(/^—$/)
    }
    expect(within(row).queryByText('0')).not.toBeInTheDocument()
    expect(within(row).queryByText('无调用')).not.toBeInTheDocument()
    expect(cells[9]).toHaveTextContent('已接入')
  })

  it('聚合数据就位时点亮:调用量 / 错误率着色 / 新鲜度相对时间', () => {
    const now = Date.now()
    mockSummary(
      {
        complaint_center: {
          domain: 'complaint_center',
          calls_24h: 12,
          calls_30d: 89,
          writes_24h: 2,
          writes_30d: 14,
          errors_30d: 0,
          last_active_at: new Date(now - 3 * 3_600_000).toISOString(),
        },
        sku_info: {
          domain: 'sku_info',
          calls_24h: 3,
          calls_30d: 23,
          writes_24h: 1,
          writes_30d: 5,
          errors_30d: 3,
          last_active_at: new Date(now - 2 * 86_400_000).toISOString(),
        },
      },
      'ok'
    )
    render(<AgentOverviewClient />)
    // 调用量拆为 24h / 30d 两个数字列（右对齐）
    const complaintRow = screen.getByRole('row', { name: /客户消息/ })
    expect(within(complaintRow).getByText('12')).toBeInTheDocument()
    expect(within(complaintRow).getByText('89')).toBeInTheDocument()
    const skuRow = screen.getByRole('row', { name: /SKU 主数据/ })
    expect(within(skuRow).getByText('3')).toBeInTheDocument()
    expect(within(skuRow).getByText('23')).toBeInTheDocument()
    expect(screen.getByText('3 小时前')).toBeInTheDocument()
    expect(screen.getByText('2 天前')).toBeInTheDocument()
    // 零错误 → 常规色;有错 → 告警色
    expect(screen.getByText('0%')).toBeInTheDocument()
    const errCell = screen.getByText('13%')
    expect(errCell).toHaveAttribute('data-tone', 'negative')
  })
})

describe('Agent Overview Warm styling contract', () => {
  it('keeps the 11-column table geometry during the Warm loading state', () => {
    const { container } = render(<AgentOverviewLoading />)
    const table = container.querySelector('table')

    expect(container.querySelector('[data-warm-agent-overview-loading="true"]')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Agent 数据流总览')
    expect(table).toBeInTheDocument()
    expect(table?.querySelectorAll('col')).toHaveLength(11)
    expect(table?.querySelectorAll('thead th')).toHaveLength(11)

    const rows = table?.querySelectorAll('tbody tr') ?? []
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      expect(row.querySelectorAll('td')).toHaveLength(11)
    }
  })

  it('uses Warm tokens and a contained sticky table with a phone breakpoint', () => {
    const cssPath = join(__dirname, 'agent-overview-warm.module.css')
    const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('var(--warm-ledger-font-variant-numeric)')
    expect(css).toContain('position: sticky')
    expect(css).toContain('overflow: auto')
    expect(css).toMatch(/\.table th\.numeric\s*\{[^}]*text-align:\s*right/)
    expect(css).toMatch(/\.table th\.center\s*\{[^}]*text-align:\s*center/)
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('rounded-none')
    expect(css).toContain('@media (max-width: 767px)')
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
    expect(productionCell('monthly_reports', fullProduction)).toBeNull()
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
