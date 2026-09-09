import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import AgentEmployeesClient, { projectScopeText } from './employees-client'
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
  it('页面标题由 TerminalHeader 承载,不渲染重复 PageHeader', () => {
    render(<AgentEmployeesClient />)

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.queryByText('Agent 中心 · 员工')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: '员工花名册' })).toBeInTheDocument()
  })
  it('渲染员工行:label / agent_id / 能力域 / 状态', async () => {
    render(<AgentEmployeesClient />)
    expect(await screen.findByText('客服 1 号')).toBeInTheDocument()
    expect(screen.getByText('cs-01')).toBeInTheDocument()
    expect(screen.getByText('全部业务域')).toBeInTheDocument()
    expect(screen.getByText('激活')).toBeInTheDocument()
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
          calls_7d: 3,
          writes_24h: 1,
          writes_7d: 1,
          errors_7d: 0,
          last_active_at: NOW_ISO,
        },
      },
      'ok'
    )
    render(<AgentEmployeesClient />)
    expect(await screen.findByText('巡检员')).toBeInTheDocument()
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    // 停用员工显示;未绑定 agent_id 显示占位文案
    expect(screen.getByText('—（未绑定）')).toBeInTheDocument()
    // 巡检员无活动条目 → 占位(按文本特征断言无第二行数值)
    expect(screen.getAllByText('2 / 3')).toHaveLength(1)
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
