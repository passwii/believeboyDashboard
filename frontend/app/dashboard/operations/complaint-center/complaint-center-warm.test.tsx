import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
  useHeaderSlot: () => null,
  useMobileFilterStrip: () => null,
}))

vi.mock('@/lib/complaint-api', () => ({
  fetchComplaintOverview: vi.fn().mockResolvedValue({
    date: '2026-11-05',
    metrics: {
      total_needs_reply: 3,
      total_reported_unresolved: 1,
      total_resolved: 7,
      sla_due_soon: 2,
      sla_overdue: 1,
    },
    trend: [],
    projects: [
      {
        project_id: 1,
        project_name: '北星店',
        country: 'US',
        check_status: 'ok',
        needs_reply: 2,
        resolved: 4,
        sla_due_soon: 1,
      },
    ],
  }),
}))

import ComplaintCenterClient from './complaint-center-client'

afterEach(cleanup)

describe('Complaint Center Warm Ledger contract', () => {
  it('renders Warm page, metric, panel, and table-scroll surfaces with real overview data', async () => {
    const { container } = render(<ComplaintCenterClient />)

    const page = await screen.findByTestId('complaint-center-page')
    expect(page).toHaveAttribute('data-warm-complaint-center', 'true')
    expect(screen.getAllByTestId('complaint-metric')).toHaveLength(4)
    expect(screen.getByTestId('complaint-trend-panel')).toHaveAttribute('data-warm-panel', 'true')

    const table = await screen.findByRole('table')
    expect(table.parentElement).toHaveAttribute('data-warm-table-scroll', 'true')
    expect(screen.getByText('北星店')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('keeps the page-local stylesheet on Warm tokens with no Terminal aliases or new breakpoints', () => {
    const cssPath = join(__dirname, 'complaint-center-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).not.toContain('@media')
  })
})
