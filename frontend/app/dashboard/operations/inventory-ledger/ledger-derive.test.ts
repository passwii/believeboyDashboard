/**
 * Unit tests for ledger-derive (BLF-428 前端重构).
 *
 * These pure functions are the overview's single source of truth: every KPI
 * and chart is derived from filtered summary+detail rows. Getting these
 * right means the overview can never disagree with the tabs.
 */

import { describe, expect, it } from 'vitest'

import {
  computeKpis,
  computeMomChange,
  computeOverviewKpis,
  dailyEventSummary,
  detailRowMatches,
  dispositionBreakdown,
  filterDetailRows,
  filterSummaryRows,
  formatLedgerMonthLabel,
  groupDetailByEventType,
  latestEndingByGroup,
  skuEndingSummary,
  skuEventTotals,
  summaryRowMatches,
  topLocations,
  warehouseDispositionSummary,
  waterLevelSeries,
} from './ledger-derive'
import {
  ALL,
  DEFAULT_FILTERS,
  type LedgerDetailRow,
  type LedgerSummaryRow,
  type SkuMonthEom,
} from './ledger-types'

// ── fixtures ──────────────────────────────────────────────────────────────────

let idSeq = 1

describe('formatLedgerMonthLabel', () => {
  it('renders backend month-start values as a human month label', () => {
    expect(formatLedgerMonthLabel('2026-08-01')).toBe('2026 年 8 月')
    expect(formatLedgerMonthLabel('2026-08')).toBe('2026 年 8 月')
  })

  it('keeps non-month values unchanged', () => {
    expect(formatLedgerMonthLabel('全部月份')).toBe('全部月份')
  })
})

function summaryRow(partial: Partial<LedgerSummaryRow>): LedgerSummaryRow {
  return {
    id: idSeq++,
    date: '2026-03-01',
    fnsku: null,
    asin: null,
    msku: 'SKU-A',
    title: null,
    disposition: 'SELLABLE',
    location: 'LAX1',
    starting_balance: 0,
    in_transit_between: 0,
    receipts: 0,
    customer_shipments: 0,
    customer_returns: 0,
    vendor_returns: 0,
    warehouse_transfer_io: 0,
    found: 0,
    lost: 0,
    damaged: 0,
    disposed: 0,
    other_events: 0,
    ending_balance: 0,
    unknown_events: 0,
    store: null,
    batch_id: null,
    ...partial,
  }
}

function detailRow(partial: Partial<LedgerDetailRow>): LedgerDetailRow {
  return {
    id: idSeq++,
    date: '2026-03-01',
    fnsku: null,
    asin: null,
    msku: 'SKU-A',
    title: null,
    event_type: 'Shipments',
    reference_id: null,
    quantity: -1,
    fulfillment_center: 'LAX1',
    disposition: 'SELLABLE',
    reason: null,
    country: 'US',
    reconciled_quantity: null,
    unreconciled_quantity: null,
    date_and_time: null,
    store: null,
    batch_id: null,
    ...partial,
  }
}

// ── 过滤 ──────────────────────────────────────────────────────────────────────

