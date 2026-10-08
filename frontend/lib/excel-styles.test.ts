import { describe, expect, it, vi } from 'vitest'
import {
  EXCEL_COLORS,
  applyDataRowBanding,
  applyGroupBanding,
  applyHeaderRowStyle,
  applyTotalRowStyle,
} from './excel-styles'

type MockCell = {
  value?: unknown
  font?: unknown
  fill?: { pattern: string; fgColor: { argb: string } } | null
  alignment?: unknown
  border?: unknown
}

function createMockContext(rowCount: number, columnCount: number) {
  const cells: MockCell[][] = Array.from({ length: rowCount + 4 }, () =>
    Array.from({ length: columnCount + 2 }, () => ({}) as MockCell)
  )
  const mergeCells = vi.fn()
  const worksheet = {
    getRow: (rowNumber: number) => ({
      getCell: (col: number) => cells[rowNumber][col],
    }),
    getCell: (rowNumber: number, col: number) => cells[rowNumber][col],
    mergeCells,
  }
  return { worksheet, cells, mergeCells }
}

describe('applyHeaderRowStyle', () => {
  it('applies header font, fill, centered wrap alignment and border to every column', () => {
    const { worksheet, cells } = createMockContext(1, 3)
    const row = worksheet.getRow(1) as unknown as Parameters<typeof applyHeaderRowStyle>[0]

    applyHeaderRowStyle(row, 3)

    expect(row.height).toBe(22)
    for (let col = 1; col <= 3; col += 1) {
      const cell = cells[1][col]
      expect(cell.font).toMatchObject({
        name: EXCEL_COLORS.font,
        bold: true,
        color: { argb: EXCEL_COLORS.text },
      })
      expect(cell.fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.headerFill } })
      expect(cell.alignment).toEqual(
        expect.objectContaining({ horizontal: 'center', wrapText: true })
      )
      expect(cell.border).toBeDefined()
    }
  })

  it('supports custom height', () => {
    const { worksheet } = createMockContext(1, 1)
    const row = worksheet.getRow(1) as unknown as Parameters<typeof applyHeaderRowStyle>[0]
    applyHeaderRowStyle(row, 1, { height: 30 })
    expect(row.height).toBe(30)
  })
})

describe('applyTotalRowStyle', () => {
  it('styles the whole row bold with alt fill and a strong top separator', () => {
    const { worksheet, cells } = createMockContext(5, 3)
    const row = worksheet.getRow(5) as unknown as Parameters<typeof applyTotalRowStyle>[0]

    applyTotalRowStyle(row, 3, { numericColumns: [2, 3] })

    for (let col = 1; col <= 3; col += 1) {
      const cell = cells[5][col]
      expect(cell.font).toMatchObject({ name: EXCEL_COLORS.font, bold: true })
      expect(cell.fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.altRowFill } })
      expect(cell.border).toMatchObject({
        top: { style: 'medium', color: { argb: EXCEL_COLORS.groupRule } },
      })
      expect(cell.alignment).toMatchObject({ vertical: 'middle' })
    }
    expect(cells[5][1].alignment).toMatchObject({ horizontal: 'left' })
    expect(cells[5][2].alignment).toMatchObject({ horizontal: 'right' })
    expect(cells[5][3].alignment).toMatchObject({ horizontal: 'right' })
  })

  it('honors centered columns', () => {
    const { worksheet, cells } = createMockContext(2, 2)
    const row = worksheet.getRow(2) as unknown as Parameters<typeof applyTotalRowStyle>[0]
    applyTotalRowStyle(row, 2, { centerColumns: [1] })
    expect(cells[2][1].alignment).toMatchObject({ horizontal: 'center' })
  })
})

describe('applyDataRowBanding', () => {
  it('alternates data rows, borders blank cells, and honors offsets across special rows', () => {
    const { worksheet, cells } = createMockContext(5, 3)

    applyDataRowBanding({
      worksheet: worksheet as never,
      startRow: 2,
      rowCount: 2,
      columnCount: 3,
      dataRowOffset: 1,
    })

    expect(cells[2][1].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.altRowFill } })
    expect(cells[3][1].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.white } })
    expect(cells[2][3].border).toMatchObject({
      top: { style: 'thin', color: { argb: EXCEL_COLORS.border } },
      left: { style: 'thin', color: { argb: EXCEL_COLORS.border } },
      bottom: { style: 'thin', color: { argb: EXCEL_COLORS.border } },
      right: { style: 'thin', color: { argb: EXCEL_COLORS.border } },
    })
    expect(cells[4][1].fill).toBeUndefined()
  })

  it('preserves existing font and alignment and round-trips styles through ExcelJS', async () => {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('数据')
    worksheet.getCell('A2').value = 'data'
    worksheet.getCell('A2').font = { bold: true }
    worksheet.getCell('A2').alignment = { horizontal: 'right' }
    worksheet.getCell('B3').value = null
    worksheet.getCell('B3').border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    }

    applyDataRowBanding({ worksheet, startRow: 2, rowCount: 2, columnCount: 2 })

    const buffer = await workbook.xlsx.writeBuffer()
    const restoredWorkbook = new ExcelJS.Workbook()
    await restoredWorkbook.xlsx.load(buffer)
    const restored = restoredWorkbook.getWorksheet('数据')!

    expect(restored.getCell('A2').fill).toMatchObject({
      fgColor: { argb: EXCEL_COLORS.white },
    })
    expect(restored.getCell('A3').fill).toMatchObject({
      fgColor: { argb: EXCEL_COLORS.altRowFill },
    })
    expect(restored.getCell('B3').border).toMatchObject({
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' },
    })
    expect(restored.getCell('A2').font).toMatchObject({ bold: true })
    expect(restored.getCell('A2').alignment).toMatchObject({ horizontal: 'right' })
  })

  it('does nothing for empty rows or columns', () => {
    const { worksheet, cells } = createMockContext(2, 2)
    applyDataRowBanding({ worksheet: worksheet as never, startRow: 2, rowCount: 0, columnCount: 2 })
    applyDataRowBanding({ worksheet: worksheet as never, startRow: 2, rowCount: 1, columnCount: 0 })
    expect(cells[2][1].fill).toBeUndefined()
    expect(cells[2][1].border).toBeUndefined()
  })
})

