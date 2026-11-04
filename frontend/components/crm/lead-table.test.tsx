import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Lead } from '@/lib/crm/types'

const mocks = vi.hoisted(() => ({
  client: {
    convertLead: vi.fn(),
    createFollow: vi.fn(),
    listFollows: vi.fn(),
    updateLead: vi.fn(),
  },
  notify: vi.fn(),
  refresh: vi.fn(),
  setFiltersAndPage: vi.fn(),
  setKeyword: vi.fn(),
  setPage: vi.fn(),
  setPageSize: vi.fn(),
  toggleSort: vi.fn(),
  downloadCrmCsv: vi.fn(),
  table: {
    data: undefined as Lead[] | undefined,
    total: 0,
    loading: false,
    error: null as Error | null,
    page: 1,
    pageSize: 20,
    sortBy: undefined as string | undefined,
    sortOrder: undefined as 'asc' | 'desc' | undefined,
    keyword: '',
    filters: [] as Array<{ field: string; op: 'eq'; value: unknown }>,
  },
}))

vi.mock('./crm-table/use-crm-table', () => ({
  useCrmTable: () => ({
    ...mocks.table,
    setFiltersAndPage: mocks.setFiltersAndPage,
    setKeyword: mocks.setKeyword,
    setPage: mocks.setPage,
    setPageSize: mocks.setPageSize,
    toggleSort: mocks.toggleSort,
    refresh: mocks.refresh,
  }),
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => mocks.client,
}))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'mine', setScope: vi.fn(), currentUserId: 'u-1' }),
}))
vi.mock('@/hooks/use-crm-users', () => ({
  useCrmUsers: () => [
    { id: 'u-1', name: '林夏', avatarUrl: null },
    { id: 'u-2', name: '周岚', avatarUrl: null },
  ],
}))
vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mocks.notify }),
}))
vi.mock('@/lib/crm/method/download-csv', () => ({
  downloadCrmCsv: mocks.downloadCrmCsv,
}))
vi.mock('./crm-overview-drawer', () => ({
  CrmOverviewDrawer: ({
    actions,
    onOpenChange,
    open,
    title,
  }: {
    actions?: React.ReactNode
    onOpenChange: (open: boolean) => void
    open: boolean
    title: string
  }) =>
    open ? (
      <section aria-label="线索详情">
        <h2>{title}</h2>
        {actions}
        <button type="button" onClick={() => onOpenChange(false)}>
          关闭详情
        </button>
      </section>
    ) : null,
}))
vi.mock('./crm-table/header-refresh', () => ({
  CrmTableHeaderRefresh: () => null,
}))

import { CrmLeadTable } from './lead-table'

const lead: Lead = {
  id: 'lead-1',
  name: '刘晨',
  company: '远帆供应链',
  source: 'referral',
  status: 'qualified',
  intent: 'high',
  ownerId: 'u-1',
  ownerName: '林夏',
  expectedAmount: 128000,
  createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-02T08:00:00Z',
}

function resetTable() {
  mocks.table.data = undefined
  mocks.table.total = 0
  mocks.table.loading = false
  mocks.table.error = null
  mocks.table.page = 1
  mocks.table.pageSize = 20
  mocks.table.sortBy = undefined
  mocks.table.sortOrder = undefined
  mocks.table.keyword = ''
  mocks.table.filters = []
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTable()
  mocks.client.listFollows.mockResolvedValue([])
  mocks.client.createFollow.mockResolvedValue({})
  mocks.client.updateLead.mockImplementation(async (_id: string, input: Partial<Lead>) => ({
    ...lead,
    ...input,
  }))
  mocks.client.convertLead.mockResolvedValue({ id: 'customer-1' })
  mocks.downloadCrmCsv.mockResolvedValue(undefined)
})

describe('CrmLeadTable Warm presentation', () => {
  it('renders the Warm table frame and keeps lead values readable', async () => {
    mocks.table.data = [lead]
    mocks.table.total = 1

    const { container } = render(<CrmLeadTable />)

    expect(container.querySelector('[data-warm-leads-table]')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '线索表格' })).toBeInTheDocument()
    expect(screen.getByText('刘晨')).toBeInTheDocument()
    expect(screen.getByText('远帆供应链')).toBeInTheDocument()
    expect(
      screen.getByText('已验证', { selector: '[data-warm-crm-status-pill]' })
    ).toHaveAttribute('data-tone', 'neutral')
    expect(
      screen.getByText('高意向', { selector: '[data-warm-crm-status-pill]' })
    ).toHaveAttribute('data-tone', 'accent')
    expect(screen.getByText('128,000')).toHaveAttribute('data-numeric')
  })

  it('keeps loading, empty, and error states distinct', async () => {
    mocks.table.loading = true
    const { rerender } = render(<CrmLeadTable />)

    expect(screen.getByRole('status')).toHaveTextContent('表格加载中')

    mocks.table.loading = false
    mocks.table.data = []
    rerender(<CrmLeadTable />)
    expect(screen.getByText('暂无线索')).toBeInTheDocument()

    mocks.table.data = undefined
    mocks.table.error = new Error('网络不可用')
    rerender(<CrmLeadTable />)
    expect(screen.getByRole('alert')).toHaveTextContent('加载失败')
    expect(screen.getByRole('alert')).toHaveTextContent('网络不可用')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })

  it('wires search, filters, sorting, and pagination through the shared table state', async () => {
    mocks.table.data = [lead]
    mocks.table.total = 100
    mocks.table.page = 2
    mocks.table.filters = [{ field: 'intent', op: 'eq', value: 'high' }]

    render(<CrmLeadTable />)

    fireEvent.click(screen.getByRole('button', { name: '联系人' }))
    expect(mocks.toggleSort).toHaveBeenCalledWith('name')

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'qualified' } })
    expect(mocks.setFiltersAndPage).toHaveBeenCalledWith(
      [
        { field: 'intent', op: 'eq', value: 'high' },
        { field: 'status', op: 'eq', value: 'qualified' },
      ],
      1
    )

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(mocks.setPage).toHaveBeenCalledWith(3)

    fireEvent.change(screen.getByLabelText('跳转到页码'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: '跳' }))
    expect(mocks.setPage).toHaveBeenCalledWith(5)

    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } })
    expect(mocks.setPageSize).toHaveBeenCalledWith(50)
  })

  it('exports with the active scope and keyword', async () => {
    mocks.table.data = [lead]
    mocks.table.total = 1
    mocks.table.keyword = '远帆'

    render(<CrmLeadTable />)
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }))

    await waitFor(() => {
      expect(mocks.downloadCrmCsv).toHaveBeenCalledWith('leads', {
        scope: 'mine',
        keyword: '远帆',
      })
    })
    expect(mocks.notify).toHaveBeenCalledWith({
      type: 'success',
      title: '导出成功',
      message: 'CSV 已开始下载',
    })
  })

  it('opens the existing drawer contract and preserves lead conversion', async () => {
    mocks.table.data = [lead]
    mocks.table.total = 1

    render(<CrmLeadTable />)
    fireEvent.click(screen.getByText('刘晨'))

    expect(screen.getByRole('region', { name: '线索详情' })).toHaveTextContent('刘晨')
    fireEvent.click(screen.getByRole('button', { name: '转为客户' }))

    await waitFor(() => expect(mocks.client.convertLead).toHaveBeenCalledWith('lead-1'))
    expect(mocks.notify).toHaveBeenCalledWith({
      type: 'success',
      title: '已转化为客户',
      message: '线索「刘晨」转为客户',
    })
  })
})