describe('row matching / filtering', () => {
  it('passes everything when all filters are ALL', () => {
    expect(summaryRowMatches(summaryRow({}), DEFAULT_FILTERS)).toBe(true)
    expect(detailRowMatches(detailRow({}), DEFAULT_FILTERS)).toBe(true)
  })

  it('filters summary rows by msku / location / disposition', () => {
    const rows = [
      summaryRow({ msku: 'SKU-A', location: 'LAX1', disposition: 'SELLABLE' }),
      summaryRow({ msku: 'SKU-A', location: 'SCK8', disposition: 'CUSTOMER_DAMAGED' }),
      summaryRow({ msku: 'SKU-B', location: 'LAX1', disposition: 'SELLABLE' }),
    ]
    expect(filterSummaryRows(rows, { ...DEFAULT_FILTERS, msku: 'SKU-A' })).toHaveLength(2)
    expect(filterSummaryRows(rows, { ...DEFAULT_FILTERS, location: 'SCK8' })).toHaveLength(1)
    expect(
      filterSummaryRows(rows, { ...DEFAULT_FILTERS, disposition: 'CUSTOMER_DAMAGED' }),
    ).toHaveLength(1)
  })

  it('filters detail rows by event type and fulfillment_center', () => {
    const rows = [
      detailRow({ event_type: 'Shipments', fulfillment_center: 'LAX1' }),
      detailRow({ event_type: 'Receipts', fulfillment_center: 'SCK8' }),
      detailRow({ event_type: 'Shipments', fulfillment_center: 'SCK8' }),
    ]
    expect(
      filterDetailRows(rows, { ...DEFAULT_FILTERS, eventType: 'Shipments' }),
    ).toHaveLength(2)
    expect(filterDetailRows(rows, { ...DEFAULT_FILTERS, location: 'SCK8' })).toHaveLength(2)
  })
})

// ── KPI ───────────────────────────────────────────────────────────────────────

describe('computeKpis', () => {
  it('takes the latest ending per (msku × location × disposition) group', () => {
    // API returns date desc: 03-02 rows first, then 03-01
    const rows = [
      summaryRow({ msku: 'SKU-A', location: 'LAX1', date: '2026-03-02', ending_balance: 40 }),
      summaryRow({ msku: 'SKU-A', location: 'LAX1', date: '2026-03-01', ending_balance: 45 }),
      summaryRow({
        msku: 'SKU-A',
        location: 'SCK8',
        disposition: 'CUSTOMER_DAMAGED',
        date: '2026-03-02',
        ending_balance: 5,
      }),
    ]
    const kpis = computeKpis(rows, [])
    expect(kpis.endingTotal).toBe(45) // 40 + 5 (the 03-01 duplicate is NOT counted)
    expect(kpis.damagedQty).toBe(5)
    expect(kpis.damagedPct).toBeCloseTo((5 / 45) * 100)
  })

  it('sums event net change and count from detail rows', () => {
    const details = [
      detailRow({ quantity: -1 }),
      detailRow({ quantity: -1 }),
      detailRow({ quantity: 9 }),
    ]
    const kpis = computeKpis([], details)
    expect(kpis.netChange).toBe(7)
    expect(kpis.eventCount).toBe(3)
  })

  it('returns zeros on empty input (no NaN pct)', () => {
    const kpis = computeKpis([], [])
    expect(kpis).toEqual({
      endingTotal: 0,
      damagedQty: 0,
      damagedPct: 0,
      netChange: 0,
      eventCount: 0,
    })
  })
})

describe('computeOverviewKpis', () => {
  it('adds SKU count and sellable/damaged split to the base KPIs', () => {
    const rows = [
      summaryRow({ msku: 'SKU-A', ending_balance: 90, disposition: 'SELLABLE' }),
      summaryRow({
        msku: 'SKU-A',
        ending_balance: 10,
        disposition: 'CUSTOMER_DAMAGED',
      }),
      summaryRow({ msku: 'SKU-B', ending_balance: 20, disposition: 'SELLABLE' }),
    ]
    const details = [detailRow({ quantity: -3 }), detailRow({ quantity: 5 })]

    expect(computeOverviewKpis(rows, details)).toMatchObject({
      skuCount: 2,
      endingTotal: 120,
      sellableQty: 110,
      damagedQty: 10,
      damagedPct: 8.333333333333332,
      netChange: 2,
      eventCount: 2,
    })
  })
})

