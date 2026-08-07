import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
      deleted_at: null,
    },
    {
      id: 2,
      key_prefix: 'bbx_cd34',
      label: '测算 Agent (测试)',
      scope: 'read',
      project_scope: '12',
      business_scope: 'shop_calculations',
      agent_id: 'shop-calc-test',
      is_revoked: true,
      expires_at: null,
      created_at: '2026-08-02T00:00:00Z',
      last_used_at: null,
      deleted_at: null,
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
      deleted_at: null,
    },
    {
      id: 4,
      key_prefix: 'bbx_gh78',
      label: '过期示例 Key',
      scope: 'read',
      project_scope: '*',
      business_scope: '*',
      agent_id: 'expired-key',
      is_revoked: false,
      expires_at: '2026-07-31T00:00:00Z',
      created_at: '2026-07-01T00:00:00Z',
      last_used_at: null,
      deleted_at: null,
    },
    {
      id: 5,
      key_prefix: 'bbx_ij90',
      label: '已删除示例 Key',
      scope: 'read',
      project_scope: '*',
      business_scope: '*',
      agent_id: 'deleted-key',
      is_revoked: false,
      expires_at: null,
      created_at: '2026-06-01T00:00:00Z',
      last_used_at: null,
      deleted_at: '2026-08-01T00:00:00Z',
    },
  ],
}))

// listAgentApiKeys 模拟后端语义：include_deleted=false 默认隐藏已删除；
// 返回值缓存稳定引用，避免 setKeys 每轮新数组导致 effect 无限重跑。
const { listAgentApiKeys, deactivateAgentApiKey, activateAgentApiKey, deleteAgentApiKey, confirm, notify } =
  vi.hoisted(() => {
    const nonDeletedKeys = mockKeys.filter((k) => !k.deleted_at)
    return {
      listAgentApiKeys: vi.fn(async (includeDeleted = false) =>
        includeDeleted ? mockKeys : nonDeletedKeys
      ),
      deactivateAgentApiKey: vi.fn().mockResolvedValue(undefined),
      activateAgentApiKey: vi.fn().mockResolvedValue(undefined),
      deleteAgentApiKey: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(true),
      notify: vi.fn(),
    }
  })

vi.mock('@/lib/api/agent-key-admin', () => ({
  listAgentApiKeys,
  createAgentApiKey: vi.fn().mockResolvedValue({
    ...mockKeys[0],
    plaintext_key: 'bbx_new_secret',
  }),
  deactivateAgentApiKey,
  activateAgentApiKey,
  deleteAgentApiKey,
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
  useNotifications: () => ({ notify }),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm }),
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
import { createAgentApiKey } from '@/lib/api/agent-key-admin'

async function openCredentialsTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /凭据管理/ }))
  await waitFor(() => expect(screen.getByText('货件助理 (生产)')).toBeTruthy())
}

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
    await openCredentialsTab(user)

    expect(screen.getByText('货件助理 (生产)')).toBeTruthy()
    // 「全部业务域」出现在筛选下拉与业务域列两处
    expect(screen.getAllByText('全部业务域').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('店铺测算').length).toBeGreaterThanOrEqual(1)
  })

  it('业务域筛选：按域过滤凭据列表（* 全放行仍展示）', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

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

  // ── BLF-468 生命周期 ─────────────────────────────────────────

  it('状态徽章：激活 / 停用 / 已过期 三态渲染，默认隐藏已删除', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    const table = screen.getByRole('table')
    // 默认列表（include_deleted=false）：已删除行不可见
    expect(within(table).queryByText('已删除')).toBeNull()
    expect(screen.queryByText('已删除示例 Key')).toBeNull()

    // 按行断言状态徽章（「停用」同时是激活行操作按钮文字，须限定行内）
    const rowActive = screen.getByText('货件助理 (生产)').closest('tr')!
    expect(within(rowActive).getByText('激活')).toBeTruthy()
    const rowInactive = screen.getByText('测算 Agent (测试)').closest('tr')!
    expect(within(rowInactive).getByText('停用')).toBeTruthy()
    expect(within(rowInactive).getByRole('button', { name: '激活' })).toBeTruthy()
    const rowExpired = screen.getByText('过期示例 Key').closest('tr')!
    expect(within(rowExpired).getByText('已过期')).toBeTruthy()
    // 过期行只有删除操作，无停用/激活按钮
    expect(within(rowExpired).queryByRole('button', { name: '激活' })).toBeNull()
    expect(within(rowExpired).queryByRole('button', { name: '停用' })).toBeNull()
  })

  it('状态筛选：按激活 / 停用 / 已过期过滤行', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    fireEvent.change(screen.getByLabelText('按状态筛选'), {
      target: { value: 'inactive' },
    })
    expect(screen.getByText('测算 Agent (测试)')).toBeTruthy()
    expect(screen.queryByText('货件助理 (生产)')).toBeNull()
    expect(screen.queryByText('过期示例 Key')).toBeNull()

    fireEvent.change(screen.getByLabelText('按状态筛选'), {
      target: { value: 'expired' },
    })
    expect(screen.getByText('过期示例 Key')).toBeTruthy()
    expect(screen.queryByText('货件助理 (生产)')).toBeNull()
  })

  it('含已删除开关：重拉 include_deleted=true 并展示已删除徽章', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    await user.click(screen.getByLabelText('含已删除'))
    await waitFor(() =>
      expect(listAgentApiKeys).toHaveBeenLastCalledWith(true)
    )
    expect(screen.getByText('已删除示例 Key')).toBeTruthy()
    expect(screen.getByText('已删除')).toBeTruthy()
  })

  it('停用流：确认后调 deactivate 端点（可逆，非 destructive 语义）', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    await user.click(screen.getAllByRole('button', { name: '停用' })[0])
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('停用凭据'), confirmText: '停用' })
    )
    await waitFor(() => expect(deactivateAgentApiKey).toHaveBeenCalledWith(1))
  })

  it('激活流：停用行的「激活」按钮调 activate 端点', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    await user.click(screen.getAllByRole('button', { name: '激活' })[0])
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('激活凭据'), confirmText: '激活' })
    )
    await waitFor(() => expect(activateAgentApiKey).toHaveBeenCalledWith(2))
  })

  it('删除流：确认带键入 Key 前缀要求，确认后调 delete 端点', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('删除凭据'),
        confirmText: '删除',
        variant: 'destructive',
        expectedInput: 'bbx_ab12',
        inputLabel: expect.stringContaining('bbx_ab12'),
      })
    )
    await waitFor(() => expect(deleteAgentApiKey).toHaveBeenCalledWith(1))
  })

  it('已删除行不展示任何操作按钮（只读）', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    await user.click(screen.getByLabelText('含已删除'))
    await waitFor(() => expect(screen.getByText('已删除示例 Key')).toBeTruthy())

    const row = screen.getByText('已删除示例 Key').closest('tr')!
    expect(within(row).queryByRole('button')).toBeNull()
  })
})
