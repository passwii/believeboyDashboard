import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LedgerOverview } from './ledger-overview'
import type {
  LedgerDetailRow,
  LedgerSummaryRow,
  SnapshotResponse,
} from './ledger-types'

const SUMMARY_ROWS: LedgerSummaryRow[] = [
  {
    id: 1,
    date: '2026-08-01',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    disposition: 'SELLABLE',
    location: 'LAX1',
    starting_balance: 10,
    in_transit_between: 0,
    receipts: 2,
    customer_shipments: -1,
    customer_returns: 0,
    vendor_returns: 0,
    warehouse_transfer_io: 0,
    found: 0,
    lost: 0,
    damaged: 0,
    disposed: 0,
    other_events: 0,
    ending_balance: 11,
    unknown_events: 0,
    store: null,
    batch_id: 1,
  },
]

const DETAIL_ROWS: LedgerDetailRow[] = [
  {
    id: 11,
    date: '2026-08-02',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    event_type: 'Receipts',
    reference_id: 'REF-1',
    quantity: 2,
    fulfillment_center: 'LAX1',
    disposition: 'SELLABLE',
    reason: null,
    country: 'US',
    reconciled_quantity: null,
    unreconciled_quantity: null,
    date_and_time: null,
    store: null,
    batch_id: 1,
  },
]

const SNAPSHOT: SnapshotResponse = {
  report_month: '2026-08-01',
  sku_count: 1,
  total_qty: 11,
  disposition_summary: [
    { disposition: 'SELLABLE', qty_eom: 11, pct_of_total: 100 },
  ],
  skus: [
    {
      msku: 'SKU-A',
      title: 'Item A',
      qty_eom: 11,
      sellable_qty: 11,
      damaged_qty: 0,
      prev_qty_eom: 10,
      change: 1,
    },
  ],
  integrity: null,
}

describe('LedgerOverview analysis expansion', () => {
  it('renders the expanded KPI and analysis panels', () => {
    render(
      <LedgerOverview
        snapshot={SNAPSHOT}
        trend={{ project_id: 1, months: [] }}
        consistency={null}
        summaryRows={SUMMARY_ROWS}
        detailRows={DETAIL_ROWS}
        mskuFilter="all"
      />,
    )

    for (const label of [
      'SKU 数',
      '期末总库存',
      '可售库存',
      '损坏库存',
      '损坏占比',
      '事件净变动',
      '事件数',
      '环比变动',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('SKU 期末库存 Top 10')).toBeInTheDocument()
    expect(screen.getByText('每日事件活动')).toBeInTheDocument()
  })
})
