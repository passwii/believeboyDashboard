import { beforeEach, describe, expect, it, vi } from 'vitest'

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn() }))

vi.mock('@/lib/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}))

import { exportDailyAnalysisToExcel } from './daily-analysis-client'

function makeSummaryRow(date: string) {
  return {
    date,
    order_qty: 2,
    pending_order_qty: 0,
    sales_amount: 12.5,
    impressions: 10,
    clicks: 2,
    cpc: 1.25,
    ad_spend: 2.5,
    ad_orders: 1,
    available_qty: 8,
    page_views: 4,
    units_ordered: 2,
    sessions: 3,
    ordered_sales_amount: 12.5,
    conversion_rate: 0.5,
  }
}

function makeDetailRow(date: string, sku: string) {
  return {
    ...makeSummaryRow(date),
    sku,
    asin: 'B000TEST',
    fnsku: null,
    product_name: null,
    in_transit_qty: 1,
  }
}

describe('exportDailyAnalysisToExcel', () => {
  beforeEach(() => {
    downloadBlobMock.mockReset()
  })

  it('writes both summary and detail rows into separate worksheets', async () => {
    await exportDailyAnalysisToExcel(
      [makeSummaryRow('2026-09-01')],
      [makeDetailRow('2026-09-01', 'SKU-1')],
      '测试项目',
      'US',
      '2026-09-01 ~ 2026-09-01',
      [],
      'daily'
    )

    const [blob] = downloadBlobMock.mock.calls[0] as [Blob, string]
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blob.arrayBuffer())

    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual(['日报汇总', 'SKU明细'])
    const summarySheet = workbook.getWorksheet('日报汇总')!
    const detailSheet = workbook.getWorksheet('SKU明细')!
    expect(summarySheet.getCell('A2').value).toBe('2026-09-01')
    expect(detailSheet.getCell('B2').value).toBe('SKU-1')
    expect(summarySheet.getCell('A2').fill).toMatchObject({
      fgColor: { argb: 'FFFFFFFF' },
    })
    expect(detailSheet.getCell('P2').border).toBeDefined()
  })
})
