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
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/components/ui/image-preview-dialog', () => ({
  PortraitScreenshotDialog: () => null,
}))

import InspectionHistory from './inspection-history'

beforeEach(() => {
  mockNotify.mockReset()
})

describe('InspectionHistory health rating labels', () => {
  it('renders production AHR enums with shared Chinese labels and semantic colors', async () => {
    render(<InspectionHistory periodId={10} />)

    const criticalBadge = await screen.findByLabelText('AHR 危险')
    const healthyBadge = await screen.findByLabelText('AHR 健康')

    expect(criticalBadge.querySelector('span')).toHaveClass('text-term-neg')
    expect(healthyBadge.querySelector('span')).toHaveClass('text-emerald-700')
  })
})
