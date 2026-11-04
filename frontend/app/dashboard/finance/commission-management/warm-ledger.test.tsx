import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DetailTab } from './detail-tab'
import { MonthlyCollectionTab } from './monthly-collection-tab'
import { MonthlySummaryTab } from './monthly-summary-tab'
import { ProjectSummaryTab } from './project-summary-tab'

const monthlyItems = [
  {
    report_month: '2026-01',
    income_total_usd: 100,
    factory_commission_usd: 10,
    factory_commission_rmb: 70,
    received_rmb: 35,
    receive_rate: 0.5,
  },
]

const projectItems = [
  {
    project_id: 7,
    project_name: 'Warm Shop',
    months: {
      '2026-01': {
        report_month: '2026-01',
        income_total_usd: 100,
        factory_commission_rmb: 70,
        received_rmb: 35,
        receive_rate: 0.5,
      },
    },
    total_income_usd: 100,
    total_commission_rmb: 70,
    total_received_rmb: 35,
    receive_rate: 0.5,
  },
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Commission Management Warm Ledger contract', () => {
  it('keeps monthly totals and rate semantics in the Warm table', () => {
    render(<MonthlySummaryTab items={monthlyItems} year="2026" loading={false} />)

    expect(screen.getByRole('table')).toHaveAttribute('data-warm-table', 'true')
    expect(screen.getByText('合计')).toBeInTheDocument()
    expect(screen.getAllByText('50.00%')[0]).toHaveAttribute('data-tone', 'accent')
  })

  it('keeps project totals and the monthly collection matrix readable', () => {
    const { unmount } = render(
      <ProjectSummaryTab items={projectItems} year="2026" loading={false} />
    )

    expect(screen.getByRole('table')).toHaveAttribute('data-warm-table', 'true')
    expect(screen.getAllByText('¥70.00').length).toBeGreaterThan(0)
    expect(screen.getByText('Warm Shop')).toBeInTheDocument()
    unmount()

    render(<MonthlyCollectionTab items={projectItems} year="2026" loading={false} />)
    expect(screen.getAllByText('50.00%')[0]).toHaveAttribute('data-tone', 'accent')
  })

  it('keeps editable payment and status controls in the overview table', () => {
    render(
      <DetailTab
        projectRows={[
          {
            projectId: 7,
            projectName: 'Warm Shop',
            rowSpan: 1,
            record: {
              id: 11,
              report_month: '2026-01',
              country: 'US',
              project_id: 7,
              project_name: 'Warm Shop',
              income_total_usd: 100,
              factory_commission_rate: 0.1,
              factory_commission_rmb: 70,
              payment_status: 'partial',
              received_rmb: 35,
              note: null,
            },
          },
        ]}
        exchangeRates={[]}
        projectMetaById={{}}
        loading={false}
        updatingId={null}
        receivedDraftById={{ 11: '35.00' }}
        onUpdateDraft={vi.fn()}
        onUpdatePaymentStatus={vi.fn()}
        onUpdateReceivedAmount={vi.fn()}
      />
    )

    expect(screen.getByRole('table')).toHaveAttribute('data-warm-table', 'true')
    expect(screen.getByDisplayValue('35.00')).toBeInTheDocument()
    expect(screen.getByText('部分回款')).toBeInTheDocument()
  })
})
