import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import AgentEmployeesClient, { projectScopeText } from './employees-client'
import AgentEmployeesLoading from './loading'
import type { AgentApiKeyItem } from '@/lib/api/agent-key-admin'
import type { EmployeeSummaryMap } from '@/lib/hooks/use-agent-employee-summary'

const listAgentApiKeysMock = vi.hoisted(() => vi.fn())
const useAgentEmployeeSummaryMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/agent-key-admin', () => ({
  listAgentApiKeys: listAgentApiKeysMock,
}))

vi.mock('@/lib/hooks/use-agent-employee-summary', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hooks/use-agent-employee-summary')>(
    '@/lib/hooks/use-agent-employee-summary'
  )
  return { ...actual, useAgentEmployeeSummary: useAgentEmployeeSummaryMock }
})

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
}))

const NOW_ISO = new Date('2026-09-05T12:00:00Z').toISOString()

function makeKey(overrides: Partial<AgentApiKeyItem> = {}): AgentApiKeyItem {
  return {
    id: 1,
    key_prefix: 'blf_abcd',
    label: '客服 1 号',
    scope: '',
    project_scope: '*',
    business_scope: '*',
    agent_id: 'cs-01',
    is_revoked: false,
    expires_at: null,
    created_at: NOW_ISO,
    last_used_at: NOW_ISO,
    deleted_at: null,
    ...overrides,
  }
}

const EMPTY_SUMMARY: EmployeeSummaryMap = {}

function mockSummary(data: EmployeeSummaryMap | null, status: 'ok' | 'error' = data ? 'ok' : 'error') {
  useAgentEmployeeSummaryMock.mockReturnValue({ data, status, reload: vi.fn() })
}

beforeEach(() => {
  listAgentApiKeysMock.mockResolvedValue([makeKey()])
  mockSummary(null)
})

