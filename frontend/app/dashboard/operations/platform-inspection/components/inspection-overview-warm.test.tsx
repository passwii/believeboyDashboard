import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/components/ui/image-preview-dialog', () => ({
  PortraitScreenshotDialog: () => null,
}))

vi.mock('@/lib/inspection-api', () => ({
  fetchPeriodOverview: vi.fn().mockResolvedValue({
    period: {
      id: 7,
      week_start: '2026-11-02',
      week_end: '2026-11-08',
      deadline: '2026-11-09T10:00:00Z',
      status: 'active',
    },
    total_projects: 1,
    submitted_count: 1,
    overdue_count: 0,
    items: [
      {
        project_id: 1,
        project_name: '北星店',
        status: 'submitted',
        account_health_rating: 'Healthy',
        negative_feedback: 0,
        a2z_claims: 0,
        chargeback_claims: 0,
        late_shipment_rate: 1,
        valid_tracking_rate: 99,
        on_time_delivery_rate: 99,
        compliance_total: 0,
        submitted_by: '巡检员',
        submitted_at: '2026-11-05T08:00:00Z',
        status_summary: null,
        screenshots: [],
      },
    ],
  }),
}))

import InspectionOverview from './inspection-overview'

afterEach(cleanup)

describe('Inspection Overview Warm Ledger contract', () => {
  it('renders Warm project cards while preserving edit selection', async () => {
    const onSelectProject = vi.fn()
    render(
      <InspectionOverview periodId={7} onSelectProject={onSelectProject} refreshKey={0} />
    )

    const page = await screen.findByTestId('inspection-overview')
    expect(page).toHaveAttribute('data-warm-inspection-overview', 'true')
    expect(screen.getByTestId('inspection-project-card')).toHaveAttribute(
      'data-warm-panel',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: '编辑 北星店' }))
    expect(onSelectProject).toHaveBeenCalledWith(1)
  })
})