describe('inventory analysis tables', () => {
  it('builds per-SKU ending summaries', () => {
    const rows = [
      summaryRow({ msku: 'SKU-A', ending_balance: 90, disposition: 'SELLABLE' }),
      summaryRow({
        msku: 'SKU-A',
        ending_balance: 10,
        disposition: 'CUSTOMER_DAMAGED',
      }),
      summaryRow({ msku: 'SKU-B', ending_balance: 20, disposition: 'SELLABLE' }),
    ]
    expect(skuEndingSummary(rows)).toEqual([
      expect.objectContaining({
        msku: 'SKU-A',
        endingQty: 100,
        sellableQty: 90,
        damagedQty: 10,
        damagedPct: 10,
      }),
      expect.objectContaining({
        msku: 'SKU-B',
        endingQty: 20,
        sellableQty: 20,
        damagedQty: 0,
      }),
    ])
  })

  it('builds per-SKU event totals', () => {
    const event = skuEventTotals([
      summaryRow({
        msku: 'SKU-A',
        receipts: 5,
        customer_shipments: -2,
        customer_returns: 1,
      }),
      summaryRow({
        msku: 'SKU-A',
        receipts: 3,
        customer_shipments: -1,
        damaged: -1,
      }),
    ])
    expect(event).toEqual([
      expect.objectContaining({
        msku: 'SKU-A',
        receipts: 8,
        customerShipments: -3,
        customerReturns: 1,
        damaged: -1,
        netChange: 5,
      }),
    ])
  })

  it('builds warehouse x disposition inventory rows', () => {
    const rows = [
      summaryRow({
        location: 'LAX1',
        disposition: 'SELLABLE',
        starting_balance: 80,
        ending_balance: 90,
        receipts: 10,
      }),
      summaryRow({
        location: 'LAX1',
        disposition: 'SELLABLE',
        msku: 'SKU-B',
        starting_balance: 10,
        ending_balance: 15,
        receipts: 5,
      }),
    ]
    expect(warehouseDispositionSummary(rows)).toEqual([
      expect.objectContaining({
        location: 'LAX1',
        disposition: 'SELLABLE',
        startingBalance: 90,
        endingBalance: 105,
        receipts: 15,
      }),
    ])
  })
})

describe('dailyEventSummary', () => {
  it('aggregates event count, net quantity and per-type quantities by date', () => {
    const rows = [
      detailRow({ date: '2026-08-02', event_type: 'Receipts', quantity: 9 }),
      detailRow({ date: '2026-08-02', event_type: 'Shipments', quantity: -1 }),
      detailRow({ date: '2026-08-03', event_type: 'Shipments', quantity: -2 }),
    ]
    const rowsAsc = dailyEventSummary(rows)
    expect(rowsAsc.map((r) => r.date)).toEqual(['2026-08-02', '2026-08-03'])
    expect(rowsAsc[0]).toMatchObject({
      eventCount: 2,
      netQty: 8,
      quantities: { Receipts: 9, Shipments: -1 },
    })
  })
})

describe('computeMomChange', () => {
  const skus: SkuMonthEom[] = [
    { msku: 'SKU-A', title: null, qty_eom: 40, sellable_qty: 40, damaged_qty: 0, prev_qty_eom: 30, change: 10 },
    { msku: 'SKU-B', title: null, qty_eom: 8, sellable_qty: 8, damaged_qty: 0, prev_qty_eom: 10, change: -2 },
    { msku: 'SKU-C', title: null, qty_eom: 5, sellable_qty: 5, damaged_qty: 0, prev_qty_eom: null, change: null },
  ]

  it('sums change across all SKUs when unfiltered', () => {
    expect(computeMomChange(skus, ALL)).toBe(8)
  })

  it('scopes to the filtered SKU', () => {
    expect(computeMomChange(skus, 'SKU-A')).toBe(10)
    expect(computeMomChange(skus, 'SKU-B')).toBe(-2)
  })

  it('returns null when no SKU has previous-month data', () => {
    expect(computeMomChange(skus, 'SKU-C')).toBeNull()
    expect(computeMomChange([], ALL)).toBeNull()
  })
})