describe('applyGroupBanding', () => {
  it('bands adjacent same-key rows together, merges the key column and styles the anchor', () => {
    const { worksheet, cells, mergeCells } = createMockContext(4, 3)

    applyGroupBanding({
      worksheet: worksheet as never,
      startRow: 2,
      rowCount: 3,
      groupKeys: ['A', 'A', 'B'],
      columnCount: 3,
      mergeColumn: 1,
    })

    // 组 1（两行）与组 2（一行）：交替白 / 浅灰蓝
    expect(cells[2][2].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.white } })
    expect(cells[3][3].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.white } })
    expect(cells[4][2].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.altRowFill } })

    // 多行组合并关键列，单行组不合并
    expect(mergeCells).toHaveBeenCalledTimes(1)
    expect(mergeCells).toHaveBeenCalledWith(2, 1, 3, 1)

    // 锚点单元格加粗居中
    expect(cells[2][1].font).toMatchObject({ bold: true })
    expect(cells[2][1].alignment).toMatchObject({
      vertical: 'middle',
      horizontal: 'center',
    })
  })

  it('degrades to zebra striping with thin separators when every group is a single row', () => {
    const { worksheet, cells, mergeCells } = createMockContext(4, 2)

    applyGroupBanding({
      worksheet: worksheet as never,
      startRow: 2,
      rowCount: 2,
      groupKeys: ['A', 'B'],
      columnCount: 2,
      mergeColumn: 1,
    })

    expect(mergeCells).not.toHaveBeenCalled()
    expect(cells[2][1].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.white } })
    expect(cells[3][1].fill).toMatchObject({ fgColor: { argb: EXCEL_COLORS.altRowFill } })
    // 单行组之间保持细横线
    expect(cells[2][1].border).toMatchObject({
      top: { style: 'thin' },
      bottom: { style: 'thin' },
    })
  })

  it('draws strong horizontal rules around multi-row groups even next to singletons', () => {
    const { worksheet, cells } = createMockContext(8, 2)

    // A 两行 / B 一行 / C 两行：中间单行组的上下沿都应是粗线
    applyGroupBanding({
      worksheet: worksheet as never,
      startRow: 2,
      rowCount: 5,
      groupKeys: ['A', 'A', 'B', 'C', 'C'],
      columnCount: 2,
    })

    expect(cells[2][1].border).toMatchObject({ top: { style: 'medium' } })
    expect(cells[3][1].border).toMatchObject({ bottom: { style: 'medium' } })
    expect(cells[4][1].border).toMatchObject({ top: { style: 'medium' } })
    expect(cells[4][1].border).toMatchObject({ bottom: { style: 'medium' } })
    expect(cells[5][1].border).toMatchObject({ top: { style: 'medium' } })
    expect(cells[6][1].border).toMatchObject({ bottom: { style: 'medium' } })
  })

  it('keeps a medium outer frame on the first and last columns', () => {
    const { worksheet, cells } = createMockContext(3, 3)

    applyGroupBanding({
      worksheet: worksheet as never,
      startRow: 1,
      rowCount: 1,
      groupKeys: ['A'],
      columnCount: 3,
    })

    expect(cells[1][1].border).toMatchObject({ left: { style: 'medium' } })
    expect(cells[1][2].border).toMatchObject({ left: { style: 'thin' } })
    expect(cells[1][3].border).toMatchObject({ right: { style: 'medium' } })
  })

  it('does nothing for an empty dataset', () => {
    const { worksheet, mergeCells } = createMockContext(2, 2)
    applyGroupBanding({
      worksheet: worksheet as never,
      startRow: 2,
      rowCount: 0,
      groupKeys: [],
      columnCount: 2,
    })
    expect(mergeCells).not.toHaveBeenCalled()
  })
})
