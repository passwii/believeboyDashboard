import { beforeEach, describe, expect, it, vi } from 'vitest'

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn() }))

vi.mock('./download-blob', () => ({ downloadBlob: downloadBlobMock }))

import { exportProductAnalysisToExcel } from './product-analysis-export'

describe('exportProductAnalysisToExcel data row styles', () => {
  beforeEach(() => {
    downloadBlobMock.mockReset()
  })

  it('round-trips zebra rows while preserving partial-period and summary semantics', async () => {
    await exportProductAnalysisToExcel({
      periods: [
        {
          report_start_date: '2026-08-03',
          report_end_date: '2026-08-09',
          is_partial: true,
          summary: { 总销量: 4, 总销售额: 20 },
          details: [
            { SKU: 'SKU-1', ASIN: 'ASIN-1', 总销量: 2, 总销售额: 10 },
            { SKU: 'SKU-2', ASIN: 'ASIN-2', 总销量: 2, 总销售额: 10 },
          ],
        },
      ],
      projectName: '测试项目',
      country: 'US',
      startDate: '2026-08-03',
      endDate: '2026-08-09',
    })

    const [blob] = downloadBlobMock.mock.calls[0] as [Blob, string]
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await blob.arrayBuffer())

    const summary = workbook.getWorksheet('汇总')!
    expect(summary.getCell('A6').value).toBe('2026-W32 *')
    expect(summary.getCell('A6').fill).toMatchObject({ fgColor: { argb: 'FFFFF3CD' } })
    expect(summary.getCell('A7').value).toBe('合计')

    const detail = workbook.getWorksheet('SKU明细')!
    expect(detail.getCell('B6').value).toBe('SKU-1')
    expect(detail.getCell('B7').value).toBe('SKU-2')
    expect(detail.getCell('C6').fill).toMatchObject({ fgColor: { argb: 'FFFFFFFF' } })
    expect(detail.getCell('C7').fill).toMatchObject({ fgColor: { argb: 'FFF8FAFC' } })
    expect(detail.getCell(6, detail.columnCount).border).toMatchObject({
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    })
    expect(detail.getCell('B8').value).toBe('汇总')
    expect(detail.getCell('B8').fill).toMatchObject({ fgColor: { argb: 'FFF0FDF4' } })
  })
})