// ── 图表派生 ──────────────────────────────────────────────────────────────────

describe('groupDetailByEventType', () => {
  it('groups count + net qty, sorted by count desc', () => {
    const rows = [
      detailRow({ event_type: 'WhseTransfers', quantity: 5 }),
      detailRow({ event_type: 'WhseTransfers', quantity: -3 }),
      detailRow({ event_type: 'Shipments', quantity: -1 }),
    ]
    const groups = groupDetailByEventType(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ event_type: 'WhseTransfers', count: 2, net_qty: 2 })
    expect(groups[1]).toEqual({ event_type: 'Shipments', count: 1, net_qty: -1 })
  })
})

describe('dispositionBreakdown', () => {
  it('computes pct of latest endings per disposition', () => {
    const rows = [
      summaryRow({ msku: 'SKU-A', disposition: 'SELLABLE', ending_balance: 90 }),
      summaryRow({ msku: 'SKU-A', disposition: 'CUSTOMER_DAMAGED', ending_balance: 10 }),
    ]
    const slices = dispositionBreakdown(rows)
    expect(slices).toHaveLength(2)
    expect(slices[0]).toMatchObject({ disposition: 'SELLABLE', qty: 90, pct: 90 })
    expect(slices[1]).toMatchObject({ disposition: 'CUSTOMER_DAMAGED', qty: 10, pct: 10 })
  })
})

describe('topLocations', () => {
  it('sorts desc and caps at topN', () => {
    const rows = [
      summaryRow({ location: 'LAX1', ending_balance: 50 }),
      summaryRow({ location: 'SCK8', msku: 'SKU-B', ending_balance: 80 }),
      summaryRow({ location: 'HOU7', msku: 'SKU-C', ending_balance: 10 }),
    ]
    const top = topLocations(rows, 2)
    expect(top).toEqual([
      { location: 'SCK8', qty: 80 },
      { location: 'LAX1', qty: 50 },
    ])
  })
})

describe('waterLevelSeries', () => {
  it('pivots per-MSKU daily endings (summed across locations), dates ascending', () => {
    // date desc input
    const rows = [
      summaryRow({ msku: 'SKU-A', location: 'LAX1', date: '2026-03-02', ending_balance: 30 }),
      summaryRow({ msku: 'SKU-A', location: 'SCK8', date: '2026-03-02', ending_balance: 10 }),
      summaryRow({ msku: 'SKU-B', location: 'LAX1', date: '2026-03-02', ending_balance: 7 }),
      summaryRow({ msku: 'SKU-A', location: 'LAX1', date: '2026-03-01', ending_balance: 25 }),
      summaryRow({ msku: 'SKU-A', location: 'SCK8', date: '2026-03-01', ending_balance: 5 }),
    ]
    const { mskus, data } = waterLevelSeries(rows)
    expect(mskus).toEqual(['SKU-A', 'SKU-B'])
    expect(data.map((d) => d.date)).toEqual(['2026-03-01', '2026-03-02'])
    expect(data[0]['SKU-A']).toBe(30) // 25 + 5
    expect(data[0]['SKU-B']).toBeUndefined() // no SKU-B row on 03-01
    expect(data[1]['SKU-A']).toBe(40) // 30 + 10
    expect(data[1]['SKU-B']).toBe(7)
  })
})

// ── latestEndingByGroup（防御性：同组重复行只取最新） ─────────────────────────

describe('latestEndingByGroup', () => {
  it('keeps the first (newest) row per group key', () => {
    const rows = [
      summaryRow({ msku: 'SKU-A', date: '2026-03-02', ending_balance: 40 }),
      summaryRow({ msku: 'SKU-A', date: '2026-03-01', ending_balance: 45 }),
    ]
    const latest = latestEndingByGroup(rows)
    expect(latest).toHaveLength(1)
    expect(latest.get('SKU-A|LAX1|SELLABLE')?.ending_balance).toBe(40)
  })
})

