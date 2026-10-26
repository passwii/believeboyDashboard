import { beforeEach, describe, expect, it, vi } from 'vitest'

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn() }))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}))

import {
  buildLedgerAnalysisWorkbook,
  exportLedgerAnalysisToExcel,
} from './ledger-excel-export'
import type {
  LedgerDetailRow,
  LedgerMonthAnalysisResponse,
  LedgerSummaryRow,
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
    customer_returns: 1,
    vendor_returns: 0,
    warehouse_transfer_io: 0,
    found: 0,
    lost: 0,
    damaged: 0,
    disposed: 0,
    other_events: 0,
    ending_balance: 12,
    unknown_events: 0,
    store: 'Store',
    batch_id: 1,
  },
  {
    id: 2,
    date: '2026-08-01',
    fnsku: 'FN-B',
    asin: 'B-B',
    msku: 'SKU-B',
    title: 'Item B',
    disposition: 'CUSTOMER_DAMAGED',
    location: 'SCK8',
    starting_balance: 2,
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
    ending_balance: 2,
    unknown_events: 0,
    store: 'Store',
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
    date_and_time: '2026-08-02T00:00:00-07:00',
    store: 'Store',
    batch_id: 2,
  },
  {
    id: 12,
    date: '2026-08-03',
    fnsku: 'FN-A',
    asin: 'B-A',
    msku: 'SKU-A',
    title: 'Item A',
    event_type: 'Shipments',
    reference_id: 'REF-2',
    quantity: -1,
    fulfillment_center: 'LAX1',
    disposition: 'SELLABLE',
    reason: null,
    country: 'US',
    reconciled_quantity: null,
    unreconciled_quantity: null,
    date_and_time: '2026-08-03T00:00:00-07:00',
    store: 'Store',
    batch_id: 2,
  },
]

const FIXTURE: LedgerMonthAnalysisResponse = {
  project_id: 1,
  project_name: '测试项目',
  country: 'US',
  report_month: '2026-08-01',
  start_date: '2026-08-01',
  end_date: '2026-08-31',
  generated_at: '2026-09-01T08:00:00Z',
  summary_rows: SUMMARY_ROWS,
  detail_rows: DETAIL_ROWS,
  snapshot: {
    report_month: '2026-08-01',
    sku_count: 2,
    total_qty: 14,
    disposition_summary: [
      { disposition: 'SELLABLE', qty_eom: 12, pct_of_total: 85.71 },
      { disposition: 'CUSTOMER_DAMAGED', qty_eom: 2, pct_of_total: 14.29 },
    ],
    skus: [
      {
        msku: 'SKU-A',
        title: 'Item A',
        qty_eom: 12,
        sellable_qty: 12,
        damaged_qty: 0,
        prev_qty_eom: 10,
        change: 2,
      },
      {
        msku: 'SKU-B',
        title: 'Item B',
        qty_eom: 2,
        sellable_qty: 0,
        damaged_qty: 2,
        prev_qty_eom: 3,
        change: -1,
      },
    ],
    integrity: {
      report_month: '2026-08-01',
      status: 'OK',
      mismatch_count: 0,
      mismatches: [],
      checked_at: '2026-09-01T08:00:00Z',
    },
  },
  trend: {
    project_id: 1,
    months: [
      {
        report_month: '2026-07',
        sku_count: 2,
        total_qty_eom: 13,
        total_receipts: 1,
        total_shipments: -2,
        total_returns: 0,
        total_damaged: 0,
        total_lost: 0,
        total_disposed: 0,
        damaged_pct: 10,
      },
      {
        report_month: '2026-08',
        sku_count: 2,
        total_qty_eom: 14,
        total_receipts: 2,
        total_shipments: -1,
        total_returns: 1,
        total_damaged: 0,
        total_lost: 0,
        total_disposed: 0,
        damaged_pct: 14.29,
      },
    ],
  },
  consistency: {
    report_month: '2026-08-01',
    status: 'OK',
    mismatch_count: 0,
    mismatches: [],
    checked_at: '2026-09-01T08:00:00Z',
  },
  batches: [
    {
      id: 1,
      project_id: 1,
      report_month: '2026-08-01',
      source_filename: '99538020752.csv',
      file_hash: 'abc',
      file_size_bytes: 100,
      file_kind: 'summary',
      loaded_by: null,
      loaded_at: '2026-09-01T08:00:00Z',
      completed_at: '2026-09-01T08:00:01Z',
      status: 'success',
      rows_parsed: 2,
      rows_written_summary: 2,
      rows_written_detail: 0,
      rows_skipped_duplicate: 0,
      rows_failed_validation: 0,
      error_message: null,
      consistency_check: 'ok',
      consistency_mismatch_count: 0,
    },
  ],
}

describe('buildLedgerAnalysisWorkbook', () => {
  it('creates the nine required sheets in the fixed order', async () => {
    const workbook = await buildLedgerAnalysisWorkbook(FIXTURE)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      '分析总览',
      'SKU期末与环比',
      'SKU事件汇总',
      '仓库状态库存',
      '每日事件分析',
      '近6月趋势',
      '数据质量与批次',
      'Summary原始数据',
      'Detail原始数据',
    ])
  })

  it('writes overview KPIs and analysis rows', async () => {
    const workbook = await buildLedgerAnalysisWorkbook(FIXTURE)
    const overview = workbook.getWorksheet('分析总览')!
    const values = overview
      .getSheetValues()
      .flat()
      .filter((value): value is string | number => value !== null && value !== undefined)
    expect(values).toContain('测试项目')
    expect(values).toContain('期末总库存')
    expect(values).toContain(14)
    expect(values).toContain('可售库存')
    expect(values).toContain(12)
  })

  it('keeps Amazon English headers on the final two raw sheets', async () => {
    const workbook = await buildLedgerAnalysisWorkbook(FIXTURE)
    const summary = workbook.getWorksheet('Summary原始数据')!
    const detail = workbook.getWorksheet('Detail原始数据')!

    expect(summary.getCell('A1').value).toBe('Date')
    expect(summary.getCell('X1').value).toBe('Batch ID')
    expect(detail.getCell('A1').value).toBe('Date')
    expect(detail.getCell('R1').value).toBe('Batch ID')
    expect(summary.getCell('D2').value).toBe('SKU-A')
    expect(detail.getCell('H2').value).toBe(2)
  })

  it('formats negative event quantities with the signed number format', async () => {
    const workbook = await buildLedgerAnalysisWorkbook(FIXTURE)
    const detail = workbook.getWorksheet('Detail原始数据')!
    expect(detail.getCell('H3').numFmt).toBe('#,##0;[Red]-#,##0')
  })
})

describe('exportLedgerAnalysisToExcel', () => {
  beforeEach(() => {
    downloadBlobMock.mockReset()
  })

  it('downloads the full workbook with a readable month filename', async () => {
    await exportLedgerAnalysisToExcel(FIXTURE)
    expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    const [blob, filename] = downloadBlobMock.mock.calls[0] as [Blob, string]
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(filename).toBe('库存分类账分析-测试项目-2026-08.xlsx')
  })
})
