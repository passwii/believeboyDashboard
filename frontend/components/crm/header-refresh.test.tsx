import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowUpGroups } from '@/lib/crm/types'
import {
  TerminalHeaderSlotProvider,
  useTerminalHeaderSlot,
} from '@/components/terminal/terminal-header-slot'
import { CrmTable } from './crm-table'
import { CrmCustomerTable } from './customer-table'
import { CrmLeadTable } from './lead-table'
import { CrmSeaTable } from './sea-table'
import { CrmFollowUpList } from './follow-up-list'

const mocks = vi.hoisted(() => {
  const listCustomers = vi.fn()
  const listLeads = vi.fn()
  const listFollowUps = vi.fn()
  return {
    client: { listCustomers, listLeads, listFollowUps },
    notify: vi.fn(),
    users: [],
    router: { replace: vi.fn(), push: vi.fn() },
    searchParams: new URLSearchParams(),
    scope: 'mine' as 'mine' | 'all',
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => mocks.router,
  usePathname: () => '/dashboard/crm/customers',
  useSearchParams: () => mocks.searchParams,
}))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => mocks.client }))
vi.mock('@/hooks/use-crm-data-scope', () => ({ useCrmDataScope: () => ({ scope: mocks.scope }) }))
vi.mock('@/hooks/use-crm-users', () => ({ useCrmUsers: () => mocks.users }))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify: mocks.notify }) }))
vi.mock('./crm-overview-drawer', () => ({ CrmOverviewDrawer: () => null }))
vi.mock('./crm-export-button', () => ({ CrmExportButton: () => null }))

function HeaderProbe() {
  const { refreshRegistered, refreshLoading, triggerRefresh } = useTerminalHeaderSlot()
  return (
    <button
      type="button"
      disabled={!refreshRegistered || refreshLoading}
      onClick={triggerRefresh}
      aria-busy={refreshLoading}
    >
      Head 刷新
    </button>
  )
}

