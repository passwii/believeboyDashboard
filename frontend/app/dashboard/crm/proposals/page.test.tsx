import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { client, getRefreshHandler, setRefreshHandler, notify } = vi.hoisted(() => {
  const client = {
    listProposals: vi.fn(),
    listCustomers: vi.fn(),
    createProposal: vi.fn(),
    downloadProposalVersion: vi.fn(),
    deleteProposal: vi.fn(),
  }
  let handler: (() => void | Promise<void>) | null = null
  return {
    client,
    notify: vi.fn(),
    getRefreshHandler: () => handler,
    setRefreshHandler: (next: () => void | Promise<void>) => { handler = next },
  }
})

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => void | Promise<void>) => {
    setRefreshHandler(handler)
    return { setLoading: vi.fn() }
  },
}))
vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => client }))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn(), currentUserId: 'user-1' }),
}))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify }) }))
vi.mock('@/hooks/use-confirm', () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(false) }) }))
vi.mock('@/components/crm/proposal', () => ({
  ProposalCreateForm: () => null,
  ProposalStatusPill: ({ status }: { status: string }) => <span>{status}</span>,
  ProposalTypePill: ({ type }: { type: string }) => <span>{type}</span>,
}))
vi.mock('../customers/components/scope-toggle', () => ({ ScopeToggle: () => null }))

import ProposalsPage from './page'

const PROPOSALS = [{
  id: 'proposal-1',
  customerId: 'customer-1',
  customerName: '客户甲',
  title: '北美春季方案',
  proposalType: 'other',
  status: 'draft',
  currentVersionNo: 2,
  versionCount: 2,
  updatedAt: '2026-10-01T00:00:00Z',
}]

beforeEach(() => {
  vi.clearAllMocks()
  client.listProposals.mockResolvedValue({ items: PROPOSALS, total: 1, page: 1, pageSize: 50 })
  client.listCustomers.mockResolvedValue({ items: [] })
})

describe('客户方案 Head 刷新', () => {
  it('查询条件变化时隐藏旧列表，失败不残留旧范围结果', async () => {
    let requestCount = 0
    client.listProposals.mockImplementation(async () => {
      requestCount += 1
      if (requestCount === 1) return { items: PROPOSALS, total: 1, page: 1, pageSize: 50 }
      throw new Error('新筛选加载失败')
    })

    render(<ProposalsPage />)
    await screen.findByText('北美春季方案')

    fireEvent.change(screen.getByLabelText('搜索方案标题'), { target: { value: '冬季' } })
    expect(screen.queryByText('北美春季方案')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('新筛选加载失败'))
    expect(screen.queryByText('北美春季方案')).not.toBeInTheDocument()
    expect(screen.getByText('共 0 个方案')).toBeInTheDocument()
  })

  it('按当前关键词、状态和 scope 重取列表，不丢筛选', async () => {
    render(<ProposalsPage />)
    await screen.findByText('北美春季方案')

    fireEvent.change(screen.getByLabelText('搜索方案标题'), { target: { value: '春季' } })
    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'draft' } })
    await waitFor(() => expect(client.listProposals).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'all', keyword: '春季', filters: [{ field: 'status', op: 'eq', value: 'draft' }], pageSize: 50,
    })))

    const beforeRefresh = client.listProposals.mock.calls.length
    await act(async () => { await getRefreshHandler()?.() })

    expect(client.listProposals).toHaveBeenCalledTimes(beforeRefresh + 1)
    expect(client.listProposals).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'all', keyword: '春季', filters: [{ field: 'status', op: 'eq', value: 'draft' }], pageSize: 50,
    }))
    expect(screen.getByLabelText('搜索方案标题')).toHaveValue('春季')
    expect(screen.getByLabelText('按状态筛选')).toHaveValue('draft')
  })
})
