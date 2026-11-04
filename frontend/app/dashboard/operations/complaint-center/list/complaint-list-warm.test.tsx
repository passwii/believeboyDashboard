import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  useHeaderSlot: () => null,
  useMobileFilterStrip: () => null,
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
    expect(page).toHaveAttribute('data-warm-complaint-list', 'true')

    const table = await screen.findByRole('table')
    expect(table.parentElement).toHaveAttribute('data-warm-table-scroll', 'true')
    expect(screen.getByText('买家甲')).toBeInTheDocument()

    fireEvent.click(screen.getByText('买家甲').closest('tr')!)
    await waitFor(() =>
      expect(screen.getByTestId('complaint-detail-drawer')).toHaveAttribute('data-open', 'true')
    )
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('keeps the list stylesheet on Warm tokens with no Terminal aliases or new breakpoints', () => {
    const cssPath = join(__dirname, 'complaint-list-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('@media')
  })
})