function renderPage(children: ReactNode) {
  return render(
    <TerminalHeaderSlotProvider>
      <HeaderProbe />
      {children}
    </TerminalHeaderSlotProvider>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const row = {
  id: '1', name: '原有客户', rating: 'A', status: 'active', intent: 'high', source: 'referral',
  ownerId: 'u-1', ownerName: '负责人', createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z',
}
const pageData = { items: [row], total: 100, page: 3, pageSize: 20 }
const followUps: FollowUpGroups = {
  overdue: [{ entityType: 'customer', entityId: '1', name: '原有待跟进', ownerId: 'u-1', nextFollowAt: '2026-10-01T00:00:00Z' }],
  today: [], thisWeek: [], overdueCount: 1, totalCount: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.scope = 'mine'
  mocks.searchParams = new URLSearchParams({
    page: '3', pageSize: '20', keyword: '原有', sortBy: 'name', sortOrder: 'desc',
  })
  mocks.client.listCustomers.mockResolvedValue(pageData)
  mocks.client.listLeads.mockResolvedValue(pageData)
  mocks.client.listFollowUps.mockResolvedValue(followUps)
})

describe('CRM 数据 owner 的 Head 刷新契约', () => {
  it.each([
    { name: '客户', Component: CrmCustomerTable, loader: mocks.client.listCustomers, scope: 'mine' },
    { name: '线索', Component: CrmLeadTable, loader: mocks.client.listLeads, scope: 'mine' },
    { name: '公海', Component: CrmSeaTable, loader: mocks.client.listCustomers, scope: 'sea' },
  ])('$name按当前查询重取，等待请求结束并更新可见行', async ({ Component, loader, scope }) => {
    renderPage(<Component />)
    await screen.findByText('原有客户')
    const button = screen.getByRole('button', { name: 'Head 刷新' })
    await waitFor(() => expect(button).toBeEnabled())

    const pending = deferred<typeof pageData>()
    loader.mockReturnValueOnce(pending.promise)
    const before = loader.mock.calls.length
    fireEvent.click(button)
    expect(loader).toHaveBeenCalledTimes(before + 1)
    expect(loader).toHaveBeenLastCalledWith(expect.objectContaining({
      scope, page: 3, pageSize: 20, keyword: '原有', sortBy: 'name', sortOrder: 'desc',
    }))
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('原有客户')).toBeVisible()

    await act(async () => {
      pending.resolve({ ...pageData, items: [{ ...row, name: '刷新后客户' }] })
    })
    await screen.findByText('刷新后客户')
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })

  it('客户刷新保留选择、分页和筛选，失败显示错误且旧行仍可读，随后可重试', async () => {
    mocks.searchParams.set('filters', JSON.stringify([{ field: 'status', op: 'eq', value: 'active' }]))
    renderPage(<CrmCustomerTable />)
    await screen.findByText('原有客户')
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 1' }))
    const button = screen.getByRole('button', { name: 'Head 刷新' })
    mocks.client.listCustomers.mockRejectedValueOnce(new Error('网络不可用'))
    fireEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent('网络不可用')
    expect(screen.getByText('原有客户')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '选择 1' })).toBeChecked()
    expect(screen.getByLabelText('状态')).toHaveValue('active')
    expect(screen.getByText('第 3 / 5 页')).toBeVisible()
    expect(button).toBeEnabled()
    expect(mocks.client.listCustomers).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: [{ field: 'status', op: 'eq', value: 'active' }],
    }))

    fireEvent.click(button)
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('checkbox', { name: '选择 1' })).toBeChecked()
  })

  it('待跟进重取最新 scope，刷新失败保留分组并恢复 Head 按钮', async () => {
    const { rerender } = renderPage(<CrmFollowUpList />)
    await screen.findByText('原有待跟进')
    mocks.scope = 'all'
    rerender(<TerminalHeaderSlotProvider><HeaderProbe /><CrmFollowUpList /></TerminalHeaderSlotProvider>)
    await waitFor(() => expect(mocks.client.listFollowUps).toHaveBeenLastCalledWith('all'))
    const pending = deferred<FollowUpGroups>()
    mocks.client.listFollowUps.mockReturnValueOnce(pending.promise)
    const before = mocks.client.listFollowUps.mock.calls.length
    const button = screen.getByRole('button', { name: 'Head 刷新' })
    fireEvent.click(button)
    expect(mocks.client.listFollowUps).toHaveBeenCalledTimes(before + 1)
    expect(mocks.client.listFollowUps).toHaveBeenLastCalledWith('all')
    expect(button).toBeDisabled()
    expect(screen.getByText('原有待跟进')).toBeVisible()
    await act(async () => { pending.reject(new Error('待跟进刷新失败')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('待跟进刷新失败')
    expect(screen.getByText('原有待跟进')).toBeVisible()
    expect(button).toBeEnabled()
  })

  it('空表刷新不重新遮盖筛选，空待跟进刷新失败也显示错误', async () => {
    mocks.client.listCustomers.mockResolvedValueOnce({ ...pageData, items: [], total: 0 })
    const first = renderPage(<CrmCustomerTable />)
    await screen.findByText('暂无客户')
    const pending = deferred<typeof pageData>()
    mocks.client.listCustomers.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Head 刷新' }))
    expect(screen.getByLabelText('状态')).toBeVisible()
    expect(screen.getByText('暂无客户')).toBeVisible()
    await act(async () => { pending.resolve(pageData) })
    first.unmount()

    mocks.client.listFollowUps.mockResolvedValueOnce({
      overdue: [], today: [], thisWeek: [], overdueCount: 0, totalCount: 0,
    })
    renderPage(<CrmFollowUpList />)
    await screen.findByText('暂无待跟进，太棒了')
    mocks.client.listFollowUps.mockRejectedValueOnce(new Error('空列表刷新失败'))
    fireEvent.click(screen.getByRole('button', { name: 'Head 刷新' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('空列表刷新失败')
    expect(screen.getByText('暂无待跟进，太棒了')).toBeVisible()
  })

  it('初载失败仍注册 callback，可从 Head 重试恢复', async () => {
    mocks.client.listCustomers.mockRejectedValueOnce(new Error('初载失败'))
    renderPage(<CrmCustomerTable />)
    await screen.findByText('初载失败')
    const button = screen.getByRole('button', { name: 'Head 刷新' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await screen.findByText('原有客户')
    expect(button).toBeEnabled()
  })

  it('非页面表格不依赖 Header Provider，也不占用全局刷新', async () => {
    render(<CrmTable queryKey="embedded" fetchPage={mocks.client.listCustomers} columns={[{ key: 'name', title: '名称' }]} rowKey="id" />)
    await screen.findByText('原有客户')
  })

  it('离开已注册表格后注销 callback，不保留上一页刷新状态', async () => {
    const { rerender } = renderPage(<CrmSeaTable />)
    await screen.findByText('原有客户')
    expect(screen.getByRole('button', { name: 'Head 刷新' })).toBeEnabled()
    rerender(<TerminalHeaderSlotProvider><HeaderProbe /></TerminalHeaderSlotProvider>)
    expect(screen.getByRole('button', { name: 'Head 刷新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Head 刷新' })).toHaveAttribute('aria-busy', 'false')
  })
})
