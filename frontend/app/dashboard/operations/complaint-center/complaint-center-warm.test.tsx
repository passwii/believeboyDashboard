import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: vi.fn(),
  useHeaderSlot: (node: ReactNode) => node,
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
import { fetchComplaintOverview } from '@/lib/complaint-api'

afterEach(cleanup)

describe('Complaint Center Warm Ledger contract', () => {
  it('renders Warm page, metric, panel, and table-scroll surfaces with real overview data', async () => {
    const { container } = render(<ComplaintCenterClient />)

    const page = await screen.findByTestId('complaint-center-page')
    const header = await screen.findByTestId('complaint-center-header-filters')
    expect(page).toHaveAttribute('data-warm-complaint-center', 'true')
    expect(header).toHaveAttribute('data-warm-header-filters', 'true')
    expect(header.querySelector('[class*="term-"]')).toBeNull()
    expect(header.querySelector('.rounded-none')).toBeNull()
    expect(screen.getByTestId('complaint-date-badge')).toHaveAttribute(
      'data-warm-date-badge',
      'true'
    )
    expect(screen.getAllByTestId('complaint-metric')).toHaveLength(4)
    expect(screen.getByTestId('complaint-trend-panel')).toHaveAttribute('data-warm-panel', 'true')
    expect(screen.queryByTestId('complaint-trend-summary')).not.toBeInTheDocument()
    expect(screen.getByText('暂无趋势数据')).toBeInTheDocument()

    const table = await screen.findByRole('table')
    expect(table.parentElement).toHaveAttribute('data-warm-table-scroll', 'true')
    expect(screen.getByText('北星店')).toBeInTheDocument()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('renders a readable trend summary and the non-empty chart path', async () => {
    vi.mocked(fetchComplaintOverview).mockResolvedValueOnce({
      date: '2026-11-05',
      metrics: {
        total_needs_reply: 3,
        total_reported_unresolved: 1,
        total_resolved: 7,
        sla_due_soon: 2,
        sla_overdue: 1,
      },
      trend: [
        { date: '2026-11-01', needs_reply: 1 },
        { date: '2026-11-02', needs_reply: 4 },
        { date: '2026-11-03', needs_reply: 2 },
      ],
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
    })

    render(<ComplaintCenterClient />)

    expect(await screen.findByTestId('complaint-trend-summary')).toHaveTextContent(
      '每日待回复快照（2026-11-01 至 2026-11-03）：最新 2 条（2026-11-03）；期间峰值 4 条（2026-11-02）。'
    )
    expect(await screen.findByTestId('complaint-trend-chart')).toBeInTheDocument()
  })

  it('summarizes a single-point snapshot without inventing a trend range', async () => {
    vi.mocked(fetchComplaintOverview).mockResolvedValueOnce({
      date: '2026-11-04',
      metrics: {
        total_needs_reply: 5,
        total_reported_unresolved: 0,
        total_resolved: 6,
        sla_due_soon: 1,
        sla_overdue: 0,
      },
      trend: [{ date: '2026-11-04', needs_reply: 5 }],
      projects: [
        {
          project_id: 1,
          project_name: '北星店',
          country: 'US',
          check_status: 'ok',
          needs_reply: 5,
          resolved: 6,
          sla_due_soon: 1,
        },
      ],
    })

    render(<ComplaintCenterClient />)

    expect(await screen.findByTestId('complaint-trend-summary')).toHaveTextContent(
      '每日待回复快照（2026-11-04 至 2026-11-04）：最新 5 条（2026-11-04）；期间峰值 5 条（2026-11-04）。'
    )
    expect(await screen.findByTestId('complaint-trend-chart')).toBeInTheDocument()
  })

  it('keeps the page-local stylesheet on Warm tokens with a phone breakpoint', () => {
    const cssPath = join(__dirname, 'complaint-center-warm.module.css')
    expect(() => readFileSync(cssPath, 'utf8')).not.toThrow()
    const css = readFileSync(cssPath, 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-panel)')
    expect(css).not.toContain('--term-')
    expect(css).toContain('@media (max-width: 767px)')
  })
})