describe('AgentEmployeesClient 员工花名册(P3)', () => {
  it('以 Warm 桌面表格面板呈现,保留只读花名册契约', async () => {
    const { container } = render(<AgentEmployeesClient />)
    await screen.findAllByText('客服 1 号')
    const table = container.querySelector<HTMLTableElement>(
      '[data-agent-employees-table-scroll] table'
    )
    const mobileList = container.querySelector<HTMLDivElement>('[data-mobile-employee-list]')!

    expect(within(table!).getByText('客服 1 号')).toBeInTheDocument()
    expect(container.querySelector('[data-warm-agent-employees="true"]')).toBeInTheDocument()
    expect(table).toBeInTheDocument()
    expect(mobileList).toHaveAttribute('data-mobile-employee-list', 'true')
    const mobileCard = container.querySelector<HTMLElement>(
      '[data-mobile-employee-list] article'
    )!
    expect(within(mobileCard).getByText('客服 1 号')).toBeInTheDocument()
    expect(within(mobileCard).getByText('cs-01')).toBeInTheDocument()
    expect(within(mobileCard).getByText('全部业务域')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
    expect(within(table!).queryByRole('button')).not.toBeInTheDocument()
    expect(listAgentApiKeysMock).toHaveBeenCalledTimes(1)
  })

  it('页面标题由 TerminalHeader 承载,不渲染重复 PageHeader', () => {
    render(<AgentEmployeesClient />)

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByText('Agent 中心 · 员工')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '员工花名册' })).toBeInTheDocument()
  })
  it('渲染员工行:label / agent_id / 能力域 / 状态', async () => {
    const { container } = render(<AgentEmployeesClient />)
    await screen.findAllByText('客服 1 号')
    const table = container.querySelector<HTMLTableElement>(
      '[data-agent-employees-table-scroll] table'
    )!
    expect(within(table).getByText('客服 1 号')).toBeInTheDocument()
    expect(within(table).getByText('cs-01')).toBeInTheDocument()
    expect(within(table).getByText('全部业务域')).toBeInTheDocument()
    expect(within(table).getByText('激活')).toBeInTheDocument()
  })

  it('活动列与花名册按 api_key_id join,未活动员工占位', async () => {
    listAgentApiKeysMock.mockResolvedValue([
      makeKey({ id: 1 }),
      makeKey({ id: 2, label: '巡检员', agent_id: null, is_revoked: true, business_scope: 'complaint_center,platform_inspection' }),
    ])
    mockSummary(
      {
        '1': {
          api_key_id: 1,
          calls_24h: 2,
          calls_30d: 30,
          writes_24h: 1,
          writes_30d: 10,
          errors_30d: 2,
          last_active_at: NOW_ISO,
        },
      },
      'ok'
    )
    const { container } = render(<AgentEmployeesClient />)
    await screen.findAllByText('巡检员')
    const table = container.querySelector<HTMLTableElement>(
      '[data-agent-employees-table-scroll] table'
    )!
    expect(within(table).getByText('巡检员')).toBeInTheDocument()
    expect(within(table).getByText('2 / 30')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '24h/30d 调用' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '30d 错误' })).toBeInTheDocument()
    expect(within(table).getAllByRole('cell')[6]).toHaveTextContent('2')
    expect(within(table).getByText('2 / 30')).toHaveAttribute('title', '写 24h:1 · 写 30d:10')
    expect(screen.getByText('调用量与错误数由 agent 访问审计按凭据聚合(最近 30 天)')).toBeInTheDocument()
    // 停用员工显示;未绑定 agent_id 显示占位文案
    expect(within(table).getByText('—（未绑定）')).toBeInTheDocument()
    // 巡检员无活动条目 → 占位(按文本特征断言无第二行数值)
    expect(within(table).getAllByText('2 / 30')).toHaveLength(1)
    expect(within(table).getByText('30 天内无调用')).toBeInTheDocument()
    expect(within(table).getAllByRole('cell')[14]).toHaveTextContent('0')

    // 手机卡片可见写入量与非零错误负向颜色回归断言
    const mobileCards = container.querySelectorAll<HTMLElement>(
      '[data-mobile-employee-list] article'
    )
    expect(mobileCards).toHaveLength(2)
    const activeCard = mobileCards[0]
    expect(within(activeCard).getByText('24h/30d 调用')).toBeInTheDocument()
    expect(within(activeCard).getByText('2 / 30')).toBeInTheDocument()
    expect(within(activeCard).getByText('24h/30d 写入')).toBeInTheDocument()
    expect(within(activeCard).getByText('1 / 10')).toBeInTheDocument()
    const errorDd = within(activeCard).getByText('2')
    expect(errorDd).toHaveAttribute('data-tone', 'negative')
    expect(errorDd.className).toContain('negativeValue')

    const inactiveCard = mobileCards[1]
    expect(within(inactiveCard).getAllByText('30 天内无调用')).toHaveLength(2)
    expect(within(inactiveCard).getByText('0')).toHaveAttribute('data-tone', 'muted')
  })

  it('活动统计请求失败时显示未知占位而不误报无调用', async () => {
    mockSummary(null, 'error')
    const { container } = render(<AgentEmployeesClient />)
    await screen.findAllByText('客服 1 号')
    const table = container.querySelector<HTMLTableElement>(
      '[data-agent-employees-table-scroll] table'
    )!
    expect(within(table).getByText('客服 1 号')).toBeInTheDocument()
    expect(within(table).getAllByText('—')).toHaveLength(2)
    expect(within(table).getAllByRole('cell')[5]).toHaveTextContent('—')
    expect(within(table).getAllByRole('cell')[6]).toHaveTextContent('—')
    expect(screen.queryByText('30 天内无调用')).not.toBeInTheDocument()
    expect(screen.getByText('活动统计暂不可用；接入后展示最近 30 天')).toBeInTheDocument()
  })

  it('花名册加载失败 → 错误提示', async () => {
    listAgentApiKeysMock.mockRejectedValue(new Error('boom'))
    render(<AgentEmployeesClient />)
    expect(await screen.findByText(/凭据花名册加载失败/)).toBeInTheDocument()
  })

  it('空花名册 → 引导去接入管理创建', async () => {
    listAgentApiKeysMock.mockResolvedValue([])
    render(<AgentEmployeesClient />)
    expect(await screen.findByText(/暂无 Agent 员工/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Agent 接入管理' }).getAttribute('href')).toBe(
      '/dashboard/system/agent-management'
    )
  })

  it('projectScopeText 纯函数', () => {
    expect(projectScopeText('*')).toBe('全部项目')
    expect(projectScopeText('')).toBe('全部项目')
    expect(projectScopeText(null)).toBe('全部项目')
    expect(projectScopeText('1,2,3')).toBe('3 个项目')
  })
})

describe('Agent Employees Warm styling contract', () => {
  it('keeps the 8-column table geometry during the Warm loading state', () => {
    const { container } = render(<AgentEmployeesLoading />)
    const table = container.querySelector('table')

    expect(container.querySelector('[data-warm-agent-employees-loading="true"]')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('正在加载 Agent 员工')
    expect(table).toBeInTheDocument()
    expect(table?.querySelectorAll('col')).toHaveLength(8)
    expect(table?.querySelectorAll('thead th')).toHaveLength(8)

    const rows = table?.querySelectorAll('tbody tr') ?? []
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      expect(row.querySelectorAll('td')).toHaveLength(8)
    }
  })

  it('uses Warm tokens and a contained sticky table with a phone breakpoint', () => {
    const cssPath = join(__dirname, 'employees-warm.module.css')
    const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).toContain('var(--warm-ledger-font-variant-numeric)')
    expect(css).toContain('position: sticky')
    expect(css).toContain('overflow: auto')
    expect(css).toContain('.mobileActivityGrid dd.negativeValue')
    expect(css).toContain('color: var(--warm-ledger-color-negative)')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('rounded-none')
    expect(css).toContain('@media (max-width: 767px)')
  })
})
