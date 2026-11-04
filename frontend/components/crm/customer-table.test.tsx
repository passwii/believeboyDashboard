import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Customer } from '@/lib/crm/types'

import { stableNotifications } from '@/test-utils/stable-mocks'
import { CrmCustomerTable } from './customer-table'

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

const { listCustomers, batchMoveToSea, mockClient } = vi.hoisted(() => {
  const listCustomers = vi.fn()
  const batchMoveToSea = vi.fn().mockResolvedValue(undefined)
  return {
    listCustomers,
    batchMoveToSea,
    mockClient: {
      listCustomers,
      batchMoveToSea,
      listFollows: vi.fn().mockResolvedValue([]),
      createFollow: vi.fn(),
      updateCustomer: vi.fn(),
    },
  }
})

vi.mock('@/lib/crm/api/crm-client-provider', () => ({ useCrmClient: () => mockClient }))
vi.mock('@/hooks/use-crm-data-scope', () => ({
  useCrmDataScope: () => ({ scope: 'mine', setScope: vi.fn() }),
}))
vi.mock('@/hooks/use-crm-users', () => ({ useCrmUsers: () => [] }))
vi.mock('@/components/notifications', () => ({ useNotifications: () => stableNotifications() }))

const mockSearchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/crm/customers',
  useSearchParams: () => mockSearchParams,
}))

const customer: Customer = {
  id: 'c1',
  name: '甲公司',
  rating: 'A',
  categories: [],
  status: 'active',
  source: 'referral',
  ownerId: 'u1',
  ownerName: '小王',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  createdBy: 'u1',
}

describe('CrmCustomerTable · Warm Ledger', () => {
  it('保留当前 scope 拉数并在 Warm 表格中渲染语义状态', async () => {
    listCustomers.mockResolvedValue({ items: [customer], total: 1, page: 1, pageSize: 20 })
    render(<CrmCustomerTable />)

    expect(await screen.findByText('甲公司')).toBeInTheDocument()
    expect(listCustomers).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine' }))
    expect(document.querySelector('[data-warm-crm-table-frame]')).toBeInTheDocument()
    expect(
      screen.getAllByText('活跃').find((element) => element.hasAttribute('data-warm-crm-status-pill'))
    ).toHaveAttribute('data-tone', 'positive')
  })

  it('保留批量移入公海的选择与确认行为', async () => {
    listCustomers.mockResolvedValue({ items: [customer], total: 1, page: 1, pageSize: 20 })
    render(<CrmCustomerTable />)

    fireEvent.click(await screen.findByRole('checkbox', { name: '选择 c1' }))
    fireEvent.click(screen.getByRole('button', { name: '移入公海（1）' }))

    await waitFor(() => expect(batchMoveToSea).toHaveBeenCalledWith(['c1']))
  })
})
