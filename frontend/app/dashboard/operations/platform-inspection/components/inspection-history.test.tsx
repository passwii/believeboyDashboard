import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: mockNotify }),
}))

vi.mock('@/lib/inspection-api', () => ({
  fetchPeriods: vi.fn().mockResolvedValue({ items: [] }),
  fetchInspectionHistory: vi.fn().mockResolvedValue({
    items: [
      {
        id: 1,
        period_id: 10,
        project_id: 101,
        project_name: 'Critical 项目',
        status: 'submitted',
        account_health_rating: 'Critical',
        compliance_total: 0,
        status_summary: null,
        screenshots: [],
        submitted_by: '测试人员',
        submitted_at: null,
        week_start: '2026-10-01',
        week_end: '2026-10-07',
      },
      {
        id: 2,
        period_id: 10,
        project_id: 102,
        project_name: 'Healthy 项目',
        status: 'submitted',
        account_health_rating: 'Healthy',
        compliance_total: 0,
        status_summary: null,
        screenshots: [],
        submitted_by: '测试人员',
        submitted_at: null,
        week_start: '2026-10-01',
        week_end: '2026-10-07',
      },
    ],
  }),
  fetchReport: vi.fn(),
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({
    children,
    ...props
  }: { children: React.ReactNode } & Record<string, unknown>) => <h2 {...props}>{children}</h2>,
}))

vi.mock('@/components/ui/image-preview-dialog', () => ({
  PortraitScreenshotDialog: () => null,
}))

import InspectionHistory from './inspection-history'

beforeEach(() => {
  mockNotify.mockReset()
})

describe('InspectionHistory health rating labels', () => {
  it('renders the history table inside Warm scroll containment', async () => {
    const { container } = render(<InspectionHistory periodId={10} />)

    const page = await screen.findByTestId('inspection-history')
    expect(page).toHaveAttribute('data-warm-inspection-history', 'true')
    const table = await screen.findByRole('table')
    expect(table.parentElement).toHaveAttribute('data-warm-table-scroll', 'true')
    expect(container.querySelector('[class*="term-"]')).toBeNull()
  })

  it('renders production AHR enums with shared Chinese labels and semantic colors', async () => {
    render(<InspectionHistory periodId={10} />)

    const criticalBadge = await screen.findByLabelText('AHR 危险')
    const healthyBadge = await screen.findByLabelText('AHR 健康')

    expect(criticalBadge).toHaveAttribute('data-tone', 'critical')
    expect(healthyBadge).toHaveAttribute('data-tone', 'normal')
  })
})
