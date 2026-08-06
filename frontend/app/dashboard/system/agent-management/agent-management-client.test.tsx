import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── 模块级 mock（防 effect 无限重跑：BLF-450 教训）───────────────────
const { mockKeys } = vi.hoisted(() => ({
  mockKeys: [
    {
      id: 1,
      key_prefix: 'bbx_ab12',
      label: '货件助理 (生产)',
      scope: 'read',
      project_scope: '*',
      business_scope: '*',
      agent_id: 'shipment-assistant-prod',
      is_revoked: false,
      expires_at: null,
      created_at: '2026-08-01T00:00:00Z',
      last_used_at: '2026-08-05T00:00:00Z',
    },
    {
      id: 2,
      key_prefix: 'bbx_cd34',
      label: '测算 Agent (测试)',
      scope: 'read',
      project_scope: '12',
      business_scope: 'shop_calculations',
      agent_id: 'shop-calc-test',
      is_revoked: false,
      expires_at: null,
      created_at: '2026-08-02T00:00:00Z',
      last_used_at: null,
    },
    {
      id: 3,
      key_prefix: 'bbx_ef56',
      label: '货件专用 (只读)',
      scope: 'read',
      project_scope: '*',
      business_scope: 'shipments',
      agent_id: 'shipment-readonly',
      is_revoked: false,
      expires_at: null,
      created_at: '2026-08-03T00:00:00Z',
      last_used_at: null,
    },
  ],
}))

vi.mock('@/lib/api/agent-key-admin', () => ({
  listAgentApiKeys: vi.fn().mockResolvedValue(mockKeys),
  createAgentApiKey: vi.fn().mockResolvedValue({
    ...mockKeys[0],
    plaintext_key: 'bbx_new_secret',
  }),
  revokeAgentApiKey: vi.fn().mockResolvedValue(undefined),
  normalizeProjectScope: (s: string | null | undefined) => (s && s.trim() && s !== '*' ? s : '*'),
  normalizeBusinessScope: (s: string | null | undefined) => (s && s.trim() && s !== '*' ? s : '*'),
}))

vi.mock('@/lib/hooks/use-managed-projects', () => ({
  useManagedProjects: () => ({
    projects: [
      { id: 12, name: '测试项目' },
      { id: 13, name: '第二个项目' },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: vi.fn() }),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}))

vi.mock('./agent-usage-guide', () => ({
  AgentUsageGuide: () => <div data-testid="usage-guide" />,
  buildUsageText: vi.fn().mockReturnValue('usage-text'),
  fetchBackendBaseUrl: vi.fn().mockResolvedValue('https://api.example.com'),
}))

vi.mock('@/components/system/agent-access-logs-panel', () => ({
  AgentAccessLogsPanel: () => <div data-testid="access-logs-panel" />,
}))

vi.mock('@/components/system/agent-operation-logs-panel', () => ({
  AgentOperationLogsPanel: () => <div data-testid="operation-logs-panel" />,
}))

// ProjectScopeSelect 内含 MultiSelect（弹层），页面测试里简化渲染。
vi.mock('@/components/project-scope-select', () => ({
  ProjectScopeSelect: () => <div data-testid="project-scope-select" />,
}))

vi.mock('@/components/ui/multi-select', () => ({
  MultiSelect: () => <div data-testid="domain-multi-select" />,
}))

import { AgentManagementClient } from './agent-management-client'
import { createAgentApiKey, listAgentApiKeys } from '@/lib/api/agent-key-admin'

describe('AgentManagementClient 4-Tab 枢纽页（BLF-448）', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('渲染标题与 4 个 Tab', async () => {
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('heading', { name: /Agent 接入管理/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /业务域概览/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /凭据管理/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /调用指南/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /访问日志/ })).toBeTruthy()
  })

  it('业务域概览 Tab 展示已接入与规划中域', async () => {
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    expect(screen.getByText('货件管理')).toBeTruthy()
    expect(screen.getByText('店铺测算')).toBeTruthy()
    expect(screen.getByText('退货分析')).toBeTruthy()
  })

  it('凭据管理 Tab 渲染凭据表并展示业务域范围列', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('tab', { name: /凭据管理/ }))

    expect(screen.getByText('货件助理 (生产)')).toBeTruthy()
    // 「全部业务域」出现在筛选下拉与业务域列两处
    expect(screen.getAllByText('全部业务域').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('店铺测算').length).toBeGreaterThanOrEqual(1)
  })

  it('业务域筛选：按域过滤凭据列表（* 全放行仍展示）', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('tab', { name: /凭据管理/ }))
    await waitFor(() => expect(screen.getByText('货件助理 (生产)')).toBeTruthy())

    // 选店铺测算：全域(*) 与 shop_calculations 白名单可见；shipments 专用隐藏
    fireEvent.change(screen.getByLabelText('按业务域筛选'), {
      target: { value: 'shop_calculations' },
    })
    await waitFor(() => expect(screen.getByText('测算 Agent (测试)')).toBeTruthy())
    expect(screen.getByText('货件助理 (生产)')).toBeTruthy() // *
    expect(screen.queryByText('货件专用 (只读)')).toBeNull()

    // 选货件：全域(*) 与 shipments 白名单可见；测算专用隐藏
    fireEvent.change(screen.getByLabelText('按业务域筛选'), {
      target: { value: 'shipments' },
    })
    await waitFor(() => expect(screen.getByText('货件专用 (只读)')).toBeTruthy())
    expect(screen.queryByText('测算 Agent (测试)')).toBeNull()
  })

  it('调用指南与访问日志 Tab 渲染共享面板', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('tab', { name: /调用指南/ }))
    expect(screen.getByTestId('usage-guide')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: /访问日志/ }))
    expect(screen.getByTestId('access-logs-panel')).toBeTruthy()

    // BLF-460：访问日志 Tab 内拆「读访问 / 写操作」子 Tab
    await user.click(screen.getByRole('tab', { name: /写操作/ }))
    expect(screen.getByTestId('operation-logs-panel')).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: /读访问/ }))
    expect(screen.getByTestId('access-logs-panel')).toBeTruthy()
  })

  it('创建凭据 Dialog 带业务域范围字段并透传 business_scope', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '创建凭据' }))
    expect(screen.getByText('业务域范围（空 = 全部业务域）')).toBeTruthy()

    await user.type(screen.getByLabelText('名称'), '新 Agent')
    await user.type(screen.getByLabelText('Agent ID'), 'new-agent')
    await user.click(screen.getByRole('button', { name: '创建', exact: true }))

    await waitFor(() =>
      expect(createAgentApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ business_scope: '*' })
      )
    )
  })
})
