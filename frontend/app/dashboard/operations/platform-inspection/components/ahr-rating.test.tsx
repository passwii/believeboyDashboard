import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

const apiMocks = vi.hoisted(() => ({
  fetchInspectionHistory: vi.fn(),
  fetchPeriods: vi.fn(),
  fetchReport: vi.fn(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/lib/inspection-api', () => apiMocks)

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <h2 {...props}>{children}</h2>
  ),
}))

vi.mock('@/components/ui/image-preview-dialog', () => ({
  PortraitScreenshotDialog: () => null,
}))

import InspectionHistory from './inspection-history'
import { AhrRatingBadge, getAhrRatingPresentation } from './ahr-rating'

const historyItem = {
  id: 34,
  period_id: 7,
  project_id: 42,
  project_name: '北星店',
  week_start: '2026-10-01',
  week_end: '2026-10-07',
  status: 'submitted',
  account_health_rating: 'At Risk',
  compliance_total: 0,
  status_summary: null,
  screenshots: [],
  submitted_by: '巡检员',
  submitted_at: '2026-10-06T08:00:00Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AHR rating presentation', () => {
  it.each([
    ['Healthy', '健康', 'normal', 'healthy'],
    ['Good', '良好', 'normal', 'good'],
    ['At Risk', '预警', 'warning', 'at-risk'],
    ['Critical', '危险', 'critical', 'critical'],
  ] as const)('maps backend rating %s to %s and its semantic tone', (rating, label, severity, ratingKey) => {
    const presentation = getAhrRatingPresentation(rating)

    expect(presentation.label).toBe(label)
    expect(presentation.severity).toBe(severity)
    expect(presentation.ratingKey).toBe(ratingKey)
  })

  it('normalizes case and preserves unknown values without assigning a known severity', () => {
    expect(getAhrRatingPresentation('hEaLtHy').label).toBe('健康')

    const unknown = getAhrRatingPresentation('Review Needed')
    expect(unknown.label).toBe('Review Needed')
    expect(unknown.severity).toBe('normal')
    expect(unknown.ratingKey).toBe('unknown')
  })

  it('renders the mapped label rather than the backend enum', () => {
    render(<AhrRatingBadge rating="Critical" showCode />)

    expect(screen.getByLabelText('AHR 危险')).toBeInTheDocument()
    expect(screen.getByText('AHR')).toBeInTheDocument()
    expect(screen.queryByText('Critical')).not.toBeInTheDocument()
  })
})

describe('inspection history AHR', () => {
  it('uses the same localized, semantic rating in the history row and detail drawer', async () => {
    apiMocks.fetchPeriods.mockResolvedValue({ items: [], total: 0 })
    apiMocks.fetchInspectionHistory.mockResolvedValue({ items: [historyItem], total: 1 })
    apiMocks.fetchReport.mockResolvedValue({
      health_data: { account_health_rating: 'At Risk' },
      compliance_data: null,
      status_summary: null,
      screenshots: [],
    })

    const { container } = render(<InspectionHistory periodId={7} />)

    const rowRating = await screen.findByLabelText('AHR 预警')
    expect(rowRating).toHaveAttribute('data-tone', 'warning')
    expect(rowRating).toHaveAttribute('data-rating', 'at-risk')
    expect(screen.queryByText('At Risk')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /查看/ }))

    await waitFor(() => expect(screen.getAllByLabelText('AHR 预警')).toHaveLength(2))
    expect(screen.getByTestId('inspection-sheet-title')).toHaveAttribute(
      'data-warm-sheet-title',
      'true'
    )
    const ratings = screen.getAllByLabelText('AHR 预警')
    expect(ratings[1]).toHaveAttribute('data-tone', 'warning')
    expect(screen.queryByText('At Risk')).not.toBeInTheDocument()
    expect(container.querySelectorAll('[data-tone="warning"]')).toHaveLength(2)
  })
})
