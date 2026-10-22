import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { client } = vi.hoisted(() => ({
  client: {
    listProposals: vi.fn(),
  },
}))

vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => client }))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'all', setScope: vi.fn(), currentUserId: 'u-1' }),
}))

import { CustomerProposals } from './customer-proposals'

const PROPOSAL = {
  id: 'p-1',
  title: '亚马逊代运营入驻方案',
  proposalType: 'onboarding' as const,
  status: 'published' as const,
  customerId: 'c-1',
  customerName: '客户甲',
  ownerId: 'u-1',
  currentVersionNo: 3,
  versionCount: 3,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  client.listProposals.mockResolvedValue({
    items: [PROPOSAL],
    total: 1,
    page: 1,
    pageSize: 50,
  })
})

describe('CustomerProposals', () => {
  it('按 customer_id 拉取并渲染关联方案', async () => {
    render(<CustomerProposals customerId="c-1" />)

    expect(await screen.findByText('亚马逊代运营入驻方案')).toBeTruthy()
    expect(screen.getByText('入驻方案')).toBeTruthy()
    expect(screen.getByText('已发布')).toBeTruthy()
    expect(screen.getByText('v3 · 3 版')).toBeTruthy()
    expect(screen.getByText('关联方案（1）')).toBeTruthy()

    expect(client.listProposals).toHaveBeenCalledWith({
      scope: 'all',
      filters: [{ field: 'customer_id', op: 'eq', value: 'c-1' }],
      sortBy: 'updated_at',
      sortOrder: 'desc',
      pageSize: 50,
    })
    // 标题可点进方案详情
    const link = screen.getByRole('link', { name: '亚马逊代运营入驻方案' })
    expect(link.getAttribute('href')).toBe('/dashboard/crm/proposals/p-1')
  })

  it('数字客户 id 以 number 传筛选值（后端 int 列，字符串会 500）', async () => {
    render(<CustomerProposals customerId="42" />)

    await waitFor(() => expect(client.listProposals).toHaveBeenCalledTimes(1))
    expect(client.listProposals.mock.calls[0][0].filters).toEqual([
      { field: 'customer_id', op: 'eq', value: 42 },
    ])
  })

  it('没有关联方案时给出空状态引导', async () => {
    client.listProposals.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 })
    render(<CustomerProposals customerId="c-1" />)

    expect(await screen.findByText(/该客户还没有关联方案/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /新建方案/ })).toBeTruthy()
  })

  it('加载失败展示错误，不伪装成空列表', async () => {
    client.listProposals.mockRejectedValue(new Error('后端不可用'))
    render(<CustomerProposals customerId="c-1" />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('后端不可用')
    expect(screen.queryByText(/该客户还没有关联方案/)).toBeNull()
  })

  it('客户变化时重新拉取', async () => {
    const { rerender } = render(<CustomerProposals customerId="c-1" />)
    await screen.findByText('亚马逊代运营入驻方案')

    rerender(<CustomerProposals customerId="c-2" />)
    await waitFor(() => expect(client.listProposals).toHaveBeenCalledTimes(2))
    expect(client.listProposals.mock.calls[1][0].filters).toEqual([
      { field: 'customer_id', op: 'eq', value: 'c-2' },
    ])
  })
})
