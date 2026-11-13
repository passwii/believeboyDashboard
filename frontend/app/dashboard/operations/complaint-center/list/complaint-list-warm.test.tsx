import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

const { managedProjects } = vi.hoisted(() => ({
  managedProjects: [{ id: 1, name: '北星店' }],
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
  useHeaderSlot: (node: ReactNode) => node,
  useMobileFilterStrip: (node: ReactNode) => (
    <div data-testid="complaint-mobile-filters">{node}</div>
  ),
}))

vi.mock('@/lib/hooks/use-managed-projects', () => ({
  useManagedProjects: () => ({
    projects: managedProjects,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}))

vi.mock('@/lib/complaint-api', () => ({
  fetchComplaintList: vi.fn().mockResolvedValue({
    items: [
      {
        id: 9,
        project_id: 1,
        project_name: '北星店',
        country: 'US',
        buyer_name: '买家甲',
        message_date: '2026-11-05',
        subject: '包裹破损',
        category: 'with_order',
        category_badge: '有订单',
        has_order: true,
        order_id: 'ORDER-9',
        asin: 'B0TEST1234',
        product_title: '测试商品',
        status: 'pending',
        sla_remaining: '2 小时',
        sla_level: 'soon',
      },
    ],
    total: 1,
    page: 1,
    page_size: 20,
    spam_count: 0,
  }),
}))

vi.mock('./components/complaint-detail-drawer', () => ({
  ComplaintDetailDrawer: ({ open }: { open: boolean }) => (
    <div data-testid="complaint-detail-drawer" data-open={String(open)} />
  ),
}))

import ComplaintListClient from './complaint-list-client'

afterEach(cleanup)

describe('Complaint List Warm Ledger contract', () => {
  it('preserves row-to-drawer behavior inside Warm page and table-scroll surfaces', async () => {
    const { container } = render(<ComplaintListClient />)

    const page = await screen.findByTestId('complaint-list-page')
    const header = await screen.findByTestId('complaint-list-header-filters')
    expect(page).toHaveAttribute('data-warm-complaint-list', 'true')
    expect(header).toHaveAttribute('data-warm-header-filters', 'true')
    expect(header.querySelector('[class*="term-"]')).toBeNull()
    expect(header.querySelector('.rounded-none')).toBeNull()
    const mobileFilters = screen.getByTestId('complaint-mobile-filters')
    expect(header.querySelector('#complaint-list-status-filter')).toBeInTheDocument()
    expect(header.querySelector('#complaint-list-category-filter')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换页面筛选' }))
    expect(mobileFilters.querySelector('#complaint-list-mobile-status-filter')).toBeInTheDocument()
    expect(
      mobileFilters.querySelector('#complaint-list-mobile-category-filter')
    ).toBeInTheDocument()
    expect(within(mobileFilters).getByLabelText('搜索买家或主题')).toBeInTheDocument()
    expect(container.querySelector('[data-mobile-complaint-list]')).toBeInTheDocument()

    const table = await screen.findByRole('table')
    expect(table.parentElement).toHaveAttribute('data-warm-table-scroll', 'true')
    expect(within(table).getByText('买家甲')).toBeInTheDocument()
    const mobileList = container.querySelector<HTMLElement>('[data-mobile-complaint-list]')!
    expect(within(mobileList).getByText('包裹破损')).toBeInTheDocument()
    expect(within(mobileList).getByText('B0TEST1234')).toBeInTheDocument()

    fireEvent.click(within(table).getByText('买家甲').closest('tr')!)
    await waitFor(() =>
      expect(screen.getByTestId('complaint-detail-drawer')).toHaveAttribute('data-open', 'true')
    )
    expect(page.querySelector('[class*="term-"]')).toBeNull()
  })

  it('keeps the list stylesheet on Warm tokens with a phone breakpoint', () => {
    const cssPath = join(__dirname, 'complaint-list-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).toContain('@media (max-width: 767px)')
  })
})
