import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Option } from '@/components/ui/multi-select'

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
const { listAgentApiKeys, deactivateAgentApiKey, activateAgentApiKey, deleteAgentApiKey, updateAgentApiKey, confirm, notify } =
  vi.hoisted(() => {
    const nonDeletedKeys = mockKeys.filter((k) => !k.deleted_at)
    return {
      listAgentApiKeys: vi.fn(async (includeDeleted = false) =>
        includeDeleted ? mockKeys : nonDeletedKeys
      ),
      deactivateAgentApiKey: vi.fn().mockResolvedValue(undefined),
      activateAgentApiKey: vi.fn().mockResolvedValue(undefined),
      deleteAgentApiKey: vi.fn().mockResolvedValue(undefined),
      updateAgentApiKey: vi.fn().mockResolvedValue(mockKeys[0]),
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
  updateAgentApiKey,
  AGENT_ID_HINT: '小写字母/数字开头，a-z0-9-_，3-128 字符',
  AGENT_ID_PATTERN: /^[a-z0-9][a-z0-9_-]{2,127}$/,
  isValidAgentId: (v: string) => /^[a-z0-9][a-z0-9_-]{2,127}$/.test(v),
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

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
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
  MultiSelect: ({ options, selected, onChange }: {
    options: Option[]
    selected: string[]
    onChange: (values: string[]) => void
  }) => (
    <select
      multiple
      aria-label="业务域范围"
      data-testid="domain-multi-select"
      value={selected}
      onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}
    >
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
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

  it('渲染 4 个 Tab（BLF-824：eyebrow pill 已随去重移除）', async () => {
    const { container } = render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    // 头部精简（BLF-493 移除标题/描述 + BLF-824 移除 eyebrow）：页面标识由 Top Header 面包屑承载
    expect(screen.queryByRole('heading', { name: /Agent 接入管理/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /业务域概览/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /凭据管理/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /调用指南/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /访问日志/ })).toBeTruthy()
    expect(container.querySelector('[data-warm-agent-management="true"]')).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
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
    // BLF-471 follow-up：中文名即「名称」（label），不再独立中文字段。
    expect(screen.queryByLabelText('Agent 名称（中文）')).toBeNull()

    await user.type(screen.getByLabelText('名称'), '货件助理 (生产)')
    await user.type(screen.getByLabelText('Agent ID'), 'new-agent')
    await user.click(screen.getByRole('button', { name: /^创建$/ }))

    await waitFor(() =>
      expect(createAgentApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          business_scope: '*',
          label: '货件助理 (生产)',
          agent_id: 'new-agent',
        })
      )
    )
  })

  it('创建凭据等待响应时只显示一个 loading 图标', async () => {
    const user = userEvent.setup()
    let resolveCreate: (result: Awaited<ReturnType<typeof createAgentApiKey>>) => void = () => {}
    const pendingCreate = new Promise<Awaited<ReturnType<typeof createAgentApiKey>>>((resolve) => {
      resolveCreate = resolve
    })
    vi.mocked(createAgentApiKey).mockReturnValue(pendingCreate)

    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '创建凭据' }))
    await user.type(screen.getByLabelText('名称'), '新的助手')
    await user.type(screen.getByLabelText('Agent ID'), 'new-assistant')
    await user.click(screen.getByRole('button', { name: /^创建$/ }))

    const creatingButton = await screen.findByRole('button', { name: '正在创建凭据' })
    expect(creatingButton).toHaveAttribute('aria-busy', 'true')
    expect(creatingButton.querySelectorAll('.warm-ledger__loading-mark')).toHaveLength(1)
    expect(creatingButton.querySelector('svg')).not.toBeInTheDocument()

    resolveCreate({
      ...mockKeys[0],
      agent_id: 'new-assistant',
      label: '新的助手',
      plaintext_key: 'bbx_new_secret',
    })
    expect(await screen.findByText('凭据创建成功')).toBeInTheDocument()
  })

  it('创建成功后只在当前 Dialog 展示一次性明文 Key 与安全提示', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '创建凭据' }))
    await user.type(screen.getByLabelText('名称'), '货件助理 (生产)')
    await user.type(screen.getByLabelText('Agent ID'), 'new-agent')
    await user.click(screen.getByRole('button', { name: /^创建$/ }))

    expect(await screen.findByText('凭据创建成功')).toBeTruthy()
    expect(screen.getByText('bbx_new_secret')).toBeTruthy()
    expect(screen.getByText(/明文仅展示一次/)).toBeTruthy()
    expect(createAgentApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        label: '货件助理 (生产)',
        agent_id: 'new-agent',
      })
    )
  })

  it('创建凭据弹窗同样使用 Warm 控件，不混入 Terminal 类', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: '创建凭据' }))
    const dialog = await screen.findByRole('dialog')

    expect(dialog.querySelectorAll('[class*="term-"]')).toHaveLength(0)
    expect(dialog.querySelectorAll('.rounded-none')).toHaveLength(0)
  })

  it('月报域可选为凭据业务范围并透传 monthly_reports（BLF-1314）', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: '创建凭据' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('option', { name: '财务月报' })).toHaveValue('monthly_reports')
    expect(within(dialog).queryByRole('option', { name: '财务利润' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: /全部业务域/ }))
    await user.selectOptions(within(dialog).getByRole('listbox', { name: '业务域范围' }), 'monthly_reports')
    await user.type(within(dialog).getByLabelText('名称'), '月报助理')
    await user.type(within(dialog).getByLabelText('Agent ID'), 'monthly-report-assistant')
    await user.click(within(dialog).getByRole('button', { name: /^创建$/ }))

    await waitFor(() => expect(createAgentApiKey).toHaveBeenCalledWith(expect.objectContaining({
      label: '月报助理',
      agent_id: 'monthly-report-assistant',
      business_scope: 'monthly_reports',
    })))
  })

  it('凭据表 Agent 列只显示 Agent ID（中文名即「名称」列，BLF-471 follow-up）', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    expect(screen.getByText('shipment-assistant-prod')).toBeTruthy()
    expect(screen.queryByLabelText('编辑 shipment-assistant-prod 的中文名')).toBeNull()
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

  // ── BLF-480 编辑权限 / 业务范围 ─────────────────────────────

  it('编辑流：行内编辑按钮打开预填 Dialog，保存调用 updateAgentApiKey', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    const row = screen.getByText('货件助理 (生产)').closest('tr')!
    await user.click(within(row).getByRole('button', { name: /编辑/ }))

    // Dialog 打开 + 名称预填；Agent ID 只读展示
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText('编辑凭据权限')).toBeTruthy()
    expect(within(dialog).getByLabelText('名称')).toHaveValue('货件助理 (生产)')
    expect(within(dialog).getByText('shipment-assistant-prod')).toBeTruthy()

    await user.clear(within(dialog).getByLabelText('名称'))
    await user.type(within(dialog).getByLabelText('名称'), '货件助理 (改名)')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateAgentApiKey).toHaveBeenCalledWith(1, {
        label: '货件助理 (改名)',
        project_scope: '*',
        business_scope: '*',
      })
    )
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
    await waitFor(() => expect(screen.queryByText('编辑凭据权限')).toBeNull())
  })

  it('编辑流：预填具体项目/业务域白名单并原样保存', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    // 测算 Agent (测试)：project_scope='12', business_scope='shop_calculations'
    const row = screen.getByText('测算 Agent (测试)').closest('tr')!
    await user.click(within(row).getByRole('button', { name: /编辑/ }))

    expect(screen.getByLabelText('名称')).toHaveValue('测算 Agent (测试)')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateAgentApiKey).toHaveBeenCalledWith(2, {
        label: '测算 Agent (测试)',
        project_scope: '12',
        business_scope: 'shop_calculations',
      })
    )
  })

  it('编辑流：点「全部业务域」toggle 后保存归一为 *', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    // 测算 Agent (测试)：business_scope='shop_calculations'，toggle 未勾选
    const row = screen.getByText('测算 Agent (测试)').closest('tr')!
    await user.click(within(row).getByRole('button', { name: /编辑/ }))

    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /全部业务域/ }))
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(updateAgentApiKey).toHaveBeenCalledWith(2, {
        label: '测算 Agent (测试)',
        project_scope: '12',
        business_scope: '*',
      })
    )
  })

  it('已删除行不展示编辑按钮', async () => {
    const user = userEvent.setup()
    render(<AgentManagementClient />)
    await waitFor(() => expect(listAgentApiKeys).toHaveBeenCalledTimes(1))
    await openCredentialsTab(user)

    await user.click(screen.getByLabelText('含已删除'))
    await waitFor(() => expect(screen.getByText('已删除示例 Key')).toBeTruthy())

    const row = screen.getByText('已删除示例 Key').closest('tr')!
    expect(within(row).queryByRole('button', { name: /编辑/ })).toBeNull()
  })
})
